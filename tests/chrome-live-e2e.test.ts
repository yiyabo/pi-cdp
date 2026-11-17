/**
 * Real-browser end-to-end suite: drives an actual Chromium-family browser (Chrome, Edge, Chromium,
 * Playwright builds…) found by `discoverBrowsers()` against a local 127.0.0.1 fixture server.
 *
 * The suite is skipped only when the machine has no Chromium-family browser at all.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import piCdpExtension from "../extensions/index.ts";
import { launchBrowserProcess } from "../src/cdp/client.ts";
import { discoverBrowsers } from "../src/discovery/browsers.ts";
import { BrowserSessionManager } from "../src/session-manager.ts";
import type { LaunchBrowserProcessOptions, LaunchedBrowserHandle, SnapshotRefEntry } from "../src/types.ts";
import { collectDescendantPids, isPidAlive } from "../src/utils/process-tree.ts";

const BROWSERS = discoverBrowsers();
const SKIP_REASON = BROWSERS.length === 0 ? "no Chromium-family browser installed on this machine" : false;
const PROFILE_MARKER = "pi-cdp-profile-";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const execFileAsync = promisify(execFile);

// ───────────────────────────── fixture server ─────────────────────────────

const APP_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>E2E App</title>
<style>
	body { font-family: sans-serif; margin: 16px; }
	iframe { display: block; margin: 24px 0 0 180px; width: 420px; height: 160px; border: 2px solid #444; }
</style>
</head>
<body>
<main>
	<h1>E2E App</h1>
	<label for="controlled">Full name</label>
	<input id="controlled" type="text" autocomplete="off">
	<p id="echo">Hello, nobody</p>

	<label for="color">Color</label>
	<select id="color">
		<option value="red">Red</option>
		<option value="green">Green</option>
		<option value="blue">Blue</option>
	</select>
	<label for="toppings">Toppings</label>
	<select id="toppings" multiple size="4">
		<option value="cheese">Cheese</option>
		<option value="olives">Olives</option>
		<option value="peppers">Peppers</option>
		<option value="onions">Onions</option>
	</select>
	<p id="select-echo">color=red toppings=</p>

	<button id="counter" type="button">Count: 0</button>
	<div id="status-log"></div>

	<button id="dialogs" type="button">Show dialogs</button>
	<p id="dialog-result">dialog:pending</p>

	<a id="to-page2" href="/page2">Go to page 2</a>
	<p id="frame-result">frame-clicks:0</p>
	<p id="fetch-result">fetch:pending</p>
	<iframe src="/frame" title="Inner frame"></iframe>
</main>
<script>
	(() => {
		// React-style value tracking: an instance-level value property records assignments, and the
		// input listener only reacts when the DOM value diverges from the tracked one. A fill that
		// assigns el.value directly is therefore swallowed; only the native prototype setter works.
		const input = document.getElementById("controlled");
		const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
		let tracked = native.get.call(input);
		window.__instanceSetterCalls = 0;
		Object.defineProperty(input, "value", {
			configurable: true,
			get() { return native.get.call(this); },
			set(next) { window.__instanceSetterCalls += 1; tracked = String(next); native.set.call(this, next); },
		});
		input.addEventListener("input", () => {
			const actual = native.get.call(input);
			if (actual === tracked) { return; }
			tracked = actual;
			document.getElementById("echo").textContent = "Hello, " + actual;
		});

		const color = document.getElementById("color");
		const toppings = document.getElementById("toppings");
		const renderSelects = () => {
			const picked = Array.from(toppings.selectedOptions).map((o) => o.value).join(",");
			document.getElementById("select-echo").textContent = "color=" + color.value + " toppings=" + picked;
		};
		color.addEventListener("change", renderSelects);
		toppings.addEventListener("change", renderSelects);

		let count = 0;
		const counter = document.getElementById("counter");
		counter.addEventListener("click", () => {
			count += 1;
			counter.textContent = "Count: " + count;
			const line = document.createElement("p");
			line.textContent = "status: clicked " + count;
			document.getElementById("status-log").appendChild(line);
			if (count === 1) {
				const reset = document.createElement("button");
				reset.type = "button";
				reset.textContent = "Reset counter";
				counter.after(reset);
			}
		});

		document.getElementById("dialogs").addEventListener("click", () => {
			window.alert("hello");
			const ok = window.confirm("proceed?");
			document.getElementById("dialog-result").textContent = "confirm:" + ok;
		});

		console.error("synthetic-console-err");
		setTimeout(() => { throw new Error("synthetic-page-err"); }, 0);
		Promise.reject(new Error("synthetic-page-err (rejection)"));
		fetch("/api/missing-404").then((res) => {
			document.getElementById("fetch-result").textContent = "fetch-done:" + res.status;
		});
	})();
</script>
</body>
</html>`;

const FRAME_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Inner</title>
<style>body { margin: 0; padding: 40px 0 0 120px; }</style>
</head>
<body>
	<button id="frame-btn" type="button">Frame Action</button>
	<input id="frame-note" type="text" aria-label="Frame note">
	<p id="inner-count">inner:0</p>
	<script>
		let clicks = 0;
		document.getElementById("frame-btn").addEventListener("click", () => {
			clicks += 1;
			document.getElementById("inner-count").textContent = "inner:" + clicks;
			parent.document.getElementById("frame-result").textContent = "frame-clicks:" + clicks;
		});
	</script>
</body>
</html>`;

const TALL_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Tall Page</title>
<style>
	body { margin: 0; }
	#spacer { position: relative; height: 3200px; background: linear-gradient(#fff, #9cf); }
	#deep { position: absolute; top: 2600px; left: 40px; width: 160px; height: 48px; }
</style>
</head>
<body>
	<div id="spacer">
		<h1>Tall Page</h1>
		<button id="deep" type="button">Deep Button</button>
	</div>
	<script>
		document.getElementById("deep").addEventListener("click", () => {
			document.title = "Tall Page (deep-clicked)";
			document.body.setAttribute("data-deep", "clicked");
		});
	</script>
</body>
</html>`;

const PAGE2_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Page Two</title></head>
<body>
	<main>
		<h1>Page Two</h1>
		<a href="/app">Back to app</a>
		<button type="button" onclick="this.textContent='Page two pressed'">Page two button</button>
	</main>
</body>
</html>`;

interface FixtureServer {
	baseUrl: string;
	requests: string[];
	close(): Promise<void>;
}

async function startFixtureServer(): Promise<FixtureServer> {
	const requests: string[] = [];
	const routes: Record<string, string> = { "/app": APP_HTML, "/frame": FRAME_HTML, "/tall": TALL_HTML, "/page2": PAGE2_HTML };
	const server = http.createServer((req, res) => {
		const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
		requests.push(pathname);
		const html = routes[pathname];
		if (html) {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			res.end(html);
			return;
		}
		if (pathname === "/favicon.ico") {
			res.writeHead(204);
			res.end();
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "not found", path: pathname }));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

// ───────────────────────────── process-leak helpers ─────────────────────────────

interface ProfileProcess {
	pid: number;
	ppid: number;
	/** Temporary profile token such as `pi-cdp-profile-AbC123` from the process command line. */
	profile: string;
}

const PROFILE_TOKEN = new RegExp(`${PROFILE_MARKER}[A-Za-z0-9]+`);

/** Every running process whose command line mentions a pi-cdp temporary profile directory (async: never blocks CDP I/O). */
async function listProfileProcesses(): Promise<ProfileProcess[]> {
	let output: string;
	try {
		const listed =
			process.platform === "win32"
				? await execFileAsync(
						"powershell.exe",
						[
							"-NoProfile",
							"-NonInteractive",
							"-Command",
							'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }',
						],
						{ encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
					)
				: await execFileAsync("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "args="], {
						encoding: "utf8",
						timeout: 10_000,
						maxBuffer: 64 * 1024 * 1024,
					});
		output = listed.stdout;
	} catch {
		return [];
	}
	const processes: ProfileProcess[] = [];
	for (const line of output.split(/\r?\n/)) {
		const profile = PROFILE_TOKEN.exec(line)?.[0];
		if (!profile) {
			continue;
		}
		const [pidText, ppidText] = line.trim().split(/\s+/);
		const pid = Number.parseInt(pidText ?? "", 10);
		const ppid = Number.parseInt(ppidText ?? "", 10);
		if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
			processes.push({ pid, ppid, profile });
		}
	}
	return processes;
}

/**
 * Periodically records the temporary profiles of browsers spawned by THIS test process (the main browser process
 * is our direct child), so leak checks ignore browsers started concurrently by unrelated processes.
 */
class OwnedBrowserSampler {
	readonly profiles = new Set<string>();
	private readonly timer: NodeJS.Timeout;
	private inFlight: Promise<void> | null = null;

	constructor(intervalMs = 150) {
		this.timer = setInterval(() => void this.sample(), intervalMs);
		void this.sample();
	}

	sample(): Promise<void> {
		this.inFlight ??= listProfileProcesses()
			.then((all) => {
				for (const proc of all) {
					if (proc.ppid === process.pid) {
						this.profiles.add(proc.profile);
					}
				}
			})
			.finally(() => {
				this.inFlight = null;
			});
		return this.inFlight;
	}

	async stop(): Promise<void> {
		clearInterval(this.timer);
		await this.inFlight;
	}

	/** PIDs of owned-profile processes still running once teardown settles (polls until `timeoutMs`). */
	async leaked(timeoutMs = 8_000): Promise<number[]> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const leaked = (await listProfileProcesses()).filter((proc) => this.profiles.has(proc.profile)).map((proc) => proc.pid);
			if (leaked.length === 0 || Date.now() >= deadline) {
				return leaked;
			}
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
	}
}

async function waitForPidsGone(pids: Iterable<number>, timeoutMs = 8_000): Promise<number[]> {
	const list = [...pids];
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const alive = list.filter(isPidAlive);
		if (alive.length === 0 || Date.now() >= deadline) {
			return alive;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

interface LaunchRecord {
	pid: number;
	userDataDir: string;
	descendants: Set<number>;
	shutdownCalled: boolean;
}

/** Real launcher that records the browser PID and its full process tree (sampled at shutdown). */
function trackingLauncher(records: LaunchRecord[]): (opts: LaunchBrowserProcessOptions) => Promise<LaunchedBrowserHandle> {
	return async (opts) => {
		const handle = await launchBrowserProcess(opts);
		const record: LaunchRecord = { pid: handle.pid, userDataDir: handle.userDataDir, descendants: new Set(), shutdownCalled: false };
		for (const pid of collectDescendantPids(handle.pid)) {
			record.descendants.add(pid);
		}
		records.push(record);
		return {
			...handle,
			shutdown: async () => {
				record.shutdownCalled = true;
				for (const pid of collectDescendantPids(handle.pid)) {
					record.descendants.add(pid);
				}
				await handle.shutdown();
			},
		};
	};
}

async function assertNoLiveBrowserProcesses(records: LaunchRecord[]): Promise<void> {
	assert.ok(records.length > 0, "expected at least one real browser launch");
	for (const record of records) {
		assert.equal(record.shutdownCalled, true, `browser pid ${record.pid} was never shut down`);
		const alive = await waitForPidsGone([record.pid, ...record.descendants]);
		assert.deepEqual(alive, [], `leaked browser processes from pid ${record.pid}: ${alive.join(", ")}`);
		assert.equal(fs.existsSync(record.userDataDir), false, `temporary profile ${record.userDataDir} was not removed`);
	}
}

// ───────────────────────────── extension harness ─────────────────────────────

interface ToolResultLike {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError?: boolean;
}

interface ExecutableTool {
	name: string;
	execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown): Promise<ToolResultLike>;
}

interface ExtensionHarness {
	tools: Map<string, ExecutableTool>;
	run(tool: string, params: Record<string, unknown>): Promise<ToolResultLike>;
	shutdown(): Promise<void>;
}

function loadExtension(cwd: string): ExtensionHarness {
	const tools = new Map<string, ExecutableTool>();
	const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const fakePi = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			events.set(event, [...(events.get(event) ?? []), handler]);
			return () => undefined;
		},
		registerTool(def: ExecutableTool) {
			tools.set(def.name, def);
		},
		registerCommand() {
			// Slash commands are not exercised by this suite.
		},
	};
	// SAFETY: structural mock of the registration surface; tools receive a minimal non-UI context.
	piCdpExtension(fakePi as unknown as Parameters<typeof piCdpExtension>[0]);
	const ctx = { cwd, hasUI: false, mode: "print" };
	let callNumber = 0;
	return {
		tools,
		async run(tool, params) {
			const definition = tools.get(tool);
			assert.ok(definition, `tool ${tool} is not registered`);
			callNumber += 1;
			return definition.execute(`e2e-${callNumber}`, params, undefined, undefined, ctx);
		},
		async shutdown() {
			for (const handler of events.get("session_shutdown") ?? []) {
				await handler({ type: "session_shutdown" }, ctx);
			}
		},
	};
}

function textOf(result: ToolResultLike): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

function expectOk(result: ToolResultLike, label: string): string {
	const text = textOf(result);
	assert.notEqual(result.isError, true, `${label} failed: ${text}`);
	return text;
}

/** Extracts the @eN ref rendered for an element line such as `- button "Count: 0" @e7`. */
function refFromText(text: string, role: string, name: string): string {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`- ${role} "${escaped}" (@e\\d+)`).exec(text);
	assert.ok(match?.[1], `no ${role} "${name}" ref in:\n${text}`);
	return match[1];
}

function assertPng(base64: string, label: string): Buffer {
	assert.equal(base64.startsWith("data:"), false, `${label}: base64 must not carry a data: URI prefix`);
	const buffer = Buffer.from(base64, "base64");
	assert.ok(buffer.subarray(0, 8).equals(PNG_SIGNATURE), `${label}: missing PNG signature`);
	return buffer;
}

function findRef(refs: readonly SnapshotRefEntry[], role: string, name: string | RegExp): SnapshotRefEntry {
	const entry = refs.find((ref) => ref.role === role && (typeof name === "string" ? ref.name === name : name.test(ref.name)));
	assert.ok(entry, `no ${role} ${String(name)} among refs: ${refs.map((ref) => `${ref.ref} ${ref.role} "${ref.name}"`).join("; ")}`);
	return entry;
}

// ───────────────────────────── suite ─────────────────────────────

describe("real Chrome end-to-end", { skip: SKIP_REASON, timeout: 240_000 }, () => {
	let fixture: FixtureServer;
	let suiteSampler: OwnedBrowserSampler | undefined;
	const tmpDirs: string[] = [];

	before(async () => {
		fixture = await startFixtureServer();
		suiteSampler = new OwnedBrowserSampler(250);
	});

	after(async () => {
		await fixture?.close();
		for (const dir of tmpDirs) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		if (suiteSampler) {
			await suiteSampler.stop();
			const leaked = await suiteSampler.leaked();
			assert.ok(suiteSampler.profiles.size > 0 || process.platform === "win32", "suite sampler never observed a browser");
			assert.deepEqual(leaked, [], `suite leaked browser processes: ${leaked.join(", ")}`);
		}
	});

	it("web_inspect (session manager) reports refs incl. iframe, console/page errors, failed fetch, screenshot, and leaks nothing", async () => {
		const records: LaunchRecord[] = [];
		const manager = new BrowserSessionManager({ launchBrowserProcess: trackingLauncher(records) });
		const report = await manager.runWebInspect({
			url: `${fixture.baseUrl}/app`,
			waitForText: "fetch-done:404",
			screenshot: true,
			timeoutMs: 30_000,
		});

		assert.equal(report.httpStatus, 200);
		assert.equal(report.title, "E2E App");
		assert.equal(report.timedOut, false);
		assert.deepEqual(report.warnings, []);
		assert.equal(manager.hasSessions(), false, "web_inspect must not leave a session behind");

		const refs = report.snapshot.refs;
		findRef(refs, "textbox", "Full name");
		findRef(refs, "combobox", "Color");
		findRef(refs, "listbox", "Toppings");
		findRef(refs, "button", "Count: 0");
		const frameButton = findRef(refs, "button", "Frame Action");
		assert.ok(frameButton.frameId, "iframe button ref must carry its frameId");
		assert.match(report.snapshot.treeText, /Frame Action" @e\d+/);

		assert.ok(
			report.consoleEntries.some((entry) => entry.level === "error" && entry.text.includes("synthetic-console-err")),
			`console errors: ${JSON.stringify(report.consoleEntries)}`,
		);
		assert.ok(
			report.pageErrors.some((entry) => entry.message.includes("synthetic-page-err")),
			`page errors: ${JSON.stringify(report.pageErrors)}`,
		);
		const missing = report.failedRequests.find((entry) => entry.url.endsWith("/api/missing-404"));
		assert.ok(missing, `failed requests: ${JSON.stringify(report.failedRequests)}`);
		assert.equal(missing.status, 404);
		assert.equal(missing.failed, false);

		assert.ok(report.screenshot);
		assert.equal(report.screenshot.mimeType, "image/png");
		const png = assertPng(report.screenshot.base64, "web_inspect screenshot");
		assert.equal(png.readUInt32BE(16), report.screenshot.width);
		assert.ok(report.screenshot.width > 0 && report.screenshot.height > 0);

		await assertNoLiveBrowserProcesses(records);
	});

	it("web_inspect (extension tool) returns text + base64 PNG ImageContent and leaks no browser processes", async () => {
		const harness = loadExtension(fixture.baseUrl);
		const sampler = new OwnedBrowserSampler();
		let result: ToolResultLike;
		try {
			result = await harness.run("web_inspect", {
				url: `${fixture.baseUrl}/app`,
				wait_for_text: "fetch-done:404",
				screenshot: true,
				viewport_width: 1024,
				viewport_height: 700,
			});
		} finally {
			await sampler.stop();
		}
		const text = expectOk(result, "web_inspect");
		assert.match(text, /^web_inspect http:\/\/127\.0\.0\.1:\d+\/app — HTTP 200/);
		assert.match(text, /synthetic-console-err/);
		assert.match(text, /synthetic-page-err/);
		assert.match(text, /\/api\/missing-404 → 404/);
		assert.match(text, /- button "Frame Action" @e\d+/);
		assert.match(text, /Screenshot \d+×\d+ image\/png/);

		const image = result.content.find((block) => block.type === "image");
		assert.ok(image?.data, "web_inspect must attach an image content block");
		assert.equal(image.mimeType, "image/png");
		const png = assertPng(image.data, "web_inspect tool image");
		assert.equal(png.readUInt32BE(16), 1024, "viewport width must be honored");

		assert.ok(sampler.profiles.size > 0 || process.platform === "win32", "sampler should have observed the inspect browser");
		const leaked = await sampler.leaked();
		assert.deepEqual(leaked, [], `web_inspect leaked browser processes: ${leaked.join(", ")}`);
		await harness.shutdown();
	});

	it("BrowserSessionManager drives forms, diffs, dialogs, iframes, history, tall pages, screenshots and tabs", async () => {
		const records: LaunchRecord[] = [];
		const manager = new BrowserSessionManager({ launchBrowserProcess: trackingLauncher(records) });
		try {
			// Lazy open auto-launches b1.
			const nav = await manager.open(`${fixture.baseUrl}/app`);
			assert.equal(nav.sessionId, "b1");
			assert.equal(nav.tabId, "t1");
			assert.equal(nav.httpStatus, 200);
			assert.equal(nav.timedOut, false);
			assert.equal(nav.title, "E2E App");
			assert.equal(records.length, 1);
			assert.equal(manager.listSessions()[0]?.pid, records[0]?.pid);

			const first = await manager.snapshot();
			const refs = first.snapshot.refs;
			const input = findRef(refs, "textbox", "Full name");
			const color = findRef(refs, "combobox", "Color");
			const toppings = findRef(refs, "listbox", "Toppings");
			const counter = findRef(refs, "button", "Count: 0");
			const dialogs = findRef(refs, "button", "Show dialogs");
			const link = findRef(refs, "link", "Go to page 2");

			// Controlled input: the native prototype setter must bypass the instance-level tracker.
			const filled = await manager.fill(input.ref, "Ada Lovelace");
			assert.equal(filled.value, "Ada Lovelace");
			assert.equal((await manager.evaluate("document.getElementById('echo').textContent")).valueText, "Hello, Ada Lovelace");
			assert.equal((await manager.evaluate("window.__instanceSetterCalls")).valueText, "0");

			assert.deepEqual((await manager.select(color.ref, ["Green"])).selected, ["green"]);
			assert.deepEqual((await manager.select(toppings.ref, ["cheese", "Peppers"])).selected, ["cheese", "peppers"]);
			await assert.rejects(manager.select(color.ref, ["red", "blue"]), /Single-choice <select> accepts exactly one value/);
			assert.equal(
				(await manager.evaluate("document.getElementById('select-echo').textContent")).valueText,
				"color=green toppings=cheese,peppers",
			);

			const clicked = await manager.click(counter.ref);
			assert.ok(clicked.x > 0 && clicked.y > 0);
			await manager.wait({ text: "status: clicked 1", timeoutMs: 5_000 });

			const diffed = await manager.snapshot({ diff: true });
			const diff = diffed.diff;
			assert.ok(diff, "snapshot({ diff: true }) must return a diff");
			assert.equal(diff.urlChanged, false);
			const changedNames = diff.changedRefs.map((change) => `${change.after.role}:${change.after.name}`);
			const counterAfter = findRef(diffed.snapshot.refs, "button", "Count: 1");
			assert.equal(counterAfter.ref, counter.ref, "refs must stay stable across snapshots of one document");
			assert.equal(findRef(diffed.snapshot.refs, "link", "Go to page 2").ref, link.ref);
			assert.ok(changedNames.includes("button:Count: 1"), `changed: ${changedNames.join(", ")}`);
			assert.ok(
				diff.changedRefs.some((change) => change.after.role === "textbox" && change.after.value === "Ada Lovelace"),
				diff.summaryText,
			);
			assert.ok(
				diff.changedRefs.some((change) => change.after.role === "combobox" && change.after.value === "Green"),
				diff.summaryText,
			);
			assert.ok(
				diff.changedRefs.some((change) => change.after.role === "option" && change.after.name === "Peppers" && change.after.selected === true),
				diff.summaryText,
			);
			assert.ok(diff.addedRefs.some((entry) => entry.role === "button" && entry.name === "Reset counter"), diff.summaryText);
			assert.match(diff.summaryText, /Count: 1/);

			// JavaScript dialogs are auto-handled (default dismiss → confirm false; accept → true).
			const dialogRef = findRef(diffed.snapshot.refs, "button", "Show dialogs").ref;
			assert.equal(dialogRef, dialogs.ref);
			await manager.click(dialogRef, { timeoutMs: 10_000 });
			await manager.wait({ text: "confirm:false", timeoutMs: 5_000 });
			manager.setDialogPolicy("accept");
			await manager.click(dialogRef, { timeoutMs: 10_000 });
			await manager.wait({ text: "confirm:true", timeoutMs: 5_000 });
			const consoleReport = await manager.getConsole();
			const dialogLog = consoleReport.dialogs.map((entry) => `${entry.type}:${entry.message}:${entry.handled}`);
			assert.deepEqual(dialogLog, [
				"alert:hello:dismissed",
				"confirm:proceed?:dismissed",
				"alert:hello:accepted",
				"confirm:proceed?:accepted",
			]);
			assert.ok(consoleReport.console.some((entry) => entry.text.includes("synthetic-console-err")));
			assert.ok(consoleReport.errors.some((entry) => entry.message.includes("synthetic-page-err")));
			const failed = await manager.getNetwork({ failedOnly: true });
			assert.ok(failed.entries.some((entry) => entry.url.endsWith("/api/missing-404") && entry.status === 404));

			// Same-origin iframe: click and fill through @eN refs resolved inside the child frame.
			const frameButton = findRef(diffed.snapshot.refs, "button", "Frame Action");
			const frameNote = findRef(diffed.snapshot.refs, "textbox", "Frame note");
			assert.ok(frameButton.frameId && frameNote.frameId);
			const frameClick = await manager.click(frameButton.ref);
			await manager.wait({ text: "frame-clicks:1", timeoutMs: 5_000 });
			const frameRect = JSON.parse(
				(await manager.evaluate("JSON.stringify(document.querySelector('iframe').getBoundingClientRect())")).valueText,
			) as { left: number; top: number; right: number; bottom: number };
			assert.ok(
				frameClick.x > frameRect.left && frameClick.x < frameRect.right && frameClick.y > frameRect.top && frameClick.y < frameRect.bottom,
				`iframe click at (${frameClick.x}, ${frameClick.y}) must land inside the iframe ${JSON.stringify(frameRect)}`,
			);
			assert.equal(
				(await manager.evaluate("document.querySelector('iframe').contentDocument.getElementById('inner-count').textContent")).valueText,
				"inner:1",
			);
			await manager.fill(frameNote.ref, "inside the frame");
			assert.equal(
				(await manager.evaluate("document.querySelector('iframe').contentDocument.getElementById('frame-note').value")).valueText,
				"inside the frame",
			);
			const frameShot = await manager.screenshot({ target: frameButton.ref });
			assertPng(frameShot.base64, "iframe element screenshot");
			assert.ok(frameShot.width > 0 && frameShot.width < 300, `iframe button screenshot width ${frameShot.width}`);

			// Navigating away makes every @eN from /app stale.
			await manager.click(link.ref);
			await manager.wait({ urlIncludes: "/page2", timeoutMs: 10_000 });
			await manager.wait({ text: "Page two button", timeoutMs: 10_000 });
			await assert.rejects(manager.click(counter.ref), /Ref @e\d+ is stale/);
			await assert.rejects(manager.fill(input.ref, "nope"), /is stale/);
			const page2 = await manager.snapshot();
			assert.equal(page2.snapshot.title, "Page Two");
			findRef(page2.snapshot.refs, "button", "Page two button");

			const back = await manager.goBack();
			assert.match(back.finalUrl, /\/app$/);
			assert.equal(back.timedOut, false);
			assert.equal(back.title, "E2E App");
			// Chrome may restore /app from the back/forward cache, so the counter can keep its clicked state.
			findRef(back.snapshot.refs, "button", /^Count: \d+$/);
			const forward = await manager.goForward();
			assert.match(forward.finalUrl, /\/page2$/);
			assert.equal(forward.timedOut, false);
			const reloaded = await manager.reload();
			assert.match(reloaded.finalUrl, /\/page2$/);
			assert.equal(reloaded.httpStatus, 200);
			assert.equal(reloaded.timedOut, false);
			await assert.rejects(manager.goForward(), /No next history entry/);

			// Tall page: offscreen click scrolls into view; viewport vs full-page vs element screenshots.
			const tall = await manager.navigate(`${fixture.baseUrl}/tall`);
			assert.equal(tall.httpStatus, 200);
			const deep = findRef(tall.snapshot.refs, "button", "Deep Button");
			const initialTop = Number((await manager.evaluate("document.getElementById('deep').getBoundingClientRect().top")).valueText);
			const innerHeight = Number((await manager.evaluate("innerHeight")).valueText);
			assert.ok(initialTop > innerHeight, `Deep Button must start offscreen (top ${initialTop}, viewport ${innerHeight})`);
			const deepClick = await manager.click(deep.ref);
			assert.ok(deepClick.y > 0 && deepClick.y < innerHeight, `click y ${deepClick.y} must be inside the viewport`);
			await manager.wait({ selector: "body[data-deep='clicked']", timeoutMs: 5_000 });
			assert.ok(Number((await manager.evaluate("scrollY")).valueText) > 1000);

			const viewportShot = await manager.screenshot();
			assertPng(viewportShot.base64, "viewport screenshot");
			assert.equal(viewportShot.fullPage, false);
			assert.ok(viewportShot.height <= 1000, `viewport screenshot height ${viewportShot.height}`);
			const fullShot = await manager.screenshot({ fullPage: true });
			assertPng(fullShot.base64, "full-page screenshot");
			assert.equal(fullShot.fullPage, true);
			assert.ok(fullShot.height >= 2500, `full-page screenshot height ${fullShot.height}`);
			const elementShot = await manager.screenshot({ target: deep.ref });
			assertPng(elementShot.base64, "element screenshot");
			assert.ok(Math.abs(elementShot.width - 160) <= 2, `element width ${elementShot.width}`);
			assert.ok(Math.abs(elementShot.height - 48) <= 2, `element height ${elementShot.height}`);
			const savePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-cdp-e2e-shot-")), "deep.png");
			tmpDirs.push(path.dirname(savePath));
			const saved = await manager.screenshot({ target: "#deep", savePath });
			assert.equal(saved.savedPath, savePath);
			assert.ok(fs.readFileSync(savePath).subarray(0, 8).equals(PNG_SIGNATURE));

			// Multi-tab.
			const opened = await manager.newTab(`${fixture.baseUrl}/page2`);
			assert.equal(opened.tab.tabId, "t2");
			assert.equal(opened.navigation?.title, "Page Two");
			let tabs = manager.listTabs().tabs;
			assert.deepEqual(
				tabs.map((tab) => `${tab.tabId}:${tab.active}`),
				["t1:false", "t2:true"],
			);
			const switched = await manager.switchTab("t1");
			assert.equal(switched.active, true);
			assert.match((await manager.evaluate("location.pathname")).valueText, /^\/tall$/);
			assert.equal((await manager.evaluate("location.pathname", { tabId: "t2" })).valueText, "/page2");
			const closed = await manager.closeTab("t2");
			assert.deepEqual(closed, { closedTabId: "t2", activeTabId: "t1" });
			tabs = manager.listTabs().tabs;
			assert.deepEqual(
				tabs.map((tab) => tab.tabId),
				["t1"],
			);
		} finally {
			await manager.disposeAll();
		}
		assert.equal(manager.hasSessions(), false);
		await assertNoLiveBrowserProcesses(records);
	});

	it("extension browser tool runs a full interactive flow and cleans up on session_shutdown", async () => {
		const sampler = new OwnedBrowserSampler();
		const harness = loadExtension(fixture.baseUrl);
		try {
			const opened = await harness.run("browser", { action: "open", url: `${fixture.baseUrl}/app` });
			const openText = expectOk(opened, "open");
			assert.match(openText, /HTTP 200/);
			assert.deepEqual(
				{ sessionId: (opened.details as { sessionId?: string }).sessionId, tabId: (opened.details as { tabId?: string }).tabId },
				{ sessionId: "b1", tabId: "t1" },
			);

			const snapText = expectOk(await harness.run("browser", { action: "snapshot" }), "snapshot");
			const counterRef = refFromText(snapText, "button", "Count: 0");
			const inputRef = refFromText(snapText, "textbox", "Full name");
			const colorRef = refFromText(snapText, "combobox", "Color");
			const frameRef = refFromText(snapText, "button", "Frame Action");

			const clickText = expectOk(await harness.run("browser", { action: "click", target: counterRef }), "click");
			assert.match(clickText, /Clicked @e\d+ button "Count: 0"/);
			assert.match(clickText, /Count: 1/);
			assert.match(clickText, /Reset counter/);

			const fillText = expectOk(await harness.run("browser", { action: "fill", target: inputRef, value: "Grace Hopper" }), "fill");
			assert.match(fillText, /Filled @e\d+ textbox "Full name" with "Grace Hopper"/);
			const echo = expectOk(
				await harness.run("browser", { action: "evaluate", expression: "document.getElementById('echo').textContent" }),
				"evaluate",
			);
			assert.equal(echo, "Hello, Grace Hopper");

			const selectText = expectOk(await harness.run("browser", { action: "select", target: colorRef, value: "blue" }), "select");
			assert.match(selectText, /Selected \["blue"\]/);

			const frameText = expectOk(await harness.run("browser", { action: "click", target: frameRef }), "frame click");
			assert.match(frameText, /Clicked @e\d+ button "Frame Action"/);
			expectOk(await harness.run("browser", { action: "wait", text: "frame-clicks:1", timeout_ms: 5_000 }), "wait");

			expectOk(await harness.run("browser", { action: "dialog_policy", policy: "accept" }), "dialog_policy");
			const dialogRef = refFromText(snapText, "button", "Show dialogs");
			expectOk(await harness.run("browser", { action: "click", target: dialogRef, timeout_ms: 10_000 }), "dialog click");
			expectOk(await harness.run("browser", { action: "wait", text: "confirm:true", timeout_ms: 5_000 }), "wait confirm");

			const consoleText = expectOk(await harness.run("browser", { action: "console" }), "console");
			assert.match(consoleText, /synthetic-console-err/);
			assert.match(consoleText, /synthetic-page-err/);
			assert.match(consoleText, /confirm "proceed\?" → accepted/);
			const networkText = expectOk(await harness.run("browser", { action: "network", failed_only: true }), "network");
			assert.match(networkText, /GET http:\/\/127\.0\.0\.1:\d+\/api\/missing-404 → 404/);

			const shot = await harness.run("browser", { action: "screenshot", full_page: true });
			expectOk(shot, "screenshot");
			const image = shot.content.find((block) => block.type === "image");
			assert.ok(image?.data);
			assert.equal(image.mimeType, "image/png");
			assertPng(image.data, "browser screenshot");

			const newTabText = expectOk(await harness.run("browser", { action: "new_tab", url: `${fixture.baseUrl}/tall` }), "new_tab");
			assert.match(newTabText, /Tall Page/);
			const tabsText = expectOk(await harness.run("browser", { action: "tabs" }), "tabs");
			assert.match(tabsText, /Tabs in \[b1\] \(2\):/);
			assert.match(tabsText, /\* t2 Tall Page/);
			const switchText = expectOk(await harness.run("browser", { action: "switch_tab", tab_id: "t1" }), "switch_tab");
			assert.match(switchText, /Active tab is now t1: E2E App/);
			const closeText = expectOk(await harness.run("browser", { action: "close_tab", tab_id: "t2" }), "close_tab");
			assert.match(closeText, /Closed tab t2\. Active tab: t1\./);

			const navText = expectOk(await harness.run("browser", { action: "navigate", url: `${fixture.baseUrl}/page2` }), "navigate");
			assert.match(navText, /Page Two/);
			const backText = expectOk(await harness.run("browser", { action: "back" }), "back");
			assert.match(backText, /E2E App/);
			const forwardText = expectOk(await harness.run("browser", { action: "forward" }), "forward");
			assert.match(forwardText, /Page Two/);

			const sessionsText = expectOk(await harness.run("browser", { action: "sessions" }), "sessions");
			assert.match(sessionsText, /\* \[b1\]/);
		} finally {
			await harness.shutdown();
			await sampler.stop();
		}
		assert.ok(sampler.profiles.size > 0 || process.platform === "win32", "sampler should have observed the tool browser");
		const leaked = await sampler.leaked();
		assert.deepEqual(leaked, [], `browser tool leaked processes after session_shutdown: ${leaked.join(", ")}`);
	});

	it("attaches non-destructively to an external browser (wsUrl and port) and leaves it running", async () => {
		const external = await launchBrowserProcess({ headless: true, timeoutMs: 30_000 });
		const externalTree = new Set<number>();
		try {
			const manager = new BrowserSessionManager();
			const viaWs = await manager.attach({ wsUrl: external.wsUrl, name: "external-ws" });
			assert.equal(viaWs.mode, "attached");
			assert.equal(viaWs.pid, undefined);
			assert.ok(viaWs.tabs.length >= 1);
			const nav = await manager.navigate(`${fixture.baseUrl}/page2`);
			assert.equal(nav.httpStatus, 200);
			const pageButton = findRef(nav.snapshot.refs, "button", "Page two button");
			await manager.click(pageButton.ref);
			assert.equal((await manager.evaluate("document.querySelector('button').textContent")).valueText, "Page two pressed");
			assert.equal((await manager.evaluate("document.title")).valueText, "Page Two");
			const closedWs = await manager.disconnect();
			assert.deepEqual(closedWs.closedSessions, [viaWs.id]);

			for (const pid of collectDescendantPids(external.pid)) {
				externalTree.add(pid);
			}
			assert.equal(isPidAlive(external.pid), true, "external browser must survive disconnect()");
			assert.equal(external.client.isOpen, true);
			const version = await external.client.send<{ product?: string }>("Browser.getVersion", {}, { timeoutMs: 5_000 });
			assert.match(version.product ?? "", /Chrome|Chromium|Edg|Brave/i);
			const targets = await external.client.send<{ targetInfos: Array<{ type: string; url: string }> }>("Target.getTargets");
			assert.ok(
				targets.targetInfos.some((info) => info.type === "page" && info.url.endsWith("/page2")),
				"the attached page must remain open after disconnect",
			);

			const viaPort = await manager.attach({ port: external.port, name: "external-port" });
			assert.equal(viaPort.mode, "attached");
			assert.ok(viaPort.tabs.some((tab) => tab.url.endsWith("/page2")), JSON.stringify(viaPort.tabs));
			const page2Tab = viaPort.tabs.find((tab) => tab.url.endsWith("/page2"));
			assert.ok(page2Tab);
			const inspected = await manager.snapshot({ tabId: page2Tab.tabId });
			findRef(inspected.snapshot.refs, "button", "Page two pressed");
			assert.equal((await manager.evaluate("location.pathname", { tabId: page2Tab.tabId })).valueText, "/page2");
			await manager.disconnect({ all: true });
			assert.equal(manager.hasSessions(), false);

			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.equal(isPidAlive(external.pid), true, "external browser must survive a second attach/disconnect");
			await external.client.send("Browser.getVersion", {}, { timeoutMs: 5_000 });
		} finally {
			for (const pid of collectDescendantPids(external.pid)) {
				externalTree.add(pid);
			}
			await external.shutdown();
		}
		assert.deepEqual(await waitForPidsGone([external.pid, ...externalTree]), []);
		assert.equal(fs.existsSync(external.userDataDir), false);
	});
});
