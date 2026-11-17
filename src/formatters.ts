/**
 * Compact, LLM-friendly text renderers for pi-cdp results.
 * Every formatter is pure (no I/O) so it can be unit-tested and reused by the tools and `/cdp`.
 */
import type { NavigationResult } from "./session-manager.ts";
import type {
	AriaSnapshot,
	BrowserDoctorReport,
	BrowserSessionSummary,
	ConsoleEntry,
	DialogEntry,
	NetworkEntry,
	PageErrorEntry,
	ScreenshotResult,
	SnapshotDiff,
	SnapshotRefEntry,
	TabSummary,
	WebInspectResult,
} from "./types.ts";

const DEFAULT_LIST_LIMIT = 30;
const MAX_URL_CHARS = 140;
const MAX_LINE_TEXT_CHARS = 240;

function clip(text: string, max: number): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function location(url: string | undefined, lineNumber: number | undefined): string {
	if (!url) {
		return "";
	}
	const suffix = lineNumber === undefined ? "" : `:${lineNumber}`;
	return ` (${clip(url, MAX_URL_CHARS)}${suffix})`;
}

function moreLine(total: number, shown: number): string[] {
	return total > shown ? [`  … ${total - shown} more`] : [];
}

/** One-line description of a snapshot ref, e.g. `@e3 button "Submit" [disabled]`. */
export function formatRefEntry(ref: SnapshotRefEntry): string {
	const flags: string[] = [];
	if (ref.checked !== undefined) {
		flags.push(`checked=${String(ref.checked)}`);
	}
	if (ref.selected) {
		flags.push("selected");
	}
	if (ref.disabled) {
		flags.push("disabled");
	}
	if (ref.expanded !== undefined) {
		flags.push(`expanded=${String(ref.expanded)}`);
	}
	if (ref.required) {
		flags.push("required");
	}
	if (ref.focused) {
		flags.push("focused");
	}
	if (ref.level !== undefined) {
		flags.push(`level=${ref.level}`);
	}
	const name = ref.name ? ` "${clip(ref.name, 80)}"` : "";
	const value = ref.value ? ` value="${clip(ref.value, 60)}"` : "";
	const url = ref.url ? ` → ${clip(ref.url, 80)}` : "";
	const flagText = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
	return `@${ref.ref.replace(/^@/, "")} ${ref.role}${name}${value}${flagText}${url}`;
}

export function formatDoctorReport(report: BrowserDoctorReport): string {
	const lines: string[] = [`pi-cdp doctor — ${report.platform}/${report.arch}`];
	if (report.preferredBrowser) {
		const pref = report.preferredBrowser;
		lines.push(`Preferred browser: ${pref.name} (${pref.channel}) — ${pref.executablePath}`);
	} else {
		lines.push("Preferred browser: none found");
	}
	lines.push(`Browsers (${report.browsers.length}):`);
	if (report.browsers.length === 0) {
		lines.push("  (none detected)");
	}
	for (const browser of report.browsers) {
		const extra = [browser.headlessOnly ? "headless-only" : "", browser.revision === undefined ? "" : `r${browser.revision}`]
			.filter((part) => part.length > 0)
			.join(", ");
		const extraText = extra ? ` [${extra}]` : "";
		lines.push(`  • ${browser.name} (${browser.channel})${extraText} — ${browser.executablePath} [${browser.source}]`);
	}
	lines.push(`Live CDP endpoints (${report.liveEndpoints.length}):`);
	if (report.liveEndpoints.length === 0) {
		lines.push("  (none listening)");
	}
	for (const endpoint of report.liveEndpoints) {
		const version = endpoint.browserVersion ? ` ${endpoint.browserVersion}` : "";
		const note = endpoint.note ? ` — ${endpoint.note}` : "";
		lines.push(`  • ${endpoint.browserName}${version} @ ${endpoint.host}:${endpoint.port} [${endpoint.mode}, ${endpoint.source}]${note}`);
	}
	const toggle = report.chromeRemoteDebuggingToggle;
	if (toggle) {
		lines.push(
			`Chrome remote-debugging toggle: ${toggle.userEnabled ? "enabled" : "disabled"} (policy ${toggle.allowed ? "allows" : "blocks"}) — ${toggle.profileDir}`,
		);
	}
	if (report.guidance.length > 0) {
		lines.push("Guidance:");
		for (const hint of report.guidance) {
			lines.push(`  - ${hint}`);
		}
	}
	return lines.join("\n");
}

export function formatTabs(tabs: TabSummary[], sessionId?: string | null): string {
	const header = sessionId ? `Tabs in [${sessionId}] (${tabs.length}):` : `Tabs (${tabs.length}):`;
	if (tabs.length === 0) {
		return `${header}\n  (no open tabs)`;
	}
	const lines = [header];
	for (const tab of tabs) {
		const marker = tab.active ? "*" : " ";
		const title = tab.title ? clip(tab.title, 60) : "(untitled)";
		const counters: string[] = [`gen ${tab.generation}`];
		if (tab.snapshotRefCount > 0) {
			counters.push(plural(tab.snapshotRefCount, "ref"));
		}
		if (tab.errorCount > 0) {
			counters.push(plural(tab.errorCount, "error"));
		}
		if (tab.failedRequestCount > 0) {
			counters.push(`${tab.failedRequestCount} failed req`);
		}
		if (tab.consoleCount > 0) {
			counters.push(`${tab.consoleCount} console`);
		}
		lines.push(`${marker} ${tab.tabId} ${title} — ${clip(tab.url, MAX_URL_CHARS)} (${counters.join(", ")})`);
	}
	return lines.join("\n");
}

export function formatSessions(sessions: BrowserSessionSummary[], activeSessionId?: string | null): string {
	if (sessions.length === 0) {
		return "No browser sessions. Use browser action 'open' (auto-launches headless), 'launch', or 'attach'.";
	}
	const lines: string[] = [`Browser sessions (${sessions.length}):`];
	for (const session of sessions) {
		const marker = session.id === activeSessionId ? "*" : " ";
		let kind = "headed";
		if (session.mode === "attached") {
			kind = "attached";
		} else if (session.headless) {
			kind = "headless";
		}
		const pid = session.pid === undefined ? "" : ` pid ${session.pid}`;
		lines.push(
			`${marker} [${session.id}] ${session.name} — ${session.browserName} (${kind}${pid}), ${plural(session.tabs.length, "tab")}, active ${session.activeTabId ?? "none"}, dialogs ${session.dialogPolicy}`,
		);
		for (const tab of session.tabs) {
			const tabMarker = tab.active ? "*" : " ";
			lines.push(`    ${tabMarker} ${tab.tabId} ${tab.title ? clip(tab.title, 50) : "(untitled)"} — ${clip(tab.url, MAX_URL_CHARS)}`);
		}
	}
	return lines.join("\n");
}

export function formatSnapshot(snapshot: AriaSnapshot): string {
	const header = [
		`Page: ${snapshot.title ? clip(snapshot.title, 120) : "(untitled)"}`,
		`URL: ${snapshot.url}`,
		`Refs: ${snapshot.refs.length}${snapshot.totalInteractiveCount > snapshot.refs.length ? ` of ${snapshot.totalInteractiveCount} interactive` : ""} (generation ${snapshot.generation})${snapshot.truncated ? " — truncated; narrow with rootSelector or raise maxElements/maxChars" : ""}`,
	];
	const body = snapshot.treeText.trim().length > 0 ? snapshot.treeText.trimEnd() : "(empty accessibility tree)";
	return `${header.join("\n")}\n\n${body}`;
}

/**
 * Structured diff listing. `limit` caps the itemised added/changed lines; `limit = 0` reports counts only
 * (used when the full new snapshot follows anyway). `summaryText` is only a fallback so nothing is repeated.
 */
export function formatSnapshotDiff(diff: SnapshotDiff, limit = DEFAULT_LIST_LIMIT): string {
	const lines: string[] = ["Changes since previous snapshot:"];
	if (diff.urlChanged) {
		lines.push(`  URL: ${clip(diff.previousUrl, MAX_URL_CHARS)} → ${clip(diff.currentUrl, MAX_URL_CHARS)}`);
	}
	if (diff.titleChanged) {
		lines.push("  Title changed");
	}
	if (diff.addedRefs.length > 0) {
		if (limit > 0) {
			const shownAdded = diff.addedRefs.slice(0, limit);
			lines.push(`  Added (${diff.addedRefs.length}):`);
			for (const ref of shownAdded) {
				lines.push(`    + ${formatRefEntry(ref)}`);
			}
			lines.push(...moreLine(diff.addedRefs.length, shownAdded.length).map((line) => `  ${line}`));
		} else {
			lines.push(`  Added: ${diff.addedRefs.length}`);
		}
	}
	if (diff.changedRefs.length > 0) {
		if (limit > 0) {
			const shownChanged = diff.changedRefs.slice(0, limit);
			lines.push(`  Changed (${diff.changedRefs.length}):`);
			for (const change of shownChanged) {
				lines.push(`    ~ ${formatRefEntry(change.before)}  ⇒  ${formatRefEntry(change.after)}`);
			}
			lines.push(...moreLine(diff.changedRefs.length, shownChanged.length).map((line) => `  ${line}`));
		} else {
			lines.push(`  Changed: ${diff.changedRefs.length}`);
		}
	}
	if (diff.removedCount > 0) {
		lines.push(`  Removed: ${diff.removedCount}`);
	}
	if (lines.length === 1) {
		lines.push(diff.summaryText ? `  ${diff.summaryText.split("\n").join("\n  ")}` : "  (no changes)");
	}
	return lines.join("\n");
}

export function formatConsole(
	consoleEntries: ConsoleEntry[],
	pageErrors: PageErrorEntry[],
	dialogs: DialogEntry[] = [],
	limit = DEFAULT_LIST_LIMIT,
): string {
	const lines: string[] = [];
	lines.push(`Page errors (${pageErrors.length}):`);
	if (pageErrors.length === 0) {
		lines.push("  (none)");
	}
	const errors = pageErrors.slice(-limit);
	lines.push(...moreLine(pageErrors.length, errors.length));
	for (const err of errors) {
		lines.push(`  ✗ ${clip(err.message, MAX_LINE_TEXT_CHARS)}${location(err.url, err.lineNumber)}`);
	}
	lines.push(`Console (${consoleEntries.length}):`);
	if (consoleEntries.length === 0) {
		lines.push("  (none)");
	}
	const entries = consoleEntries.slice(-limit);
	lines.push(...moreLine(consoleEntries.length, entries.length));
	for (const entry of entries) {
		lines.push(`  [${entry.level}] ${clip(entry.text, MAX_LINE_TEXT_CHARS)}${location(entry.url, entry.lineNumber)}`);
	}
	if (dialogs.length > 0) {
		lines.push(`Dialogs (${dialogs.length}):`);
		for (const dialog of dialogs.slice(-limit)) {
			lines.push(`  ${dialog.type} "${clip(dialog.message, 120)}" → ${dialog.handled}`);
		}
	}
	return lines.join("\n");
}

function formatNetworkEntry(entry: NetworkEntry): string {
	let outcome: string;
	if (entry.failed) {
		outcome = entry.canceled ? "CANCELED" : `FAILED ${entry.errorText ?? ""}`.trim();
	} else if (entry.status === undefined) {
		outcome = "pending";
	} else {
		outcome = `${entry.status}${entry.statusText ? ` ${entry.statusText}` : ""}`;
	}
	return `  ${entry.method} ${clip(entry.url, MAX_URL_CHARS)} → ${outcome} [${entry.resourceType}]`;
}

export function formatNetwork(
	entries: NetworkEntry[],
	opts: { totalTracked?: number; failedOnly?: boolean } = {},
): string {
	const label = opts.failedOnly ? "Failed requests" : "Network requests";
	const tracked = opts.totalTracked === undefined ? "" : ` of ${opts.totalTracked} tracked`;
	const lines = [`${label} (${entries.length}${tracked}):`];
	if (entries.length === 0) {
		lines.push("  (none)");
	}
	for (const entry of entries) {
		lines.push(formatNetworkEntry(entry));
	}
	return lines.join("\n");
}

export function formatScreenshotSummary(shot: ScreenshotResult): string {
	const saved = shot.savedPath ? ` saved to ${shot.savedPath}` : "";
	return `Screenshot ${shot.width}×${shot.height} ${shot.mimeType}${shot.fullPage ? " (full page)" : ""}${saved}`;
}

export function formatNavigation(nav: NavigationResult): string {
	const status = nav.httpStatus === undefined ? "" : ` HTTP ${nav.httpStatus}`;
	const timing = nav.timedOut ? ` — load event timed out after ${nav.durationMs}ms (page may still be loading)` : ` in ${nav.durationMs}ms`;
	return `[${nav.sessionId}/${nav.tabId}] Loaded ${nav.finalUrl}${status}${timing}\n\n${formatSnapshot(nav.snapshot)}`;
}

export function formatWebInspectResult(result: WebInspectResult & { warnings?: string[] }): string {
	const status = result.httpStatus === undefined ? "" : ` — HTTP ${result.httpStatus}`;
	const lines: string[] = [
		`web_inspect ${result.finalUrl}${status} (${result.browserName}, ${result.durationMs}ms)`,
	];
	if (result.finalUrl !== result.url) {
		lines.push(`Requested: ${result.url}`);
	}
	const health = [
		plural(result.pageErrors.length, "page error"),
		plural(result.failedRequests.length, "failed request"),
		`${result.consoleEntries.filter((entry) => entry.level === "error" || entry.level === "warning").length} console warnings/errors`,
	];
	lines.push(`Health: ${health.join(", ")}`);
	for (const warning of result.warnings ?? []) {
		lines.push(`⚠ ${warning}`);
	}
	if (result.screenshot) {
		lines.push(formatScreenshotSummary(result.screenshot));
	}
	lines.push("", formatSnapshot(result.snapshot));
	if (result.pageErrors.length > 0 || result.consoleEntries.length > 0) {
		lines.push("", formatConsole(result.consoleEntries, result.pageErrors));
	}
	if (result.failedRequests.length > 0) {
		lines.push("", formatNetwork(result.failedRequests, { failedOnly: true }));
	}
	return lines.join("\n");
}
