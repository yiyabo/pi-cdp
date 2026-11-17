/**
 * DOM and input actions over CDP: ref/selector resolution, real mouse/keyboard input,
 * framework-safe form filling, waits, evaluation, and screenshots.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	CdpClientInterface,
	CdpSendOptions,
	ClickOptions,
	ResolvedDomTarget,
	ScreenshotOptions,
	ScreenshotResult,
	SnapshotRefEntry,
	TargetResolutionContext,
	WaitConditionOptions,
} from "../types.ts";
import { resolveToolPath } from "../utils/process-tree.ts";

interface RemoteObject {
	type?: string;
	subtype?: string;
	className?: string;
	value?: unknown;
	unserializableValue?: string;
	description?: string;
	objectId?: string;
}

interface ExceptionDetails {
	text?: string;
	exception?: RemoteObject;
}

interface EvaluateResponse {
	result?: RemoteObject;
	exceptionDetails?: ExceptionDetails;
}

const REF_PATTERN = /^@?e(\d+)$/;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const WAIT_POLL_MS = 100;
const MAX_EVAL_TEXT = 50_000;
const EVAL_OBJECT_GROUP = "pi-cdp-eval";

function ctxOptions(ctx: TargetResolutionContext): CdpSendOptions {
	return {
		sessionId: ctx.sessionId,
		...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs }),
		...(ctx.signal ? { signal: ctx.signal } : {}),
	};
}

function sendOptions(sessionId: string, timeoutMs?: number, signal?: AbortSignal): CdpSendOptions {
	return {
		sessionId,
		...(timeoutMs === undefined ? {} : { timeoutMs }),
		...(signal ? { signal } : {}),
	};
}

/** Applies per-action timeout/abort overrides on top of the shared resolution context. */
function withCallOverrides(
	ctx: TargetResolutionContext,
	overrides?: { timeoutMs?: number; signal?: AbortSignal },
): TargetResolutionContext {
	const next: TargetResolutionContext = { ...ctx };
	if (overrides?.timeoutMs !== undefined) {
		next.timeoutMs = overrides.timeoutMs;
	}
	if (overrides?.signal) {
		next.signal = overrides.signal;
	}
	return next;
}

interface QuadBox {
	left: number;
	top: number;
	width: number;
	height: number;
	centerX: number;
	centerY: number;
}

/** Converts a CDP content quad (8 numbers, clockwise points) into an axis-aligned box. */
function quadBox(quad: number[]): QuadBox | null {
	if (quad.length < 8) {
		return null;
	}
	const xs = [quad[0], quad[2], quad[4], quad[6]];
	const ys = [quad[1], quad[3], quad[5], quad[7]];
	const left = Math.min(...xs);
	const top = Math.min(...ys);
	return {
		left,
		top,
		width: Math.max(...xs) - left,
		height: Math.max(...ys) - top,
		centerX: (xs[0] + xs[1] + xs[2] + xs[3]) / 4,
		centerY: (ys[0] + ys[1] + ys[2] + ys[3]) / 4,
	};
}

function exceptionText(details: ExceptionDetails): string {
	const description = details.exception?.description;
	if (description) {
		return description.split("\n")[0] ?? description;
	}
	if (details.exception?.value !== undefined) {
		return String(details.exception.value);
	}
	return details.text ?? "Uncaught exception";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
			return;
		}
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Returns the canonical `@eN` form when `target` looks like a snapshot ref, else null. */
export function normalizeRef(target: string): string | null {
	const match = REF_PATTERN.exec(target.trim());
	return match ? `@e${match[1]}` : null;
}

/** `@eLow..@eHigh` span of a snapshot's refs (refs stay stable within a generation, so numbering may have gaps). */
function refRangeText(refs: readonly SnapshotRefEntry[]): string {
	const numbers = refs.map((entry) => Number.parseInt(entry.ref.replace(/^@e/, ""), 10)).filter(Number.isFinite);
	if (numbers.length === 0) {
		return `${refs.length} refs`;
	}
	const low = Math.min(...numbers);
	const high = Math.max(...numbers);
	const span = `@e${low}..@e${high}`;
	return refs.length === high - low + 1 ? span : `${refs.length} refs within ${span}`;
}

function describeEntry(entry: SnapshotRefEntry): string {
	return `${entry.ref} ${entry.role}${entry.name ? ` ${JSON.stringify(entry.name)}` : ""}`;
}

function staleRefError(ref: string): Error {
	return new Error(`Ref ${ref} is stale — run snapshot again (the page changed or navigated since it was captured).`);
}

async function releaseObject(client: CdpClientInterface, options: CdpSendOptions, objectId: string): Promise<void> {
	try {
		await client.send("Runtime.releaseObject", { objectId }, options);
	} catch {
		// Object already collected (navigation, context destroyed).
	}
}

/** Best-effort command whose failure must not mask the caller's outcome (cleanup, optional domain enables). */
async function sendQuietly(
	client: CdpClientInterface,
	method: string,
	params: Record<string, unknown>,
	options: CdpSendOptions,
): Promise<void> {
	try {
		await client.send(method, params, options);
	} catch {
		// Intentionally ignored: see call sites.
	}
}

async function resolveObjectId(ctx: TargetResolutionContext, backendNodeId: number): Promise<string> {
	const resolved = await ctx.client.send<{ object?: RemoteObject }>(
		"DOM.resolveNode",
		{ backendNodeId },
		ctxOptions(ctx),
	);
	const objectId = resolved.object?.objectId;
	if (!objectId) {
		throw new Error(`DOM node ${backendNodeId} could not be resolved to a JavaScript object`);
	}
	return objectId;
}

/** Calls `functionDeclaration` with `this` bound to the node; throws on page exceptions. */
async function callOnNode<T>(
	ctx: TargetResolutionContext,
	backendNodeId: number,
	label: string,
	functionDeclaration: string,
	args: unknown[] = [],
): Promise<T> {
	const options = ctxOptions(ctx);
	const objectId = await resolveObjectId(ctx, backendNodeId);
	try {
		const response = await ctx.client.send<EvaluateResponse>(
			"Runtime.callFunctionOn",
			{
				objectId,
				functionDeclaration,
				arguments: args.map((value) => ({ value })),
				returnByValue: true,
				awaitPromise: true,
				userGesture: true,
			},
			options,
		);
		if (response.exceptionDetails) {
			throw new Error(`${label} failed: ${exceptionText(response.exceptionDetails)}`);
		}
		// SAFETY: returnByValue serializes the page-side return value whose shape the caller declares as T.
		return response.result?.value as T;
	} finally {
		await releaseObject(ctx.client, options, objectId);
	}
}

async function resolveRefTarget(ctx: TargetResolutionContext, ref: string): Promise<ResolvedDomTarget> {
	const snapshot = ctx.latestSnapshot;
	if (!snapshot) {
		throw new Error(`No snapshot has been captured yet — run snapshot first to obtain ${ref}-style refs.`);
	}
	const entry = snapshot.refMap.get(ref);
	if (!entry) {
		const last = snapshot.refs.length > 0 ? ` (latest snapshot has ${refRangeText(snapshot.refs)})` : "";
		throw new Error(`Unknown ref ${ref}${last} — run snapshot again to get current refs.`);
	}
	if (snapshot.generation !== ctx.currentGeneration) {
		throw staleRefError(ref);
	}
	const options = ctxOptions(ctx);
	let objectId: string | undefined;
	try {
		const resolved = await ctx.client.send<{ object?: RemoteObject }>(
			"DOM.resolveNode",
			{ backendNodeId: entry.backendNodeId },
			options,
		);
		objectId = resolved.object?.objectId;
	} catch {
		throw staleRefError(ref);
	}
	if (!objectId) {
		throw staleRefError(ref);
	}
	try {
		const connected = await ctx.client.send<EvaluateResponse>(
			"Runtime.callFunctionOn",
			{ objectId, functionDeclaration: "function() { return this.isConnected === true; }", returnByValue: true },
			options,
		);
		if (connected.exceptionDetails || connected.result?.value !== true) {
			throw staleRefError(ref);
		}
	} finally {
		await releaseObject(ctx.client, options, objectId);
	}
	return { backendNodeId: entry.backendNodeId, description: describeEntry(entry), fromRef: entry };
}

async function resolveSelectorTarget(ctx: TargetResolutionContext, selector: string): Promise<ResolvedDomTarget> {
	const options = ctxOptions(ctx);
	const evaluated = await ctx.client.send<EvaluateResponse>(
		"Runtime.evaluate",
		{ expression: `document.querySelector(${JSON.stringify(selector)})`, returnByValue: false },
		options,
	);
	if (evaluated.exceptionDetails) {
		throw new Error(`Invalid selector ${JSON.stringify(selector)}: ${exceptionText(evaluated.exceptionDetails)}`);
	}
	const objectId = evaluated.result?.objectId;
	if (!objectId || evaluated.result?.subtype === "null") {
		throw new Error(`No element matches selector ${JSON.stringify(selector)}`);
	}
	try {
		const described = await ctx.client.send<{ node?: { backendNodeId?: number; localName?: string; nodeName?: string } }>(
			"DOM.describeNode",
			{ objectId },
			options,
		);
		const backendNodeId = described.node?.backendNodeId;
		if (typeof backendNodeId !== "number") {
			throw new Error(`Selector ${JSON.stringify(selector)} did not resolve to a DOM node`);
		}
		const tag = described.node?.localName || described.node?.nodeName?.toLowerCase() || "node";
		return { backendNodeId, description: `${JSON.stringify(selector)} <${tag}>` };
	} finally {
		await releaseObject(ctx.client, options, objectId);
	}
}

/** Resolves `@eN` / `eN` snapshot refs (verifying they are still attached) or CSS selectors. */
export async function resolveDomTarget(ctx: TargetResolutionContext, target: string): Promise<ResolvedDomTarget> {
	const trimmed = target.trim();
	if (!trimmed) {
		throw new Error("Target is empty — pass an @eN ref from the latest snapshot or a CSS selector.");
	}
	const ref = normalizeRef(trimmed);
	if (ref) {
		return resolveRefTarget(ctx, ref);
	}
	return resolveSelectorTarget(ctx, trimmed);
}

async function elementCenter(ctx: TargetResolutionContext, backendNodeId: number): Promise<{ x: number; y: number } | null> {
	const options = ctxOptions(ctx);
	try {
		await ctx.client.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }, options);
	} catch {
		// Non-element nodes cannot scroll; quads below decide whether the node is hittable.
	}
	let quads: number[][] = [];
	try {
		const response = await ctx.client.send<{ quads?: number[][] }>("DOM.getContentQuads", { backendNodeId }, options);
		quads = response.quads ?? [];
	} catch {
		return null;
	}
	for (const quad of quads) {
		const box = quadBox(quad);
		if (box && box.width > 0 && box.height > 0) {
			return { x: box.centerX, y: box.centerY };
		}
	}
	return null;
}

const BUTTON_MASKS: Record<NonNullable<ClickOptions["button"]>, number> = { left: 1, right: 2, middle: 4 };

const DISABLED_CHECK = `function() {
	if (!(this instanceof this.ownerDocument.defaultView.Element)) { return false; }
	return this.matches(":disabled") || this.getAttribute("aria-disabled") === "true";
}`;

export async function clickTarget(
	ctx: TargetResolutionContext,
	target: string,
	options?: ClickOptions,
): Promise<{ clicked: string; x: number; y: number }> {
	const actionCtx = withCallOverrides(ctx, options);
	const resolved = await resolveDomTarget(actionCtx, target);
	const liveDisabled = await callOnNode<boolean>(actionCtx, resolved.backendNodeId, "Disabled check", DISABLED_CHECK);
	if (liveDisabled === true) {
		throw new Error(`Cannot click ${resolved.description}: element is disabled`);
	}

	const center = await elementCenter(actionCtx, resolved.backendNodeId);
	if (!center) {
		await callOnNode(actionCtx, resolved.backendNodeId, "JS click fallback", "function() { this.click(); }");
		return { clicked: `${resolved.description} (JS click fallback: element has no visible box)`, x: 0, y: 0 };
	}

	const sendOpts = ctxOptions(actionCtx);
	const button = options?.button ?? "left";
	const buttons = BUTTON_MASKS[button];
	const { x, y } = center;
	await ctx.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 }, sendOpts);
	const clickCounts = options?.doubleClick ? [1, 2] : [1];
	for (const clickCount of clickCounts) {
		await ctx.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount }, sendOpts);
		await ctx.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount }, sendOpts);
	}
	return { clicked: resolved.description, x, y };
}

export async function hoverTarget(ctx: TargetResolutionContext, target: string): Promise<{ hovered: string; x: number; y: number }> {
	const resolved = await resolveDomTarget(ctx, target);
	const center = await elementCenter(ctx, resolved.backendNodeId);
	if (!center) {
		throw new Error(`Cannot hover ${resolved.description}: element has no visible box`);
	}
	await ctx.client.send(
		"Input.dispatchMouseEvent",
		{ type: "mouseMoved", x: center.x, y: center.y, button: "none", buttons: 0 },
		ctxOptions(ctx),
	);
	return { hovered: resolved.description, x: center.x, y: center.y };
}

const FILL_FUNCTION = `function(value) {
	const el = this;
	const win = el.ownerDocument && el.ownerDocument.defaultView;
	if (!win || !(el instanceof win.Element)) { throw new Error("Target is not an element"); }
	if (el.isContentEditable) {
		el.focus();
		el.textContent = value;
		el.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
		el.dispatchEvent(new win.Event("change", { bubbles: true }));
		return el.textContent;
	}
	const tag = el.tagName;
	if (tag === "SELECT") { throw new Error("Element is a <select>; use select instead of fill"); }
	if (tag !== "INPUT" && tag !== "TEXTAREA") {
		throw new Error("Element <" + tag.toLowerCase() + "> is not fillable (expected input, textarea or contenteditable)");
	}
	if (tag === "INPUT") {
		const type = (el.getAttribute("type") || "text").toLowerCase();
		const blocked = ["checkbox", "radio", "file", "submit", "button", "image", "reset", "hidden"];
		if (blocked.includes(type)) { throw new Error("<input type=" + type + "> cannot be filled; use click instead"); }
	}
	if (el.disabled) { throw new Error("Element is disabled"); }
	if (el.readOnly) { throw new Error("Element is read-only"); }
	el.focus();
	const proto = tag === "INPUT" ? win.HTMLInputElement.prototype : win.HTMLTextAreaElement.prototype;
	const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
	if (descriptor && descriptor.set) { descriptor.set.call(el, value); } else { el.value = value; }
	el.dispatchEvent(new win.Event("input", { bubbles: true }));
	el.dispatchEvent(new win.Event("change", { bubbles: true }));
	return el.value;
}`;

/** Sets the value through the native prototype setter so React/Vue controlled inputs observe it. */
export async function fillTarget(
	ctx: TargetResolutionContext,
	target: string,
	value: string,
): Promise<{ filled: string; value: string }> {
	const resolved = await resolveDomTarget(ctx, target);
	const finalValue = await callOnNode<unknown>(ctx, resolved.backendNodeId, `Fill ${resolved.description}`, FILL_FUNCTION, [
		value,
	]);
	return { filled: resolved.description, value: typeof finalValue === "string" ? finalValue : value };
}

const SELECT_FUNCTION = `function(values) {
	if (this.tagName !== "SELECT") {
		throw new Error("Element <" + String(this.tagName).toLowerCase() + "> is not a <select>; click custom dropdown options instead");
	}
	if (this.disabled) { throw new Error("Element is disabled"); }
	const options = Array.from(this.options);
	const picked = [];
	for (const raw of values) {
		const wanted = String(raw);
		const trimmed = wanted.trim();
		const match = options.find((o) => o.value === wanted)
			|| options.find((o) => o.label === wanted)
			|| options.find((o) => (o.textContent || "").trim() === trimmed);
		if (!match) {
			const available = options.slice(0, 20).map((o) => JSON.stringify(o.value)).join(", ");
			throw new Error("No <option> matches " + JSON.stringify(wanted) + ". Available values: " + available);
		}
		if (match.disabled) { throw new Error("Option " + JSON.stringify(wanted) + " is disabled"); }
		if (!picked.includes(match)) { picked.push(match); }
	}
	if (!this.multiple && picked.length > 1) {
		throw new Error("Single-choice <select> accepts exactly one value (got " + picked.length + ")");
	}
	if (this.multiple) {
		for (const option of options) { option.selected = picked.includes(option); }
	} else {
		picked[0].selected = true;
	}
	const win = this.ownerDocument.defaultView;
	this.dispatchEvent(new win.Event("input", { bubbles: true }));
	this.dispatchEvent(new win.Event("change", { bubbles: true }));
	return picked.map((o) => o.value);
}`;

export async function selectTarget(
	ctx: TargetResolutionContext,
	target: string,
	values: string[],
): Promise<{ selected: string[]; target: string }> {
	if (values.length === 0) {
		throw new Error("select requires at least one value (option value, label, or visible text)");
	}
	const resolved = await resolveDomTarget(ctx, target);
	const selected = await callOnNode<unknown>(ctx, resolved.backendNodeId, `Select on ${resolved.description}`, SELECT_FUNCTION, [
		values,
	]);
	return {
		selected: Array.isArray(selected) ? selected.map((v) => String(v)) : [],
		target: resolved.description,
	};
}

export async function typeText(
	client: CdpClientInterface,
	sessionId: string,
	text: string,
	submit?: boolean,
	timeoutMs?: number,
	signal?: AbortSignal,
): Promise<void> {
	if (text.length > 0) {
		await client.send("Input.insertText", { text }, sendOptions(sessionId, timeoutMs, signal));
	}
	if (submit) {
		await pressKey(client, sessionId, "Enter", timeoutMs, signal);
	}
}

interface KeyDefinition {
	key: string;
	code: string;
	virtualKey: number;
	text?: string;
	location?: number;
}

const NAMED_KEYS: Record<string, KeyDefinition> = {
	Enter: { key: "Enter", code: "Enter", virtualKey: 13, text: "\r" },
	Tab: { key: "Tab", code: "Tab", virtualKey: 9 },
	Escape: { key: "Escape", code: "Escape", virtualKey: 27 },
	Backspace: { key: "Backspace", code: "Backspace", virtualKey: 8 },
	Delete: { key: "Delete", code: "Delete", virtualKey: 46 },
	Insert: { key: "Insert", code: "Insert", virtualKey: 45 },
	ArrowUp: { key: "ArrowUp", code: "ArrowUp", virtualKey: 38 },
	ArrowDown: { key: "ArrowDown", code: "ArrowDown", virtualKey: 40 },
	ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", virtualKey: 37 },
	ArrowRight: { key: "ArrowRight", code: "ArrowRight", virtualKey: 39 },
	Home: { key: "Home", code: "Home", virtualKey: 36 },
	End: { key: "End", code: "End", virtualKey: 35 },
	PageUp: { key: "PageUp", code: "PageUp", virtualKey: 33 },
	PageDown: { key: "PageDown", code: "PageDown", virtualKey: 34 },
	Space: { key: " ", code: "Space", virtualKey: 32, text: " " },
	Shift: { key: "Shift", code: "ShiftLeft", virtualKey: 16, location: 1 },
	Control: { key: "Control", code: "ControlLeft", virtualKey: 17, location: 1 },
	Alt: { key: "Alt", code: "AltLeft", virtualKey: 18, location: 1 },
	Meta: { key: "Meta", code: "MetaLeft", virtualKey: 91, location: 1 },
};

const KEY_ALIASES: Record<string, string> = {
	ctrl: "Control",
	control: "Control",
	cmd: "Meta",
	command: "Meta",
	meta: "Meta",
	super: "Meta",
	win: "Meta",
	alt: "Alt",
	option: "Alt",
	opt: "Alt",
	shift: "Shift",
	esc: "Escape",
	escape: "Escape",
	return: "Enter",
	enter: "Enter",
	del: "Delete",
	delete: "Delete",
	backspace: "Backspace",
	tab: "Tab",
	space: "Space",
	up: "ArrowUp",
	down: "ArrowDown",
	left: "ArrowLeft",
	right: "ArrowRight",
	arrowup: "ArrowUp",
	arrowdown: "ArrowDown",
	arrowleft: "ArrowLeft",
	arrowright: "ArrowRight",
	home: "Home",
	end: "End",
	pageup: "PageUp",
	pagedown: "PageDown",
	insert: "Insert",
};

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

/** macOS editing shortcuts are not derived from synthetic key events, so pass the editor command explicitly. */
const MAC_META_COMMANDS: Record<string, string> = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo" };

function resolveKeyName(raw: string): string {
	if (raw.toLowerCase() === "controlormeta") {
		return process.platform === "darwin" ? "Meta" : "Control";
	}
	return KEY_ALIASES[raw.toLowerCase()] ?? raw;
}

function keyDefinition(name: string, shift: boolean): KeyDefinition {
	const named = NAMED_KEYS[name];
	if (named) {
		return named;
	}
	const fnMatch = /^F(\d{1,2})$/.exec(name);
	if (fnMatch) {
		const n = Number(fnMatch[1]);
		if (n >= 1 && n <= 24) {
			return { key: name, code: name, virtualKey: 111 + n };
		}
	}
	if ([...name].length === 1) {
		const lower = name.toLowerCase();
		const isLetter = lower >= "a" && lower <= "z";
		const isDigit = name >= "0" && name <= "9";
		const char = isLetter && shift ? name.toUpperCase() : name;
		if (isLetter) {
			return { key: char, code: `Key${lower.toUpperCase()}`, virtualKey: lower.toUpperCase().charCodeAt(0), text: char };
		}
		if (isDigit) {
			return { key: name, code: `Digit${name}`, virtualKey: name.charCodeAt(0), text: name };
		}
		return { key: name, code: "", virtualKey: 0, text: name };
	}
	throw new Error(`Unknown key ${JSON.stringify(name)}. Use names like Enter, Tab, Escape, ArrowDown, F5, a, or combos like Control+A.`);
}

function parseKeyCombo(combo: string): { modifiers: string[]; main: string } {
	const trimmed = combo.trim();
	if (!trimmed) {
		throw new Error("Key is empty");
	}
	if (trimmed === "+") {
		return { modifiers: [], main: "+" };
	}
	const parts = trimmed.endsWith("++") ? [...trimmed.slice(0, -2).split("+"), "+"] : trimmed.split("+");
	const names = parts.map((part) => resolveKeyName(part.trim())).filter((part) => part.length > 0);
	const main = names.pop();
	if (!main) {
		throw new Error(`Invalid key combo ${JSON.stringify(combo)}`);
	}
	for (const modifier of names) {
		if (MODIFIER_BITS[modifier] === undefined) {
			throw new Error(`${JSON.stringify(modifier)} is not a modifier (use Control, Shift, Alt, Meta)`);
		}
	}
	return { modifiers: names, main };
}

/** Presses a key or combo such as `Enter`, `Shift+Tab`, `Control+A`, `Meta+Enter`. */
export async function pressKey(
	client: CdpClientInterface,
	sessionId: string,
	key: string,
	timeoutMs?: number,
	signal?: AbortSignal,
): Promise<void> {
	const options = sendOptions(sessionId, timeoutMs, signal);
	const { modifiers, main } = parseKeyCombo(key);
	let modifierMask = 0;
	for (const modifier of modifiers) {
		modifierMask |= MODIFIER_BITS[modifier] ?? 0;
		const def = NAMED_KEYS[modifier];
		await client.send(
			"Input.dispatchKeyEvent",
			{
				type: "rawKeyDown",
				key: def.key,
				code: def.code,
				windowsVirtualKeyCode: def.virtualKey,
				modifiers: modifierMask,
				location: def.location ?? 0,
			},
			options,
		);
	}

	const shift = (modifierMask & MODIFIER_BITS.Shift) !== 0;
	const def = keyDefinition(main, shift);
	const commandModifier = (modifierMask & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta)) !== 0;
	const text = commandModifier ? undefined : def.text;
	const macCommand =
		process.platform === "darwin" && (modifierMask & MODIFIER_BITS.Meta) !== 0 ? MAC_META_COMMANDS[main.toLowerCase()] : undefined;
	await client.send(
		"Input.dispatchKeyEvent",
		{
			type: text ? "keyDown" : "rawKeyDown",
			key: def.key,
			code: def.code,
			windowsVirtualKeyCode: def.virtualKey,
			modifiers: modifierMask,
			...(text ? { text, unmodifiedText: text } : {}),
			...(macCommand ? { commands: [macCommand] } : {}),
		},
		options,
	);
	await client.send(
		"Input.dispatchKeyEvent",
		{ type: "keyUp", key: def.key, code: def.code, windowsVirtualKeyCode: def.virtualKey, modifiers: modifierMask },
		options,
	);

	for (const modifier of modifiers.toReversed()) {
		modifierMask &= ~(MODIFIER_BITS[modifier] ?? 0);
		const modDef = NAMED_KEYS[modifier];
		await client.send(
			"Input.dispatchKeyEvent",
			{
				type: "keyUp",
				key: modDef.key,
				code: modDef.code,
				windowsVirtualKeyCode: modDef.virtualKey,
				modifiers: modifierMask,
				location: modDef.location ?? 0,
			},
			options,
		);
	}
}

type ScrollDirection = "up" | "down" | "left" | "right" | "top" | "bottom";

const SCROLL_FUNCTION = `function(direction, amount) {
	const isWindow = this === undefined || this === null || this === globalThis;
	const el = isWindow ? (document.scrollingElement || document.documentElement) : this;
	const win = isWindow ? window : el.ownerDocument.defaultView;
	const viewW = isWindow ? win.innerWidth : el.clientWidth;
	const viewH = isWindow ? win.innerHeight : el.clientHeight;
	const dx = amount === null ? Math.round(viewW * 0.8) : amount;
	const dy = amount === null ? Math.round(viewH * 0.8) : amount;
	if (direction === null) {
		el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
		return { scrollX: win.scrollX, scrollY: win.scrollY };
	}
	switch (direction) {
		case "up": el.scrollBy({ top: -dy, behavior: "instant" }); break;
		case "down": el.scrollBy({ top: dy, behavior: "instant" }); break;
		case "left": el.scrollBy({ left: -dx, behavior: "instant" }); break;
		case "right": el.scrollBy({ left: dx, behavior: "instant" }); break;
		case "top": el.scrollTo({ top: 0, behavior: "instant" }); break;
		case "bottom": el.scrollTo({ top: el.scrollHeight, behavior: "instant" }); break;
		default: throw new Error("Unknown scroll direction " + direction);
	}
	return isWindow ? { scrollX: win.scrollX, scrollY: win.scrollY } : { scrollX: el.scrollLeft, scrollY: el.scrollTop };
}`;

/**
 * Scrolls the page (default: down by 80% of the viewport). With `target` and no direction the
 * element is scrolled into view; with `target` and a direction the element itself is scrolled.
 */
export async function scrollViewport(
	ctx: TargetResolutionContext,
	opts: { direction?: ScrollDirection; amountPx?: number; target?: string },
): Promise<{ scrollX: number; scrollY: number }> {
	const amount = opts.amountPx === undefined ? null : Math.abs(opts.amountPx);
	let result: unknown;
	if (opts.target) {
		const resolved = await resolveDomTarget(ctx, opts.target);
		result = await callOnNode<unknown>(ctx, resolved.backendNodeId, `Scroll ${resolved.description}`, SCROLL_FUNCTION, [
			opts.direction ?? null,
			amount,
		]);
	} else {
		const response = await ctx.client.send<EvaluateResponse>(
			"Runtime.evaluate",
			{
				expression: `(${SCROLL_FUNCTION}).call(window, ${JSON.stringify(opts.direction ?? "down")}, ${JSON.stringify(amount)})`,
				returnByValue: true,
			},
			ctxOptions(ctx),
		);
		if (response.exceptionDetails) {
			throw new Error(`Scroll failed: ${exceptionText(response.exceptionDetails)}`);
		}
		result = response.result?.value;
	}
	const position = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
	return {
		scrollX: typeof position.scrollX === "number" ? position.scrollX : 0,
		scrollY: typeof position.scrollY === "number" ? position.scrollY : 0,
	};
}

function buildWaitExpression(options: WaitConditionOptions): string {
	const selector = options.selector === undefined ? "null" : JSON.stringify(options.selector);
	const text = options.text === undefined ? "null" : JSON.stringify(options.text);
	const urlIncludes = options.urlIncludes === undefined ? "null" : JSON.stringify(options.urlIncludes);
	return `(() => {
	const selector = ${selector};
	const text = ${text};
	const urlIncludes = ${urlIncludes};
	let selectorOk = true;
	if (selector !== null) {
		const el = document.querySelector(selector);
		selectorOk = !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
	}
	const textOk = text === null || (!!document.body && document.body.innerText.includes(text));
	const urlOk = urlIncludes === null || location.href.includes(urlIncludes);
	return { selectorOk, textOk, urlOk };
})()`;
}

function describeWait(options: WaitConditionOptions): string {
	const parts: string[] = [];
	if (options.selector !== undefined) {
		parts.push(`selector ${JSON.stringify(options.selector)} visible`);
	}
	if (options.text !== undefined) {
		parts.push(`text ${JSON.stringify(options.text)}`);
	}
	if (options.urlIncludes !== undefined) {
		parts.push(`URL includes ${JSON.stringify(options.urlIncludes)}`);
	}
	if (options.networkIdleMs !== undefined) {
		parts.push(`network idle for ${options.networkIdleMs}ms`);
	}
	return parts.join(" and ");
}

function trackNetwork(client: CdpClientInterface, sessionId: string): { idleSince: () => number | null; dispose: () => void } {
	const inflight = new Set<string>();
	let lastActivity = Date.now();
	const dispose = client.onEvent((event) => {
		if (event.sessionId !== sessionId) {
			return;
		}
		const requestId = typeof event.params.requestId === "string" ? event.params.requestId : null;
		if (!requestId) {
			return;
		}
		switch (event.method) {
			case "Network.requestWillBeSent":
				inflight.add(requestId);
				lastActivity = Date.now();
				break;
			case "Network.loadingFinished":
			case "Network.loadingFailed":
				inflight.delete(requestId);
				lastActivity = Date.now();
				break;
			default:
				break;
		}
	});
	return { idleSince: () => (inflight.size === 0 ? lastActivity : null), dispose };
}

interface PagePollResult {
	ok: boolean;
	error?: string;
}

/** One evaluation of the page-side wait expression; navigation-related failures are reported, not thrown. */
async function pollPageCondition(
	client: CdpClientInterface,
	sessionId: string,
	expression: string,
	deadline: number,
	signal?: AbortSignal,
): Promise<PagePollResult> {
	try {
		const response = await client.send<EvaluateResponse>(
			"Runtime.evaluate",
			{ expression, returnByValue: true },
			sendOptions(sessionId, Math.max(500, Math.min(5_000, deadline - Date.now())), signal),
		);
		if (response.exceptionDetails) {
			return { ok: false, error: exceptionText(response.exceptionDetails) };
		}
		const value = response.result?.value as { selectorOk?: boolean; textOk?: boolean; urlOk?: boolean } | undefined;
		return { ok: value?.selectorOk === true && value.textOk === true && value.urlOk === true };
	} catch (error) {
		if (signal?.aborted) {
			throw error;
		}
		// Navigations destroy the execution context mid-poll; keep waiting.
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function hasPageCondition(options: WaitConditionOptions): boolean {
	return options.selector !== undefined || options.text !== undefined || options.urlIncludes !== undefined;
}

interface WaitLoopState {
	options: WaitConditionOptions;
	started: number;
	timeoutMs: number;
	network: ReturnType<typeof trackNetwork> | null;
}

async function pollUntilSatisfied(
	client: CdpClientInterface,
	sessionId: string,
	state: WaitLoopState,
): Promise<{ matched: string; elapsedMs: number }> {
	const { options, started, timeoutMs, network } = state;
	const checkPage = hasPageCondition(options);
	const expression = buildWaitExpression(options);
	const deadline = started + timeoutMs;
	const idleThreshold = options.networkIdleMs ?? 0;
	let lastError = "";
	for (;;) {
		let pageOk = true;
		if (checkPage) {
			const poll = await pollPageCondition(client, sessionId, expression, deadline, options.signal);
			pageOk = poll.ok;
			lastError = poll.error ?? lastError;
		}
		const idleSince = network?.idleSince() ?? null;
		const networkOk = network === null || (idleSince !== null && Date.now() - idleSince >= idleThreshold);
		if (pageOk && networkOk) {
			return { matched: describeWait(options), elapsedMs: Date.now() - started };
		}
		if (Date.now() >= deadline) {
			const suffix = lastError ? ` (last error: ${lastError})` : "";
			throw new Error(`Timed out after ${timeoutMs}ms waiting for ${describeWait(options)}${suffix}`);
		}
		await sleep(Math.min(WAIT_POLL_MS, Math.max(1, deadline - Date.now())), options.signal);
	}
}

/** Polls until every requested condition holds (selector visible, text, URL, network idle). */
export async function waitForCondition(
	client: CdpClientInterface,
	sessionId: string,
	options: WaitConditionOptions,
): Promise<{ matched: string; elapsedMs: number }> {
	const started = Date.now();
	const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
	const signal = options.signal;
	if (!hasPageCondition(options) && options.networkIdleMs === undefined) {
		if (options.delayMs === undefined) {
			throw new Error("wait requires selector, text, urlIncludes, networkIdleMs, or delayMs");
		}
		await sleep(options.delayMs, signal);
		return { matched: `delay ${options.delayMs}ms`, elapsedMs: Date.now() - started };
	}
	if (options.delayMs !== undefined) {
		await sleep(options.delayMs, signal);
	}

	const network = options.networkIdleMs === undefined ? null : trackNetwork(client, sessionId);
	try {
		if (network) {
			await sendQuietly(client, "Network.enable", {}, sendOptions(sessionId, Math.min(timeoutMs, 5_000), signal));
		}
		return await pollUntilSatisfied(client, sessionId, { options, started, timeoutMs, network });
	} finally {
		network?.dispose();
	}
}

function formatPrimitive(obj: RemoteObject): string | null {
	if (obj.type === "undefined") {
		return "undefined";
	}
	if (obj.subtype === "null") {
		return "null";
	}
	if (obj.unserializableValue) {
		return obj.unserializableValue;
	}
	if (obj.type === "string") {
		return String(obj.value);
	}
	if (obj.type === "number" || obj.type === "boolean" || obj.type === "bigint") {
		return obj.value === undefined ? (obj.description ?? obj.type) : String(obj.value);
	}
	if (obj.type === "symbol" || obj.type === "function") {
		return obj.description ?? obj.type;
	}
	return null;
}

function clipText(text: string): string {
	return text.length > MAX_EVAL_TEXT ? `${text.slice(0, MAX_EVAL_TEXT)}… (truncated ${text.length - MAX_EVAL_TEXT} chars)` : text;
}

/** Evaluates JavaScript in the page (top-level await allowed) and renders the result as text. */
export async function evaluateExpression(
	client: CdpClientInterface,
	sessionId: string,
	expression: string,
	timeoutMs?: number,
	signal?: AbortSignal,
): Promise<{ valueText: string; isError: boolean }> {
	const options = sendOptions(sessionId, timeoutMs, signal);
	try {
		const response = await client.send<EvaluateResponse>(
			"Runtime.evaluate",
			{
				expression,
				objectGroup: EVAL_OBJECT_GROUP,
				returnByValue: false,
				awaitPromise: true,
				userGesture: true,
				replMode: true,
				generatePreview: false,
			},
			options,
		);
		if (response.exceptionDetails) {
			const details = response.exceptionDetails;
			return { valueText: clipText(details.exception?.description ?? exceptionText(details)), isError: true };
		}
		const result = response.result ?? { type: "undefined" };
		const primitive = formatPrimitive(result);
		if (primitive !== null) {
			return { valueText: clipText(primitive), isError: false };
		}
		if (!result.objectId || result.subtype === "node" || result.subtype === "error" || result.subtype === "regexp") {
			return { valueText: clipText(result.description ?? result.className ?? "object"), isError: false };
		}
		const serialized = await client.send<EvaluateResponse>(
			"Runtime.callFunctionOn",
			{
				objectId: result.objectId,
				functionDeclaration:
					"function() { try { const s = JSON.stringify(this, null, 2); return s === undefined ? null : s; } catch (e) { return null; } }",
				returnByValue: true,
			},
			options,
		);
		const json = serialized.result?.value;
		const text = typeof json === "string" ? json : (result.description ?? result.className ?? "object");
		return { valueText: clipText(text), isError: false };
	} finally {
		await sendQuietly(client, "Runtime.releaseObjectGroup", { objectGroup: EVAL_OBJECT_GROUP }, options);
	}
}

interface ImageDimensions {
	width: number;
	height: number;
}

function pngDimensions(buffer: Buffer): ImageDimensions | null {
	if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.toString("ascii", 12, 16) === "IHDR") {
		return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
	}
	return null;
}

function isJpegStartOfFrame(marker: number): boolean {
	return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function isStandaloneJpegMarker(marker: number): boolean {
	return marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

/** Offset of the next JPEG marker after the segment starting at `offset` (fill bytes advance by one). */
function nextJpegSegment(buffer: Buffer, offset: number): number {
	if (buffer[offset] !== 0xff) {
		return offset + 1;
	}
	if (isStandaloneJpegMarker(buffer[offset + 1])) {
		return offset + 2;
	}
	return offset + 2 + buffer.readUInt16BE(offset + 2);
}

function jpegDimensions(buffer: Buffer): ImageDimensions | null {
	if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
		return null;
	}
	for (let offset = 2; offset + 9 < buffer.length; offset = nextJpegSegment(buffer, offset)) {
		if (buffer[offset] === 0xff && isJpegStartOfFrame(buffer[offset + 1])) {
			return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
		}
	}
	return null;
}

function webpDimensions(buffer: Buffer): ImageDimensions | null {
	if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
		return null;
	}
	switch (buffer.toString("ascii", 12, 16)) {
		case "VP8 ":
			return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
		case "VP8L": {
			const bits = buffer.readUInt32LE(21);
			return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
		}
		case "VP8X":
			return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
		default:
			return null;
	}
}

/** Reads pixel dimensions from PNG (IHDR), JPEG (SOFn), or WebP (VP8/VP8L/VP8X) headers. */
export function parseImageDimensions(buffer: Buffer): ImageDimensions | null {
	return pngDimensions(buffer) ?? jpegDimensions(buffer) ?? webpDimensions(buffer);
}

interface LayoutMetrics {
	cssContentSize?: { width: number; height: number };
	contentSize?: { width: number; height: number };
	cssLayoutViewport?: { clientWidth: number; clientHeight: number; pageX?: number; pageY?: number };
	cssVisualViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number; scale?: number };
}

const MIME_TYPES: Record<NonNullable<ScreenshotOptions["format"]>, ScreenshotResult["mimeType"]> = {
	png: "image/png",
	jpeg: "image/jpeg",
	webp: "image/webp",
};

interface ScreenshotClip {
	x: number;
	y: number;
	width: number;
	height: number;
	scale: number;
}

async function elementClip(ctx: TargetResolutionContext, target: string, metrics: LayoutMetrics): Promise<ScreenshotClip> {
	const resolved = await resolveDomTarget(ctx, target);
	const options = ctxOptions(ctx);
	try {
		await ctx.client.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: resolved.backendNodeId }, options);
	} catch {
		// Not scrollable; measure where it is.
	}
	const response = await ctx.client.send<{ quads?: number[][] }>(
		"DOM.getContentQuads",
		{ backendNodeId: resolved.backendNodeId },
		options,
	);
	const box = (response.quads ?? []).map(quadBox).find((candidate) => candidate !== null);
	if (!box) {
		throw new Error(`Cannot screenshot ${resolved.description}: element has no visible box`);
	}
	if (box.width <= 0 || box.height <= 0) {
		throw new Error(`Cannot screenshot ${resolved.description}: element has an empty box`);
	}
	// Quads are viewport-relative; clips are document-relative. Re-read metrics because scrolling moved the page.
	let latest = metrics;
	try {
		latest = await ctx.client.send<LayoutMetrics>("Page.getLayoutMetrics", {}, options);
	} catch {
		// Keep the pre-scroll metrics.
	}
	const pageX = latest.cssVisualViewport?.pageX ?? 0;
	const pageY = latest.cssVisualViewport?.pageY ?? 0;
	return { x: box.left + pageX, y: box.top + pageY, width: box.width, height: box.height, scale: 1 };
}

function fullPageClip(metrics: LayoutMetrics): ScreenshotClip | undefined {
	const size = metrics.cssContentSize ?? metrics.contentSize;
	if (!size) {
		return undefined;
	}
	return { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
}

function screenshotParams(
	format: NonNullable<ScreenshotOptions["format"]>,
	fullPage: boolean,
	clip: ScreenshotClip | undefined,
	quality: number | undefined,
): Record<string, unknown> {
	const params: Record<string, unknown> = { format, fromSurface: true, captureBeyondViewport: fullPage };
	if (clip) {
		params.clip = clip;
	}
	if (format !== "png" && quality !== undefined) {
		params.quality = Math.max(0, Math.min(100, Math.round(quality)));
	}
	return params;
}

function saveScreenshot(buffer: Buffer, savePath: string, cwd?: string): string {
	const resolved = resolveToolPath(savePath, cwd);
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	fs.writeFileSync(resolved, buffer);
	return resolved;
}

export async function capturePageScreenshot(
	ctx: TargetResolutionContext,
	options?: ScreenshotOptions,
	cwd?: string,
): Promise<ScreenshotResult> {
	const shotCtx = withCallOverrides(ctx, options);
	const sendOpts = ctxOptions(shotCtx);
	const format = options?.format ?? "png";
	const target = options?.target;
	const fullPage = options?.fullPage === true && !target;
	const metrics = await ctx.client.send<LayoutMetrics>("Page.getLayoutMetrics", {}, sendOpts);

	let clip: ScreenshotClip | undefined;
	if (target) {
		clip = await elementClip(shotCtx, target, metrics);
	} else if (fullPage) {
		clip = fullPageClip(metrics);
	}

	const params = screenshotParams(format, fullPage, clip, options?.quality);
	const shot = await ctx.client.send<{ data?: string }>("Page.captureScreenshot", params, sendOpts);
	if (!shot.data) {
		throw new Error("Page.captureScreenshot returned no image data");
	}
	const buffer = Buffer.from(shot.data, "base64");
	const parsed = parseImageDimensions(buffer);
	const width = parsed?.width ?? Math.round(clip?.width ?? metrics.cssLayoutViewport?.clientWidth ?? 0);
	const height = parsed?.height ?? Math.round(clip?.height ?? metrics.cssLayoutViewport?.clientHeight ?? 0);

	const result: ScreenshotResult = { base64: shot.data, mimeType: MIME_TYPES[format], width, height, fullPage };
	if (options?.savePath) {
		result.savedPath = saveScreenshot(buffer, options.savePath, cwd);
	}
	return result;
}
