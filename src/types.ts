/**
 * Core contracts and CDP types for pi-cdp.
 * Zero external runtime dependencies; compatible with Node.js >=22.6 built-in WebSocket.
 */

export type BrowserChannel =
	| "chrome"
	| "chrome-for-testing"
	| "playwright-chromium"
	| "playwright-headless-shell"
	| "chromium"
	| "edge"
	| "brave"
	| "arc"
	| "custom";

export interface DiscoveredBrowser {
	id: string;
	name: string;
	channel: BrowserChannel;
	executablePath: string;
	source: string;
	headlessOnly?: boolean;
	revision?: number;
}

export type LiveEndpointMode = "normal" | "approval" | "stale";

export interface LiveCdpEndpoint {
	id: string;
	browserName: string;
	host: string;
	port: number;
	wsUrl: string;
	mode: LiveEndpointMode;
	source: string;
	userDataDir?: string;
	browserVersion?: string;
	note?: string;
}

export interface BrowserDoctorReport {
	platform: NodeJS.Platform;
	arch: string;
	preferredBrowser: DiscoveredBrowser | null;
	browsers: DiscoveredBrowser[];
	liveEndpoints: LiveCdpEndpoint[];
	chromeRemoteDebuggingToggle?: {
		profileDir: string;
		allowed: boolean;
		userEnabled: boolean;
	};
	guidance: string[];
}

export interface CdpSendOptions {
	sessionId?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface CdpEventMessage {
	method: string;
	params: Record<string, unknown>;
	sessionId?: string;
}

export interface CdpClientInterface {
	readonly wsUrl: string;
	readonly isOpen: boolean;
	send<T = Record<string, unknown>>(
		method: string,
		params?: Record<string, unknown>,
		options?: CdpSendOptions,
	): Promise<T>;
	onEvent(listener: (event: CdpEventMessage) => void): () => void;
	close(): Promise<void>;
}

export interface LaunchBrowserProcessOptions {
	executablePath?: string;
	cwd?: string;
	headless?: boolean;
	userDataDir?: string;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	extraArgs?: string[];
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface LaunchedBrowserHandle {
	client: CdpClientInterface;
	pid: number;
	executablePath: string;
	browserName: string;
	wsUrl: string;
	port: number;
	userDataDir: string;
	ownsUserDataDir: boolean;
	headless: boolean;
	shutdown(): Promise<void>;
}

export interface SnapshotRefEntry {
	ref: string;
	backendNodeId: number;
	frameId?: string;
	role: string;
	name: string;
	value?: string;
	description?: string;
	checked?: "true" | "false" | "mixed";
	disabled?: boolean;
	expanded?: boolean;
	required?: boolean;
	focused?: boolean;
	level?: number;
	url?: string;
}

export interface AriaSnapshotOptions {
	maxElements?: number;
	maxChars?: number;
	includeStaticText?: boolean;
	includeIframes?: boolean;
	rootSelector?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface AriaSnapshot {
	url: string;
	title: string;
	capturedAt: number;
	generation: number;
	refs: SnapshotRefEntry[];
	refMap: ReadonlyMap<string, SnapshotRefEntry>;
	treeText: string;
	truncated: boolean;
	totalInteractiveCount: number;
}

export interface SnapshotDiff {
	previousUrl: string;
	currentUrl: string;
	urlChanged: boolean;
	titleChanged: boolean;
	addedRefs: SnapshotRefEntry[];
	changedRefs: Array<{
		before: SnapshotRefEntry;
		after: SnapshotRefEntry;
	}>;
	removedCount: number;
	summaryText: string;
}

export interface TargetResolutionContext {
	client: CdpClientInterface;
	sessionId: string;
	latestSnapshot: AriaSnapshot | null;
	currentGeneration: number;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface ResolvedDomTarget {
	backendNodeId: number;
	description: string;
	fromRef?: SnapshotRefEntry;
}

export interface ClickOptions {
	doubleClick?: boolean;
	button?: "left" | "right" | "middle";
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface ScreenshotOptions {
	fullPage?: boolean;
	target?: string;
	savePath?: string;
	format?: "png" | "jpeg" | "webp";
	quality?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface ScreenshotResult {
	base64: string;
	mimeType: "image/png" | "image/jpeg" | "image/webp";
	width: number;
	height: number;
	fullPage: boolean;
	savedPath?: string;
}

export interface WaitConditionOptions {
	selector?: string;
	text?: string;
	urlIncludes?: string;
	networkIdleMs?: number;
	delayMs?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface ConsoleEntry {
	seq: number;
	timestamp: number;
	level: string;
	text: string;
	url?: string;
	lineNumber?: number;
}

export interface PageErrorEntry {
	seq: number;
	timestamp: number;
	message: string;
	url?: string;
	lineNumber?: number;
	stack?: string;
}

export interface NetworkEntry {
	seq: number;
	requestId: string;
	timestamp: number;
	method: string;
	url: string;
	resourceType: string;
	status?: number;
	statusText?: string;
	failed: boolean;
	errorText?: string;
	canceled?: boolean;
	mimeType?: string;
}

export interface DialogEntry {
	seq: number;
	timestamp: number;
	type: string;
	message: string;
	defaultPrompt?: string;
	handled: "accepted" | "dismissed";
}

export type DialogPolicy = "accept" | "dismiss";

export interface TabSummary {
	tabId: string;
	targetId: string;
	title: string;
	url: string;
	active: boolean;
	generation: number;
	snapshotRefCount: number;
	consoleCount: number;
	errorCount: number;
	failedRequestCount: number;
}

export interface BrowserSessionSummary {
	id: string;
	name: string;
	mode: "launched" | "attached";
	browserName: string;
	wsUrl: string;
	headless: boolean;
	pid?: number;
	activeTabId: string | null;
	tabs: TabSummary[];
	dialogPolicy: DialogPolicy;
}

export interface WebInspectOptions {
	url: string;
	cwd?: string;
	waitForSelector?: string;
	waitForText?: string;
	waitMs?: number;
	screenshot?: boolean;
	fullPage?: boolean;
	saveScreenshotPath?: string;
	viewport?: { width: number; height: number };
	maxElements?: number;
	maxChars?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface WebInspectResult {
	url: string;
	finalUrl: string;
	title: string;
	httpStatus?: number;
	browserName: string;
	snapshot: AriaSnapshot;
	consoleEntries: ConsoleEntry[];
	pageErrors: PageErrorEntry[];
	failedRequests: NetworkEntry[];
	screenshot?: ScreenshotResult;
	durationMs: number;
}
