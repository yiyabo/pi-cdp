import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { runBrowserDoctor } from "../src/discovery/browsers.ts";
import {
	formatConsole,
	formatDoctorReport,
	formatNavigation,
	formatNetwork,
	formatScreenshotSummary,
	formatSessions,
	formatSnapshot,
	formatSnapshotDiff,
	formatTabs,
	formatWebInspectResult,
} from "../src/formatters.ts";
import { BrowserSessionManager, type NavigationResult, type SnapshotOutcome } from "../src/session-manager.ts";
import type { AriaSnapshotOptions, ScreenshotResult } from "../src/types.ts";
import { resolveToolPath } from "../src/utils/process-tree.ts";

const STATUS_KEY = "pi-cdp";

function stringEnum<const T extends readonly [string, ...string[]]>(values: T, options?: { description?: string }) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: [...values],
		...(options?.description ? { description: options.description } : {}),
	});
}

export const BROWSER_ACTIONS = [
	"doctor",
	"sessions",
	"switch_session",
	"launch",
	"attach",
	"disconnect",
	"open",
	"navigate",
	"reload",
	"back",
	"forward",
	"tabs",
	"new_tab",
	"switch_tab",
	"close_tab",
	"snapshot",
	"click",
	"fill",
	"select",
	"hover",
	"type",
	"press",
	"scroll",
	"wait",
	"evaluate",
	"screenshot",
	"console",
	"network",
	"viewport",
	"dialog_policy",
] as const;

type BrowserAction = (typeof BROWSER_ACTIONS)[number];

const WebInspectParamsSchema = Type.Object({
	url: Type.String({
		description: "URL to render (https://…, http://localhost:3000, example.com, or a local .html file path).",
	}),
	wait_for_selector: Type.Optional(Type.String({ description: "CSS selector to wait for after load." })),
	wait_for_text: Type.Optional(Type.String({ description: "Visible text to wait for after load." })),
	wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 60000, description: "Extra settle delay after load." })),
	screenshot: Type.Optional(Type.Boolean({ description: "Attach a PNG screenshot of the rendered page." })),
	full_page: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page instead of the viewport." })),
	save_screenshot_path: Type.Optional(Type.String({ description: "Also write the screenshot to this file path." })),
	viewport_width: Type.Optional(Type.Integer({ minimum: 200, maximum: 7680 })),
	viewport_height: Type.Optional(Type.Integer({ minimum: 200, maximum: 4320 })),
	max_elements: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000, description: "Cap on @eN refs." })),
	max_chars: Type.Optional(Type.Integer({ minimum: 500, maximum: 200000, description: "Cap on snapshot text." })),
	timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: 180000, description: "Overall timeout." })),
});

type WebInspectParams = Static<typeof WebInspectParamsSchema>;

const BrowserParamsSchema = Type.Object({
	action: stringEnum(BROWSER_ACTIONS, { description: "Browser operation." }),
	session_id: Type.Optional(Type.String({ description: "Browser session id (b1, b2…). Defaults to the active session." })),
	tab_id: Type.Optional(Type.String({ description: "Tab id (t1, t2…). Defaults to the active tab." })),
	url: Type.Optional(Type.String({ description: "URL for open/navigate/new_tab/launch." })),
	new_tab: Type.Optional(Type.Boolean({ description: "open: load the URL in a new tab." })),
	target: Type.Optional(
		Type.String({ description: "Element target: snapshot ref like @e12 (preferred) or a CSS selector." }),
	),
	value: Type.Optional(Type.String({ description: "fill: text value; select: single option value/label." })),
	values: Type.Optional(Type.Array(Type.String(), { description: "select: option values/labels." })),
	text: Type.Optional(Type.String({ description: "type: text to type; wait: visible text to wait for." })),
	submit: Type.Optional(Type.Boolean({ description: "type: press Enter after typing." })),
	key: Type.Optional(Type.String({ description: "press: key name such as Enter, Tab, Escape, ArrowDown, Control+A." })),
	double_click: Type.Optional(Type.Boolean()),
	button: Type.Optional(stringEnum(["left", "right", "middle"] as const)),
	direction: Type.Optional(stringEnum(["up", "down", "left", "right", "top", "bottom"] as const)),
	amount_px: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
	selector: Type.Optional(Type.String({ description: "wait: CSS selector to wait for." })),
	url_includes: Type.Optional(Type.String({ description: "wait: substring the page URL must contain." })),
	network_idle_ms: Type.Optional(Type.Integer({ minimum: 100, maximum: 60000, description: "wait: quiet network window." })),
	delay_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 60000, description: "wait: fixed delay." })),
	expression: Type.Optional(Type.String({ description: "evaluate: JavaScript expression (awaited if it returns a promise)." })),
	full_page: Type.Optional(Type.Boolean({ description: "screenshot: capture the full scrollable page." })),
	save_path: Type.Optional(Type.String({ description: "screenshot: also write the image to this path." })),
	format: Type.Optional(stringEnum(["png", "jpeg", "webp"] as const)),
	quality: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	diff: Type.Optional(Type.Boolean({ description: "snapshot: report only changes since the previous snapshot." })),
	snapshot: Type.Optional(
		Type.Boolean({ description: "Interactions: return a settled snapshot diff afterwards (default true)." }),
	),
	max_elements: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
	max_chars: Type.Optional(Type.Integer({ minimum: 500, maximum: 200000 })),
	root_selector: Type.Optional(Type.String({ description: "snapshot: limit the tree to this CSS subtree." })),
	include_static_text: Type.Optional(Type.Boolean({ description: "snapshot: include non-interactive text lines." })),
	headless: Type.Optional(Type.Boolean({ description: "launch: headless (default true)." })),
	executable_path: Type.Optional(Type.String({ description: "launch: browser executable override." })),
	user_data_dir: Type.Optional(Type.String({ description: "launch: persistent profile directory." })),
	name: Type.Optional(Type.String({ description: "launch/attach: human-readable session label." })),
	ws_url: Type.Optional(Type.String({ description: "attach: browser WebSocket debugger URL." })),
	host: Type.Optional(Type.String({ description: "attach: DevTools host (default 127.0.0.1)." })),
	port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535, description: "attach: DevTools port." })),
	all: Type.Optional(Type.Boolean({ description: "disconnect: close every session." })),
	width: Type.Optional(Type.Integer({ minimum: 200, maximum: 7680 })),
	height: Type.Optional(Type.Integer({ minimum: 200, maximum: 4320 })),
	device_scale_factor: Type.Optional(Type.Number({ minimum: 0.5, maximum: 4 })),
	mobile: Type.Optional(Type.Boolean()),
	policy: Type.Optional(stringEnum(["accept", "dismiss"] as const, { description: "dialog_policy: how to answer JS dialogs." })),
	failed_only: Type.Optional(Type.Boolean({ description: "network: only failed (or HTTP >= 400) requests." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "console/network: max entries." })),
	clear: Type.Optional(Type.Boolean({ description: "console/network: clear the buffer after reading." })),
	timeout_ms: Type.Optional(Type.Integer({ minimum: 100, maximum: 180000 })),
});

type BrowserParams = Static<typeof BrowserParamsSchema>;

interface BrowserToolDetails {
	ok: boolean;
	action: string;
	sessionId?: string;
	tabId?: string;
	url?: string;
	summary?: string;
}

type ToolContent = TextContent | ImageContent;

function okResult(text: string, details: BrowserToolDetails, extra: ToolContent[] = []): AgentToolResult<BrowserToolDetails> {
	return {
		content: [{ type: "text", text }, ...extra],
		details,
	};
}

function errorResult(
	message: string,
	tool: string,
	action: string,
	ids: { sessionId?: string; tabId?: string } = {},
): AgentToolResult<BrowserToolDetails> {
	return {
		content: [{ type: "text", text: `${tool} error (${action}): ${message}` }],
		details: { ok: false, action, sessionId: ids.sessionId, tabId: ids.tabId, summary: message },
		isError: true,
	};
}

function imageBlock(shot: ScreenshotResult): ImageContent {
	return { type: "image", data: shot.base64, mimeType: shot.mimeType };
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function requireParam<T>(value: T | undefined, name: string, action: string): T {
	if (value === undefined || value === null || (typeof value === "string" && value.trim().length === 0)) {
		throw new Error(`'${name}' is required for action '${action}'.`);
	}
	return value;
}

function snapshotOptionsFrom(params: BrowserParams, signal?: AbortSignal): AriaSnapshotOptions {
	return {
		maxElements: params.max_elements,
		maxChars: params.max_chars,
		rootSelector: params.root_selector,
		includeStaticText: params.include_static_text,
		signal,
	};
}

/** Render a snapshot outcome: a compact diff when it is the same document, the full tree otherwise. */
function renderSnapshotOutcome(outcome: SnapshotOutcome, preferDiff: boolean): string {
	const diff = outcome.diff;
	if (preferDiff && diff && !diff.urlChanged) {
		const snap = outcome.snapshot;
		const header = `[${outcome.sessionId}/${outcome.tabId}] ${snap.title || "(untitled)"} — ${snap.url} (${snap.refs.length} refs, generation ${snap.generation})`;
		return `${header}\n${formatSnapshotDiff(diff)}`;
	}
	const prefix = diff?.urlChanged ? `${formatSnapshotDiff(diff, 0)}\n\n` : "";
	return `${prefix}[${outcome.sessionId}/${outcome.tabId}]\n${formatSnapshot(outcome.snapshot)}`;
}

function navigationDetails(action: string, nav: NavigationResult): BrowserToolDetails {
	return {
		ok: true,
		action,
		sessionId: nav.sessionId,
		tabId: nav.tabId,
		url: nav.finalUrl,
		summary: `${nav.finalUrl}${nav.httpStatus === undefined ? "" : ` (HTTP ${nav.httpStatus})`}`,
	};
}

function renderStatusFooter(manager: BrowserSessionManager, theme: Theme): string | undefined {
	const sessions = manager.listSessions();
	if (sessions.length === 0) {
		return undefined;
	}
	const active = manager.activeSession;
	const parts = sessions.map((session) => {
		const marker = session.id === active ? "*" : "";
		const label = `${session.id}${marker}:${session.tabs.length}tab${session.tabs.length === 1 ? "" : "s"}`;
		return session.mode === "attached" ? theme.fg("warning", `${label}(attached)`) : theme.fg("accent", label);
	});
	return `${theme.fg("accent", "🌐")} ${parts.join(theme.fg("dim", " · "))}`;
}

function syncUiStatus(manager: BrowserSessionManager, ctx: ExtensionContext | undefined): void {
	if (ctx && ctx.mode === "tui") {
		ctx.ui.setStatus(STATUS_KEY, renderStatusFooter(manager, ctx.ui.theme));
	}
}

function renderCollapsedLines(text: string, maxLines: number, theme: Theme, width: number): string {
	const lines = text.split("\n");
	const visible = lines.slice(0, maxLines).map((line) => truncateToWidth(line, Math.max(20, width)));
	if (lines.length > maxLines) {
		visible.push(theme.fg("muted", `… (${lines.length - maxLines} more lines — expand tool output to view all)`));
	}
	return visible.join("\n");
}

function firstText(result: AgentToolResult<unknown>): string {
	const block = result.content[0];
	return block && block.type === "text" ? block.text : "";
}

function hasImage(result: AgentToolResult<unknown>): boolean {
	return result.content.some((block) => block.type === "image");
}

interface ActionEnv {
	manager: BrowserSessionManager;
	cwd: string;
	signal?: AbortSignal;
}

async function runSessionAction(
	action: BrowserAction,
	params: BrowserParams,
	env: ActionEnv,
): Promise<AgentToolResult<BrowserToolDetails> | undefined> {
	const { manager, cwd, signal } = env;
	switch (action) {
		case "doctor": {
			const report = await runBrowserDoctor(cwd);
			return okResult(formatDoctorReport(report), {
				ok: true,
				action,
				summary: report.preferredBrowser ? report.preferredBrowser.name : "no browser found",
			});
		}
		case "sessions": {
			return okResult(formatSessions(manager.listSessions(), manager.activeSession), {
				ok: true,
				action,
				sessionId: manager.activeSession ?? undefined,
			});
		}
		case "switch_session": {
			const summary = manager.switchSession(requireParam(params.session_id, "session_id", action));
			return okResult(`Active session is now [${summary.id}].\n\n${formatTabs(summary.tabs, summary.id)}`, {
				ok: true,
				action,
				sessionId: summary.id,
				tabId: summary.activeTabId ?? undefined,
			});
		}
		case "launch": {
			const res = await manager.launch({
				name: params.name,
				headless: params.headless,
				executablePath: params.executable_path ? resolveToolPath(params.executable_path, cwd) : undefined,
				userDataDir: params.user_data_dir ? resolveToolPath(params.user_data_dir, cwd) : undefined,
				viewport: params.width && params.height ? { width: params.width, height: params.height } : undefined,
				url: params.url,
				cwd,
				timeoutMs: params.timeout_ms,
				signal,
			});
			const lines = [`Launched [${res.session.id}] ${res.session.browserName}.`, formatSessions([res.session], res.session.id)];
			if (res.navigation) {
				lines.push("", formatNavigation(res.navigation));
			}
			return okResult(lines.join("\n"), {
				ok: true,
				action,
				sessionId: res.session.id,
				tabId: res.session.activeTabId ?? undefined,
				url: res.navigation?.finalUrl,
			});
		}
		case "attach": {
			const summary = await manager.attach({
				wsUrl: params.ws_url,
				host: params.host,
				port: params.port,
				name: params.name,
				timeoutMs: params.timeout_ms,
				signal,
			});
			const text = `Attached [${summary.id}] to ${summary.browserName} (${summary.wsUrl}). Disconnecting later leaves this browser running.\n\n${formatTabs(summary.tabs, summary.id)}`;
			return okResult(text, { ok: true, action, sessionId: summary.id, tabId: summary.activeTabId ?? undefined });
		}
		case "disconnect": {
			const { closedSessions } = await manager.disconnect({ sessionId: params.session_id, all: params.all });
			const text =
				closedSessions.length > 0
					? `Disconnected browser session(s): ${closedSessions.join(", ")}`
					: "No browser sessions to disconnect.";
			return okResult(text, { ok: true, action, summary: closedSessions.join(",") });
		}
		case "dialog_policy": {
			const policy = requireParam(params.policy, "policy", action);
			const summary = manager.setDialogPolicy(policy, params.session_id);
			return okResult(`[${summary.id}] JavaScript dialogs will now be auto-${policy === "accept" ? "accepted" : "dismissed"}.`, {
				ok: true,
				action,
				sessionId: summary.id,
			});
		}
		default:
			return undefined;
	}
}

async function runTabAction(
	action: BrowserAction,
	params: BrowserParams,
	env: ActionEnv,
): Promise<AgentToolResult<BrowserToolDetails> | undefined> {
	const { manager, cwd, signal } = env;
	const ref = { sessionId: params.session_id, tabId: params.tab_id };
	const navOpts = { ...ref, cwd, timeoutMs: params.timeout_ms, signal, snapshot: snapshotOptionsFrom(params, signal) };
	switch (action) {
		case "open":
		case "navigate": {
			const url = requireParam(params.url, "url", action);
			const nav =
				action === "open"
					? await manager.open(url, { ...navOpts, newTab: params.new_tab })
					: await manager.navigate(url, navOpts);
			return okResult(formatNavigation(nav), navigationDetails(action, nav));
		}
		case "reload":
		case "back":
		case "forward": {
			let nav: NavigationResult;
			if (action === "reload") {
				nav = await manager.reload(navOpts);
			} else if (action === "back") {
				nav = await manager.goBack(navOpts);
			} else {
				nav = await manager.goForward(navOpts);
			}
			return okResult(formatNavigation(nav), navigationDetails(action, nav));
		}
		case "tabs": {
			const { sessionId, tabs } = manager.listTabs(params.session_id);
			const text = sessionId ? formatTabs(tabs, sessionId) : formatSessions([], null);
			return okResult(text, { ok: true, action, sessionId: sessionId ?? undefined });
		}
		case "new_tab": {
			const { tab, navigation } = await manager.newTab(params.url, {
				sessionId: params.session_id,
				cwd,
				timeoutMs: params.timeout_ms,
				signal,
				snapshot: snapshotOptionsFrom(params, signal),
			});
			const text = navigation ? formatNavigation(navigation) : `Opened blank tab ${tab.tabId} (now active).`;
			return okResult(text, { ok: true, action, sessionId: navigation?.sessionId, tabId: tab.tabId, url: tab.url });
		}
		case "switch_tab": {
			const tab = await manager.switchTab(requireParam(params.tab_id, "tab_id", action), params.session_id);
			return okResult(`Active tab is now ${tab.tabId}: ${tab.title || "(untitled)"} — ${tab.url}`, {
				ok: true,
				action,
				tabId: tab.tabId,
				url: tab.url,
			});
		}
		case "close_tab": {
			const res = await manager.closeTab(params.tab_id, params.session_id);
			return okResult(`Closed tab ${res.closedTabId}. Active tab: ${res.activeTabId ?? "none"}.`, {
				ok: true,
				action,
				tabId: res.activeTabId ?? undefined,
			});
		}
		case "viewport": {
			const res = await manager.setViewport(
				requireParam(params.width, "width", action),
				requireParam(params.height, "height", action),
				params.device_scale_factor,
				params.mobile,
				ref,
			);
			return okResult(
				`[${res.sessionId}/${res.tabId}] Viewport set to ${res.width}×${res.height} @${res.deviceScaleFactor}x${res.mobile ? " (mobile)" : ""}.`,
				{ ok: true, action, sessionId: res.sessionId, tabId: res.tabId },
			);
		}
		default:
			return undefined;
	}
}

async function withSettledSnapshot(
	headline: string,
	ids: { sessionId: string; tabId: string },
	action: string,
	params: BrowserParams,
	env: ActionEnv,
): Promise<AgentToolResult<BrowserToolDetails>> {
	const details: BrowserToolDetails = { ok: true, action, sessionId: ids.sessionId, tabId: ids.tabId, summary: headline };
	if (params.snapshot === false) {
		return okResult(headline, details);
	}
	const outcome = await env.manager.settleAndSnapshot({
		sessionId: ids.sessionId,
		tabId: ids.tabId,
		timeoutMs: params.timeout_ms,
		signal: env.signal,
		snapshot: snapshotOptionsFrom(params, env.signal),
	});
	return okResult(`${headline}\n\n${renderSnapshotOutcome(outcome, true)}`, {
		...details,
		tabId: outcome.tabId,
		url: outcome.snapshot.url,
	});
}

async function runInteractionAction(
	action: BrowserAction,
	params: BrowserParams,
	env: ActionEnv,
): Promise<AgentToolResult<BrowserToolDetails> | undefined> {
	const { manager, signal } = env;
	const ref = { sessionId: params.session_id, tabId: params.tab_id };
	const common = { ...ref, timeoutMs: params.timeout_ms, signal };
	switch (action) {
		case "click": {
			const target = requireParam(params.target, "target", action);
			const res = await manager.click(target, { ...common, doubleClick: params.double_click, button: params.button });
			const verb = params.double_click ? "Double-clicked" : "Clicked";
			return withSettledSnapshot(`${verb} ${res.clicked} at (${Math.round(res.x)}, ${Math.round(res.y)}).`, res, action, params, env);
		}
		case "fill": {
			const target = requireParam(params.target, "target", action);
			const res = await manager.fill(target, requireParam(params.value, "value", action), common);
			return withSettledSnapshot(`Filled ${res.filled} with ${JSON.stringify(res.value)}.`, res, action, params, env);
		}
		case "select": {
			const target = requireParam(params.target, "target", action);
			const values = params.values && params.values.length > 0 ? params.values : [requireParam(params.value, "values", action)];
			const res = await manager.select(target, values, common);
			return withSettledSnapshot(`Selected ${JSON.stringify(res.selected)} in ${res.target}.`, res, action, params, env);
		}
		case "hover": {
			const res = await manager.hover(requireParam(params.target, "target", action), common);
			return withSettledSnapshot(`Hovering ${res.hovered} at (${Math.round(res.x)}, ${Math.round(res.y)}).`, res, action, params, env);
		}
		case "type": {
			const res = await manager.type(requireParam(params.text, "text", action), { ...common, submit: params.submit });
			return withSettledSnapshot(`Typed ${res.typed} characters${res.submitted ? " and pressed Enter" : ""}.`, res, action, params, env);
		}
		case "press": {
			const res = await manager.press(requireParam(params.key, "key", action), common);
			return withSettledSnapshot(`Pressed ${res.pressed}.`, res, action, params, env);
		}
		case "scroll": {
			const res = await manager.scroll({ ...common, direction: params.direction, amountPx: params.amount_px, target: params.target });
			return withSettledSnapshot(`Scrolled to (${Math.round(res.scrollX)}, ${Math.round(res.scrollY)}).`, res, action, params, env);
		}
		default:
			return undefined;
	}
}

async function runInspectionAction(
	action: BrowserAction,
	params: BrowserParams,
	env: ActionEnv,
): Promise<AgentToolResult<BrowserToolDetails> | undefined> {
	const { manager, cwd, signal } = env;
	const ref = { sessionId: params.session_id, tabId: params.tab_id };
	switch (action) {
		case "snapshot": {
			const outcome = await manager.snapshot({ ...ref, ...snapshotOptionsFrom(params, signal), diff: params.diff });
			return okResult(renderSnapshotOutcome(outcome, params.diff === true), {
				ok: true,
				action,
				sessionId: outcome.sessionId,
				tabId: outcome.tabId,
				url: outcome.snapshot.url,
				summary: `${outcome.snapshot.refs.length} refs`,
			});
		}
		case "wait": {
			const hasCondition =
				params.selector !== undefined ||
				params.text !== undefined ||
				params.url_includes !== undefined ||
				params.network_idle_ms !== undefined ||
				params.delay_ms !== undefined;
			if (!hasCondition) {
				throw new Error("wait needs one of: selector, text, url_includes, network_idle_ms, delay_ms.");
			}
			const res = await manager.wait({
				...ref,
				selector: params.selector,
				text: params.text,
				urlIncludes: params.url_includes,
				networkIdleMs: params.network_idle_ms,
				delayMs: params.delay_ms,
				timeoutMs: params.timeout_ms,
				signal,
			});
			return withSettledSnapshot(`Condition met (${res.matched}) after ${res.elapsedMs}ms.`, res, action, params, env);
		}
		case "evaluate": {
			const res = await manager.evaluate(requireParam(params.expression, "expression", action), {
				...ref,
				timeoutMs: params.timeout_ms,
				signal,
			});
			const details: BrowserToolDetails = { ok: !res.isError, action, sessionId: res.sessionId, tabId: res.tabId };
			if (res.isError) {
				return { ...okResult(`browser error (evaluate): ${res.valueText}`, details), isError: true };
			}
			return okResult(res.valueText, details);
		}
		case "screenshot": {
			const shot = await manager.screenshot({
				...ref,
				fullPage: params.full_page,
				target: params.target,
				savePath: params.save_path,
				format: params.format,
				quality: params.quality,
				timeoutMs: params.timeout_ms,
				signal,
				cwd,
			});
			const summary = `[${shot.sessionId}/${shot.tabId}] ${formatScreenshotSummary(shot)}`;
			return okResult(summary, { ok: true, action, sessionId: shot.sessionId, tabId: shot.tabId, summary }, [imageBlock(shot)]);
		}
		case "console": {
			const report = await manager.getConsole({ ...ref, limit: params.limit, clear: params.clear });
			const text = `[${report.sessionId}/${report.tabId}]\n${formatConsole(report.console, report.errors, report.dialogs)}`;
			return okResult(text, {
				ok: true,
				action,
				sessionId: report.sessionId,
				tabId: report.tabId,
				summary: `${report.errors.length} errors, ${report.console.length} console`,
			});
		}
		case "network": {
			const report = await manager.getNetwork({ ...ref, failedOnly: params.failed_only, limit: params.limit, clear: params.clear });
			const text = `[${report.sessionId}/${report.tabId}]\n${formatNetwork(report.entries, { totalTracked: report.totalTracked, failedOnly: params.failed_only })}`;
			return okResult(text, { ok: true, action, sessionId: report.sessionId, tabId: report.tabId });
		}
		default:
			return undefined;
	}
}

export async function runBrowserAction(params: BrowserParams, env: ActionEnv): Promise<AgentToolResult<BrowserToolDetails>> {
	const action = params.action;
	const result =
		(await runSessionAction(action, params, env)) ??
		(await runTabAction(action, params, env)) ??
		(await runInteractionAction(action, params, env)) ??
		(await runInspectionAction(action, params, env));
	if (!result) {
		throw new Error(`Unknown browser action '${String(action)}'. Valid actions: ${BROWSER_ACTIONS.join(", ")}.`);
	}
	return result;
}

export default function piCdpExtension(pi: ExtensionAPI): void {
	const manager = new BrowserSessionManager();
	let lastCtx: ExtensionContext | undefined;

	manager.onChange(() => {
		syncUiStatus(manager, lastCtx);
	});

	pi.on("session_start", async (event, ctx) => {
		lastCtx = ctx;
		if (event.reason === "new" || event.reason === "resume") {
			await manager.disposeAll();
		}
		syncUiStatus(manager, ctx);
	});

	pi.on("session_shutdown", async () => {
		await manager.disposeAll();
		if (lastCtx && lastCtx.mode === "tui") {
			lastCtx.ui.setStatus(STATUS_KEY, undefined);
		}
	});

	pi.registerTool({
		name: "web_inspect",
		label: "Web Inspect",
		description:
			"One-shot headless browser check: renders a URL in an isolated headless Chrome/Edge/Chromium, returns an @eN accessibility snapshot of the page, JavaScript page errors, console warnings/errors, failed network requests, HTTP status, and an optional screenshot image, then closes the browser.",
		promptSnippet:
			"Render a web page headlessly and get its accessibility snapshot, JS errors, failed requests, and optional screenshot in one self-cleaning call",
		promptGuidelines: [
			"Use `web_inspect` to verify a web page or local dev server actually renders (after UI edits, deploys, or when the user shares a URL) instead of guessing from source or using curl, because it executes JavaScript and reports page errors and failed requests.",
			"Pass `screenshot: true` to `web_inspect` when visual layout, styling, or images matter; skip it for pure content or error checks to save tokens.",
			"Switch from `web_inspect` to `browser` when you need to click, fill forms, log in, or follow multi-step flows on the same page.",
		],
		parameters: WebInspectParamsSchema,
		executionMode: "sequential",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
		},
		async execute(_toolCallId, params: WebInspectParams, signal, _onUpdate, ctx) {
			lastCtx = ctx;
			try {
				const res = await manager.runWebInspect({
					url: params.url,
					cwd: ctx.cwd,
					waitForSelector: params.wait_for_selector,
					waitForText: params.wait_for_text,
					waitMs: params.wait_ms,
					screenshot: params.screenshot,
					fullPage: params.full_page,
					saveScreenshotPath: params.save_screenshot_path
						? resolveToolPath(params.save_screenshot_path, ctx.cwd)
						: undefined,
					viewport:
						params.viewport_width && params.viewport_height
							? { width: params.viewport_width, height: params.viewport_height }
							: undefined,
					maxElements: params.max_elements,
					maxChars: params.max_chars,
					timeoutMs: params.timeout_ms,
					signal,
				});
				const text = formatWebInspectResult(res);
				const details: BrowserToolDetails = {
					ok: true,
					action: "inspect",
					url: res.finalUrl,
					summary: `${res.pageErrors.length} page errors, ${res.failedRequests.length} failed requests`,
				};
				return okResult(text, details, res.screenshot ? [imageBlock(res.screenshot)] : []);
			} catch (err) {
				return errorResult(errorMessage(err), "web_inspect", "inspect");
			}
		},
		renderCall(args, theme) {
			const flags = [args.screenshot ? "screenshot" : "", args.full_page ? "full-page" : ""].filter(Boolean).join(" ");
			const line = `${theme.fg("accent", theme.bold("web_inspect"))} ${theme.fg("text", args.url)}${flags ? ` ${theme.fg("muted", flags)}` : ""}`;
			return new Text(line, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Rendering page headlessly…"), 0, 0);
			}
			const rawText = firstText(result);
			if (result.isError) {
				return new Text(theme.fg("error", rawText), 0, 0);
			}
			const imageNote = hasImage(result) ? `\n${theme.fg("muted", "[screenshot attached]")}` : "";
			if (expanded) {
				return new Text(`${rawText}${imageNote}`, 0, 0);
			}
			return new Text(`${renderCollapsedLines(rawText, 12, theme, 110 - context.outputPad)}${imageNote}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "browser",
		label: "Browser",
		description:
			"Interactive Chrome DevTools Protocol browser: multiple sessions (b1, b2…) and tabs (t1, t2…), zero-ceremony `open` (auto-launches headless Chrome/Edge/Chromium), live attach to the user's running Chrome, @eN accessibility snapshots with diffs, click/fill/select/hover/type/press/scroll by @eN ref or CSS selector, wait conditions, JavaScript evaluate, screenshots, console/page-error and network logs, viewport emulation, and automatic JS dialog handling.",
		promptSnippet:
			"Drive a real browser step by step: open pages, act on @eN snapshot refs, read diffs, screenshots, console and network logs",
		promptGuidelines: [
			"Use `browser` with action `open` and a URL to start; it auto-launches a headless browser session, so `launch` is only needed for headed mode, custom profiles, or a specific executable.",
			"In `browser`, target elements by the @eN refs from the latest snapshot (e.g. `target: \"@e12\"`); after a navigation the refs are renumbered, so take a fresh `browser` snapshot instead of reusing old refs.",
			"`browser` interactions (click/fill/select/type/press/scroll/wait) return a settled diff of what changed; call `browser` action `snapshot` for the full tree or `screenshot` when visual confirmation matters.",
			"Use `browser` action `attach` only when the user asks to work in their own running Chrome (e.g. logged-in pages); `browser` disconnect then leaves their browser open.",
			"Check `browser` actions `console` and `network` (failed_only: true) when a page misbehaves before guessing at causes.",
		],
		parameters: BrowserParamsSchema,
		executionMode: "sequential",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
		},
		async execute(_toolCallId, params: BrowserParams, signal, _onUpdate, ctx) {
			lastCtx = ctx;
			try {
				const result = await runBrowserAction(params, { manager, cwd: ctx.cwd, signal });
				syncUiStatus(manager, ctx);
				return result;
			} catch (err) {
				syncUiStatus(manager, ctx);
				return errorResult(errorMessage(err), "browser", params.action, {
					sessionId: params.session_id,
					tabId: params.tab_id,
				});
			}
		},
		renderCall(args, theme) {
			const parts: string[] = [theme.fg("accent", theme.bold("browser")), theme.fg("warning", args.action)];
			if (args.session_id || args.tab_id) {
				parts.push(theme.fg("muted", `[${[args.session_id, args.tab_id].filter(Boolean).join("/")}]`));
			}
			const subject = args.url ?? args.target ?? args.expression ?? args.key ?? args.text ?? args.selector;
			if (subject) {
				parts.push(theme.fg("text", subject));
			}
			if (args.value !== undefined) {
				parts.push(theme.fg("muted", JSON.stringify(args.value)));
			}
			return new Text(parts.join(" "), 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Running browser action…"), 0, 0);
			}
			const rawText = firstText(result);
			if (result.isError) {
				return new Text(theme.fg("error", rawText), 0, 0);
			}
			const imageNote = hasImage(result) ? `\n${theme.fg("muted", "[screenshot attached]")}` : "";
			if (expanded) {
				return new Text(`${rawText}${imageNote}`, 0, 0);
			}
			return new Text(`${renderCollapsedLines(rawText, 12, theme, 110 - context.outputPad)}${imageNote}`, 0, 0);
		},
	});

	const notify = (ctx: ExtensionCommandContext, message: string): void => {
		if (ctx.hasUI) {
			ctx.ui.notify(message, "info");
		}
	};

	const handleSlashCommand = async (rawArgs: string, ctx: ExtensionCommandContext): Promise<void> => {
		lastCtx = ctx;
		const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
		const sub = tokens[0] ?? "status";
		switch (sub) {
			case "doctor": {
				try {
					notify(ctx, formatDoctorReport(await runBrowserDoctor(ctx.cwd)));
				} catch (err) {
					notify(ctx, `pi-cdp doctor failed: ${errorMessage(err)}`);
				}
				return;
			}
			case "stop":
			case "disconnect": {
				const target = tokens[1];
				const { closedSessions } = await manager.disconnect(
					target && target !== "all" ? { sessionId: target } : { all: true },
				);
				syncUiStatus(manager, ctx);
				notify(
					ctx,
					closedSessions.length > 0
						? `Stopped browser session(s): ${closedSessions.join(", ")}`
						: "No active browser sessions to stop.",
				);
				return;
			}
			default: {
				notify(ctx, formatSessions(manager.listSessions(), manager.activeSession));
				return;
			}
		}
	};

	pi.registerCommand("cdp", {
		description: "Inspect or control pi-cdp browser sessions (/cdp [status|sessions|doctor|stop [id|all]])",
		getArgumentCompletions(prefix) {
			const candidates = ["status", "sessions", "doctor", "stop", "stop all"];
			const filtered = candidates.filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value }));
			return filtered.length > 0 ? filtered : null;
		},
		handler: handleSlashCommand,
	});
}
