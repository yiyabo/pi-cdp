import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import piCdpExtension, { BROWSER_ACTIONS, runBrowserAction } from "../extensions/index.ts";
import {
	formatConsole,
	formatDoctorReport,
	formatNetwork,
	formatRefEntry,
	formatSessions,
	formatSnapshotDiff,
	formatTabs,
	formatWebInspectResult,
} from "../src/formatters.ts";
import { BrowserSessionManager, normalizeNavigationUrl } from "../src/session-manager.ts";
import type {
	AriaSnapshot,
	CdpClientInterface,
	CdpEventMessage,
	CdpSendOptions,
	LaunchedBrowserHandle,
	LiveCdpEndpoint,
	SnapshotDiff,
	SnapshotRefEntry,
} from "../src/types.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface RegisteredTool {
	name: string;
	executionMode?: string;
	promptGuidelines?: string[];
	parameters: { properties: Record<string, { enum?: string[] }> };
	renderCall?: unknown;
	renderResult?: unknown;
}

function makeRef(ref: string, role: string, name: string, extra: Partial<SnapshotRefEntry> = {}): SnapshotRefEntry {
	return { ref, backendNodeId: Number(ref.replace(/\D/g, "")) || 1, role, name, ...extra };
}

function makeSnapshot(url: string, title: string, generation: number, refs: SnapshotRefEntry[]): AriaSnapshot {
	return {
		url,
		title,
		capturedAt: Date.now(),
		generation,
		refs,
		refMap: new Map(refs.map((entry) => [entry.ref, entry])),
		treeText: refs.map((entry) => `- ${entry.role} "${entry.name}" [${entry.ref}]`).join("\n"),
		truncated: false,
		totalInteractiveCount: refs.length,
	};
}

interface PageState {
	targetId: string;
	frameId: string;
	url: string;
}

/** Scriptable in-memory CDP browser endpoint speaking the flattened-session protocol. */
class FakeCdpBrowser implements CdpClientInterface {
	readonly wsUrl: string;
	open = true;
	closed = false;
	readonly sent: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
	readonly pages = new Map<string, PageState>();
	private readonly listeners = new Set<(event: CdpEventMessage) => void>();
	private readonly targets: Array<{ targetId: string; type: string; url: string; title: string }>;
	private nextSession = 1;
	private nextLoader = 1;
	private nextTarget = 100;
	/** Extra events emitted mid-navigation (between frameNavigated and loadEventFired). */
	duringNavigation?: (sessionId: string, url: string) => void;

	constructor(wsUrl: string, initialTargets: Array<{ targetId: string; url: string; title: string }>) {
		this.wsUrl = wsUrl;
		this.targets = initialTargets.map((target) => ({ ...target, type: "page" }));
	}

	get isOpen(): boolean {
		return this.open;
	}

	onEvent(listener: (event: CdpEventMessage) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	emit(method: string, params: Record<string, unknown>, sessionId?: string): void {
		for (const listener of [...this.listeners]) {
			listener({ method, params, sessionId });
		}
	}

	pageUrl(sessionId: string): string {
		return this.pages.get(sessionId)?.url ?? "about:blank";
	}

	methods(): string[] {
		return this.sent.map((entry) => entry.method);
	}

	async close(): Promise<void> {
		this.open = false;
		this.closed = true;
	}

	async send<T = Record<string, unknown>>(
		method: string,
		params: Record<string, unknown> = {},
		options: CdpSendOptions = {},
	): Promise<T> {
		this.sent.push({ method, params, sessionId: options.sessionId });
		// SAFETY: test double returns protocol-shaped plain objects for the caller's expected result type.
		return this.respond(method, params, options.sessionId) as unknown as T;
	}

	private respond(method: string, params: Record<string, unknown>, sessionId?: string): Record<string, unknown> {
		switch (method) {
			case "Target.getTargets":
				return { targetInfos: this.targets.map((target) => ({ ...target, attached: false })) };
			case "Target.createTarget": {
				const targetId = `T${this.nextTarget++}`;
				this.targets.push({ targetId, type: "page", url: String(params.url ?? "about:blank"), title: "" });
				return { targetId };
			}
			case "Target.attachToTarget": {
				const targetId = String(params.targetId);
				const sid = `S${this.nextSession++}`;
				const target = this.targets.find((entry) => entry.targetId === targetId);
				this.pages.set(sid, { targetId, frameId: `F-${targetId}`, url: target?.url ?? "about:blank" });
				return { sessionId: sid };
			}
			case "Page.getFrameTree": {
				const page = sessionId ? this.pages.get(sessionId) : undefined;
				return { frameTree: { frame: { id: page?.frameId ?? "F0", url: page?.url ?? "about:blank" } } };
			}
			case "Page.navigate": {
				const page = sessionId ? this.pages.get(sessionId) : undefined;
				if (!page || !sessionId) {
					return { errorText: "net::ERR_ABORTED" };
				}
				const url = String(params.url);
				if (url.includes("unreachable.invalid")) {
					return { frameId: page.frameId, errorText: "net::ERR_NAME_NOT_RESOLVED" };
				}
				const loaderId = `L${this.nextLoader++}`;
				setTimeout(() => {
					this.playNavigation(sessionId, page, url, loaderId);
				}, 5);
				return { frameId: page.frameId, loaderId };
			}
			default:
				return {};
		}
	}

	private playNavigation(sessionId: string, page: PageState, url: string, loaderId: string): void {
		this.emit("Page.frameStartedLoading", { frameId: page.frameId }, sessionId);
		this.emit(
			"Network.requestWillBeSent",
			{ requestId: loaderId, loaderId, frameId: page.frameId, type: "Document", request: { method: "GET", url } },
			sessionId,
		);
		this.emit(
			"Network.responseReceived",
			{ requestId: loaderId, loaderId, type: "Document", response: { url, status: 200, statusText: "OK", mimeType: "text/html" } },
			sessionId,
		);
		page.url = url;
		this.emit("Page.frameNavigated", { frame: { id: page.frameId, url, loaderId } }, sessionId);
		this.duringNavigation?.(sessionId, url);
		this.emit("Page.loadEventFired", { timestamp: Date.now() / 1000 }, sessionId);
		this.emit("Page.frameStoppedLoading", { frameId: page.frameId }, sessionId);
	}
}

function fakeDiff(prev: AriaSnapshot, cur: AriaSnapshot): SnapshotDiff {
	const prevRefs = new Set(prev.refs.map((entry) => entry.ref));
	const addedRefs = cur.refs.filter((entry) => !prevRefs.has(entry.ref));
	return {
		previousUrl: prev.url,
		currentUrl: cur.url,
		urlChanged: prev.url !== cur.url,
		titleChanged: prev.title !== cur.title,
		addedRefs,
		changedRefs: [],
		removedCount: 0,
		summaryText: `${addedRefs.length} added`,
	};
}

function createFakeManager() {
	const browser = new FakeCdpBrowser("ws://127.0.0.1:9333/devtools/browser/launched", [
		{ targetId: "T1", url: "about:blank", title: "" },
	]);
	let shutdownCalls = 0;
	const handle: LaunchedBrowserHandle = {
		client: browser,
		pid: 4242,
		executablePath: "/fake/chrome",
		browserName: "Fake Chrome",
		wsUrl: browser.wsUrl,
		port: 9333,
		userDataDir: "/tmp/fake-profile",
		ownsUserDataDir: true,
		headless: true,
		async shutdown() {
			shutdownCalls += 1;
			await browser.close();
		},
	};
	const manager = new BrowserSessionManager({
		launchBrowserProcess: async () => handle,
		captureAriaSnapshot: async (_client, sessionId, generation) => {
			const url = browser.pageUrl(sessionId);
			const refs = url === "about:blank" ? [] : [makeRef("e1", "link", "More information"), makeRef("e2", "button", "Accept")];
			return makeSnapshot(url, url === "about:blank" ? "" : "Example Domain", generation, refs);
		},
		diffAriaSnapshots: fakeDiff,
	});
	return { manager, browser, shutdownCount: () => shutdownCalls };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	return first && first.type === "text" ? (first.text ?? "") : "";
}

describe("pi-cdp extension registration contract", () => {
	it("registers web_inspect, browser, /cdp and lifecycle hooks with zero startup side effects", async () => {
		const tools = new Map<string, RegisteredTool>();
		const commands = new Map<string, { getArgumentCompletions?: (prefix: string) => unknown }>();
		const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
		const fakePi = {
			on(event: string, handler: (...args: unknown[]) => unknown) {
				const list = events.get(event) ?? [];
				list.push(handler);
				events.set(event, list);
				return () => undefined;
			},
			registerTool(def: RegisteredTool) {
				tools.set(def.name, def);
			},
			registerCommand(name: string, opts: { getArgumentCompletions?: (prefix: string) => unknown }) {
				commands.set(name, opts);
			},
		};

		// SAFETY: minimal structural mock exercising only the registration surface used by the factory.
		piCdpExtension(fakePi as unknown as Parameters<typeof piCdpExtension>[0]);

		assert.deepEqual([...tools.keys()].sort(), ["browser", "web_inspect"]);
		assert.ok(commands.has("cdp"));
		assert.ok(events.has("session_start"));
		assert.ok(events.has("session_shutdown"));

		const browserTool = tools.get("browser");
		assert.ok(browserTool);
		assert.equal(browserTool.executionMode, "sequential");
		assert.deepEqual(browserTool.parameters.properties.action.enum, [...BROWSER_ACTIONS]);
		assert.equal(BROWSER_ACTIONS.length, 30);
		for (const tool of tools.values()) {
			assert.equal(typeof tool.renderCall, "function", `${tool.name} renderCall`);
			assert.equal(typeof tool.renderResult, "function", `${tool.name} renderResult`);
			for (const guideline of tool.promptGuidelines ?? []) {
				assert.ok(/\b(browser|web_inspect)\b/.test(guideline), `guideline must name its tool: ${guideline}`);
			}
		}

		const completions = commands.get("cdp")?.getArgumentCompletions?.("st");
		assert.deepEqual(completions, [
			{ value: "status", label: "status" },
			{ value: "stop", label: "stop" },
			{ value: "stop all", label: "stop all" },
		]);

		// Shutdown with no sessions must resolve cleanly (idempotent disposeAll).
		for (const handler of events.get("session_shutdown") ?? []) {
			await handler({ type: "session_shutdown" }, { mode: "print" });
		}
	});

	it("loads via Pi's real DefaultResourceLoader with the browser-cdp skill and runs safe tool actions", async () => {
		const tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cdp-agentdir-"));
		try {
			const loader = new DefaultResourceLoader({
				cwd: PKG_ROOT,
				agentDir: tmpAgentDir,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				additionalExtensionPaths: [path.join(PKG_ROOT, "extensions", "index.ts")],
				additionalSkillPaths: [path.join(PKG_ROOT, "skills", "browser-cdp")],
			});
			await loader.reload();

			const extRes = loader.getExtensions();
			assert.equal(extRes.errors.length, 0, `Extension load errors: ${JSON.stringify(extRes.errors)}`);
			const skillRes = loader.getSkills();
			assert.equal(skillRes.diagnostics.length, 0, `Skill diagnostics: ${JSON.stringify(skillRes.diagnostics)}`);
			assert.ok(skillRes.skills.some((skill) => skill.name === "browser-cdp"));

			const loaded = extRes.extensions.find((ext) => ext.tools.has("browser"));
			assert.ok(loaded, "Expected pi-cdp extension to be loaded");
			assert.ok(loaded.tools.has("web_inspect"));
			assert.ok(loaded.commands.has("cdp"));

			const browserTool = loaded.tools.get("browser");
			assert.ok(browserTool);
			// SAFETY: minimal ExtensionContext stub for non-UI tool invocation.
			const stubCtx = { cwd: PKG_ROOT, hasUI: false } as unknown as Parameters<typeof browserTool.definition.execute>[4];

			const sessions = await browserTool.definition.execute("call-1", { action: "sessions" }, undefined, undefined, stubCtx);
			assert.notEqual(sessions.isError, true);
			assert.match(textOf(sessions), /No browser sessions/);

			const missing = await browserTool.definition.execute("call-2", { action: "click" }, undefined, undefined, stubCtx);
			assert.equal(missing.isError, true);
			assert.match(textOf(missing), /browser error \(click\): 'target' is required/);

			const noTab = await browserTool.definition.execute("call-3", { action: "switch_tab" }, undefined, undefined, stubCtx);
			assert.equal(noTab.isError, true);
			assert.match(textOf(noTab), /'tab_id' is required/);
		} finally {
			fs.rmSync(tmpAgentDir, { recursive: true, force: true });
		}
	});
});

describe("browser action dispatch over a fake CDP endpoint", () => {
	it("lazily launches b1 on open, tracks console/errors/network, auto-handles dialogs, and shuts down", async () => {
		const { manager, browser, shutdownCount } = createFakeManager();
		const env = { manager, cwd: PKG_ROOT };
		browser.duringNavigation = (sessionId) => {
			browser.emit("Runtime.consoleAPICalled", { type: "warning", args: [{ type: "string", value: "deprecated API" }] }, sessionId);
			browser.emit(
				"Runtime.exceptionThrown",
				{
					exceptionDetails: {
						text: "Uncaught",
						url: "https://example.com/app.js",
						lineNumber: 9,
						exception: { description: "TypeError: x is undefined\n    at app.js:10:3" },
					},
				},
				sessionId,
			);
			browser.emit(
				"Network.requestWillBeSent",
				{ requestId: "R9", type: "Script", request: { method: "GET", url: "https://example.com/app.js" } },
				sessionId,
			);
			browser.emit("Network.loadingFailed", { requestId: "R9", type: "Script", errorText: "net::ERR_FAILED" }, sessionId);
			browser.emit("Page.javascriptDialogOpening", { type: "confirm", message: "Leave?" }, sessionId);
		};

		const opened = await runBrowserAction({ action: "open", url: "example.com" }, env);
		const openText = textOf(opened);
		assert.notEqual(opened.isError, true);
		assert.match(openText, /^\[b1\/t1\] Loaded https:\/\/example\.com\/? HTTP 200/);
		assert.match(openText, /Refs: 2 \(generation 1\)/);
		assert.equal(manager.activeSession, "b1");

		const attachCall = browser.sent.find((entry) => entry.method === "Target.attachToTarget");
		assert.deepEqual(attachCall?.params, { targetId: "T1", flatten: true });
		for (const domain of ["Page.enable", "Runtime.enable", "Network.enable"]) {
			assert.ok(browser.methods().includes(domain), `${domain} should be enabled`);
		}

		const dialogReply = browser.sent.find((entry) => entry.method === "Page.handleJavaScriptDialog");
		assert.deepEqual(dialogReply?.params, { accept: false });

		const consoleText = textOf(await runBrowserAction({ action: "console" }, env));
		assert.match(consoleText, /Page errors \(1\):\n {2}✗ TypeError: x is undefined \(https:\/\/example\.com\/app\.js:10\)/);
		assert.match(consoleText, /\[warning\] deprecated API/);
		assert.match(consoleText, /confirm "Leave\?" → dismissed/);

		const networkText = textOf(await runBrowserAction({ action: "network", failed_only: true }, env));
		assert.match(networkText, /Failed requests \(1/);
		assert.match(networkText, /GET https:\/\/example\.com\/app\.js → FAILED net::ERR_FAILED \[Script\]/);

		const policy = await runBrowserAction({ action: "dialog_policy", policy: "accept" }, env);
		assert.match(textOf(policy), /auto-accepted/);
		browser.emit("Page.javascriptDialogOpening", { type: "prompt", message: "Name?", defaultPrompt: "pi" }, "S1");
		const accepted = browser.sent.filter((entry) => entry.method === "Page.handleJavaScriptDialog").at(-1);
		assert.deepEqual(accepted?.params, { accept: true, promptText: "pi" });

		const tabsText = textOf(await runBrowserAction({ action: "tabs" }, env));
		assert.match(tabsText, /Tabs in \[b1\] \(1\):\n\* t1 Example Domain — https:\/\/example\.com/);
		assert.match(tabsText, /1 error/);

		const failedNav = await runBrowserAction({ action: "navigate", url: "https://unreachable.invalid/" }, env).catch(
			(err: unknown) => err,
		);
		assert.ok(failedNav instanceof Error);
		assert.match(failedNav.message, /net::ERR_NAME_NOT_RESOLVED/);

		const disconnected = await runBrowserAction({ action: "disconnect" }, env);
		assert.match(textOf(disconnected), /Disconnected browser session\(s\): b1/);
		assert.equal(shutdownCount(), 1);
		assert.equal(manager.hasSessions(), false);
		await manager.disposeAll();
		assert.equal(shutdownCount(), 1, "disposeAll after disconnect must be a no-op");
	});

	it("attaches to a live browser non-destructively and never sends Browser.close", async () => {
		const live = new FakeCdpBrowser("ws://127.0.0.1:9222/devtools/browser/user", [
			{ targetId: "U1", url: "https://mail.example.com/", title: "Inbox" },
			{ targetId: "U2", url: "https://docs.example.com/", title: "Docs" },
		]);
		const endpoint: LiveCdpEndpoint = {
			id: "chrome-9222",
			browserName: "Google Chrome",
			host: "127.0.0.1",
			port: 9222,
			wsUrl: live.wsUrl,
			mode: "normal",
			source: "DevToolsActivePort",
		};
		const manager = new BrowserSessionManager({
			selectLiveEndpointForAttach: async () => endpoint,
			connectClient: async () => live,
			captureAriaSnapshot: async (_client, sessionId, generation) =>
				makeSnapshot(live.pageUrl(sessionId), "Inbox", generation, [makeRef("e1", "button", "Compose")]),
			diffAriaSnapshots: fakeDiff,
		});
		const env = { manager, cwd: PKG_ROOT };

		const attached = await runBrowserAction({ action: "attach", port: 9222 }, env);
		const attachText = textOf(attached);
		assert.notEqual(attached.isError, true, attachText);
		assert.match(attachText, /Attached \[b1\] to Google Chrome/);
		assert.match(attachText, /Tabs in \[b1\] \(2\):/);

		const sessionsText = textOf(await runBrowserAction({ action: "sessions" }, env));
		assert.match(sessionsText, /\* \[b1\] .* — Google Chrome \(attached\), 2 tabs/);

		await runBrowserAction({ action: "disconnect" }, env);
		assert.equal(live.methods().includes("Browser.close"), false);
		assert.equal(live.methods().filter((method) => method === "Target.detachFromTarget").length, 2);
		assert.equal(live.methods().includes("Target.closeTarget"), false);
		assert.equal(live.closed, true);
	});

	it("attached sessions default to manual dialogs (never answered, not even beforeunload) and open in a new tab", async () => {
		const live = new FakeCdpBrowser("ws://127.0.0.1:9222/devtools/browser/user", [
			{ targetId: "U1", url: "https://mail.example.com/", title: "Inbox" },
		]);
		const endpoint: LiveCdpEndpoint = {
			id: "chrome-9222",
			browserName: "Google Chrome",
			host: "127.0.0.1",
			port: 9222,
			wsUrl: live.wsUrl,
			mode: "normal",
			source: "DevToolsActivePort",
		};
		const manager = new BrowserSessionManager({
			selectLiveEndpointForAttach: async () => endpoint,
			connectClient: async () => live,
			captureAriaSnapshot: async (_client, sessionId, generation) =>
				makeSnapshot(live.pageUrl(sessionId), "Page", generation, [makeRef("e1", "button", "Compose")]),
			diffAriaSnapshots: fakeDiff,
		});
		const env = { manager, cwd: PKG_ROOT };
		const summary = await manager.attach({ port: 9222 });
		assert.equal(summary.dialogPolicy, "manual");
		assert.equal(summary.activeTabId, "t1");

		live.emit("Page.javascriptDialogOpening", { type: "alert", message: "Unsaved draft" }, "S1");
		live.emit("Page.javascriptDialogOpening", { type: "beforeunload", message: "" }, "S1");
		assert.equal(live.methods().includes("Page.handleJavaScriptDialog"), false, "manual policy must never answer dialogs");
		const report = await manager.getConsole({ tabId: "t1" });
		assert.deepEqual(
			report.dialogs.map((entry) => `${entry.type}:${entry.handled}`),
			["alert:pending", "beforeunload:pending"],
		);
		assert.match(textOf(await runBrowserAction({ action: "console", tab_id: "t1" }, env)), /alert "Unsaved draft" → pending/);

		const opened = await runBrowserAction({ action: "open", url: "https://example.com/" }, env);
		assert.notEqual(opened.isError, true, textOf(opened));
		assert.equal(opened.details?.tabId, "t2", "open in an attached session must not hijack the user's tab");
		assert.equal(live.methods().filter((method) => method === "Target.createTarget").length, 1);
		const navigated = live.sent.filter((entry) => entry.method === "Page.navigate");
		assert.deepEqual(
			navigated.map((entry) => entry.sessionId),
			["S2"],
		);
		assert.equal(live.pageUrl("S1"), "https://mail.example.com/");

		// Explicit tab_id still reuses that tab.
		await runBrowserAction({ action: "open", url: "https://example.org/", tab_id: "t1" }, env);
		assert.equal(live.methods().filter((method) => method === "Target.createTarget").length, 1);
		assert.equal(live.pageUrl("S1"), "https://example.org/");

		const policy = await runBrowserAction({ action: "dialog_policy", policy: "dismiss" }, env);
		assert.match(textOf(policy), /auto-dismissed/);
		live.emit("Page.javascriptDialogOpening", { type: "confirm", message: "Sure?" }, "S1");
		assert.deepEqual(live.sent.find((entry) => entry.method === "Page.handleJavaScriptDialog")?.params, { accept: false });
		const manual = await runBrowserAction({ action: "dialog_policy", policy: "manual" }, env);
		assert.match(textOf(manual), /only be recorded and left open for the user/);

		await manager.disposeAll();
		assert.equal(live.methods().includes("Browser.close"), false);
	});

	it("launched sessions keep the dismiss default and an explicit dialogPolicy wins", async () => {
		const { manager, browser } = createFakeManager();
		const launched = await manager.launch();
		assert.equal(launched.session.dialogPolicy, "dismiss");
		browser.emit("Page.javascriptDialogOpening", { type: "beforeunload", message: "" }, "S1");
		assert.deepEqual(browser.sent.find((entry) => entry.method === "Page.handleJavaScriptDialog")?.params, { accept: true });
		await manager.disposeAll();

		const second = createFakeManager();
		const manualLaunch = await second.manager.launch({ dialogPolicy: "manual" });
		assert.equal(manualLaunch.session.dialogPolicy, "manual");
		second.browser.emit("Page.javascriptDialogOpening", { type: "alert", message: "x" }, "S1");
		assert.equal(second.browser.methods().includes("Page.handleJavaScriptDialog"), false);
		await second.manager.disposeAll();
	});

	it("a failed follow-up snapshot keeps a successful interaction successful and hides secret fill values", async () => {
		const { manager } = createFakeManager();
		const env = { manager, cwd: PKG_ROOT };
		await runBrowserAction({ action: "open", url: "https://example.com/" }, env);
		const click = await runBrowserAction({ action: "click", target: "@e2" }, env).catch((err: unknown) => err);
		// The fake browser has no DOM: the click action itself fails and must surface as an error.
		assert.ok(click instanceof Error);

		manager.click = async (target) => ({ clicked: target, x: 1, y: 2, sessionId: "b1", tabId: "t1" });
		manager.fill = async (target, value) => ({ filled: `${target} textbox "Password"`, value, sessionId: "b1", tabId: "t1" });
		manager.settleAndSnapshot = async () => {
			throw new Error("Tab t1 in session [b1] was closed or crashed.");
		};
		const clicked = await runBrowserAction({ action: "click", target: "@e2" }, env);
		assert.notEqual(clicked.isError, true);
		assert.equal(clicked.details?.ok, true);
		const clickText = textOf(clicked);
		assert.match(clickText, /^Clicked @e2 at \(1, 2\)\./);
		assert.match(clickText, /Warning: the click succeeded, but the follow-up snapshot failed \(Tab t1 in session \[b1\] was closed or crashed\.\)/);
		assert.match(clickText, /Do not repeat the click/);

		const filled = await runBrowserAction({ action: "fill", target: "@e3", value: "hunter2-secret" }, env);
		assert.notEqual(filled.isError, true);
		assert.doesNotMatch(textOf(filled), /hunter2/);
		assert.match(textOf(filled), /with 14 characters \(value hidden\)/);
		const bySelector = await runBrowserAction({ action: "fill", target: "#api-token", value: "tok_123", snapshot: false }, env);
		assert.doesNotMatch(textOf(bySelector), /tok_123/);

		manager.fill = async (target, value) => ({ filled: `${target} textbox "Email"`, value, sessionId: "b1", tabId: "t1" });
		const email = await runBrowserAction({ action: "fill", target: "@e4", value: "me@example.com", snapshot: false }, env);
		assert.match(textOf(email), /with "me@example\.com"/);
		await manager.disposeAll();
	});

	it("rolls back half-attached tabs and dedupes concurrent attaches to one target", async () => {
		const { manager, browser } = createFakeManager();
		await manager.launch();
		const failingSend = browser.send.bind(browser);
		let failNetworkEnable = true;
		browser.send = async <T,>(method: string, params?: Record<string, unknown>, options?: CdpSendOptions): Promise<T> => {
			if (method === "Network.enable" && failNetworkEnable) {
				failNetworkEnable = false;
				await failingSend(method, params, options);
				throw new Error("Network.enable failed");
			}
			return failingSend<T>(method, params, options);
		};
		await assert.rejects(manager.newTab(), /Network\.enable failed/);
		assert.deepEqual(
			manager.listTabs().tabs.map((tab) => tab.tabId),
			["t1"],
			"the half-initialized tab must not linger",
		);
		const detach = browser.sent.filter((entry) => entry.method === "Target.detachFromTarget");
		assert.deepEqual(detach.map((entry) => entry.params), [{ sessionId: "S2" }]);

		// Popups announced twice while the first attach is in flight share one tab.
		browser.emit("Target.targetCreated", { targetInfo: { targetId: "POP", type: "page", url: "about:blank", title: "", openerId: "T1" } });
		browser.emit("Target.targetCreated", { targetInfo: { targetId: "POP", type: "page", url: "about:blank", title: "", openerId: "T1" } });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const popupAttaches = browser.sent.filter((entry) => entry.method === "Target.attachToTarget" && entry.params.targetId === "POP");
		assert.equal(popupAttaches.length, 1);
		assert.equal(manager.listTabs().tabs.filter((tab) => tab.targetId === "POP").length, 1);
		await manager.disposeAll();
	});

	it("disposeAll during an in-flight launch or attach closes the new browser instead of leaking it", async () => {
		const { manager, browser, shutdownCount } = createFakeManager();
		let releaseLaunch: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			releaseLaunch = resolve;
		});
		const original = (manager as unknown as { deps: { launchBrowserProcess: () => Promise<LaunchedBrowserHandle> } }).deps;
		const launchHandle = original.launchBrowserProcess;
		original.launchBrowserProcess = async () => {
			await gate;
			return launchHandle();
		};
		const pending = manager.launch();
		await manager.disposeAll();
		releaseLaunch();
		await assert.rejects(pending, /shut down while launching Fake Chrome/);
		assert.equal(shutdownCount(), 1);
		assert.equal(browser.closed, true);
		assert.equal(manager.hasSessions(), false);

		const live = new FakeCdpBrowser("ws://127.0.0.1:9222/devtools/browser/user", [
			{ targetId: "U1", url: "https://mail.example.com/", title: "Inbox" },
		]);
		let releaseConnect: () => void = () => undefined;
		const connectGate = new Promise<void>((resolve) => {
			releaseConnect = resolve;
		});
		const attacher = new BrowserSessionManager({
			selectLiveEndpointForAttach: async () => ({
				id: "chrome-9222",
				browserName: "Google Chrome",
				host: "127.0.0.1",
				port: 9222,
				wsUrl: live.wsUrl,
				mode: "normal",
				source: "test",
			}),
			connectClient: async () => {
				await connectGate;
				return live;
			},
		});
		const attaching = attacher.attach();
		await attacher.disposeAll();
		releaseConnect();
		await assert.rejects(attaching, /shut down while connecting to Google Chrome/);
		assert.equal(live.closed, true);
		assert.equal(live.methods().includes("Target.attachToTarget"), false);
		assert.equal(attacher.hasSessions(), false);
	});

	it("normalizes bare hosts, localhost ports and file paths for navigation", () => {
		assert.match(normalizeNavigationUrl("example.com"), /^https:\/\/example\.com\/?$/);
		assert.match(normalizeNavigationUrl("localhost:3000/app"), /^http:\/\/localhost:3000\/app$/);
		assert.match(normalizeNavigationUrl("https://a.test/x"), /^https:\/\/a\.test\/x$/);
	});
});

describe("formatters", () => {
	it("formats refs, diffs, sessions and tabs compactly", () => {
		assert.equal(formatRefEntry(makeRef("e3", "button", "Submit", { disabled: true })), '@e3 button "Submit" [disabled]');
		assert.equal(
			formatRefEntry(makeRef("e4", "checkbox", "Remember me", { checked: "true", focused: true })),
			'@e4 checkbox "Remember me" [checked=true, focused]',
		);

		const diffText = formatSnapshotDiff({
			previousUrl: "https://a.test/",
			currentUrl: "https://a.test/",
			urlChanged: false,
			titleChanged: false,
			addedRefs: [makeRef("e9", "dialog", "Saved")],
			changedRefs: [{ before: makeRef("e2", "textbox", "Email"), after: makeRef("e2", "textbox", "Email", { value: "me@x.io" }) }],
			removedCount: 1,
			summaryText: "",
		});
		assert.match(diffText, /Added \(1\):\n {4}\+ @e9 dialog "Saved"/);
		assert.match(diffText, /~ @e2 textbox "Email" {2}⇒ {2}@e2 textbox "Email" value="me@x\.io"/);
		assert.match(diffText, /Removed: 1/);

		assert.match(formatSessions([]), /No browser sessions/);
		assert.match(formatTabs([], "b2"), /Tabs in \[b2\] \(0\):\n {2}\(no open tabs\)/);
	});

	it("formats console, network, doctor and web_inspect reports", () => {
		const consoleText = formatConsole(
			[{ seq: 1, timestamp: 0, level: "error", text: "boom", url: "https://a.test/x.js", lineNumber: 3 }],
			[],
			[{ seq: 2, timestamp: 0, type: "alert", message: "hi", handled: "dismissed" }],
		);
		assert.match(consoleText, /Page errors \(0\):\n {2}\(none\)/);
		assert.match(consoleText, /\[error\] boom \(https:\/\/a\.test\/x\.js:3\)/);
		assert.match(consoleText, /alert "hi" → dismissed/);

		const networkText = formatNetwork(
			[
				{ seq: 1, requestId: "1", timestamp: 0, method: "POST", url: "https://a.test/api", resourceType: "Fetch", status: 500, statusText: "Internal Server Error", failed: false },
				{ seq: 2, requestId: "2", timestamp: 0, method: "GET", url: "https://a.test/img.png", resourceType: "Image", failed: true, canceled: true },
			],
			{ totalTracked: 7 },
		);
		assert.match(networkText, /Network requests \(2 of 7 tracked\):/);
		assert.match(networkText, /POST https:\/\/a\.test\/api → 500 Internal Server Error \[Fetch\]/);
		assert.match(networkText, /GET https:\/\/a\.test\/img\.png → CANCELED \[Image\]/);

		const doctorText = formatDoctorReport({
			platform: "linux",
			arch: "x64",
			preferredBrowser: null,
			browsers: [],
			liveEndpoints: [],
			guidance: ["Install Google Chrome or set PI_CDP_BROWSER."],
		});
		assert.match(doctorText, /^pi-cdp doctor — linux\/x64\nPreferred browser: none found/);
		assert.match(doctorText, /Guidance:\n {2}- Install Google Chrome/);

		const inspectText = formatWebInspectResult({
			url: "example.com",
			finalUrl: "https://example.com/",
			title: "Example Domain",
			httpStatus: 200,
			browserName: "Chromium",
			snapshot: makeSnapshot("https://example.com/", "Example Domain", 1, [makeRef("e1", "link", "More information")]),
			consoleEntries: [],
			pageErrors: [{ seq: 1, timestamp: 0, message: "ReferenceError: foo is not defined" }],
			failedRequests: [],
			screenshot: { base64: "AAAA", mimeType: "image/png", width: 1280, height: 720, fullPage: false },
			durationMs: 321,
			warnings: ["waitForText timed out"],
		});
		assert.match(inspectText, /^web_inspect https:\/\/example\.com\/ — HTTP 200 \(Chromium, 321ms\)/);
		assert.match(inspectText, /Health: 1 page error, 0 failed requests, 0 console warnings\/errors/);
		assert.match(inspectText, /⚠ waitForText timed out/);
		assert.match(inspectText, /Screenshot 1280×720 image\/png/);
		assert.match(inspectText, /✗ ReferenceError: foo is not defined/);
	});
});
