/**
 * Multi-session / multi-tab browser manager for pi-cdp.
 *
 * Each browser session (b1, b2, …) owns one browser-level CDP connection. Every tab (t1, t2, …)
 * is a flattened `Target.attachToTarget({ flatten: true })` session multiplexed over that socket,
 * with its own console / page-error / network / dialog ring buffers and navigation generation.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import {
	capturePageScreenshot,
	clickTarget,
	evaluateExpression,
	fillTarget,
	hoverTarget,
	pressKey,
	scrollViewport,
	selectTarget,
	typeText,
	waitForCondition,
} from "./cdp/actions.ts";
import { CdpMultiplexClient, launchBrowserProcess } from "./cdp/client.ts";
import { captureAriaSnapshot, diffAriaSnapshots } from "./cdp/snapshot.ts";
import { selectLiveEndpointForAttach } from "./discovery/browsers.ts";
import type {
	AriaSnapshot,
	AriaSnapshotOptions,
	BrowserSessionSummary,
	CdpClientInterface,
	CdpEventMessage,
	ClickOptions,
	ConsoleEntry,
	DialogEntry,
	DialogPolicy,
	LaunchBrowserProcessOptions,
	LaunchedBrowserHandle,
	NetworkEntry,
	PageErrorEntry,
	ScreenshotOptions,
	ScreenshotResult,
	SnapshotDiff,
	TabSummary,
	TargetResolutionContext,
	WaitConditionOptions,
	WebInspectOptions,
	WebInspectResult,
} from "./types.ts";

/** Maximum entries retained per tab for each console / error / network / dialog ring buffer. */
export const MAX_BUFFER_ENTRIES = 200;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_ATTACH_TIMEOUT_MS = 30_000;
const DEFAULT_INSPECT_TIMEOUT_MS = 30_000;
const DEFAULT_SETTLE_QUIET_MS = 150;
const MAX_CONSOLE_TEXT_CHARS = 2_000;
const MAX_TRACKED_DOCUMENT_LOADERS = 64;

export interface TabRef {
	sessionId?: string;
	tabId?: string;
}

export interface LaunchSessionOptions {
	name?: string;
	headless?: boolean;
	executablePath?: string;
	userDataDir?: string;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	url?: string;
	cwd?: string;
	extraArgs?: string[];
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface AttachSessionOptions {
	wsUrl?: string;
	host?: string;
	port?: number;
	name?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface NavigationOptions extends TabRef {
	cwd?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	snapshot?: AriaSnapshotOptions;
	newTab?: boolean;
}

export interface NavigationResult {
	sessionId: string;
	tabId: string;
	requestedUrl: string;
	finalUrl: string;
	title: string;
	httpStatus?: number;
	timedOut: boolean;
	durationMs: number;
	snapshot: AriaSnapshot;
}

export interface LaunchSessionResult {
	session: BrowserSessionSummary;
	navigation?: NavigationResult;
}

export interface SnapshotRequestOptions extends AriaSnapshotOptions, TabRef {
	diff?: boolean;
}

export interface SnapshotOutcome {
	sessionId: string;
	tabId: string;
	snapshot: AriaSnapshot;
	diff?: SnapshotDiff;
}

export interface SettleOptions extends TabRef {
	quietMs?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
	snapshot?: AriaSnapshotOptions;
}

export interface ConsoleReport {
	sessionId: string;
	tabId: string;
	console: ConsoleEntry[];
	errors: PageErrorEntry[];
	dialogs: DialogEntry[];
}

export interface NetworkReport {
	sessionId: string;
	tabId: string;
	entries: NetworkEntry[];
	totalTracked: number;
}

export interface WebInspectReport extends WebInspectResult {
	warnings: string[];
	timedOut: boolean;
}

export type ActionOutcome<T> = T & { sessionId: string; tabId: string };

export interface BrowserSessionManagerDeps {
	launchBrowserProcess: (opts: LaunchBrowserProcessOptions) => Promise<LaunchedBrowserHandle>;
	connectClient: (wsUrl: string, timeoutMs?: number, signal?: AbortSignal) => Promise<CdpClientInterface>;
	selectLiveEndpointForAttach: typeof selectLiveEndpointForAttach;
	captureAriaSnapshot: typeof captureAriaSnapshot;
	diffAriaSnapshots: typeof diffAriaSnapshots;
}

const DEFAULT_DEPS: BrowserSessionManagerDeps = {
	launchBrowserProcess,
	connectClient: (wsUrl, timeoutMs, signal) => CdpMultiplexClient.connect(wsUrl, timeoutMs, signal),
	selectLiveEndpointForAttach,
	captureAriaSnapshot,
	diffAriaSnapshots,
};

/** Fixed-capacity FIFO buffer; evicted items are reported through `onEvict`. */
class RingBuffer<T> {
	private items: T[] = [];
	private readonly capacity: number;
	private readonly onEvict?: (item: T) => void;

	constructor(capacity: number, onEvict?: (item: T) => void) {
		this.capacity = capacity;
		this.onEvict = onEvict;
	}

	push(item: T): void {
		this.items.push(item);
		while (this.items.length > this.capacity) {
			const evicted = this.items.shift();
			if (evicted !== undefined && this.onEvict) {
				this.onEvict(evicted);
			}
		}
	}

	toArray(): T[] {
		return [...this.items];
	}

	clear(): void {
		this.items = [];
	}

	get size(): number {
		return this.items.length;
	}
}

interface EventWaiter {
	methods: ReadonlySet<string>;
	predicate?: (event: CdpEventMessage) => boolean;
	resolve: (event: CdpEventMessage | null) => void;
}

interface PendingWait {
	promise: Promise<CdpEventMessage | null>;
	cancel: () => void;
}

interface TabState {
	tabId: string;
	targetId: string;
	cdpSessionId: string;
	title: string;
	url: string;
	mainFrameId?: string;
	mainDocumentLoaderId?: string;
	generation: number;
	loading: boolean;
	seq: number;
	console: RingBuffer<ConsoleEntry>;
	errors: RingBuffer<PageErrorEntry>;
	network: RingBuffer<NetworkEntry>;
	networkById: Map<string, NetworkEntry>;
	dialogs: RingBuffer<DialogEntry>;
	documentStatusByLoader: Map<string, number>;
	latestSnapshot: AriaSnapshot | null;
	previousSnapshot: AriaSnapshot | null;
	waiters: Set<EventWaiter>;
	closed: boolean;
}

interface SessionState {
	id: string;
	name: string;
	mode: "launched" | "attached";
	browserName: string;
	wsUrl: string;
	headless: boolean;
	pid?: number;
	client: CdpClientInterface;
	handle?: LaunchedBrowserHandle;
	tabs: Map<string, TabState>;
	tabsByCdpSession: Map<string, TabState>;
	pendingAttachTargets: Set<string>;
	activeTabId: string | null;
	dialogPolicy: DialogPolicy;
	nextTabNumber: number;
	viewport?: { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean };
	unsubscribe: () => void;
	disposed: boolean;
}

interface TargetInfoLike {
	targetId: string;
	type: string;
	title: string;
	url: string;
	openerId?: string;
}

interface NavigateCommandResult {
	frameId?: string;
	loaderId?: string;
	errorText?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		// SAFETY: narrowed to a non-null, non-array object; CDP payloads are JSON objects.
		return value as Record<string, unknown>;
	}
	return undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toTargetInfo(value: unknown): TargetInfoLike | undefined {
	const rec = asRecord(value);
	const targetId = asString(rec?.targetId);
	if (!rec || !targetId) {
		return undefined;
	}
	return {
		targetId,
		type: asString(rec.type) ?? "other",
		title: asString(rec.title) ?? "",
		url: asString(rec.url) ?? "",
		openerId: asString(rec.openerId),
	};
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function truncateText(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("Aborted"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("Aborted"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function isFailedRequest(entry: NetworkEntry): boolean {
	if (entry.failed) {
		return entry.canceled !== true;
	}
	return typeof entry.status === "number" && entry.status >= 400;
}

/** Render a Runtime.RemoteObject argument of a console call as compact text. */
function remoteObjectToText(value: unknown): string {
	const obj = asRecord(value);
	if (!obj) {
		return String(value);
	}
	if ("value" in obj) {
		const raw = obj.value;
		if (typeof raw === "string") {
			return raw;
		}
		try {
			return JSON.stringify(raw) ?? String(raw);
		} catch {
			return String(raw);
		}
	}
	return asString(obj.unserializableValue) ?? asString(obj.description) ?? asString(obj.type) ?? "";
}

function firstCallFrame(stackTrace: unknown): { url?: string; lineNumber?: number } {
	const frames = asRecord(stackTrace)?.callFrames;
	if (!Array.isArray(frames) || frames.length === 0) {
		return {};
	}
	const top = asRecord(frames[0]);
	const line = asNumber(top?.lineNumber);
	return {
		url: asString(top?.url) || undefined,
		lineNumber: line === undefined ? undefined : line + 1,
	};
}

const KNOWN_SCHEME = /^(https?|file|about|data|blob|chrome|chrome-extension|edge|brave|view-source|javascript|ws|wss):/i;
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$|\?|#)/i;

/**
 * Normalize agent-provided navigation targets:
 * `example.com` → `https://example.com`, `localhost:3000` → `http://localhost:3000`,
 * `./dist/index.html` (existing local path) → `file:///…/dist/index.html`.
 */
export function normalizeNavigationUrl(raw: string, cwd?: string): string {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		throw new Error("A non-empty URL is required.");
	}
	if (KNOWN_SCHEME.test(trimmed) || trimmed.includes("://")) {
		return trimmed;
	}
	if (LOCAL_HOST.test(trimmed)) {
		return `http://${trimmed}`;
	}
	const expanded = trimmed.startsWith("~") ? `${homedir()}${trimmed.slice(1)}` : trimmed;
	const looksLikePath =
		expanded.startsWith(".") ||
		expanded.startsWith("/") ||
		expanded.startsWith("\\") ||
		/^[a-zA-Z]:[\\/]/.test(expanded) ||
		trimmed.startsWith("~");
	const absolute = isAbsolute(expanded) ? expanded : resolvePath(cwd ?? process.cwd(), expanded);
	if (looksLikePath || existsSync(absolute)) {
		return pathToFileURL(absolute).href;
	}
	return `https://${trimmed}`;
}

/**
 * Manages concurrent browser sessions (launched or non-destructively attached) and their tabs.
 */
export class BrowserSessionManager {
	private readonly deps: BrowserSessionManagerDeps;
	private readonly sessions = new Map<string, SessionState>();
	private readonly listeners = new Set<() => void>();
	private activeSessionId: string | null = null;
	private nextSessionNumber = 1;

	constructor(deps: Partial<BrowserSessionManagerDeps> = {}) {
		this.deps = { ...DEFAULT_DEPS, ...deps };
	}

	// ───────────────────────────── change notifications ─────────────────────────────

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emitChange(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// Listener failures (e.g. a torn-down TUI) must never break browser control.
			}
		}
	}

	// ───────────────────────────── session lifecycle ─────────────────────────────

	get activeSession(): string | null {
		return this.activeSessionId;
	}

	hasSessions(): boolean {
		this.pruneDeadSessions();
		return this.sessions.size > 0;
	}

	listSessions(): BrowserSessionSummary[] {
		this.pruneDeadSessions();
		return [...this.sessions.values()].map((session) => this.summarizeSession(session));
	}

	switchSession(sessionId: string): BrowserSessionSummary {
		this.pruneDeadSessions();
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Unknown browser session '${sessionId}'. Active sessions: ${this.describeSessionIds()}.`);
		}
		this.activeSessionId = session.id;
		this.emitChange();
		return this.summarizeSession(session);
	}

	async launch(opts: LaunchSessionOptions = {}): Promise<LaunchSessionResult> {
		const timeoutMs = opts.timeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;
		const headless = opts.headless ?? true;
		const handle = await this.deps.launchBrowserProcess({
			executablePath: opts.executablePath,
			cwd: opts.cwd,
			headless,
			userDataDir: opts.userDataDir,
			viewport: opts.viewport,
			extraArgs: opts.extraArgs,
			timeoutMs,
			signal: opts.signal,
		});
		const id = `b${this.nextSessionNumber++}`;
		const session = this.createSessionState({
			id,
			name: opts.name ?? id,
			mode: "launched",
			browserName: handle.browserName,
			wsUrl: handle.wsUrl,
			headless: handle.headless,
			pid: handle.pid,
			client: handle.client,
			handle,
			viewport: opts.viewport,
		});
		try {
			await this.attachInitialTabs(session, timeoutMs, opts.signal);
		} catch (err) {
			session.disposed = true;
			session.unsubscribe();
			await handle.shutdown().catch(() => undefined);
			throw new Error(`Launched ${handle.browserName} but failed to attach a page target: ${errorMessage(err)}`);
		}
		this.sessions.set(id, session);
		this.activeSessionId = id;
		this.emitChange();

		let navigation: NavigationResult | undefined;
		if (opts.url) {
			navigation = await this.navigate(opts.url, { sessionId: id, cwd: opts.cwd, signal: opts.signal });
		}
		return { session: this.summarizeSession(session), navigation };
	}

	async attach(opts: AttachSessionOptions = {}): Promise<BrowserSessionSummary> {
		const timeoutMs = opts.timeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;
		const endpoint = await this.deps.selectLiveEndpointForAttach({
			host: opts.host,
			port: opts.port,
			wsUrl: opts.wsUrl,
			includeApprovalMode: true,
		});
		const client = await this.deps.connectClient(endpoint.wsUrl, timeoutMs, opts.signal);
		const id = `b${this.nextSessionNumber++}`;
		const session = this.createSessionState({
			id,
			name: opts.name ?? `${endpoint.browserName} (attached)`,
			mode: "attached",
			browserName: endpoint.browserName,
			wsUrl: endpoint.wsUrl,
			headless: false,
			client,
		});
		try {
			await this.attachInitialTabs(session, timeoutMs, opts.signal);
		} catch (err) {
			session.disposed = true;
			session.unsubscribe();
			await this.detachAttachedSession(session);
			throw new Error(`Connected to ${endpoint.browserName} but failed to attach page targets: ${errorMessage(err)}`);
		}
		this.sessions.set(id, session);
		this.activeSessionId = id;
		this.emitChange();
		return this.summarizeSession(session);
	}

	/**
	 * Disconnect one session (default: active) or all sessions.
	 * Launched sessions are shut down; attached sessions only detach our CDP target sessions and
	 * close the WebSocket — the user's browser keeps running untouched.
	 */
	async disconnect(opts: { sessionId?: string; all?: boolean } = {}): Promise<{ closedSessions: string[] }> {
		const targets: SessionState[] = [];
		if (opts.all) {
			targets.push(...this.sessions.values());
		} else {
			const id = opts.sessionId ?? this.activeSessionId;
			const session = id ? this.sessions.get(id) : undefined;
			if (session) {
				targets.push(session);
			}
		}
		await Promise.allSettled(targets.map((session) => this.disposeSession(session)));
		return { closedSessions: targets.map((session) => session.id) };
	}

	/** Idempotently disconnect / shut down every session (used on Pi `session_shutdown`). */
	async disposeAll(): Promise<void> {
		const all = [...this.sessions.values()];
		if (all.length === 0) {
			return;
		}
		await Promise.allSettled(all.map((session) => this.disposeSession(session)));
	}

	setDialogPolicy(policy: DialogPolicy, sessionId?: string): BrowserSessionSummary {
		const session = this.requireSession(sessionId);
		session.dialogPolicy = policy;
		this.emitChange();
		return this.summarizeSession(session);
	}

	// ───────────────────────────── tabs ─────────────────────────────

	listTabs(sessionId?: string): { sessionId: string | null; tabs: TabSummary[] } {
		this.pruneDeadSessions();
		const id = sessionId ?? this.activeSessionId;
		const session = id ? this.sessions.get(id) : undefined;
		if (!session) {
			if (sessionId) {
				throw new Error(`Unknown browser session '${sessionId}'. Active sessions: ${this.describeSessionIds()}.`);
			}
			return { sessionId: null, tabs: [] };
		}
		return { sessionId: session.id, tabs: this.summarizeTabs(session) };
	}

	async newTab(
		url?: string,
		opts: { sessionId?: string; cwd?: string; timeoutMs?: number; signal?: AbortSignal; snapshot?: AriaSnapshotOptions } = {},
	): Promise<{ tab: TabSummary; navigation?: NavigationResult }> {
		const session = this.requireSession(opts.sessionId);
		const tab = await this.createTab(session, opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, opts.signal);
		session.activeTabId = tab.tabId;
		this.emitChange();
		let navigation: NavigationResult | undefined;
		if (url) {
			navigation = await this.navigate(url, {
				sessionId: session.id,
				tabId: tab.tabId,
				cwd: opts.cwd,
				timeoutMs: opts.timeoutMs,
				signal: opts.signal,
				snapshot: opts.snapshot,
			});
		}
		return { tab: this.summarizeTab(session, tab), navigation };
	}

	async switchTab(tabId: string, sessionId?: string): Promise<TabSummary> {
		const session = this.requireSession(sessionId);
		const tab = session.tabs.get(tabId);
		if (!tab) {
			throw new Error(`Unknown tab '${tabId}' in session [${session.id}]. Tabs: ${[...session.tabs.keys()].join(", ") || "(none)"}.`);
		}
		session.activeTabId = tab.tabId;
		await session.client
			.send("Target.activateTarget", { targetId: tab.targetId }, { timeoutMs: 5_000 })
			.catch(() => undefined);
		this.emitChange();
		return this.summarizeTab(session, tab);
	}

	async closeTab(tabId?: string, sessionId?: string): Promise<{ closedTabId: string; activeTabId: string | null }> {
		const session = this.requireSession(sessionId);
		const id = tabId ?? session.activeTabId;
		const tab = id ? session.tabs.get(id) : undefined;
		if (!tab) {
			throw new Error(`Unknown tab '${id ?? "(none)"}' in session [${session.id}].`);
		}
		await session.client
			.send("Target.closeTarget", { targetId: tab.targetId }, { timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS })
			.catch(() => undefined);
		this.removeTab(session, tab);
		return { closedTabId: tab.tabId, activeTabId: session.activeTabId };
	}

	// ───────────────────────────── navigation ─────────────────────────────

	/** Navigate the active tab (lazily launching a default headless session b1 when none exists). */
	async open(url: string, opts: NavigationOptions = {}): Promise<NavigationResult> {
		this.pruneDeadSessions();
		if (this.sessions.size === 0) {
			const launched = await this.launch({ cwd: opts.cwd, signal: opts.signal });
			return this.navigate(url, { ...opts, sessionId: launched.session.id, tabId: undefined, newTab: false });
		}
		if (opts.newTab) {
			const created = await this.newTab(url, {
				sessionId: opts.sessionId,
				cwd: opts.cwd,
				timeoutMs: opts.timeoutMs,
				signal: opts.signal,
				snapshot: opts.snapshot,
			});
			if (created.navigation) {
				return created.navigation;
			}
		}
		return this.navigate(url, opts);
	}

	async navigate(url: string, opts: NavigationOptions = {}): Promise<NavigationResult> {
		this.pruneDeadSessions();
		if (this.sessions.size === 0) {
			const launched = await this.launch({ cwd: opts.cwd, signal: opts.signal });
			return this.navigate(url, { ...opts, sessionId: launched.session.id, tabId: undefined });
		}
		const { session, tab } = await this.resolveTab(opts, opts.signal);
		const target = normalizeNavigationUrl(url, opts.cwd);
		return this.runNavigation(session, tab, target, "navigate", opts, async (timeoutMs) => {
			const result = await session.client.send<NavigateCommandResult>(
				"Page.navigate",
				{ url: target },
				{ sessionId: tab.cdpSessionId, timeoutMs, signal: opts.signal },
			);
			if (result.errorText) {
				throw new Error(`Navigation to ${target} failed: ${result.errorText}`);
			}
			return result;
		});
	}

	async reload(opts: NavigationOptions & { ignoreCache?: boolean } = {}): Promise<NavigationResult> {
		const { session, tab } = await this.resolveTab(opts, opts.signal);
		return this.runNavigation(session, tab, tab.url, "reload", opts, async (timeoutMs) => {
			await session.client.send(
				"Page.reload",
				{ ignoreCache: opts.ignoreCache ?? false },
				{ sessionId: tab.cdpSessionId, timeoutMs, signal: opts.signal },
			);
			return {};
		});
	}

	goBack(opts: NavigationOptions = {}): Promise<NavigationResult> {
		return this.navigateHistory(-1, opts);
	}

	goForward(opts: NavigationOptions = {}): Promise<NavigationResult> {
		return this.navigateHistory(1, opts);
	}

	async setViewport(
		width: number,
		height: number,
		deviceScaleFactor?: number,
		mobile?: boolean,
		ref: TabRef = {},
	): Promise<ActionOutcome<{ width: number; height: number; deviceScaleFactor: number; mobile: boolean }>> {
		const { session, tab } = await this.resolveTab(ref);
		const metrics = { width, height, deviceScaleFactor: deviceScaleFactor ?? 1, mobile: mobile ?? false };
		await session.client.send("Emulation.setDeviceMetricsOverride", metrics, {
			sessionId: tab.cdpSessionId,
			timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
		});
		session.viewport = metrics;
		return { ...metrics, sessionId: session.id, tabId: tab.tabId };
	}

	// ───────────────────────────── snapshots ─────────────────────────────

	async snapshot(opts: SnapshotRequestOptions = {}): Promise<SnapshotOutcome> {
		const { session, tab } = await this.resolveTab(opts, opts.signal);
		const { diff: wantDiff, sessionId: _sessionId, tabId: _tabId, ...snapshotOptions } = opts;
		const snapshot = await this.captureSnapshotForTab(session, tab, snapshotOptions);
		const previous = tab.previousSnapshot;
		const diff = wantDiff && previous ? this.deps.diffAriaSnapshots(previous, snapshot) : undefined;
		return { sessionId: session.id, tabId: tab.tabId, snapshot, diff };
	}

	/**
	 * Let the page settle after an interaction (short quiet period, then wait for any in-flight
	 * top-frame load), and capture a fresh snapshot diffed against the previous one.
	 */
	async settleAndSnapshot(opts: SettleOptions = {}): Promise<SnapshotOutcome> {
		const { session, tab } = await this.resolveTab(opts, opts.signal);
		await sleep(opts.quietMs ?? DEFAULT_SETTLE_QUIET_MS, opts.signal);
		if (tab.loading && !tab.closed) {
			const wait = this.waitForTabEvent(
				tab,
				["Page.loadEventFired", "Page.frameStoppedLoading"],
				opts.timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
				opts.signal,
				(event) => event.method === "Page.loadEventFired" || asString(event.params.frameId) === tab.mainFrameId,
			);
			await wait.promise;
			opts.signal?.throwIfAborted();
		}
		const active = this.lookupLiveTab(session, tab);
		let snapshot: AriaSnapshot;
		try {
			snapshot = await this.captureSnapshotForTab(session, active, opts.snapshot);
		} catch {
			// A navigation may have swapped the document mid-capture; retry once on the new document.
			await sleep(300, opts.signal);
			snapshot = await this.captureSnapshotForTab(session, this.lookupLiveTab(session, active), opts.snapshot);
		}
		const previous = active.previousSnapshot;
		const diff = previous ? this.deps.diffAriaSnapshots(previous, snapshot) : undefined;
		return { sessionId: session.id, tabId: active.tabId, snapshot, diff };
	}

	// ───────────────────────────── element & page actions ─────────────────────────────

	async click(target: string, opts: ClickOptions & TabRef = {}): Promise<ActionOutcome<{ clicked: string; x: number; y: number }>> {
		const { session, tab, ctx } = await this.actionContext(opts, opts.timeoutMs, opts.signal);
		const res = await clickTarget(ctx, target, {
			doubleClick: opts.doubleClick,
			button: opts.button,
			timeoutMs: opts.timeoutMs,
			signal: opts.signal,
		});
		return { ...res, sessionId: session.id, tabId: tab.tabId };
	}

	async fill(
		target: string,
		value: string,
		opts: TabRef & { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<ActionOutcome<{ filled: string; value: string }>> {
		const { session, tab, ctx } = await this.actionContext(opts, opts.timeoutMs, opts.signal);
		const res = await fillTarget(ctx, target, value);
		return { ...res, sessionId: session.id, tabId: tab.tabId };
	}

	async select(
		target: string,
		values: string[],
		opts: TabRef & { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<ActionOutcome<{ selected: string[]; target: string }>> {
		const { session, tab, ctx } = await this.actionContext(opts, opts.timeoutMs, opts.signal);
		const res = await selectTarget(ctx, target, values);
		return { ...res, sessionId: session.id, tabId: tab.tabId };
	}

	async hover(
		target: string,
		opts: TabRef & { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<ActionOutcome<{ hovered: string; x: number; y: number }>> {
		const { session, tab, ctx } = await this.actionContext(opts, opts.timeoutMs, opts.signal);
		const res = await hoverTarget(ctx, target);
		return { ...res, sessionId: session.id, tabId: tab.tabId };
	}

	async type(
		text: string,
		opts: TabRef & { submit?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<ActionOutcome<{ typed: number; submitted: boolean }>> {
		const { session, tab } = await this.resolveTab(opts, opts.signal);
		await typeText(session.client, tab.cdpSessionId, text, opts.submit, opts.timeoutMs, opts.signal);
		return { typed: text.length, submitted: opts.submit ?? false, sessionId: session.id, tabId: tab.tabId };
	}

	async press(
		key: string,
		opts: TabRef & { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<ActionOutcome<{ pressed: string }>> {
		const { session, tab } = await this.resolveTab(opts, opts.signal);
		await pressKey(session.client, tab.cdpSessionId, key, opts.timeoutMs, opts.signal);
		return { pressed: key, sessionId: session.id, tabId: tab.tabId };
	}

	async scroll(
		opts: TabRef & {
			direction?: "up" | "down" | "left" | "right" | "top" | "bottom";
			amountPx?: number;
			target?: string;
			timeoutMs?: number;
			signal?: AbortSignal;
		} = {},
	): Promise<ActionOutcome<{ scrollX: number; scrollY: number }>> {
		const { session, tab, ctx } = await this.actionContext(opts, opts.timeoutMs, opts.signal);
		const res = await scrollViewport(ctx, { direction: opts.direction, amountPx: opts.amountPx, target: opts.target });
		return { ...res, sessionId: session.id, tabId: tab.tabId };
	}

	async wait(opts: WaitConditionOptions & TabRef = {}): Promise<ActionOutcome<{ matched: string; elapsedMs: number }>> {
		const { session, tab } = await this.resolveTab(opts, opts.signal);
		const { sessionId: _sessionId, tabId: _tabId, ...condition } = opts;
		const res = await waitForCondition(session.client, tab.cdpSessionId, condition);
		return { ...res, sessionId: session.id, tabId: tab.tabId };
	}

	async evaluate(
		expression: string,
		opts: TabRef & { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<ActionOutcome<{ valueText: string; isError: boolean }>> {
		const { session, tab } = await this.resolveTab(opts, opts.signal);
		const res = await evaluateExpression(session.client, tab.cdpSessionId, expression, opts.timeoutMs, opts.signal);
		return { ...res, sessionId: session.id, tabId: tab.tabId };
	}

	async screenshot(opts: ScreenshotOptions & TabRef & { cwd?: string } = {}): Promise<ActionOutcome<ScreenshotResult>> {
		const { session, tab, ctx } = await this.actionContext(opts, opts.timeoutMs, opts.signal);
		const { sessionId: _sessionId, tabId: _tabId, cwd, ...shotOptions } = opts;
		const res = await capturePageScreenshot(ctx, shotOptions, cwd);
		return { ...res, sessionId: session.id, tabId: tab.tabId };
	}

	// ───────────────────────────── diagnostics buffers ─────────────────────────────

	async getConsole(opts: TabRef & { limit?: number; clear?: boolean } = {}): Promise<ConsoleReport> {
		const { session, tab } = await this.resolveTab(opts, undefined, false);
		const limit = opts.limit ?? MAX_BUFFER_ENTRIES;
		const report: ConsoleReport = {
			sessionId: session.id,
			tabId: tab.tabId,
			console: tab.console.toArray().slice(-limit),
			errors: tab.errors.toArray().slice(-limit),
			dialogs: tab.dialogs.toArray().slice(-limit),
		};
		if (opts.clear) {
			tab.console.clear();
			tab.errors.clear();
			tab.dialogs.clear();
		}
		return report;
	}

	async getNetwork(opts: TabRef & { failedOnly?: boolean; limit?: number; clear?: boolean } = {}): Promise<NetworkReport> {
		const { session, tab } = await this.resolveTab(opts, undefined, false);
		const all = tab.network.toArray();
		const filtered = opts.failedOnly ? all.filter(isFailedRequest) : all;
		const limit = opts.limit ?? 50;
		const report: NetworkReport = {
			sessionId: session.id,
			tabId: tab.tabId,
			entries: filtered.slice(-limit).map((entry) => ({ ...entry })),
			totalTracked: all.length,
		};
		if (opts.clear) {
			tab.network.clear();
			tab.networkById.clear();
		}
		return report;
	}

	// ───────────────────────────── one-shot inspection ─────────────────────────────

	/**
	 * Launch an isolated headless browser, render `opts.url`, collect an @eN accessibility snapshot,
	 * console / page errors, failed requests and an optional screenshot, then always shut it down.
	 */
	async runWebInspect(opts: WebInspectOptions): Promise<WebInspectReport> {
		const started = Date.now();
		const timeoutMs = opts.timeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS;
		const url = normalizeNavigationUrl(opts.url, opts.cwd);
		const handle = await this.deps.launchBrowserProcess({
			cwd: opts.cwd,
			headless: true,
			viewport: opts.viewport,
			timeoutMs,
			signal: opts.signal,
		});
		const session = this.createSessionState({
			id: "inspect",
			name: "web_inspect",
			mode: "launched",
			browserName: handle.browserName,
			wsUrl: handle.wsUrl,
			headless: true,
			pid: handle.pid,
			client: handle.client,
			handle,
			viewport: opts.viewport,
		});
		try {
			await this.attachInitialTabs(session, timeoutMs, opts.signal);
			const tab = this.firstTab(session);
			const warnings: string[] = [];
			const nav = await this.runNavigation(
				session,
				tab,
				url,
				"navigate",
				{ timeoutMs, signal: opts.signal, skipSnapshot: true },
				async (sendTimeout) => {
					const result = await session.client.send<NavigateCommandResult>(
						"Page.navigate",
						{ url },
						{ sessionId: tab.cdpSessionId, timeoutMs: sendTimeout, signal: opts.signal },
					);
					if (result.errorText) {
						throw new Error(`Navigation to ${url} failed: ${result.errorText}`);
					}
					return result;
				},
			);
			if (nav.timedOut) {
				warnings.push(`Page load event did not fire within ${timeoutMs}ms; inspected the partially loaded page.`);
			}
			if (opts.waitForSelector || opts.waitForText) {
				try {
					await waitForCondition(session.client, tab.cdpSessionId, {
						selector: opts.waitForSelector,
						text: opts.waitForText,
						timeoutMs,
						signal: opts.signal,
					});
				} catch (err) {
					opts.signal?.throwIfAborted();
					warnings.push(`Wait condition not met: ${errorMessage(err)}`);
				}
			}
			if (opts.waitMs && opts.waitMs > 0) {
				await sleep(opts.waitMs, opts.signal);
			}
			const live = this.lookupLiveTab(session, tab);
			const snapshot = await this.captureSnapshotForTab(session, live, {
				maxElements: opts.maxElements,
				maxChars: opts.maxChars,
				timeoutMs,
				signal: opts.signal,
			});
			let screenshot: ScreenshotResult | undefined;
			if (opts.screenshot || opts.saveScreenshotPath) {
				screenshot = await capturePageScreenshot(
					this.buildTargetContext(session, live, timeoutMs, opts.signal),
					{ fullPage: opts.fullPage, savePath: opts.saveScreenshotPath, timeoutMs, signal: opts.signal },
					opts.cwd,
				);
			}
			return {
				url,
				finalUrl: snapshot.url || live.url,
				title: snapshot.title || live.title,
				httpStatus: nav.httpStatus,
				browserName: handle.browserName,
				snapshot,
				consoleEntries: live.console.toArray(),
				pageErrors: live.errors.toArray(),
				failedRequests: live.network.toArray().filter(isFailedRequest),
				screenshot,
				durationMs: Date.now() - started,
				warnings,
				timedOut: nav.timedOut,
			};
		} finally {
			session.disposed = true;
			session.unsubscribe();
			this.releaseAllWaiters(session);
			await handle.shutdown().catch(() => undefined);
		}
	}

	// ───────────────────────────── internals: sessions ─────────────────────────────

	private createSessionState(init: {
		id: string;
		name: string;
		mode: "launched" | "attached";
		browserName: string;
		wsUrl: string;
		headless: boolean;
		pid?: number;
		client: CdpClientInterface;
		handle?: LaunchedBrowserHandle;
		viewport?: { width: number; height: number; deviceScaleFactor?: number };
	}): SessionState {
		const session: SessionState = {
			...init,
			tabs: new Map(),
			tabsByCdpSession: new Map(),
			pendingAttachTargets: new Set(),
			activeTabId: null,
			dialogPolicy: "dismiss",
			nextTabNumber: 1,
			unsubscribe: () => undefined,
			disposed: false,
		};
		session.unsubscribe = init.client.onEvent((event) => {
			this.routeEvent(session, event);
		});
		return session;
	}

	private async attachInitialTabs(session: SessionState, timeoutMs: number, signal?: AbortSignal): Promise<void> {
		await session.client
			.send("Target.setDiscoverTargets", { discover: true }, { timeoutMs, signal })
			.catch(() => undefined);
		const { targetInfos } = await session.client.send<{ targetInfos?: unknown[] }>("Target.getTargets", {}, { timeoutMs, signal });
		const pages = (targetInfos ?? [])
			.map(toTargetInfo)
			.filter((info): info is TargetInfoLike => info !== undefined && info.type === "page" && !info.url.startsWith("devtools://"));
		const results = await Promise.allSettled(pages.map((info) => this.attachTab(session, info, timeoutMs, signal)));
		const attached = results.flatMap((res) => (res.status === "fulfilled" ? [res.value] : []));
		if (attached.length === 0) {
			const firstFailure = results.find((res): res is PromiseRejectedResult => res.status === "rejected");
			if (firstFailure && session.mode === "attached" && pages.length > 0) {
				throw new Error(errorMessage(firstFailure.reason));
			}
			const created = await this.createTab(session, timeoutMs, signal);
			session.activeTabId = created.tabId;
			return;
		}
		session.activeTabId = attached[0]?.tabId ?? null;
	}

	private async createTab(session: SessionState, timeoutMs: number, signal?: AbortSignal): Promise<TabState> {
		const { targetId } = await session.client.send<{ targetId: string }>(
			"Target.createTarget",
			{ url: "about:blank" },
			{ timeoutMs, signal },
		);
		return this.attachTab(session, { targetId, type: "page", title: "", url: "about:blank" }, timeoutMs, signal);
	}

	private async attachTab(session: SessionState, info: TargetInfoLike, timeoutMs: number, signal?: AbortSignal): Promise<TabState> {
		for (const existing of session.tabs.values()) {
			if (existing.targetId === info.targetId) {
				return existing;
			}
		}
		session.pendingAttachTargets.add(info.targetId);
		try {
			const { sessionId } = await session.client.send<{ sessionId: string }>(
				"Target.attachToTarget",
				{ targetId: info.targetId, flatten: true },
				{ timeoutMs, signal },
			);
			const tab = this.createTabState(session, info, sessionId);
			// Register before enabling domains so replayed events (pending dialogs, console) are routed.
			session.tabs.set(tab.tabId, tab);
			session.tabsByCdpSession.set(sessionId, tab);
			const opts = { sessionId, timeoutMs, signal };
			await Promise.all([
				session.client.send("Page.enable", {}, opts),
				session.client.send("Runtime.enable", {}, opts),
				session.client.send("Network.enable", {}, opts),
			]);
			const tree = await session.client
				.send<{ frameTree?: { frame?: { id?: string; url?: string } } }>("Page.getFrameTree", {}, opts)
				.catch(() => ({ frameTree: undefined }));
			const frame = tree.frameTree?.frame;
			if (frame?.id) {
				tab.mainFrameId = frame.id;
			}
			if (frame?.url) {
				tab.url = frame.url;
			}
			if (session.viewport) {
				await session.client
					.send(
						"Emulation.setDeviceMetricsOverride",
						{
							width: session.viewport.width,
							height: session.viewport.height,
							deviceScaleFactor: session.viewport.deviceScaleFactor ?? 1,
							mobile: session.viewport.mobile ?? false,
						},
						opts,
					)
					.catch(() => undefined);
			}
			this.emitChange();
			return tab;
		} finally {
			session.pendingAttachTargets.delete(info.targetId);
		}
	}

	private createTabState(session: SessionState, info: TargetInfoLike, cdpSessionId: string): TabState {
		const networkById = new Map<string, NetworkEntry>();
		return {
			tabId: `t${session.nextTabNumber++}`,
			targetId: info.targetId,
			cdpSessionId,
			title: info.title,
			url: info.url,
			generation: 0,
			loading: false,
			seq: 0,
			console: new RingBuffer<ConsoleEntry>(MAX_BUFFER_ENTRIES),
			errors: new RingBuffer<PageErrorEntry>(MAX_BUFFER_ENTRIES),
			network: new RingBuffer<NetworkEntry>(MAX_BUFFER_ENTRIES, (evicted) => {
				if (networkById.get(evicted.requestId) === evicted) {
					networkById.delete(evicted.requestId);
				}
			}),
			networkById,
			dialogs: new RingBuffer<DialogEntry>(MAX_BUFFER_ENTRIES),
			documentStatusByLoader: new Map(),
			latestSnapshot: null,
			previousSnapshot: null,
			waiters: new Set(),
			closed: false,
		};
	}

	private removeTab(session: SessionState, tab: TabState): void {
		if (tab.closed) {
			return;
		}
		tab.closed = true;
		for (const waiter of tab.waiters) {
			waiter.resolve(null);
		}
		tab.waiters.clear();
		session.tabs.delete(tab.tabId);
		session.tabsByCdpSession.delete(tab.cdpSessionId);
		if (session.activeTabId === tab.tabId) {
			const remaining = [...session.tabs.keys()];
			session.activeTabId = remaining.at(-1) ?? null;
		}
		this.emitChange();
	}

	private releaseAllWaiters(session: SessionState): void {
		for (const tab of session.tabs.values()) {
			for (const waiter of tab.waiters) {
				waiter.resolve(null);
			}
			tab.waiters.clear();
		}
	}

	private async disposeSession(session: SessionState): Promise<void> {
		if (session.disposed) {
			this.sessions.delete(session.id);
			return;
		}
		session.disposed = true;
		session.unsubscribe();
		this.releaseAllWaiters(session);
		this.sessions.delete(session.id);
		if (this.activeSessionId === session.id) {
			this.activeSessionId = [...this.sessions.keys()].at(-1) ?? null;
		}
		this.emitChange();
		if (session.mode === "launched" && session.handle) {
			await session.handle.shutdown().catch(() => undefined);
			return;
		}
		await this.detachAttachedSession(session);
	}

	/** Non-destructive teardown: detach our flattened target sessions, close the socket, never Browser.close. */
	private async detachAttachedSession(session: SessionState): Promise<void> {
		if (session.client.isOpen) {
			await Promise.allSettled(
				[...session.tabs.values()].map((tab) =>
					session.client.send("Target.detachFromTarget", { sessionId: tab.cdpSessionId }, { timeoutMs: 3_000 }),
				),
			);
		}
		await session.client.close().catch(() => undefined);
	}

	private pruneDeadSessions(): void {
		for (const session of [...this.sessions.values()]) {
			if (!session.client.isOpen) {
				void this.disposeSession(session);
			}
		}
	}

	private describeSessionIds(): string {
		const ids = [...this.sessions.keys()];
		return ids.length > 0 ? ids.join(", ") : "(none)";
	}

	private requireSession(sessionId?: string): SessionState {
		this.pruneDeadSessions();
		const id = sessionId ?? this.activeSessionId;
		if (!id) {
			throw new Error("No active browser session. Use browser action 'open', 'launch', or 'attach' first.");
		}
		const session = this.sessions.get(id);
		if (!session) {
			throw new Error(`Unknown browser session '${id}'. Active sessions: ${this.describeSessionIds()}.`);
		}
		return session;
	}

	private async resolveTab(
		ref: TabRef,
		signal?: AbortSignal,
		createIfMissing = true,
	): Promise<{ session: SessionState; tab: TabState }> {
		const session = this.requireSession(ref.sessionId);
		if (ref.tabId) {
			const tab = session.tabs.get(ref.tabId);
			if (!tab) {
				throw new Error(
					`Unknown tab '${ref.tabId}' in session [${session.id}]. Tabs: ${[...session.tabs.keys()].join(", ") || "(none)"}.`,
				);
			}
			return { session, tab };
		}
		const active = session.activeTabId ? session.tabs.get(session.activeTabId) : undefined;
		if (active) {
			return { session, tab: active };
		}
		if (!createIfMissing) {
			throw new Error(`Session [${session.id}] has no open tabs. Use browser action 'new_tab' first.`);
		}
		const created = await this.createTab(session, DEFAULT_COMMAND_TIMEOUT_MS, signal);
		session.activeTabId = created.tabId;
		this.emitChange();
		return { session, tab: created };
	}

	private firstTab(session: SessionState): TabState {
		const tab = session.activeTabId ? session.tabs.get(session.activeTabId) : undefined;
		if (!tab) {
			throw new Error("Browser launched without an attachable page target.");
		}
		return tab;
	}

	private lookupLiveTab(session: SessionState, tab: TabState): TabState {
		if (tab.closed || !session.tabs.has(tab.tabId)) {
			throw new Error(`Tab ${tab.tabId} in session [${session.id}] was closed or crashed.`);
		}
		return tab;
	}

	private buildTargetContext(
		session: SessionState,
		tab: TabState,
		timeoutMs?: number,
		signal?: AbortSignal,
	): TargetResolutionContext {
		return {
			client: session.client,
			sessionId: tab.cdpSessionId,
			latestSnapshot: tab.latestSnapshot,
			currentGeneration: tab.generation,
			timeoutMs,
			signal,
		};
	}

	private async actionContext(
		ref: TabRef,
		timeoutMs?: number,
		signal?: AbortSignal,
	): Promise<{ session: SessionState; tab: TabState; ctx: TargetResolutionContext }> {
		const { session, tab } = await this.resolveTab(ref, signal);
		return { session, tab, ctx: this.buildTargetContext(session, tab, timeoutMs, signal) };
	}

	private async captureSnapshotForTab(
		session: SessionState,
		tab: TabState,
		options: AriaSnapshotOptions = {},
	): Promise<AriaSnapshot> {
		const snapshot = await this.deps.captureAriaSnapshot(session.client, tab.cdpSessionId, tab.generation, options);
		tab.previousSnapshot = tab.latestSnapshot;
		tab.latestSnapshot = snapshot;
		if (snapshot.title) {
			tab.title = snapshot.title;
		}
		if (snapshot.url) {
			tab.url = snapshot.url;
		}
		return snapshot;
	}

	// ───────────────────────────── internals: navigation ─────────────────────────────

	private async navigateHistory(delta: -1 | 1, opts: NavigationOptions): Promise<NavigationResult> {
		const { session, tab } = await this.resolveTab(opts, opts.signal);
		const history = await session.client.send<{ currentIndex: number; entries: Array<{ id: number; url: string }> }>(
			"Page.getNavigationHistory",
			{},
			{ sessionId: tab.cdpSessionId, timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS, signal: opts.signal },
		);
		const entry = history.entries[history.currentIndex + delta];
		if (!entry) {
			throw new Error(`No ${delta < 0 ? "previous" : "next"} history entry in tab ${tab.tabId}.`);
		}
		return this.runNavigation(session, tab, entry.url, "history", opts, async (timeoutMs) => {
			await session.client.send(
				"Page.navigateToHistoryEntry",
				{ entryId: entry.id },
				{ sessionId: tab.cdpSessionId, timeoutMs, signal: opts.signal },
			);
			return {};
		});
	}

	/**
	 * Run a navigation trigger and wait for it to complete:
	 * cross-document → `Page.loadEventFired` after a new top-frame commit (or bfcache restore);
	 * same-document (`Page.navigate` without loaderId) → `Page.navigatedWithinDocument`.
	 */
	private async runNavigation(
		session: SessionState,
		tab: TabState,
		requestedUrl: string,
		mode: "navigate" | "reload" | "history",
		opts: { timeoutMs?: number; signal?: AbortSignal; snapshot?: AriaSnapshotOptions; skipSnapshot?: boolean },
		trigger: (timeoutMs: number) => Promise<NavigateCommandResult>,
	): Promise<NavigationResult> {
		const started = Date.now();
		const timeoutMs = opts.timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
		const startGeneration = tab.generation;
		const startLoaderId = tab.mainDocumentLoaderId;
		const loadWait = this.waitForTabEvent(
			tab,
			["Page.loadEventFired", "Page.frameNavigated"],
			timeoutMs,
			opts.signal,
			(event) => {
				if (event.method === "Page.frameNavigated") {
					const frame = asRecord(event.params.frame);
					return !frame?.parentId && asString(event.params.type) === "BackForwardCacheRestore";
				}
				return tab.generation > startGeneration;
			},
		);
		const sameDocWait = this.waitForTabEvent(tab, ["Page.navigatedWithinDocument"], timeoutMs, opts.signal, (event) => {
			const frameId = asString(event.params.frameId);
			return !tab.mainFrameId || frameId === tab.mainFrameId;
		});

		let result: NavigateCommandResult;
		try {
			result = await trigger(timeoutMs);
		} catch (err) {
			loadWait.cancel();
			sameDocWait.cancel();
			throw err;
		}

		let event: CdpEventMessage | null;
		if (mode === "navigate" && result.loaderId) {
			sameDocWait.cancel();
			event = await loadWait.promise;
		} else if (mode === "navigate") {
			loadWait.cancel();
			event = await sameDocWait.promise;
		} else if (mode === "reload") {
			sameDocWait.cancel();
			event = await loadWait.promise;
		} else {
			event = await Promise.race([loadWait.promise, sameDocWait.promise]);
			loadWait.cancel();
			sameDocWait.cancel();
		}
		opts.signal?.throwIfAborted();
		const live = this.lookupLiveTab(session, tab);
		const timedOut = event === null;

		let httpStatus: number | undefined;
		if (result.loaderId) {
			httpStatus = live.documentStatusByLoader.get(result.loaderId);
		} else if (live.mainDocumentLoaderId && live.mainDocumentLoaderId !== startLoaderId) {
			httpStatus = live.documentStatusByLoader.get(live.mainDocumentLoaderId);
		}

		const snapshot = opts.skipSnapshot
			? this.placeholderSnapshot(live)
			: await this.captureSnapshotForTab(session, live, opts.snapshot);
		this.emitChange();
		return {
			sessionId: session.id,
			tabId: live.tabId,
			requestedUrl,
			finalUrl: snapshot.url || live.url,
			title: snapshot.title || live.title,
			httpStatus,
			timedOut,
			durationMs: Date.now() - started,
			snapshot,
		};
	}

	private placeholderSnapshot(tab: TabState): AriaSnapshot {
		return {
			url: tab.url,
			title: tab.title,
			capturedAt: Date.now(),
			generation: tab.generation,
			refs: [],
			refMap: new Map(),
			treeText: "",
			truncated: false,
			totalInteractiveCount: 0,
		};
	}

	/** Register a one-shot waiter for a tab event; resolves `null` on timeout, abort, or tab close. */
	private waitForTabEvent(
		tab: TabState,
		methods: string[],
		timeoutMs: number,
		signal?: AbortSignal,
		predicate?: (event: CdpEventMessage) => boolean,
	): PendingWait {
		let settle: (event: CdpEventMessage | null) => void = () => undefined;
		const promise = new Promise<CdpEventMessage | null>((resolve) => {
			settle = resolve;
		});
		if (tab.closed || signal?.aborted) {
			settle(null);
			return { promise, cancel: () => undefined };
		}
		let done = false;
		const waiter: EventWaiter = {
			methods: new Set(methods),
			predicate,
			resolve: (event) => {
				finish(event);
			},
		};
		const onAbort = () => {
			finish(null);
		};
		const timer = setTimeout(() => {
			finish(null);
		}, timeoutMs);
		const finish = (event: CdpEventMessage | null) => {
			if (done) {
				return;
			}
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			tab.waiters.delete(waiter);
			settle(event);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		tab.waiters.add(waiter);
		return {
			promise,
			cancel: () => {
				finish(null);
			},
		};
	}

	// ───────────────────────────── internals: event routing ─────────────────────────────

	private routeEvent(session: SessionState, event: CdpEventMessage): void {
		if (session.disposed) {
			return;
		}
		if (!event.sessionId) {
			this.handleBrowserEvent(session, event);
			return;
		}
		const tab = session.tabsByCdpSession.get(event.sessionId);
		if (!tab) {
			return;
		}
		this.handleTabEvent(session, tab, event);
		for (const waiter of [...tab.waiters]) {
			if (waiter.methods.has(event.method) && (!waiter.predicate || waiter.predicate(event))) {
				waiter.resolve(event);
			}
		}
	}

	private handleBrowserEvent(session: SessionState, event: CdpEventMessage): void {
		switch (event.method) {
			case "Target.targetInfoChanged": {
				const info = toTargetInfo(event.params.targetInfo);
				if (!info) {
					return;
				}
				for (const tab of session.tabs.values()) {
					if (tab.targetId === info.targetId) {
						tab.title = info.title;
						tab.url = info.url;
						this.emitChange();
					}
				}
				return;
			}
			case "Target.targetDestroyed": {
				const targetId = asString(event.params.targetId);
				for (const tab of [...session.tabs.values()]) {
					if (tab.targetId === targetId) {
						this.removeTab(session, tab);
					}
				}
				return;
			}
			case "Target.detachedFromTarget": {
				const sessionId = asString(event.params.sessionId);
				const tab = sessionId ? session.tabsByCdpSession.get(sessionId) : undefined;
				if (tab) {
					this.removeTab(session, tab);
				}
				return;
			}
			case "Target.targetCreated": {
				const info = toTargetInfo(event.params.targetInfo);
				if (info?.type !== "page" || !info.openerId || session.pendingAttachTargets.has(info.targetId)) {
					return;
				}
				const openerIsOurs = [...session.tabs.values()].some((tab) => tab.targetId === info.openerId);
				if (openerIsOurs) {
					// Auto-track popups (window.open / target=_blank) opened by one of our tabs.
					void this.attachTab(session, info, DEFAULT_COMMAND_TIMEOUT_MS).catch(() => undefined);
				}
				return;
			}
			default:
				return;
		}
	}

	private handleTabEvent(session: SessionState, tab: TabState, event: CdpEventMessage): void {
		const params = event.params;
		switch (event.method) {
			case "Runtime.consoleAPICalled": {
				const args = Array.isArray(params.args) ? params.args : [];
				const text = args.map(remoteObjectToText).join(" ");
				const frame = firstCallFrame(params.stackTrace);
				tab.console.push({
					seq: ++tab.seq,
					timestamp: Date.now(),
					level: asString(params.type) ?? "log",
					text: truncateText(text, MAX_CONSOLE_TEXT_CHARS),
					url: frame.url,
					lineNumber: frame.lineNumber,
				});
				return;
			}
			case "Runtime.exceptionThrown": {
				const details = asRecord(params.exceptionDetails) ?? {};
				const exception = asRecord(details.exception);
				const description = asString(exception?.description);
				const firstLine = description?.split("\n")[0];
				const line = asNumber(details.lineNumber);
				const frame = firstCallFrame(details.stackTrace);
				tab.errors.push({
					seq: ++tab.seq,
					timestamp: Date.now(),
					message: firstLine || asString(details.text) || "Uncaught exception",
					url: asString(details.url) || frame.url,
					lineNumber: line === undefined ? frame.lineNumber : line + 1,
					stack: description ? truncateText(description, MAX_CONSOLE_TEXT_CHARS) : undefined,
				});
				return;
			}
			case "Network.requestWillBeSent": {
				this.onRequestWillBeSent(tab, params);
				return;
			}
			case "Network.responseReceived": {
				const requestId = asString(params.requestId);
				const response = asRecord(params.response);
				if (!requestId || !response) {
					return;
				}
				const status = asNumber(response.status);
				const resourceType = asString(params.type);
				const loaderId = asString(params.loaderId);
				if (resourceType === "Document" && loaderId && status !== undefined) {
					tab.documentStatusByLoader.set(loaderId, status);
					while (tab.documentStatusByLoader.size > MAX_TRACKED_DOCUMENT_LOADERS) {
						const oldest = tab.documentStatusByLoader.keys().next().value;
						if (oldest === undefined) {
							break;
						}
						tab.documentStatusByLoader.delete(oldest);
					}
				}
				const entry = tab.networkById.get(requestId) ?? this.pushNetworkEntry(tab, requestId, "GET", asString(response.url) ?? "", resourceType);
				entry.status = status;
				entry.statusText = asString(response.statusText);
				entry.mimeType = asString(response.mimeType);
				if (resourceType) {
					entry.resourceType = resourceType;
				}
				return;
			}
			case "Network.loadingFailed": {
				const requestId = asString(params.requestId);
				if (!requestId) {
					return;
				}
				// Join by requestId so the failure keeps the original method and URL.
				const entry =
					tab.networkById.get(requestId) ?? this.pushNetworkEntry(tab, requestId, "UNKNOWN", "", asString(params.type));
				entry.failed = true;
				entry.errorText = asString(params.errorText);
				entry.canceled = params.canceled === true;
				return;
			}
			case "Page.javascriptDialogOpening": {
				const type = asString(params.type) ?? "alert";
				// beforeunload is always accepted so navigations are never silently cancelled.
				const accept = type === "beforeunload" || session.dialogPolicy === "accept";
				const defaultPrompt = asString(params.defaultPrompt);
				tab.dialogs.push({
					seq: ++tab.seq,
					timestamp: Date.now(),
					type,
					message: asString(params.message) ?? "",
					defaultPrompt,
					handled: accept ? "accepted" : "dismissed",
				});
				const dialogParams: Record<string, unknown> = { accept };
				if (accept && type === "prompt") {
					dialogParams.promptText = defaultPrompt ?? "";
				}
				void session.client
					.send("Page.handleJavaScriptDialog", dialogParams, { sessionId: tab.cdpSessionId, timeoutMs: 5_000 })
					.catch(() => undefined);
				return;
			}
			case "Page.frameNavigated": {
				const frame = asRecord(params.frame);
				if (!frame || frame.parentId) {
					return;
				}
				tab.generation += 1;
				tab.mainFrameId = asString(frame.id) ?? tab.mainFrameId;
				tab.url = asString(frame.url) ?? tab.url;
				this.emitChange();
				return;
			}
			case "Page.navigatedWithinDocument": {
				if (!tab.mainFrameId || asString(params.frameId) === tab.mainFrameId) {
					tab.url = asString(params.url) ?? tab.url;
				}
				return;
			}
			case "Page.frameStartedLoading": {
				if (asString(params.frameId) === tab.mainFrameId) {
					tab.loading = true;
				}
				return;
			}
			case "Page.frameStoppedLoading": {
				if (asString(params.frameId) === tab.mainFrameId) {
					tab.loading = false;
				}
				return;
			}
			case "Page.loadEventFired": {
				tab.loading = false;
				return;
			}
			case "Inspector.targetCrashed": {
				tab.errors.push({ seq: ++tab.seq, timestamp: Date.now(), message: "Renderer process crashed (Inspector.targetCrashed)." });
				tab.loading = false;
				return;
			}
			default:
				return;
		}
	}

	private onRequestWillBeSent(tab: TabState, params: Record<string, unknown>): void {
		const requestId = asString(params.requestId);
		const request = asRecord(params.request);
		if (!requestId || !request) {
			return;
		}
		const method = asString(request.method) ?? "GET";
		const url = asString(request.url) ?? "";
		const resourceType = asString(params.type);
		const loaderId = asString(params.loaderId);
		if (resourceType === "Document" && loaderId && (!tab.mainFrameId || asString(params.frameId) === tab.mainFrameId)) {
			tab.mainDocumentLoaderId = loaderId;
		}
		const existing = tab.networkById.get(requestId);
		if (existing) {
			// Redirect hop: same requestId, new URL. Keep a single entry describing the latest hop.
			existing.method = method;
			existing.url = url;
			existing.status = undefined;
			existing.statusText = undefined;
			existing.failed = false;
			existing.errorText = undefined;
			return;
		}
		this.pushNetworkEntry(tab, requestId, method, url, resourceType);
	}

	private pushNetworkEntry(tab: TabState, requestId: string, method: string, url: string, resourceType?: string): NetworkEntry {
		const entry: NetworkEntry = {
			seq: ++tab.seq,
			requestId,
			timestamp: Date.now(),
			method,
			url,
			resourceType: resourceType ?? "Other",
			failed: false,
		};
		tab.network.push(entry);
		tab.networkById.set(requestId, entry);
		return entry;
	}

	// ───────────────────────────── internals: summaries ─────────────────────────────

	private summarizeSession(session: SessionState): BrowserSessionSummary {
		return {
			id: session.id,
			name: session.name,
			mode: session.mode,
			browserName: session.browserName,
			wsUrl: session.wsUrl,
			headless: session.headless,
			pid: session.pid,
			activeTabId: session.activeTabId,
			tabs: this.summarizeTabs(session),
			dialogPolicy: session.dialogPolicy,
		};
	}

	private summarizeTabs(session: SessionState): TabSummary[] {
		return [...session.tabs.values()].map((tab) => this.summarizeTab(session, tab));
	}

	private summarizeTab(session: SessionState, tab: TabState): TabSummary {
		return {
			tabId: tab.tabId,
			targetId: tab.targetId,
			title: tab.title,
			url: tab.url,
			active: session.activeTabId === tab.tabId,
			generation: tab.generation,
			snapshotRefCount: tab.latestSnapshot?.refs.length ?? 0,
			consoleCount: tab.console.size,
			errorCount: tab.errors.size,
			failedRequestCount: tab.network.toArray().filter(isFailedRequest).length,
		};
	}
}
