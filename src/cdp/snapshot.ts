/**
 * Accessibility-tree snapshots with stable-for-one-generation `@eN` element refs.
 *
 * Chrome AX tree rules handled here (verified against Chrome 157):
 * - `nodeId`, `parentId`, `childIds` are strings; `backendDOMNodeId` is a positive number.
 * - `InlineTextBox` nodes carry negative ids and no `backendDOMNodeId`; they are skipped.
 * - `ignored: true` nodes still list `childIds`, so the walk flattens through them (and through
 *   unnamed `generic` / `none` wrappers) to keep the meaningful descendants.
 */

import type {
	AriaSnapshot,
	AriaSnapshotOptions,
	CdpClientInterface,
	CdpSendOptions,
	SnapshotDiff,
	SnapshotRefEntry,
	SnapshotRefRegistry,
} from "../types.ts";

interface AXValue {
	type?: string;
	value?: unknown;
}

interface AXProperty {
	name: string;
	value?: AXValue;
}

export interface AXNode {
	nodeId: string;
	ignored?: boolean;
	role?: AXValue;
	name?: AXValue;
	description?: AXValue;
	value?: AXValue;
	properties?: AXProperty[];
	parentId?: string;
	childIds?: string[];
	backendDOMNodeId?: number;
	frameId?: string;
}

interface FrameTreeNode {
	frame: { id: string; url?: string; parentId?: string };
	childFrames?: FrameTreeNode[];
}

const DEFAULT_MAX_ELEMENTS = 150;
const DEFAULT_MAX_CHARS = 12_000;
const MAX_NAME_CHARS = 120;
const MAX_TEXT_CHARS = 200;

const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
	"button",
	"link",
	"textbox",
	"searchbox",
	"combobox",
	"listbox",
	"option",
	"checkbox",
	"radio",
	"switch",
	"tab",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"slider",
	"spinbutton",
	"treeitem",
	"summary",
]);

/** Roles kept as structural context lines even when they carry no accessible name. */
const STRUCTURAL_ROLES: ReadonlySet<string> = new Set([
	"main",
	"navigation",
	"banner",
	"contentinfo",
	"complementary",
	"form",
	"search",
	"region",
	"dialog",
	"alertdialog",
	"alert",
	"list",
	"table",
	"grid",
	"treegrid",
	"tablist",
	"tabpanel",
	"menu",
	"menubar",
	"tree",
	"radiogroup",
	"toolbar",
	"heading",
	"article",
	"Iframe",
	"img",
	"image",
]);

/** Roles that never produce a line; their children are rendered at the same depth. */
const TRANSPARENT_ROLES: ReadonlySet<string> = new Set(["none", "generic", "presentation", "LineBreak"]);

/** Roles whose accessible name is usually computed from their text content. */
const NAME_FROM_CONTENT_ROLES: ReadonlySet<string> = new Set([
	...INTERACTIVE_ROLES,
	"heading",
	"cell",
	"gridcell",
	"columnheader",
	"rowheader",
	"tooltip",
	"legend",
	"caption",
	"figcaption",
]);

function normalizeText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function axString(value: AXValue | undefined): string {
	if (!value || value.value === undefined || value.value === null) {
		return "";
	}
	return typeof value.value === "string" ? value.value : String(value.value);
}

function propertyMap(node: AXNode): Map<string, unknown> {
	const map = new Map<string, unknown>();
	for (const prop of node.properties ?? []) {
		map.set(prop.name, prop.value?.value);
	}
	return map;
}

function isEditableValue(value: unknown): boolean {
	return value === "plaintext" || value === "richtext";
}

function asTristate(value: unknown): "true" | "false" | "mixed" | undefined {
	if (value === true || value === "true") {
		return "true";
	}
	if (value === false || value === "false") {
		return "false";
	}
	if (value === "mixed") {
		return "mixed";
	}
	return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	if (value === true || value === "true") {
		return true;
	}
	if (value === false || value === "false") {
		return false;
	}
	return undefined;
}

interface WalkFrame {
	key: string;
	frameId?: string;
	nodes: Map<string, AXNode>;
	rootIds: string[];
}

function buildFrame(nodes: AXNode[], key: string, frameId: string | undefined): WalkFrame {
	const map = new Map<string, AXNode>();
	for (const node of nodes) {
		map.set(String(node.nodeId), node);
	}
	const rootIds: string[] = [];
	for (const node of nodes) {
		const parentId = node.parentId === undefined ? undefined : String(node.parentId);
		if (parentId === undefined || !map.has(parentId)) {
			rootIds.push(String(node.nodeId));
		}
	}
	return { key, frameId, nodes: map, rootIds };
}

interface RenderState {
	lines: string[];
	chars: number;
	refs: SnapshotRefEntry[];
	totalInteractive: number;
	truncated: boolean;
	stopped: boolean;
	maxElements: number;
	maxChars: number;
	includeStaticText: boolean;
	seenBackendIds: Set<number>;
	visited: Set<string>;
	/** Child frame trees keyed by the backendNodeId of their owning <iframe>. */
	childFramesByOwner: Map<number, WalkFrame>;
	renderedFrames: Set<string>;
	/** Allocator for `@eN` refs (shared with earlier snapshots of the same generation when provided). */
	registry: SnapshotRefRegistry;
	/** Refs already emitted by this snapshot, guarding against handing one ref to two elements. */
	usedRefs: Set<string>;
}

interface WalkContext {
	depth: number;
	/** Normalized name of the nearest rendered ancestor whose name comes from its content. */
	contentName: string;
	insideEditable: boolean;
}

function emit(state: RenderState, depth: number, text: string): boolean {
	if (state.stopped) {
		state.truncated = true;
		return false;
	}
	const line = `${"  ".repeat(depth)}${text}`;
	if (state.chars + line.length + 1 > state.maxChars) {
		state.truncated = true;
		state.stopped = true;
		return false;
	}
	state.lines.push(line);
	state.chars += line.length + 1;
	return true;
}

function tristateAttr(props: Map<string, unknown>, key: string): string[] {
	const value = asTristate(props.get(key));
	if (value === "true") {
		return [`[${key}]`];
	}
	if (value === "mixed") {
		return [`[${key}=mixed]`];
	}
	return [];
}

function flagAttrs(props: Map<string, unknown>, keys: readonly string[]): string[] {
	return keys.filter((key) => asBoolean(props.get(key)) === true).map((key) => `[${key}]`);
}

function expandedAttr(expanded: boolean | undefined): string[] {
	if (expanded === undefined) {
		return [];
	}
	return [expanded ? "[expanded]" : "[collapsed]"];
}

/** State suffix such as ` [checked] [disabled]`; refs are built from the same AX properties, so props alone suffice. */
function describeAttributes(props: Map<string, unknown>, role: string): string {
	const expanded = asBoolean(props.get("expanded"));
	const level = props.get("level");
	const attrs = [
		...tristateAttr(props, "checked"),
		...tristateAttr(props, "pressed"),
		...flagAttrs(props, ["selected"]),
		...expandedAttr(expanded),
		...(role === "heading" && typeof level === "number" ? [`[level=${level}]`] : []),
		...flagAttrs(props, ["disabled", "required", "readonly", "focused"]),
	];
	return attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
}

function buildRefEntry(
	node: AXNode,
	frame: WalkFrame,
	role: string,
	name: string,
	props: Map<string, unknown>,
): Omit<SnapshotRefEntry, "ref"> {
	const value = normalizeText(axString(node.value));
	const description = normalizeText(axString(node.description));
	const url = props.get("url");
	const level = props.get("level");
	const checked = asTristate(props.get("checked"));
	const expanded = asBoolean(props.get("expanded"));
	return {
		backendNodeId: node.backendDOMNodeId ?? 0,
		...(frame.frameId ? { frameId: frame.frameId } : {}),
		role: role || "generic",
		name,
		...(value ? { value } : {}),
		...(description ? { description } : {}),
		...(checked ? { checked } : {}),
		...(asBoolean(props.get("selected")) === true ? { selected: true } : {}),
		...(asBoolean(props.get("disabled")) === true ? { disabled: true } : {}),
		...(expanded === undefined ? {} : { expanded }),
		...(asBoolean(props.get("required")) === true ? { required: true } : {}),
		...(asBoolean(props.get("focused")) === true ? { focused: true } : {}),
		...(typeof level === "number" ? { level } : {}),
		...(typeof url === "string" && url ? { url } : {}),
	};
}

/**
 * Emits an interactive line with its `@eN` ref; returns false when the budget is exhausted. Elements already known
 * to the registry keep their ref; others get the next unused number, committed only once the line is emitted.
 */
function renderInteractive(
	state: RenderState,
	depth: number,
	entry: Omit<SnapshotRefEntry, "ref">,
	props: Map<string, unknown>,
): boolean {
	if (state.stopped || state.refs.length >= state.maxElements) {
		state.truncated = true;
		state.stopped = true;
		return false;
	}
	const key = identityKey(entry);
	const known = state.registry.refsByElement.get(key);
	const reuse = known !== undefined && !state.usedRefs.has(known);
	const ref = reuse ? known : `@e${state.registry.lastIndex + 1}`;
	const role = entry.role;
	const displayRole = INTERACTIVE_ROLES.has(role) ? role : `${role} (editable)`;
	const value = entry.value ?? "";
	const valueText = value && value !== entry.name ? ` value=${JSON.stringify(clip(value, MAX_NAME_CHARS))}` : "";
	const nameText = entry.name ? ` ${JSON.stringify(clip(entry.name, MAX_NAME_CHARS))}` : "";
	const line = `- ${displayRole}${nameText} ${ref}${valueText}${describeAttributes(props, role)}`;
	if (!emit(state, depth, line)) {
		return false;
	}
	if (!reuse) {
		state.registry.lastIndex += 1;
		state.registry.refsByElement.set(key, ref);
	}
	state.usedRefs.add(ref);
	state.refs.push({ ref, ...entry });
	return true;
}

/** A non-ignored, non-text AX node with its decoded fields, ready for classification and rendering. */
interface ElementInfo {
	node: AXNode;
	role: string;
	name: string;
	props: Map<string, unknown>;
	backendId: number;
	editable: boolean;
}

function walkChildren(state: RenderState, frame: WalkFrame, node: AXNode, ctx: WalkContext): void {
	for (const childId of node.childIds ?? []) {
		walkNode(state, frame, String(childId), ctx);
	}
}

function renderStaticText(state: RenderState, name: string, ctx: WalkContext): void {
	const text = normalizeText(name);
	if (!state.includeStaticText || text.length === 0) {
		return;
	}
	// Labels already carried by the enclosing control's name/value would only add noise.
	if (ctx.contentName.length > 0 && ctx.contentName.includes(text)) {
		return;
	}
	emit(state, ctx.depth, `- text: ${clip(text, MAX_TEXT_CHARS)}`);
}

function isInteractiveElement(info: ElementInfo, ctx: WalkContext): boolean {
	if (info.backendId <= 0) {
		return false;
	}
	return INTERACTIVE_ROLES.has(info.role) || (info.editable && !ctx.insideEditable);
}

/** Text already conveyed by an element's own line, so child StaticText repeating it is suppressed. */
function ownContentText(info: ElementInfo, interactive: boolean): string {
	if (interactive) {
		return normalizeText(`${info.name} ${axString(info.node.value)}`);
	}
	return NAME_FROM_CONTENT_ROLES.has(info.role) ? info.name : "";
}

function walkChildFrame(state: RenderState, ownerBackendId: number, depth: number): void {
	const childFrame = state.childFramesByOwner.get(ownerBackendId);
	if (!childFrame || state.renderedFrames.has(childFrame.key)) {
		return;
	}
	state.renderedFrames.add(childFrame.key);
	for (const rootId of childFrame.rootIds) {
		walkNode(state, childFrame, rootId, { depth, contentName: "", insideEditable: false });
	}
}

/** Renders an interactive or structural element line, then descends into its children (and iframe content). */
function walkElement(state: RenderState, frame: WalkFrame, info: ElementInfo, ctx: WalkContext): void {
	const { node, role, name, props, backendId } = info;
	const interactive = isInteractiveElement(info, ctx);
	if (interactive && state.seenBackendIds.has(backendId)) {
		walkChildren(state, frame, node, ctx);
		return;
	}
	let rendered: boolean;
	if (interactive) {
		state.seenBackendIds.add(backendId);
		state.totalInteractive += 1;
		rendered = renderInteractive(state, ctx.depth, buildRefEntry(node, frame, role, name, props), props);
	} else {
		const nameText = name ? ` ${JSON.stringify(clip(name, MAX_NAME_CHARS))}` : "";
		rendered = emit(state, ctx.depth, `- ${role}${nameText}${describeAttributes(props, role)}`);
	}
	const ownText = ownContentText(info, interactive);
	const childCtx: WalkContext = {
		depth: rendered ? ctx.depth + 1 : ctx.depth,
		contentName: rendered && ownText ? ownText : ctx.contentName,
		insideEditable: ctx.insideEditable || info.editable,
	};
	walkChildren(state, frame, node, childCtx);
	if (role === "Iframe" && backendId > 0) {
		walkChildFrame(state, backendId, childCtx.depth);
	}
}

/** Wrapper nodes (ignored, generic/none without a name, document roots) are flattened so their children survive. */
function isPassThrough(info: ElementInfo, ctx: WalkContext): boolean {
	if (info.role === "RootWebArea" || info.role === "WebArea") {
		return true;
	}
	if (isInteractiveElement(info, ctx)) {
		return false;
	}
	if (TRANSPARENT_ROLES.has(info.role) && info.name.length === 0) {
		return true;
	}
	return !STRUCTURAL_ROLES.has(info.role) && info.name.length === 0;
}

function walkNode(state: RenderState, frame: WalkFrame, nodeId: string, ctx: WalkContext): void {
	const visitKey = `${frame.key}:${nodeId}`;
	const node = frame.nodes.get(nodeId);
	if (state.visited.has(visitKey) || !node) {
		return;
	}
	state.visited.add(visitKey);
	const role = axString(node.role);
	if (role === "InlineTextBox") {
		return;
	}
	if (node.ignored === true) {
		walkChildren(state, frame, node, ctx);
		return;
	}
	const name = normalizeText(axString(node.name));
	if (role === "StaticText") {
		renderStaticText(state, name, ctx);
		return;
	}
	const props = propertyMap(node);
	const info: ElementInfo = {
		node,
		role,
		name,
		props,
		backendId: typeof node.backendDOMNodeId === "number" ? node.backendDOMNodeId : 0,
		editable: isEditableValue(props.get("editable")),
	};
	if (isPassThrough(info, ctx)) {
		walkChildren(state, frame, node, ctx);
		return;
	}
	walkElement(state, frame, info, ctx);
}

function collectChildFrames(tree: FrameTreeNode | undefined, out: Array<{ id: string; url: string }>): void {
	for (const child of tree?.childFrames ?? []) {
		out.push({ id: child.frame.id, url: child.frame.url ?? "" });
		collectChildFrames(child, out);
	}
}

async function resolveRootBackendId(
	client: CdpClientInterface,
	send: CdpSendOptions,
	selector: string,
): Promise<number> {
	const evaluated = await client.send<{ result?: { objectId?: string; subtype?: string }; exceptionDetails?: unknown }>(
		"Runtime.evaluate",
		{ expression: `document.querySelector(${JSON.stringify(selector)})`, returnByValue: false },
		send,
	);
	if (evaluated.exceptionDetails) {
		throw new Error(`Invalid rootSelector ${JSON.stringify(selector)}`);
	}
	const objectId = evaluated.result?.objectId;
	if (!objectId) {
		throw new Error(`rootSelector ${JSON.stringify(selector)} matched no element`);
	}
	try {
		const described = await client.send<{ node?: { backendNodeId?: number } }>("DOM.describeNode", { objectId }, send);
		const backendNodeId = described.node?.backendNodeId;
		if (typeof backendNodeId !== "number") {
			throw new Error(`rootSelector ${JSON.stringify(selector)} did not resolve to a DOM node`);
		}
		return backendNodeId;
	} finally {
		await releaseObject(client, send, objectId);
	}
}

async function releaseObject(client: CdpClientInterface, send: CdpSendOptions, objectId: string): Promise<void> {
	try {
		// Deliberately drop the caller's AbortSignal: an aborted snapshot must still free its remote object.
		await client.send("Runtime.releaseObject", { objectId }, { sessionId: send.sessionId, timeoutMs: 2_000 });
	} catch {
		// Object may already be gone after navigation.
	}
}

async function fetchChildFrameTrees(
	client: CdpClientInterface,
	send: CdpSendOptions,
	mainBackendIds: Set<number>,
): Promise<Map<number, WalkFrame>> {
	const byOwner = new Map<number, WalkFrame>();
	let frameTree: { frameTree?: FrameTreeNode };
	try {
		frameTree = await client.send<{ frameTree?: FrameTreeNode }>("Page.getFrameTree", {}, send);
	} catch {
		return byOwner;
	}
	const frames: Array<{ id: string; url: string }> = [];
	collectChildFrames(frameTree.frameTree, frames);
	for (const frame of frames) {
		try {
			const owner = await client.send<{ backendNodeId?: number }>("DOM.getFrameOwner", { frameId: frame.id }, send);
			const ownerId = owner.backendNodeId;
			if (typeof ownerId !== "number") {
				continue;
			}
			const tree = await client.send<{ nodes?: AXNode[] }>("Accessibility.getFullAXTree", { frameId: frame.id }, send);
			const nodes = tree.nodes ?? [];
			// Skip frames whose content the main-frame tree already inlined.
			const alreadyInlined = nodes.some(
				(node) => typeof node.backendDOMNodeId === "number" && axString(node.role) !== "Iframe" && mainBackendIds.has(node.backendDOMNodeId),
			);
			if (nodes.length === 0 || alreadyInlined) {
				continue;
			}
			byOwner.set(ownerId, buildFrame(nodes, `frame:${frame.id}`, frame.id));
		} catch {
			// Cross-origin (out-of-process) or detached frames are not reachable from this session.
		}
	}
	return byOwner;
}

function snapshotSendOptions(sessionId: string, options?: AriaSnapshotOptions): CdpSendOptions {
	const send: CdpSendOptions = { sessionId };
	if (options?.timeoutMs !== undefined) {
		send.timeoutMs = options.timeoutMs;
	}
	if (options?.signal) {
		send.signal = options.signal;
	}
	return send;
}

async function readPageInfo(client: CdpClientInterface, send: CdpSendOptions): Promise<{ url: string; title: string }> {
	const page = await client.send<{ result?: { value?: { url?: unknown; title?: unknown } } }>(
		"Runtime.evaluate",
		{ expression: "({ url: location.href, title: document.title })", returnByValue: true },
		send,
	);
	const value = page.result?.value;
	return {
		url: typeof value?.url === "string" ? value.url : "",
		title: typeof value?.title === "string" ? value.title : "",
	};
}

function collectBackendIds(nodes: readonly AXNode[]): Set<number> {
	const ids = new Set<number>();
	for (const node of nodes) {
		if (typeof node.backendDOMNodeId === "number") {
			ids.add(node.backendDOMNodeId);
		}
	}
	return ids;
}

async function resolveStartIds(
	client: CdpClientInterface,
	send: CdpSendOptions,
	mainFrame: WalkFrame,
	rootSelector: string | undefined,
): Promise<string[]> {
	if (!rootSelector) {
		return mainFrame.rootIds;
	}
	const rootBackendId = await resolveRootBackendId(client, send, rootSelector);
	for (const node of mainFrame.nodes.values()) {
		if (node.backendDOMNodeId === rootBackendId) {
			return [String(node.nodeId)];
		}
	}
	throw new Error(`rootSelector ${JSON.stringify(rootSelector)} has no accessibility node`);
}

function createRenderState(
	options: AriaSnapshotOptions | undefined,
	childFramesByOwner: Map<number, WalkFrame>,
	registry: SnapshotRefRegistry,
): RenderState {
	return {
		lines: [],
		chars: 0,
		refs: [],
		totalInteractive: 0,
		truncated: false,
		stopped: false,
		maxElements: Math.max(0, options?.maxElements ?? DEFAULT_MAX_ELEMENTS),
		maxChars: Math.max(0, options?.maxChars ?? DEFAULT_MAX_CHARS),
		includeStaticText: options?.includeStaticText !== false,
		seenBackendIds: new Set<number>(),
		visited: new Set<string>(),
		childFramesByOwner,
		renderedFrames: new Set<string>(),
		registry,
		usedRefs: new Set<string>(),
	};
}

/** Frames whose owner <iframe> was never rendered are appended after the main tree. */
function appendUnrenderedFrames(state: RenderState, ctx: WalkContext): void {
	for (const childFrame of state.childFramesByOwner.values()) {
		if (state.renderedFrames.has(childFrame.key)) {
			continue;
		}
		state.renderedFrames.add(childFrame.key);
		for (const rootId of childFrame.rootIds) {
			walkNode(state, childFrame, rootId, ctx);
		}
	}
}

function finalizeLines(state: RenderState): string {
	if (state.lines.length === 0 && !state.truncated) {
		state.lines.push("(no accessible content)");
	}
	if (state.truncated) {
		state.lines.push(
			`… truncated: showing ${state.refs.length} of ${state.totalInteractive} interactive elements (raise maxElements/maxChars or narrow with rootSelector)`,
		);
	}
	return state.lines.join("\n");
}

export async function captureAriaSnapshot(
	client: CdpClientInterface,
	sessionId: string,
	generation: number,
	options?: AriaSnapshotOptions,
): Promise<AriaSnapshot> {
	const send = snapshotSendOptions(sessionId, options);
	const { url, title } = await readPageInfo(client, send);

	const mainTree = await client.send<{ nodes?: AXNode[] }>("Accessibility.getFullAXTree", {}, send);
	const mainNodes = mainTree.nodes ?? [];
	const mainFrame = buildFrame(mainNodes, "main", undefined);
	const childFramesByOwner =
		options?.includeIframes === false
			? new Map<number, WalkFrame>()
			: await fetchChildFrameTrees(client, send, collectBackendIds(mainNodes));
	const startIds = await resolveStartIds(client, send, mainFrame, options?.rootSelector);

	const state = createRenderState(options, childFramesByOwner, prepareRefRegistry(options?.refRegistry, generation));
	const rootCtx: WalkContext = { depth: 0, contentName: "", insideEditable: false };
	for (const rootId of startIds) {
		walkNode(state, mainFrame, rootId, rootCtx);
	}
	// Frames outside a rootSelector subtree are intentionally excluded; full snapshots append any orphaned frames.
	if (!options?.rootSelector) {
		appendUnrenderedFrames(state, rootCtx);
	}
	const treeText = finalizeLines(state);

	const refs = state.refs;
	return {
		url,
		title,
		capturedAt: Date.now(),
		generation,
		refs,
		refMap: new Map(refs.map((entry) => [entry.ref, entry])),
		treeText,
		truncated: state.truncated,
		totalInteractiveCount: state.totalInteractive,
	};
}

/** A shared registry is reset when the document generation moved on; without one each snapshot numbers from @e1. */
function prepareRefRegistry(registry: SnapshotRefRegistry | undefined, generation: number): SnapshotRefRegistry {
	if (!registry) {
		return { generation, refsByElement: new Map(), lastIndex: 0 };
	}
	if (registry.generation !== generation) {
		registry.generation = generation;
		registry.refsByElement.clear();
		registry.lastIndex = 0;
	}
	return registry;
}

function identityKey(entry: Pick<SnapshotRefEntry, "frameId" | "backendNodeId">): string {
	return `${entry.frameId ?? "main"}:${entry.backendNodeId}`;
}

const COMPARED_FIELDS = ["role", "name", "value", "checked", "selected", "disabled", "expanded", "required", "focused"] as const;

function describeRef(entry: SnapshotRefEntry): string {
	return `${entry.ref} ${entry.role}${entry.name ? ` ${JSON.stringify(clip(entry.name, 60))}` : ""}`;
}

const DIFF_LIST_CAP = 20;

function fieldDiffs(before: SnapshotRefEntry, after: SnapshotRefEntry): string[] {
	const diffs: string[] = [];
	for (const field of COMPARED_FIELDS) {
		const a = before[field];
		const b = after[field];
		if (a !== b) {
			diffs.push(`${field}: ${JSON.stringify(a ?? null)} → ${JSON.stringify(b ?? null)}`);
		}
	}
	return diffs;
}

/** A header plus up to DIFF_LIST_CAP item lines and an overflow note; empty when there are no items. */
function cappedSection(header: string, items: readonly string[]): string[] {
	if (items.length === 0) {
		return [];
	}
	const lines = [header, ...items.slice(0, DIFF_LIST_CAP)];
	if (items.length > DIFF_LIST_CAP) {
		lines.push(`  … and ${items.length - DIFF_LIST_CAP} more`);
	}
	return lines;
}

export function diffAriaSnapshots(previous: AriaSnapshot, current: AriaSnapshot): SnapshotDiff {
	const previousByKey = new Map(previous.refs.map((entry) => [identityKey(entry), entry]));
	const currentKeys = new Set<string>();
	const addedRefs: SnapshotRefEntry[] = [];
	const changedRefs: Array<{ before: SnapshotRefEntry; after: SnapshotRefEntry }> = [];
	const changeNotes: string[] = [];

	for (const entry of current.refs) {
		const key = identityKey(entry);
		currentKeys.add(key);
		const before = previousByKey.get(key);
		if (!before) {
			addedRefs.push(entry);
			continue;
		}
		const diffs = fieldDiffs(before, entry);
		if (diffs.length > 0) {
			changedRefs.push({ before, after: entry });
			changeNotes.push(`  ~ ${describeRef(entry)} (${diffs.join(", ")})`);
		}
	}
	const removedCount = [...previousByKey.keys()].filter((key) => !currentKeys.has(key)).length;

	const urlChanged = previous.url !== current.url;
	const titleChanged = previous.title !== current.title;
	const summary = [
		...(urlChanged ? [`URL changed: ${previous.url} → ${current.url}`] : []),
		...(titleChanged ? [`Title changed: ${JSON.stringify(previous.title)} → ${JSON.stringify(current.title)}`] : []),
		...cappedSection(
			`+${addedRefs.length} new element(s):`,
			addedRefs.map((entry) => `  + ${describeRef(entry)}`),
		),
		...cappedSection(`~${changedRefs.length} changed element(s):`, changeNotes),
		...(removedCount > 0 ? [`-${removedCount} element(s) removed`] : []),
	];
	if (summary.length === 0) {
		summary.push("No changes in interactive elements.");
	}

	return {
		previousUrl: previous.url,
		currentUrl: current.url,
		urlChanged,
		titleChanged,
		addedRefs,
		changedRefs,
		removedCount,
		summaryText: summary.join("\n"),
	};
}
