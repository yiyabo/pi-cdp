import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { describe, test } from "node:test";
import {
	capturePageScreenshot,
	clickTarget,
	evaluateExpression,
	fillTarget,
	normalizeRef,
	parseImageDimensions,
	pressKey,
	resolveDomTarget,
	selectTarget,
	typeText,
	waitForCondition,
} from "../src/cdp/actions.ts";
import { CdpMultiplexClient, CdpProtocolError, DEVTOOLS_LISTENING_RE, fetchJsonVersion } from "../src/cdp/client.ts";
import { type AXNode, captureAriaSnapshot, diffAriaSnapshots } from "../src/cdp/snapshot.ts";
import type {
	AriaSnapshot,
	CdpClientInterface,
	CdpEventMessage,
	CdpSendOptions,
	SnapshotRefEntry,
	TargetResolutionContext,
} from "../src/types.ts";

// ---------------------------------------------------------------------------
// Mock CDP client
// ---------------------------------------------------------------------------

interface RecordedCall {
	method: string;
	params: Record<string, unknown>;
	options?: CdpSendOptions;
}

type Handler = (method: string, params: Record<string, unknown>, options?: CdpSendOptions) => unknown;

class MockCdpClient implements CdpClientInterface {
	readonly wsUrl = "mock";
	readonly isOpen = true;
	readonly calls: RecordedCall[] = [];
	readonly listeners = new Set<(event: CdpEventMessage) => void>();
	handler: Handler;

	constructor(handler: Handler) {
		this.handler = handler;
	}

	async send<T = Record<string, unknown>>(
		method: string,
		params?: Record<string, unknown>,
		options?: CdpSendOptions,
	): Promise<T> {
		const p = params ?? {};
		this.calls.push({ method, params: p, ...(options ? { options } : {}) });
		const result = await this.handler(method, p, options);
		// SAFETY: tests return hand-built CDP payloads matching each command's declared T.
		return (result ?? {}) as T;
	}

	onEvent(listener: (event: CdpEventMessage) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	emit(event: CdpEventMessage): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	async close(): Promise<void> {}

	methods(): string[] {
		return this.calls.map((call) => call.method);
	}

	callsOf(method: string): RecordedCall[] {
		return this.calls.filter((call) => call.method === method);
	}
}

function ax(
	nodeId: string,
	role: string,
	opts: {
		name?: string;
		value?: string;
		ignored?: boolean;
		parentId?: string;
		childIds?: string[];
		backendDOMNodeId?: number;
		properties?: Record<string, unknown>;
	} = {},
): AXNode {
	return {
		nodeId,
		ignored: opts.ignored ?? false,
		role: { type: "role", value: role },
		...(opts.name === undefined ? {} : { name: { type: "computedString", value: opts.name } }),
		...(opts.value === undefined ? {} : { value: { type: "string", value: opts.value } }),
		...(opts.parentId === undefined ? {} : { parentId: opts.parentId }),
		childIds: opts.childIds ?? [],
		...(opts.backendDOMNodeId === undefined ? {} : { backendDOMNodeId: opts.backendDOMNodeId }),
		properties: Object.entries(opts.properties ?? {}).map(([name, value]) => ({
			name,
			value: { type: typeof value === "boolean" ? "boolean" : "token", value },
		})),
	};
}

/** A Chrome 157-shaped AX tree: string ids, ignored wrappers with children, InlineTextBox leaves. */
function sampleTree(): AXNode[] {
	return [
		ax("1", "RootWebArea", { name: "Demo", childIds: ["2", "20"], backendDOMNodeId: 1 }),
		ax("2", "none", { ignored: true, parentId: "1", childIds: ["3", "8"], backendDOMNodeId: 2 }),
		ax("3", "generic", { parentId: "2", childIds: ["4", "7"], backendDOMNodeId: 3 }),
		ax("4", "button", { name: "Save", parentId: "3", childIds: ["5"], backendDOMNodeId: 10 }),
		ax("5", "StaticText", { name: "Save", parentId: "4", childIds: ["-6"] }),
		ax("-6", "InlineTextBox", { name: "Save", parentId: "5" }),
		ax("7", "button", {
			name: "Delete",
			parentId: "3",
			backendDOMNodeId: 11,
			properties: { disabled: true },
		}),
		ax("8", "generic", { ignored: true, parentId: "2", childIds: ["9", "11", "12"], backendDOMNodeId: 4 }),
		ax("9", "checkbox", {
			name: "Agree",
			parentId: "8",
			backendDOMNodeId: 12,
			properties: { checked: "true", focusable: true },
		}),
		ax("11", "StaticText", { name: "Hello world", parentId: "8", childIds: [] }),
		ax("12", "generic", {
			parentId: "8",
			childIds: ["13"],
			backendDOMNodeId: 14,
			properties: { editable: "richtext", focusable: true },
		}),
		ax("13", "generic", { parentId: "12", childIds: [], backendDOMNodeId: 15, properties: { editable: "richtext" } }),
		ax("20", "navigation", { parentId: "1", childIds: ["21", "22"], backendDOMNodeId: 20 }),
		ax("21", "link", { name: "Docs", parentId: "20", backendDOMNodeId: 21, properties: { url: "https://x.test/docs" } }),
		ax("22", "link", { name: "No DOM", parentId: "20" }),
	];
}

function snapshotHandler(nodes: AXNode[], extra?: Handler): Handler {
	return (method, params, options) => {
		const custom = extra?.(method, params, options);
		if (custom !== undefined) {
			return custom;
		}
		switch (method) {
			case "Runtime.evaluate":
				return { result: { type: "object", value: { url: "https://x.test/", title: "Demo" } } };
			case "Accessibility.getFullAXTree":
				return { nodes };
			case "Page.getFrameTree":
				return { frameTree: { frame: { id: "main" }, childFrames: [] } };
			default:
				return {};
		}
	};
}

// ---------------------------------------------------------------------------
// captureAriaSnapshot / diffAriaSnapshots
// ---------------------------------------------------------------------------

describe("captureAriaSnapshot", () => {
	test("flattens ignored/generic wrappers, skips InlineTextBox, assigns sequential @eN refs", async () => {
		const client = new MockCdpClient(snapshotHandler(sampleTree()));
		const snap = await captureAriaSnapshot(client, "S1", 7);

		assert.equal(snap.url, "https://x.test/");
		assert.equal(snap.title, "Demo");
		assert.equal(snap.generation, 7);
		assert.equal(snap.truncated, false);
		assert.deepEqual(
			snap.refs.map((r) => `${r.ref}:${r.role}:${r.name}`),
			["@e1:button:Save", "@e2:button:Delete", "@e3:checkbox:Agree", "@e4:generic:", "@e5:link:Docs"],
		);
		assert.equal(snap.totalInteractiveCount, 5);
		assert.equal(snap.refMap.get("@e3")?.backendNodeId, 12);
		assert.equal(snap.refMap.get("@e5")?.url, "https://x.test/docs");
		assert.equal(
			snap.treeText,
			[
				'- button "Save" @e1',
				'- button "Delete" @e2 [disabled]',
				'- checkbox "Agree" @e3 [checked]',
				"- text: Hello world",
				"- generic (editable) @e4",
				"- navigation",
				'  - link "Docs" @e5',
				'  - link "No DOM"',
			].join("\n"),
		);
		// Every command is routed to the target session.
		assert.ok(client.calls.every((call) => call.options?.sessionId === "S1"));
	});

	test("deduplicates StaticText equal to the parent interactive name and marks disabled/checked", async () => {
		const client = new MockCdpClient(snapshotHandler(sampleTree()));
		const snap = await captureAriaSnapshot(client, "S1", 1);
		assert.equal(snap.treeText.includes("text: Save"), false);
		assert.equal(snap.refMap.get("@e2")?.disabled, true);
		assert.equal(snap.refMap.get("@e3")?.checked, "true");
		assert.equal(snap.treeText.includes("InlineTextBox"), false);
	});

	test("enforces maxElements while reporting the full interactive total", async () => {
		const client = new MockCdpClient(snapshotHandler(sampleTree()));
		const snap = await captureAriaSnapshot(client, "S1", 1, { maxElements: 2 });
		assert.equal(snap.refs.length, 2);
		assert.equal(snap.truncated, true);
		assert.equal(snap.totalInteractiveCount, 5);
		assert.match(snap.treeText, /truncated: showing 2 of 5 interactive elements/);
		assert.equal(snap.refMap.has("@e3"), false);
	});

	test("enforces maxChars", async () => {
		const client = new MockCdpClient(snapshotHandler(sampleTree()));
		const snap = await captureAriaSnapshot(client, "S1", 1, { maxChars: 40 });
		assert.equal(snap.truncated, true);
		assert.equal(snap.refs.length, 1);
		assert.equal(snap.totalInteractiveCount, 5);
	});

	test("includeStaticText:false omits text lines", async () => {
		const client = new MockCdpClient(snapshotHandler(sampleTree()));
		const snap = await captureAriaSnapshot(client, "S1", 1, { includeStaticText: false });
		assert.equal(snap.treeText.includes("Hello world"), false);
	});

	test("inlines same-origin iframe trees under their owner and ignores unreachable frames", async () => {
		const main = [
			ax("1", "RootWebArea", { childIds: ["2", "3"], backendDOMNodeId: 1 }),
			ax("2", "Iframe", { parentId: "1", backendDOMNodeId: 50 }),
			ax("3", "button", { name: "After", parentId: "1", backendDOMNodeId: 51 }),
		];
		const frameNodes = [
			ax("100", "RootWebArea", { childIds: ["101"], backendDOMNodeId: 60 }),
			ax("101", "button", { name: "Inner", parentId: "100", backendDOMNodeId: 61 }),
		];
		const client = new MockCdpClient(
			snapshotHandler(main, (method, params) => {
				if (method === "Page.getFrameTree") {
					return {
						frameTree: {
							frame: { id: "main" },
							childFrames: [{ frame: { id: "child" } }, { frame: { id: "oopif" } }],
						},
					};
				}
				if (method === "DOM.getFrameOwner") {
					if (params.frameId === "oopif") {
						throw new Error("Frame with the given id was not found.");
					}
					return { backendNodeId: 50 };
				}
				if (method === "Accessibility.getFullAXTree" && params.frameId === "child") {
					return { nodes: frameNodes };
				}
				return undefined;
			}),
		);
		const snap = await captureAriaSnapshot(client, "S1", 1);
		assert.equal(snap.treeText, ["- Iframe", '  - button "Inner" @e1', '- button "After" @e2'].join("\n"));
		assert.equal(snap.refMap.get("@e1")?.frameId, "child");

		const noFrames = new MockCdpClient(snapshotHandler(main));
		const plain = await captureAriaSnapshot(noFrames, "S1", 1, { includeIframes: false });
		assert.equal(noFrames.callsOf("Page.getFrameTree").length, 0);
		assert.equal(plain.refs.length, 1);
	});

	test("rootSelector scopes the walk to the matched element", async () => {
		const client = new MockCdpClient(
			snapshotHandler(sampleTree(), (method, params) => {
				if (method === "Runtime.evaluate" && String(params.expression).includes("querySelector")) {
					return { result: { type: "object", subtype: "node", objectId: "root-obj" } };
				}
				if (method === "DOM.describeNode") {
					return { node: { backendNodeId: 20 } };
				}
				return undefined;
			}),
		);
		const snap = await captureAriaSnapshot(client, "S1", 1, { rootSelector: "nav" });
		assert.equal(snap.treeText, ["- navigation", '  - link "Docs" @e1', '  - link "No DOM"'].join("\n"));
		const release = client.callsOf("Runtime.releaseObject").find((call) => call.params.objectId === "root-obj");
		assert.ok(release);
		assert.deepEqual(release.options, { sessionId: "S1", timeoutMs: 2_000 }, "release must not carry the caller's AbortSignal");
	});

	test("a shared refRegistry keeps refs stable within a generation and restarts numbering on a new one", async () => {
		const registry = { generation: 0, refsByElement: new Map<string, string>(), lastIndex: 0 };
		const first = await captureAriaSnapshot(new MockCdpClient(snapshotHandler(sampleTree())), "S1", 3, { refRegistry: registry });
		assert.deepEqual(
			first.refs.map((r) => r.ref),
			["@e1", "@e2", "@e3", "@e4", "@e5"],
		);

		// "Delete" (backend 11) disappears and a new "Reset" button (backend 99) appears before "Agree".
		const mutated = sampleTree()
			.filter((node) => node.nodeId !== "7")
			.map((node) => (node.nodeId === "3" ? { ...node, childIds: ["4", "70"] } : node));
		mutated.push(ax("70", "button", { name: "Reset", parentId: "3", backendDOMNodeId: 99 }));
		const second = await captureAriaSnapshot(new MockCdpClient(snapshotHandler(mutated)), "S1", 3, { refRegistry: registry });
		assert.deepEqual(
			second.refs.map((r) => `${r.ref}:${r.name}`),
			["@e1:Save", "@e6:Reset", "@e3:Agree", "@e4:", "@e5:Docs"],
		);
		assert.equal(second.refMap.has("@e2"), false, "a removed element's ref is never handed to another element");
		assert.match(second.treeText, /- button "Reset" @e6/);

		const nextGeneration = await captureAriaSnapshot(new MockCdpClient(snapshotHandler(mutated)), "S1", 4, { refRegistry: registry });
		assert.deepEqual(
			nextGeneration.refs.map((r) => r.ref),
			["@e1", "@e2", "@e3", "@e4", "@e5"],
		);
		assert.equal(registry.generation, 4);
	});

	test("records selected options so selection changes show up in diffs", async () => {
		const nodes = [
			ax("1", "RootWebArea", { childIds: ["2"], backendDOMNodeId: 1 }),
			ax("2", "listbox", { name: "Toppings", parentId: "1", childIds: ["3", "4"], backendDOMNodeId: 2 }),
			ax("3", "option", { name: "Cheese", parentId: "2", backendDOMNodeId: 3, properties: { selected: true } }),
			ax("4", "option", { name: "Olives", parentId: "2", backendDOMNodeId: 4, properties: { selected: false } }),
		];
		const before = await captureAriaSnapshot(new MockCdpClient(snapshotHandler(nodes)), "S1", 1);
		assert.equal(before.refMap.get("@e2")?.selected, true);
		assert.equal(before.refMap.get("@e3")?.selected, undefined);
		const toggled = nodes.map((node) =>
			node.nodeId === "4" ? ax("4", "option", { name: "Olives", parentId: "2", backendDOMNodeId: 4, properties: { selected: true } }) : node,
		);
		const after = await captureAriaSnapshot(new MockCdpClient(snapshotHandler(toggled)), "S1", 1);
		const diff = diffAriaSnapshots(before, after);
		assert.deepEqual(
			diff.changedRefs.map((change) => `${change.after.name}:${String(change.after.selected)}`),
			["Olives:true"],
		);
		assert.match(diff.summaryText, /~ @e3 option "Olives" \(selected: null → true\)/);
	});
});

function makeSnapshot(refs: SnapshotRefEntry[], overrides: Partial<AriaSnapshot> = {}): AriaSnapshot {
	return {
		url: "https://x.test/",
		title: "Demo",
		capturedAt: 0,
		generation: 1,
		refs,
		refMap: new Map(refs.map((r) => [r.ref, r])),
		treeText: "",
		truncated: false,
		totalInteractiveCount: refs.length,
		...overrides,
	};
}

describe("diffAriaSnapshots", () => {
	test("reports added, changed, and removed elements plus URL/title changes", () => {
		const before = makeSnapshot([
			{ ref: "@e1", backendNodeId: 10, role: "button", name: "Save" },
			{ ref: "@e2", backendNodeId: 11, role: "checkbox", name: "Agree", checked: "false" },
			{ ref: "@e3", backendNodeId: 12, role: "link", name: "Old" },
		]);
		const after = makeSnapshot(
			[
				{ ref: "@e1", backendNodeId: 10, role: "button", name: "Save" },
				{ ref: "@e2", backendNodeId: 11, role: "checkbox", name: "Agree", checked: "true" },
				{ ref: "@e3", backendNodeId: 30, role: "button", name: "New" },
			],
			{ url: "https://x.test/next", title: "Next" },
		);
		const diff = diffAriaSnapshots(before, after);
		assert.equal(diff.urlChanged, true);
		assert.equal(diff.titleChanged, true);
		assert.deepEqual(
			diff.addedRefs.map((r) => r.name),
			["New"],
		);
		assert.equal(diff.changedRefs.length, 1);
		assert.equal(diff.changedRefs[0]?.before.checked, "false");
		assert.equal(diff.changedRefs[0]?.after.checked, "true");
		assert.equal(diff.removedCount, 1);
		assert.match(diff.summaryText, /URL changed: https:\/\/x\.test\/ → https:\/\/x\.test\/next/);
		assert.match(diff.summaryText, /\+ @e3 button "New"/);
		assert.match(diff.summaryText, /checked: "false" → "true"/);
		assert.match(diff.summaryText, /-1 element\(s\) removed/);
	});

	test("reports no changes for identical snapshots", () => {
		const refs: SnapshotRefEntry[] = [{ ref: "@e1", backendNodeId: 10, role: "button", name: "Save" }];
		const diff = diffAriaSnapshots(makeSnapshot(refs), makeSnapshot(refs));
		assert.equal(diff.summaryText, "No changes in interactive elements.");
		assert.equal(diff.removedCount, 0);
	});
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const SAVE: SnapshotRefEntry = { ref: "@e1", backendNodeId: 10, role: "button", name: "Save" };
const GONE: SnapshotRefEntry = { ref: "@e2", backendNodeId: 11, role: "button", name: "Gone", disabled: true };

function actionContext(client: MockCdpClient, generation = 1): TargetResolutionContext {
	return {
		client,
		sessionId: "S1",
		latestSnapshot: makeSnapshot([SAVE, GONE], { generation: 1 }),
		currentGeneration: generation,
	};
}

interface DomBehavior {
	connected?: boolean;
	disabled?: boolean;
	quads?: number[][];
	callResult?: unknown;
	callException?: string;
	resolveThrows?: boolean;
}

function domHandler(behavior: DomBehavior = {}, extra?: Handler): Handler {
	return (method, params, options) => {
		const custom = extra?.(method, params, options);
		if (custom !== undefined) {
			return custom;
		}
		switch (method) {
			case "DOM.resolveNode":
				if (behavior.resolveThrows) {
					throw new Error("No node with given id found");
				}
				return { object: { type: "object", subtype: "node", objectId: `obj-${String(params.backendNodeId)}` } };
			case "Runtime.callFunctionOn": {
				const fn = String(params.functionDeclaration);
				if (fn.includes("isConnected")) {
					return { result: { type: "boolean", value: behavior.connected ?? true } };
				}
				if (fn.includes(":disabled")) {
					return { result: { type: "boolean", value: behavior.disabled ?? false } };
				}
				if (behavior.callException) {
					return {
						result: { type: "object", subtype: "error" },
						exceptionDetails: { text: "Uncaught", exception: { type: "object", description: behavior.callException } },
					};
				}
				return { result: { type: "object", value: behavior.callResult } };
			}
			case "DOM.getContentQuads":
				return { quads: behavior.quads ?? [[10, 20, 110, 20, 110, 60, 10, 60]] };
			default:
				return {};
		}
	};
}

describe("resolveDomTarget", () => {
	test("accepts @eN and eN refs after verifying the node is still connected", async () => {
		const client = new MockCdpClient(domHandler());
		const ctx = actionContext(client);
		const viaAt = await resolveDomTarget(ctx, "@e1");
		const viaBare = await resolveDomTarget(ctx, "e1");
		assert.equal(viaAt.backendNodeId, 10);
		assert.equal(viaBare.fromRef?.ref, "@e1");
		assert.equal(viaAt.description, '@e1 button "Save"');
		assert.deepEqual(client.callsOf("DOM.resolveNode")[0]?.params, { backendNodeId: 10 });
		assert.equal(client.callsOf("Runtime.releaseObject").length, 2);
		assert.equal(normalizeRef(" e12 "), "@e12");
		assert.equal(normalizeRef("button.e1"), null);
	});

	test("throws a stale-ref error for disconnected nodes", async () => {
		const client = new MockCdpClient(domHandler({ connected: false }));
		await assert.rejects(resolveDomTarget(actionContext(client), "@e1"), /Ref @e1 is stale — run snapshot again/);
		assert.equal(client.callsOf("Runtime.releaseObject").length, 1);
	});

	test("throws a stale-ref error when the backend node no longer resolves", async () => {
		const client = new MockCdpClient(domHandler({ resolveThrows: true }));
		await assert.rejects(resolveDomTarget(actionContext(client), "@e1"), /Ref @e1 is stale/);
	});

	test("throws a stale-ref error when the page generation advanced (navigation)", async () => {
		const client = new MockCdpClient(domHandler());
		await assert.rejects(resolveDomTarget(actionContext(client, 2), "@e1"), /Ref @e1 is stale/);
		assert.equal(client.calls.length, 0);
	});

	test("explains unknown refs and missing snapshots", async () => {
		const client = new MockCdpClient(domHandler());
		await assert.rejects(resolveDomTarget(actionContext(client), "@e9"), /Unknown ref @e9 \(latest snapshot has @e1\.\.@e2\)/);
		await assert.rejects(
			resolveDomTarget({ ...actionContext(client), latestSnapshot: null }, "@e1"),
			/No snapshot has been captured yet/,
		);
	});

	test("falls back to CSS selectors via document.querySelector + DOM.describeNode", async () => {
		const client = new MockCdpClient((method) => {
			if (method === "Runtime.evaluate") {
				return { result: { type: "object", subtype: "node", objectId: "sel-obj" } };
			}
			if (method === "DOM.describeNode") {
				return { node: { backendNodeId: 77, localName: "input" } };
			}
			return {};
		});
		const resolved = await resolveDomTarget(actionContext(client), "#email");
		assert.equal(resolved.backendNodeId, 77);
		assert.equal(resolved.description, '"#email" <input>');
		assert.equal(client.callsOf("Runtime.evaluate")[0]?.params.expression, 'document.querySelector("#email")');
		assert.deepEqual(client.callsOf("Runtime.releaseObject")[0]?.params, { objectId: "sel-obj" });
	});

	test("reports selectors that match nothing", async () => {
		const client = new MockCdpClient(() => ({ result: { type: "object", subtype: "null", value: null } }));
		await assert.rejects(resolveDomTarget(actionContext(client), ".missing"), /No element matches selector "\.missing"/);
	});
});

describe("clickTarget", () => {
	test("scrolls, then dispatches mouseMoved + mousePressed/mouseReleased with clickCount 1 at the quad center", async () => {
		const client = new MockCdpClient(domHandler());
		const result = await clickTarget(actionContext(client), "@e1");
		assert.deepEqual(result, { clicked: '@e1 button "Save"', x: 60, y: 40 });
		assert.ok(client.methods().includes("DOM.scrollIntoViewIfNeeded"));
		const mouse = client.callsOf("Input.dispatchMouseEvent").map((call) => call.params);
		assert.deepEqual(mouse, [
			{ type: "mouseMoved", x: 60, y: 40, button: "none", buttons: 0 },
			{ type: "mousePressed", x: 60, y: 40, button: "left", buttons: 1, clickCount: 1 },
			{ type: "mouseReleased", x: 60, y: 40, button: "left", buttons: 0, clickCount: 1 },
		]);
	});

	test("doubleClick adds a clickCount 2 press/release pair", async () => {
		const client = new MockCdpClient(domHandler());
		await clickTarget(actionContext(client), "@e1", { doubleClick: true, button: "right" });
		const counts = client
			.callsOf("Input.dispatchMouseEvent")
			.filter((call) => call.params.type !== "mouseMoved")
			.map((call) => `${String(call.params.type)}:${String(call.params.clickCount)}:${String(call.params.button)}`);
		assert.deepEqual(counts, ["mousePressed:1:right", "mouseReleased:1:right", "mousePressed:2:right", "mouseReleased:2:right"]);
	});

	test("rejects disabled elements without dispatching input", async () => {
		const client = new MockCdpClient(domHandler({ disabled: true }));
		await assert.rejects(clickTarget(actionContext(client), "@e2"), /Cannot click @e2 button "Gone": element is disabled/);
		assert.equal(client.callsOf("Input.dispatchMouseEvent").length, 0);
	});

	test("falls back to element.click() when the node has no box", async () => {
		const client = new MockCdpClient(domHandler({ quads: [] }));
		const result = await clickTarget(actionContext(client), "@e1");
		assert.match(result.clicked, /JS click fallback/);
		assert.equal(client.callsOf("Input.dispatchMouseEvent").length, 0);
		assert.ok(
			client.callsOf("Runtime.callFunctionOn").some((call) => String(call.params.functionDeclaration).includes("this.click()")),
		);
		const fallback = client
			.callsOf("Runtime.callFunctionOn")
			.find((call) => String(call.params.functionDeclaration).includes("this.click()"));
		assert.match(String(fallback?.params.functionDeclaration), /if \(!this\.isConnected\) \{ throw new Error\("element is stale or detached/);
	});

	test("JS click fallback refuses a node that detached after resolution", async () => {
		const client = new MockCdpClient(
			domHandler({ quads: [] }, (method, params) => {
				if (method === "Runtime.callFunctionOn" && String(params.functionDeclaration).includes("this.click()")) {
					return {
						result: { type: "object", subtype: "error" },
						exceptionDetails: {
							text: "Uncaught",
							exception: { type: "object", description: "Error: element is stale or detached from the document — run snapshot again" },
						},
					};
				}
				return undefined;
			}),
		);
		await assert.rejects(clickTarget(actionContext(client), "@e1"), /JS click fallback failed: Error: element is stale or detached/);
		assert.equal(client.callsOf("Input.dispatchMouseEvent").length, 0);
	});
});

describe("fillTarget / selectTarget", () => {
	test("fill uses the native prototype value setter, dispatches input+change, and releases the object", async () => {
		const client = new MockCdpClient(domHandler({ callResult: "a@b.co" }));
		const result = await fillTarget(actionContext(client), "@e1", "a@b.co");
		assert.deepEqual(result, { filled: '@e1 button "Save"', value: "a@b.co" });
		const fillCall = client
			.callsOf("Runtime.callFunctionOn")
			.find((call) => String(call.params.functionDeclaration).includes("getOwnPropertyDescriptor"));
		assert.ok(fillCall);
		const fn = String(fillCall.params.functionDeclaration);
		assert.match(fn, /HTMLInputElement\.prototype/);
		assert.match(fn, /HTMLTextAreaElement\.prototype/);
		assert.match(fn, /isContentEditable/);
		assert.match(fn, /new win\.Event\("input", \{ bubbles: true \}\)/);
		assert.match(fn, /new win\.Event\("change", \{ bubbles: true \}\)/);
		assert.deepEqual(fillCall.params.arguments, [{ value: "a@b.co" }]);
		assert.ok(client.callsOf("Runtime.releaseObject").some((call) => call.params.objectId === "obj-10"));
	});

	test("releaseObject never forwards the caller's AbortSignal so aborted actions still free remote objects", async () => {
		const client = new MockCdpClient(domHandler({ callResult: "x" }));
		const controller = new AbortController();
		await fillTarget({ ...actionContext(client), signal: controller.signal, timeoutMs: 9_000 }, "@e1", "x");
		const fillCall = client
			.callsOf("Runtime.callFunctionOn")
			.find((call) => String(call.params.functionDeclaration).includes("getOwnPropertyDescriptor"));
		assert.equal(fillCall?.options?.signal, controller.signal, "the action itself honours the signal");
		const releases = client.callsOf("Runtime.releaseObject");
		assert.ok(releases.length >= 2);
		for (const release of releases) {
			assert.deepEqual(release.options, { sessionId: "S1", timeoutMs: 2_000 });
		}
	});

	test("fill surfaces page exceptionDetails and still releases the object", async () => {
		const client = new MockCdpClient(domHandler({ callException: "Error: Element <h1> is not fillable" }));
		await assert.rejects(fillTarget(actionContext(client), "@e1", "x"), /Fill @e1 button "Save" failed: Error: Element <h1> is not fillable/);
		assert.equal(client.callsOf("Runtime.releaseObject").length, 2);
	});

	test("select handles single vs multiple <select> and returns chosen values", async () => {
		const client = new MockCdpClient(domHandler({ callResult: ["b"] }));
		const result = await selectTarget(actionContext(client), "@e1", ["Beta"]);
		assert.deepEqual(result, { selected: ["b"], target: '@e1 button "Save"' });
		const selectCall = client
			.callsOf("Runtime.callFunctionOn")
			.find((call) => String(call.params.functionDeclaration).includes("this.multiple"));
		assert.ok(selectCall);
		const fn = String(selectCall.params.functionDeclaration);
		assert.match(fn, /if \(this\.multiple\)/);
		assert.match(fn, /picked\[0\]\.selected = true/);
		assert.match(fn, /o\.label === wanted/);
		assert.match(fn, /textContent \|\| ""\)\.trim\(\) === trimmed/);
		assert.deepEqual(selectCall.params.arguments, [{ value: ["Beta"] }]);
	});

	test("select surfaces exceptionDetails and rejects empty value lists", async () => {
		const client = new MockCdpClient(domHandler({ callException: 'Error: No <option> matches "zzz"' }));
		await assert.rejects(selectTarget(actionContext(client), "@e1", ["zzz"]), /failed: Error: No <option> matches "zzz"/);
		await assert.rejects(selectTarget(actionContext(client), "@e1", []), /at least one value/);
	});
});

describe("keyboard and evaluation", () => {
	test("pressKey sends modifier down/up around the main key without text for shortcuts", async () => {
		const client = new MockCdpClient(() => ({}));
		await pressKey(client, "S1", "Control+a");
		const events = client.callsOf("Input.dispatchKeyEvent").map((call) => call.params);
		assert.deepEqual(
			events.map((e) => `${String(e.type)}:${String(e.key)}:${String(e.modifiers)}`),
			["rawKeyDown:Control:2", "rawKeyDown:a:2", "keyUp:a:2", "keyUp:Control:0"],
		);
		assert.equal(events[1]?.text, undefined);
		assert.equal(events[1]?.code, "KeyA");
	});

	test("typeText inserts text and submits with Enter", async () => {
		const client = new MockCdpClient(() => ({}));
		await typeText(client, "S1", "hello", true);
		assert.deepEqual(client.callsOf("Input.insertText")[0]?.params, { text: "hello" });
		const enterDown = client.callsOf("Input.dispatchKeyEvent")[0]?.params;
		assert.equal(enterDown?.type, "keyDown");
		assert.equal(enterDown?.text, "\r");
		assert.equal(enterDown?.windowsVirtualKeyCode, 13);
		await assert.rejects(pressKey(client, "S1", "NotAKey"), /Unknown key "NotAKey"/);
	});

	test("evaluateExpression reports exceptions and JSON-serializes objects", async () => {
		const failing = new MockCdpClient((method) =>
			method === "Runtime.evaluate"
				? { result: { type: "object" }, exceptionDetails: { text: "Uncaught", exception: { description: "Error: boom" } } }
				: {},
		);
		assert.deepEqual(await evaluateExpression(failing, "S1", "boom()"), { valueText: "Error: boom", isError: true });
		assert.ok(failing.methods().includes("Runtime.releaseObjectGroup"));

		const objects = new MockCdpClient((method) => {
			if (method === "Runtime.evaluate") {
				return { result: { type: "object", objectId: "o1", className: "Object", description: "Object" } };
			}
			if (method === "Runtime.callFunctionOn") {
				return { result: { type: "string", value: '{\n  "a": 1\n}' } };
			}
			return {};
		});
		assert.deepEqual(await evaluateExpression(objects, "S1", "({a:1})"), { valueText: '{\n  "a": 1\n}', isError: false });
	});

	test("evaluateExpression uses a unique objectGroup per call and releases it without the caller's signal", async () => {
		const client = new MockCdpClient((method) =>
			method === "Runtime.evaluate" ? { result: { type: "number", value: 1, description: "1" } } : {},
		);
		const controller = new AbortController();
		await Promise.all([
			evaluateExpression(client, "S1", "1", 5_000, controller.signal),
			evaluateExpression(client, "S1", "1", 5_000, controller.signal),
		]);
		const groups = client.callsOf("Runtime.evaluate").map((call) => String(call.params.objectGroup));
		assert.equal(groups.length, 2);
		assert.notEqual(groups[0], groups[1], "concurrent evaluations must not share an object group");
		for (const group of groups) {
			assert.match(group, /^pi-cdp-eval-\d+$/);
		}
		for (const call of client.callsOf("Runtime.evaluate")) {
			assert.equal(call.options?.signal, controller.signal);
		}
		const releases = client.callsOf("Runtime.releaseObjectGroup");
		assert.deepEqual(
			releases.map((call) => String(call.params.objectGroup)).sort(),
			[...groups].sort(),
			"each call releases exactly its own group",
		);
		for (const release of releases) {
			assert.deepEqual(release.options, { sessionId: "S1", timeoutMs: 2_000 });
		}
	});
});

describe("waitForCondition", () => {
	test("polls until the page condition holds", async () => {
		let polls = 0;
		const client = new MockCdpClient(() => {
			polls += 1;
			return { result: { type: "object", value: { selectorOk: true, textOk: polls >= 3, urlOk: true } } };
		});
		const result = await waitForCondition(client, "S1", { text: "Ready", timeoutMs: 2_000 });
		assert.equal(result.matched, 'text "Ready"');
		assert.equal(polls, 3);
	});

	test("times out with a descriptive error", async () => {
		const client = new MockCdpClient(() => ({ result: { type: "object", value: { selectorOk: false, textOk: true, urlOk: true } } }));
		await assert.rejects(
			waitForCondition(client, "S1", { selector: "#late", timeoutMs: 150 }),
			/Timed out after 150ms waiting for selector "#late" visible/,
		);
	});

	test("network idle tracks in-flight requests on the session", async () => {
		const client = new MockCdpClient(() => ({}));
		const pending = waitForCondition(client, "S1", { networkIdleMs: 50, timeoutMs: 2_000 });
		client.emit({ method: "Network.requestWillBeSent", params: { requestId: "r1" }, sessionId: "S1" });
		client.emit({ method: "Network.requestWillBeSent", params: { requestId: "x" }, sessionId: "OTHER" });
		setTimeout(() => {
			client.emit({ method: "Network.loadingFinished", params: { requestId: "r1" }, sessionId: "S1" });
		}, 80);
		const result = await pending;
		assert.ok(result.elapsedMs >= 120, `expected idle wait after request finished, got ${result.elapsedMs}ms`);
		assert.equal(client.listeners.size, 0);
	});

	test("requires at least one condition", async () => {
		const client = new MockCdpClient(() => ({}));
		await assert.rejects(waitForCondition(client, "S1", {}), /wait requires/);
	});
});

// ---------------------------------------------------------------------------
// Screenshots and image parsing
// ---------------------------------------------------------------------------

function pngHeader(width: number, height: number): Buffer {
	const buf = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
	buf.writeUInt32BE(13, 8);
	buf.write("IHDR", 12, "ascii");
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	return buf;
}

function jpegHeader(width: number, height: number): Buffer {
	const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14)]);
	const sof = Buffer.alloc(19);
	sof.writeUInt16BE(0xffc0, 0);
	sof.writeUInt16BE(17, 2);
	sof[4] = 8;
	sof.writeUInt16BE(height, 5);
	sof.writeUInt16BE(width, 7);
	return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

describe("parseImageDimensions", () => {
	test("reads PNG IHDR, JPEG SOF0, and WebP VP8X/VP8L headers", () => {
		assert.deepEqual(parseImageDimensions(pngHeader(1280, 3431)), { width: 1280, height: 3431 });
		assert.deepEqual(parseImageDimensions(jpegHeader(640, 480)), { width: 640, height: 480 });

		const vp8x = Buffer.alloc(30);
		vp8x.write("RIFF", 0, "ascii");
		vp8x.write("WEBP", 8, "ascii");
		vp8x.write("VP8X", 12, "ascii");
		vp8x.writeUIntLE(1279, 24, 3);
		vp8x.writeUIntLE(799, 27, 3);
		assert.deepEqual(parseImageDimensions(vp8x), { width: 1280, height: 800 });

		const vp8l = Buffer.alloc(30);
		vp8l.write("RIFF", 0, "ascii");
		vp8l.write("WEBP", 8, "ascii");
		vp8l.write("VP8L", 12, "ascii");
		vp8l.writeUInt32LE((99 & 0x3fff) | ((49 & 0x3fff) << 14), 21);
		assert.deepEqual(parseImageDimensions(vp8l), { width: 100, height: 50 });

		assert.equal(parseImageDimensions(Buffer.from("not an image")), null);
	});
});

describe("capturePageScreenshot", () => {
	const metrics = {
		cssContentSize: { x: 0, y: 0, width: 1265.4, height: 3430.2 },
		cssLayoutViewport: { clientWidth: 1280, clientHeight: 713, pageX: 0, pageY: 0 },
		cssVisualViewport: { pageX: 0, pageY: 120, clientWidth: 1280, clientHeight: 713 },
	};

	function screenshotClient(width: number, height: number): MockCdpClient {
		return new MockCdpClient(
			domHandler({}, (method) => {
				if (method === "Page.getLayoutMetrics") {
					return metrics;
				}
				if (method === "Page.captureScreenshot") {
					return { data: pngHeader(width, height).toString("base64") };
				}
				return undefined;
			}),
		);
	}

	test("viewport capture does not capture beyond the viewport and parses PNG dimensions", async () => {
		const client = screenshotClient(1280, 713);
		const shot = await capturePageScreenshot(actionContext(client));
		const params = client.callsOf("Page.captureScreenshot")[0]?.params;
		assert.equal(params?.captureBeyondViewport, false);
		assert.equal(params?.clip, undefined);
		assert.equal(params?.format, "png");
		assert.deepEqual([shot.width, shot.height, shot.mimeType, shot.fullPage], [1280, 713, "image/png", false]);
	});

	test("fullPage clips to cssContentSize with captureBeyondViewport", async () => {
		const client = screenshotClient(1266, 3431);
		const shot = await capturePageScreenshot(actionContext(client), { fullPage: true });
		const params = client.callsOf("Page.captureScreenshot")[0]?.params;
		assert.equal(params?.captureBeyondViewport, true);
		assert.deepEqual(params?.clip, { x: 0, y: 0, width: 1266, height: 3431, scale: 1 });
		assert.deepEqual([shot.width, shot.height, shot.fullPage], [1266, 3431, true]);
	});

	test("element capture clips to the element box in document coordinates", async () => {
		const client = screenshotClient(100, 40);
		await capturePageScreenshot(actionContext(client), { target: "@e1", format: "jpeg", quality: 70 });
		const params = client.callsOf("Page.captureScreenshot")[0]?.params;
		assert.deepEqual(params?.clip, { x: 10, y: 140, width: 100, height: 40, scale: 1 });
		assert.equal(params?.format, "jpeg");
		assert.equal(params?.quality, 70);
	});
});

// ---------------------------------------------------------------------------
// CdpMultiplexClient over a real (in-process) WebSocket server
// ---------------------------------------------------------------------------

interface MiniWsServer {
	url: string;
	port: number;
	received: Array<Record<string, unknown>>;
	sendJson(socketIndex: number, payload: unknown): void;
	onMessage: (socketIndex: number, message: Record<string, unknown>) => void;
	dropAll(): void;
	close(): Promise<void>;
	upgradeHeaders: http.IncomingHttpHeaders[];
}

function encodeFrame(text: string, opcode = 0x1): Buffer {
	const payload = Buffer.from(text, "utf8");
	let header: Buffer;
	if (payload.length < 126) {
		header = Buffer.from([0x80 | opcode, payload.length]);
	} else if (payload.length < 65_536) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(payload.length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(payload.length), 2);
	}
	return Buffer.concat([header, payload]);
}

function decodeFrames(buffer: Buffer): { frames: Array<{ opcode: number; payload: Buffer }>; rest: Buffer } {
	const frames: Array<{ opcode: number; payload: Buffer }> = [];
	let offset = 0;
	while (buffer.length - offset >= 2) {
		const opcode = buffer[offset] & 0x0f;
		const masked = (buffer[offset + 1] & 0x80) !== 0;
		let length = buffer[offset + 1] & 0x7f;
		let cursor = offset + 2;
		if (length === 126) {
			if (buffer.length < cursor + 2) {
				break;
			}
			length = buffer.readUInt16BE(cursor);
			cursor += 2;
		} else if (length === 127) {
			if (buffer.length < cursor + 8) {
				break;
			}
			length = Number(buffer.readBigUInt64BE(cursor));
			cursor += 8;
		}
		const maskLength = masked ? 4 : 0;
		if (buffer.length < cursor + maskLength + length) {
			break;
		}
		const mask = buffer.subarray(cursor, cursor + maskLength);
		cursor += maskLength;
		const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
		if (masked) {
			for (let i = 0; i < payload.length; i += 1) {
				payload[i] ^= mask[i % 4];
			}
		}
		frames.push({ opcode, payload });
		offset = cursor + length;
	}
	return { frames, rest: buffer.subarray(offset) };
}

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const HANDSHAKE_DIGEST = "SHA-1";

async function websocketAccept(key: string): Promise<string> {
	const digest = await crypto.webcrypto.subtle.digest(HANDSHAKE_DIGEST, new TextEncoder().encode(`${key}${WEBSOCKET_GUID}`));
	return Buffer.from(digest).toString("base64");
}

async function startMiniWsServer(): Promise<MiniWsServer> {
	const sockets: Socket[] = [];
	const server = http.createServer((_req, res) => {
		res.writeHead(404);
		res.end();
	});
	const state: MiniWsServer = {
		url: "",
		port: 0,
		received: [],
		upgradeHeaders: [],
		onMessage: () => {},
		sendJson(socketIndex, payload) {
			sockets[socketIndex]?.write(encodeFrame(JSON.stringify(payload)));
		},
		dropAll() {
			for (const socket of sockets) {
				socket.destroy();
			}
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) {
					socket.destroy();
				}
				server.close(() => resolve());
			}),
	};
	server.on("upgrade", (req, socket: Socket) => {
		state.upgradeHeaders.push(req.headers);
		const key = String(req.headers["sec-websocket-key"]);
		// RFC 6455 §4.2.2 fixes the handshake digest algorithm; this is protocol framing, not a security control.
		void websocketAccept(key).then((accept) => {
			socket.write(
				`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
			);
		});
		const index = sockets.push(socket) - 1;
		let pending: Buffer = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			const decoded = decodeFrames(Buffer.concat([pending, chunk]));
			pending = decoded.rest;
			for (const frame of decoded.frames) {
				if (frame.opcode === 0x8) {
					socket.end(encodeFrame("", 0x8));
					continue;
				}
				if (frame.opcode === 0x1) {
					const message = JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>;
					state.received.push(message);
					state.onMessage(index, message);
				}
			}
		});
		socket.on("error", () => {});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const { port } = server.address() as AddressInfo;
	const url = new URL(`http://127.0.0.1:${port}/devtools/browser/unit-test`);
	url.protocol = "ws:";
	state.url = url.href;
	state.port = port;
	return state;
}

describe("CdpMultiplexClient", () => {
	test("multiplexes browser- and session-level commands and routes events", async () => {
		const server = await startMiniWsServer();
		try {
			server.onMessage = (index, message) => {
				if (message.method === "Target.getTargets") {
					server.sendJson(index, { id: message.id, result: { targetInfos: [] } });
				} else if (message.method === "Runtime.evaluate") {
					server.sendJson(index, {
						method: "Runtime.consoleAPICalled",
						params: { type: "log" },
						sessionId: message.sessionId,
					});
					server.sendJson(index, { id: message.id, result: { result: { type: "number", value: 2 } } });
				} else {
					server.sendJson(index, { id: message.id, error: { code: -32601, message: `'${String(message.method)}' wasn't found` } });
				}
			};
			const client = await CdpMultiplexClient.connect(server.url, 2_000);
			assert.equal(client.isOpen, true);
			assert.equal(server.upgradeHeaders[0]?.origin, undefined);

			const events: CdpEventMessage[] = [];
			const unsubscribe = client.onEvent((event) => events.push(event));
			const [targets, evaluated] = await Promise.all([
				client.send<{ targetInfos: unknown[] }>("Target.getTargets"),
				client.send<{ result: { value: number } }>("Runtime.evaluate", { expression: "1+1" }, { sessionId: "SESSION-A" }),
			]);
			assert.deepEqual(targets, { targetInfos: [] });
			assert.equal(evaluated.result.value, 2);
			assert.deepEqual(server.received[0], { id: 1, method: "Target.getTargets", params: {} });
			assert.deepEqual(server.received[1], {
				id: 2,
				method: "Runtime.evaluate",
				params: { expression: "1+1" },
				sessionId: "SESSION-A",
			});
			assert.deepEqual(events, [{ method: "Runtime.consoleAPICalled", params: { type: "log" }, sessionId: "SESSION-A" }]);

			const protocolError = await client.send("Nope.method").catch((error: unknown) => error);
			assert.ok(protocolError instanceof CdpProtocolError);
			assert.equal(protocolError.code, -32601);
			assert.match(protocolError.message, /CDP Nope\.method failed: 'Nope\.method' wasn't found/);

			unsubscribe();
			server.sendJson(0, { method: "Page.loadEventFired", params: {} });
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(events.length, 1);

			await client.close();
			assert.equal(client.isOpen, false);
			await assert.rejects(client.send("Target.getTargets"), /is closed/);
		} finally {
			await server.close();
		}
	});

	test("per-call timeouts and abort signals reject and clean up", async () => {
		const server = await startMiniWsServer();
		try {
			server.onMessage = () => {};
			const client = await CdpMultiplexClient.connect(server.url, 2_000);
			await assert.rejects(client.send("Slow.method", {}, { timeoutMs: 30 }), /CDP Slow\.method timed out after 30ms/);

			const controller = new AbortController();
			const aborted = client.send("Slow.other", {}, { signal: controller.signal });
			controller.abort(new Error("user cancelled"));
			await assert.rejects(aborted, /user cancelled/);
			await assert.rejects(client.send("X.y", {}, { signal: controller.signal }), /user cancelled/);

			// A late response for a timed-out call is ignored.
			server.sendJson(0, { id: 1, result: {} });
			await client.close();
		} finally {
			await server.close();
		}
	});

	test("rejects pending calls when the socket drops", async () => {
		const server = await startMiniWsServer();
		try {
			server.onMessage = () => {};
			const client = await CdpMultiplexClient.connect(server.url, 2_000);
			const pending = client.send("Hang.forever", {}, { timeoutMs: 5_000 });
			server.dropAll();
			await assert.rejects(pending, /before Hang\.forever completed/);
			assert.equal(client.isOpen, false);
		} finally {
			await server.close();
		}
	});

	test("connect validates the URL scheme and fails fast on refused connections", async () => {
		await assert.rejects(CdpMultiplexClient.connect("http://127.0.0.1:9/x"), /must use ws: or wss:/);
		const server = await startMiniWsServer();
		const url = server.url;
		await server.close();
		await assert.rejects(CdpMultiplexClient.connect(url, 2_000), /Failed to connect|closed during handshake/);
	});
});

describe("DEVTOOLS_LISTENING_RE", () => {
	test("only matches a complete stderr line so a chunk split mid-URL never yields a truncated ws:// URL", () => {
		const full = "ws://127.0.0.1:41234/devtools/browser/0f1e2d3c-aaaa-bbbb-cccc-1234567890ab";
		assert.equal(DEVTOOLS_LISTENING_RE.exec(`DevTools listening on ${full.slice(0, 30)}`), null);
		assert.equal(DEVTOOLS_LISTENING_RE.exec(`noise\nDevTools listening on ${full}`), null);
		assert.equal(DEVTOOLS_LISTENING_RE.exec(`noise\nDevTools listening on ${full}\n`)?.[1], full);
		assert.equal(DEVTOOLS_LISTENING_RE.exec(`DevTools listening on ${full}\r\nmore`)?.[1], full);
	});
});

describe("fetchJsonVersion", () => {
	test("parses /json/version and returns null for missing endpoints", async () => {
		const server = http.createServer((req, res) => {
			if (req.url === "/json/version") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ Browser: "Chrome/157.0.0.0", webSocketDebuggerUrl: "wsurl-placeholder" }));
				return;
			}
			res.writeHead(404);
			res.end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		const { port } = server.address() as AddressInfo;
		try {
			assert.deepEqual(await fetchJsonVersion("127.0.0.1", port), {
				browser: "Chrome/157.0.0.0",
				webSocketDebuggerUrl: "wsurl-placeholder",
			});
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		assert.equal(await fetchJsonVersion("127.0.0.1", port, 500), null);
	});
});
