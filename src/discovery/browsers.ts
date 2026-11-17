/**
 * Cross-platform Chromium-family browser discovery and live CDP endpoint probing.
 *
 * Chrome 144+ rule: discovery NEVER opens a WebSocket. In Chrome's approval mode
 * (chrome://inspect remote-debugging toggle) every WebSocket handshake pops a modal
 * "Allow remote debugging?" dialog, so probing is limited to a raw TCP connect plus
 * an HTTP GET of /json/version.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { BrowserChannel, BrowserDoctorReport, DiscoveredBrowser, LiveCdpEndpoint } from "../types.ts";
import { isExecutableFile, resolveToolPath, whichExecutable } from "../utils/process-tree.ts";

const DEFAULT_CDP_HOST = "127.0.0.1";
const DEFAULT_CDP_PORT = 9222;
const MAX_TCP_PROBE_MS = 600;
const MAX_VERSION_BODY_BYTES = 1024 * 1024;
const APPROVAL_NOTE = "Chrome approval mode: connecting will prompt 'Allow remote debugging?' in Chrome.";
const EXECUTABLE_ENV_VARS = ["PI_CDP_EXECUTABLE", "CHROME_BIN", "PUPPETEER_EXECUTABLE_PATH"] as const;

interface BrowserCandidate {
	name: string;
	channel: BrowserChannel;
	executablePath: string;
	source: string;
	headlessOnly?: boolean;
	revision?: number;
}

interface UserDataDirInfo {
	browserName: string;
	dir: string;
}

interface DevToolsActivePortInfo {
	port: number;
	wsPath?: string;
}

interface EndpointCandidate {
	host: string;
	port: number;
	source: string;
	fallbackWsPath?: string;
	userDataDir?: string;
}

interface HttpTextResponse {
	status: number;
	body: string;
}

interface JsonVersionInfo {
	wsUrl: string;
	browserVersion?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObjectFile(filePath: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function realpathOrSelf(filePath: string): string {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return path.resolve(filePath);
	}
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function formatHostForUrl(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Turns a user-supplied executable reference into a concrete executable file.
 * Accepts absolute/relative/`~`/`@` paths, bare binary names on PATH, and macOS `.app` bundles.
 */
function resolveExecutableReference(rawValue: string, baseDir?: string): string | null {
	const value = rawValue.trim();
	if (!value) {
		return null;
	}
	const resolved = resolveToolPath(value, baseDir);
	if (isExecutableFile(resolved)) {
		return resolved;
	}
	if (process.platform === "darwin" && resolved.endsWith(".app")) {
		const bundleBinary = path.join(resolved, "Contents", "MacOS", path.basename(resolved, ".app"));
		if (isExecutableFile(bundleBinary)) {
			return bundleBinary;
		}
	}
	const looksLikeBareName = !value.includes("/") && !value.includes("\\") && !value.startsWith("~");
	if (looksLikeBareName) {
		return whichExecutable(value.replace(/^@/, ""));
	}
	return null;
}

function envOverrideCandidates(cwd: string): BrowserCandidate[] {
	const candidates: BrowserCandidate[] = [];
	for (const envName of EXECUTABLE_ENV_VARS) {
		const raw = process.env[envName];
		if (!raw) {
			continue;
		}
		const executablePath = resolveExecutableReference(raw, cwd);
		if (executablePath) {
			candidates.push({
				name: `Custom browser (${envName})`,
				channel: "custom",
				executablePath,
				source: `env:${envName}`,
			});
		}
	}
	return candidates;
}

function configFileCandidates(cwd: string): BrowserCandidate[] {
	const configs = [
		{ file: path.join(cwd, ".pi", "cdp.json"), baseDir: cwd, label: "project" },
		{ file: path.join(os.homedir(), ".pi", "agent", "cdp.json"), baseDir: os.homedir(), label: "global" },
	];
	const candidates: BrowserCandidate[] = [];
	for (const config of configs) {
		const parsed = readJsonObjectFile(config.file);
		if (!parsed || typeof parsed.executablePath !== "string") {
			continue;
		}
		const executablePath = resolveExecutableReference(parsed.executablePath, config.baseDir);
		if (executablePath) {
			candidates.push({
				name: `Custom browser (${config.label} cdp.json)`,
				channel: "custom",
				executablePath,
				source: `config:${config.file}`,
			});
		}
	}
	return candidates;
}

function darwinSystemCandidates(): BrowserCandidate[] {
	const bundles: Array<{ app: string; name: string; channel: BrowserChannel }> = [
		{ app: "Google Chrome.app", name: "Google Chrome", channel: "chrome" },
		{ app: "Google Chrome for Testing.app", name: "Google Chrome for Testing", channel: "chrome-for-testing" },
		{ app: "Microsoft Edge.app", name: "Microsoft Edge", channel: "edge" },
		{ app: "Brave Browser.app", name: "Brave Browser", channel: "brave" },
		{ app: "Chromium.app", name: "Chromium", channel: "chromium" },
		{ app: "Google Chrome Canary.app", name: "Google Chrome Canary", channel: "chrome" },
		{ app: "Arc.app", name: "Arc", channel: "arc" },
	];
	const roots = ["/Applications", path.join(os.homedir(), "Applications")];
	const candidates: BrowserCandidate[] = [];
	for (const bundle of bundles) {
		for (const root of roots) {
			const executablePath = path.join(root, bundle.app, "Contents", "MacOS", path.basename(bundle.app, ".app"));
			candidates.push({
				name: bundle.name,
				channel: bundle.channel,
				executablePath,
				source: `system:${root}`,
			});
		}
	}
	return candidates;
}

function linuxSystemCandidates(): BrowserCandidate[] {
	const pathBinaries: Array<{ bin: string; name: string; channel: BrowserChannel }> = [
		{ bin: "google-chrome", name: "Google Chrome", channel: "chrome" },
		{ bin: "google-chrome-stable", name: "Google Chrome", channel: "chrome" },
		{ bin: "chromium", name: "Chromium", channel: "chromium" },
		{ bin: "chromium-browser", name: "Chromium", channel: "chromium" },
		{ bin: "microsoft-edge", name: "Microsoft Edge", channel: "edge" },
		{ bin: "microsoft-edge-stable", name: "Microsoft Edge", channel: "edge" },
		{ bin: "brave-browser", name: "Brave Browser", channel: "brave" },
	];
	const fixedPaths: Array<{ file: string; name: string; channel: BrowserChannel }> = [
		{ file: "/opt/google/chrome/chrome", name: "Google Chrome", channel: "chrome" },
		{ file: "/usr/local/share/chromium/chrome-linux/chrome", name: "Chromium", channel: "chromium" },
		{ file: "/opt/microsoft/msedge/msedge", name: "Microsoft Edge", channel: "edge" },
		{ file: "/opt/brave.com/brave/brave-browser", name: "Brave Browser", channel: "brave" },
		{ file: "/snap/bin/chromium", name: "Chromium", channel: "chromium" },
	];
	const candidates: BrowserCandidate[] = [];
	for (const entry of pathBinaries) {
		const found = whichExecutable(entry.bin);
		if (found) {
			candidates.push({ name: entry.name, channel: entry.channel, executablePath: found, source: "system:PATH" });
		}
	}
	for (const entry of fixedPaths) {
		candidates.push({ name: entry.name, channel: entry.channel, executablePath: entry.file, source: "system:fixed-path" });
	}
	return candidates;
}

function queryWindowsAppPath(exeName: string): string[] {
	const results: string[] = [];
	for (const hive of ["HKLM", "HKCU"]) {
		const key = `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`;
		try {
			const output = execFileSync("reg", ["query", key, "/ve"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 2000,
				windowsHide: true,
			});
			const match = /REG_(?:EXPAND_)?SZ\s+(.+)/.exec(output);
			const value = match?.[1]?.trim().replace(/^"|"$/g, "");
			if (value) {
				results.push(value);
			}
		} catch {
			// Key missing or reg.exe unavailable: fall back to well-known install prefixes.
		}
	}
	return results;
}

function win32SystemCandidates(): BrowserCandidate[] {
	const candidates: BrowserCandidate[] = [];
	const registryEntries: Array<{ exe: string; name: string; channel: BrowserChannel }> = [
		{ exe: "chrome.exe", name: "Google Chrome", channel: "chrome" },
		{ exe: "msedge.exe", name: "Microsoft Edge", channel: "edge" },
	];
	for (const entry of registryEntries) {
		for (const executablePath of queryWindowsAppPath(entry.exe)) {
			candidates.push({ name: entry.name, channel: entry.channel, executablePath, source: "system:registry" });
		}
	}

	const prefixes = [
		process.env.LOCALAPPDATA,
		process.env.PROGRAMFILES,
		process.env["PROGRAMFILES(X86)"],
		"C:\\Program Files",
		"C:\\Program Files (x86)",
	].filter((prefix): prefix is string => typeof prefix === "string" && prefix.length > 0);
	const suffixes: Array<{ suffix: string; name: string; channel: BrowserChannel }> = [
		{ suffix: "\\Google\\Chrome\\Application\\chrome.exe", name: "Google Chrome", channel: "chrome" },
		{ suffix: "\\Microsoft\\Edge\\Application\\msedge.exe", name: "Microsoft Edge", channel: "edge" },
		{ suffix: "\\BraveSoftware\\Brave-Browser\\Application\\brave.exe", name: "Brave Browser", channel: "brave" },
		{ suffix: "\\Chromium\\Application\\chrome.exe", name: "Chromium", channel: "chromium" },
	];
	for (const entry of suffixes) {
		for (const prefix of prefixes) {
			candidates.push({
				name: entry.name,
				channel: entry.channel,
				executablePath: `${prefix}${entry.suffix}`,
				source: "system:program-files",
			});
		}
	}
	return candidates;
}

function systemCandidates(): BrowserCandidate[] {
	switch (process.platform) {
		case "darwin":
			return darwinSystemCandidates();
		case "win32":
			return win32SystemCandidates();
		case "linux":
			return linuxSystemCandidates();
		default:
			return linuxSystemCandidates();
	}
}

function playwrightCacheRoot(): string {
	const override = process.env.PLAYWRIGHT_BROWSERS_PATH;
	if (override && override !== "0") {
		return resolveToolPath(override);
	}
	switch (process.platform) {
		case "darwin":
			return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
		case "win32":
			return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "ms-playwright");
		default:
			return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "ms-playwright");
	}
}

/** Relative executable paths inside a Playwright `chromium-<rev>` directory, newest layout first. */
function playwrightChromiumRelativePaths(): string[] {
	const cftMac = path.join("Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
	switch (process.platform) {
		case "darwin":
			return [
				path.join("chrome-mac-arm64", cftMac),
				path.join("chrome-mac-x64", cftMac),
				path.join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
			];
		case "win32":
			return [path.join("chrome-win64", "chrome.exe"), path.join("chrome-win", "chrome.exe")];
		default:
			return [
				path.join("chrome-linux64", "chrome"),
				path.join("chrome-linux-arm64", "chrome"),
				path.join("chrome-linux", "chrome"),
			];
	}
}

/** Relative executable paths inside a Playwright `chromium_headless_shell-<rev>` directory. */
function playwrightHeadlessShellRelativePaths(): string[] {
	switch (process.platform) {
		case "darwin":
			return [
				path.join("chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
				path.join("chrome-headless-shell-mac-x64", "chrome-headless-shell"),
				path.join("chrome-mac", "headless_shell"),
			];
		case "win32":
			return [
				path.join("chrome-headless-shell-win64", "chrome-headless-shell.exe"),
				path.join("chrome-win", "headless_shell.exe"),
			];
		default:
			return [
				path.join("chrome-headless-shell-linux64", "chrome-headless-shell"),
				path.join("chrome-headless-shell-linux-arm64", "chrome-headless-shell"),
				path.join("chrome-linux", "headless_shell"),
			];
	}
}

function scanPlaywrightRevisions(
	cacheRoot: string,
	entries: string[],
	pattern: RegExp,
	relativePaths: string[],
	describe: (revision: number) => Omit<BrowserCandidate, "executablePath" | "revision">,
): BrowserCandidate[] {
	const revisions: Array<{ dir: string; revision: number }> = [];
	for (const entry of entries) {
		const match = pattern.exec(entry);
		if (match?.[1]) {
			revisions.push({ dir: path.join(cacheRoot, entry), revision: Number.parseInt(match[1], 10) });
		}
	}
	revisions.sort((a, b) => b.revision - a.revision);

	const candidates: BrowserCandidate[] = [];
	for (const { dir, revision } of revisions) {
		if (!fs.existsSync(path.join(dir, "INSTALLATION_COMPLETE"))) {
			continue;
		}
		const executable = relativePaths.map((rel) => path.join(dir, rel)).find(isExecutableFile);
		if (executable) {
			candidates.push({ ...describe(revision), executablePath: executable, revision });
		}
	}
	return candidates;
}

function playwrightCandidates(): BrowserCandidate[] {
	const cacheRoot = playwrightCacheRoot();
	let entries: string[];
	try {
		entries = fs.readdirSync(cacheRoot);
	} catch {
		return [];
	}
	const source = `playwright:${cacheRoot}`;
	const headed = scanPlaywrightRevisions(cacheRoot, entries, /^chromium-(\d+)$/, playwrightChromiumRelativePaths(), (revision) => ({
		name: `Playwright Chromium r${revision}`,
		channel: "playwright-chromium",
		source,
		headlessOnly: false,
	}));
	const headlessShell = scanPlaywrightRevisions(
		cacheRoot,
		entries,
		/^chromium_headless_shell-(\d+)$/,
		playwrightHeadlessShellRelativePaths(),
		(revision) => ({
			name: `Playwright Chromium Headless Shell r${revision}`,
			channel: "playwright-headless-shell",
			source,
			headlessOnly: true,
		}),
	);
	return [...headed, ...headlessShell];
}

/**
 * Discovers installed Chromium-family browsers in priority order:
 * env overrides → cdp.json config → system installs → Playwright cache.
 * Results are de-duplicated by real path.
 */
export function discoverBrowsers(cwd?: string): DiscoveredBrowser[] {
	const baseDir = cwd ?? process.cwd();
	const ordered = [
		...envOverrideCandidates(baseDir),
		...configFileCandidates(baseDir),
		...systemCandidates(),
		...playwrightCandidates(),
	];

	const seenPaths = new Set<string>();
	const seenIds = new Map<string, number>();
	const browsers: DiscoveredBrowser[] = [];
	for (const candidate of ordered) {
		if (!isExecutableFile(candidate.executablePath)) {
			continue;
		}
		const realPath = realpathOrSelf(candidate.executablePath);
		if (seenPaths.has(realPath)) {
			continue;
		}
		seenPaths.add(realPath);

		const baseId = slugify(candidate.revision === undefined ? candidate.name : `${candidate.channel}-${candidate.revision}`);
		const occurrences = (seenIds.get(baseId) ?? 0) + 1;
		seenIds.set(baseId, occurrences);
		const browser: DiscoveredBrowser = {
			id: occurrences === 1 ? baseId : `${baseId}-${occurrences}`,
			name: candidate.name,
			channel: candidate.channel,
			executablePath: candidate.executablePath,
			source: candidate.source,
		};
		if (candidate.headlessOnly !== undefined) {
			browser.headlessOnly = candidate.headlessOnly;
		}
		if (candidate.revision !== undefined) {
			browser.revision = candidate.revision;
		}
		browsers.push(browser);
	}
	return browsers;
}

/**
 * Picks the browser to launch. An explicit executable wins (and must exist); otherwise the
 * first discovered browser, skipping headless-only builds when `requireHeaded` is set.
 */
export function selectPreferredBrowser(
	cwd?: string,
	explicitExecutable?: string,
	opts: { requireHeaded?: boolean } = {},
): DiscoveredBrowser {
	if (explicitExecutable?.trim()) {
		const executablePath = resolveExecutableReference(explicitExecutable, cwd ?? process.cwd());
		if (!executablePath) {
			throw new Error(`Browser executable not found or not executable: ${explicitExecutable}`);
		}
		return {
			id: "explicit",
			name: `Custom browser (${path.basename(executablePath)})`,
			channel: "custom",
			executablePath,
			source: "explicit",
		};
	}

	const browsers = discoverBrowsers(cwd);
	const eligible = opts.requireHeaded ? browsers.filter((browser) => browser.headlessOnly !== true) : browsers;
	const preferred = eligible[0];
	if (preferred) {
		return preferred;
	}
	const headedHint =
		opts.requireHeaded && browsers.length > 0
			? " Only headless-only builds were found; install a full browser (`npx playwright install chromium`) for headed mode."
			: "";
	throw new Error(
		`No Chromium-family browser found.${headedHint} Install Google Chrome, run \`npx playwright install chromium\`, or set PI_CDP_EXECUTABLE to a Chrome/Chromium executable.`,
	);
}

function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port });
		let settled = false;
		const finish = (reachable: boolean): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(reachable);
		};
		const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

function httpGetText(host: string, port: number, requestPath: string, timeoutMs: number): Promise<HttpTextResponse | null> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: HttpTextResponse | null): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const request = http.get(
			{
				host,
				port,
				path: requestPath,
				agent: false,
				headers: { Host: `${formatHostForUrl(host)}:${port}`, Accept: "application/json" },
			},
			(response) => {
				const chunks: Buffer[] = [];
				let size = 0;
				response.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > MAX_VERSION_BODY_BYTES) {
						request.destroy();
						finish(null);
						return;
					}
					chunks.push(chunk);
				});
				response.on("end", () => {
					finish({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
				});
				response.on("error", () => finish(null));
			},
		);
		const timer = setTimeout(() => {
			request.destroy();
			finish(null);
		}, Math.max(1, timeoutMs));
		request.on("error", () => finish(null));
	});
}

function browserNameFromUserDataDir(userDataDir?: string): string {
	if (!userDataDir) {
		return "Chromium";
	}
	const lower = userDataDir.toLowerCase();
	if (lower.includes("edge")) {
		return "Microsoft Edge";
	}
	if (lower.includes("brave")) {
		return "Brave Browser";
	}
	if (lower.includes("arc")) {
		return "Arc";
	}
	if (lower.includes("chromium")) {
		return "Chromium";
	}
	if (lower.includes("chrome")) {
		return "Google Chrome";
	}
	return "Chromium";
}

function isValidPort(port: number): boolean {
	return Number.isInteger(port) && port > 0 && port <= 65535;
}

/** Extracts the browser WebSocket URL and `Browser` product string from a /json/version body. */
function parseJsonVersion(body: string): JsonVersionInfo | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) {
		return null;
	}
	const wsUrl = parsed.webSocketDebuggerUrl;
	if (typeof wsUrl !== "string" || !wsUrl) {
		return null;
	}
	const browser = parsed.Browser;
	return typeof browser === "string" && browser ? { wsUrl, browserVersion: browser } : { wsUrl };
}

/**
 * Probes a CDP port without ever opening a WebSocket:
 * TCP connect → HTTP GET /json/version. Returns `normal` on a valid 200 response, `approval`
 * on 404 when a DevToolsActivePort WebSocket path is known, else `null`.
 */
export async function probePortEndpoint(
	host: string,
	port: number,
	source: string,
	timeoutMs = 800,
	fallbackWsPath?: string,
	userDataDir?: string,
): Promise<LiveCdpEndpoint | null> {
	if (!isValidPort(port)) {
		return null;
	}
	const reachable = await tcpReachable(host, port, Math.min(timeoutMs, MAX_TCP_PROBE_MS));
	if (!reachable) {
		return null;
	}

	const response = await httpGetText(host, port, "/json/version", timeoutMs);
	if (!response) {
		return null;
	}
	const base = {
		id: `${host}:${port}`,
		host,
		port,
		source,
		...(userDataDir ? { userDataDir } : {}),
	};

	if (response.status === 200) {
		const version = parseJsonVersion(response.body);
		if (!version) {
			return null;
		}
		return {
			...base,
			browserName: version.browserVersion ?? "Chromium",
			wsUrl: version.wsUrl,
			mode: "normal",
			...(version.browserVersion ? { browserVersion: version.browserVersion } : {}),
		};
	}

	if (response.status === 404 && fallbackWsPath) {
		const wsPath = fallbackWsPath.startsWith("/") ? fallbackWsPath : `/${fallbackWsPath}`;
		return {
			...base,
			browserName: browserNameFromUserDataDir(userDataDir),
			wsUrl: `ws://${formatHostForUrl(host)}:${port}${wsPath}`,
			mode: "approval",
			note: APPROVAL_NOTE,
		};
	}
	return null;
}

function defaultUserDataDirs(): UserDataDirInfo[] {
	const home = os.homedir();
	switch (process.platform) {
		case "darwin": {
			const support = path.join(home, "Library", "Application Support");
			return [
				{ browserName: "Google Chrome", dir: path.join(support, "Google", "Chrome") },
				{ browserName: "Google Chrome Canary", dir: path.join(support, "Google", "Chrome Canary") },
				{ browserName: "Google Chrome for Testing", dir: path.join(support, "Google", "Chrome for Testing") },
				{ browserName: "Microsoft Edge", dir: path.join(support, "Microsoft Edge") },
				{ browserName: "Brave Browser", dir: path.join(support, "BraveSoftware", "Brave-Browser") },
				{ browserName: "Chromium", dir: path.join(support, "Chromium") },
				{ browserName: "Arc", dir: path.join(support, "Arc", "User Data") },
			];
		}
		case "win32": {
			const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
			return [
				{ browserName: "Google Chrome", dir: path.join(local, "Google", "Chrome", "User Data") },
				{ browserName: "Google Chrome Canary", dir: path.join(local, "Google", "Chrome SxS", "User Data") },
				{ browserName: "Microsoft Edge", dir: path.join(local, "Microsoft", "Edge", "User Data") },
				{ browserName: "Brave Browser", dir: path.join(local, "BraveSoftware", "Brave-Browser", "User Data") },
				{ browserName: "Chromium", dir: path.join(local, "Chromium", "User Data") },
			];
		}
		default: {
			const config = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
			return [
				{ browserName: "Google Chrome", dir: path.join(config, "google-chrome") },
				{ browserName: "Google Chrome Beta", dir: path.join(config, "google-chrome-beta") },
				{ browserName: "Google Chrome Dev", dir: path.join(config, "google-chrome-unstable") },
				{ browserName: "Chromium", dir: path.join(config, "chromium") },
				{ browserName: "Microsoft Edge", dir: path.join(config, "microsoft-edge") },
				{ browserName: "Brave Browser", dir: path.join(config, "BraveSoftware", "Brave-Browser") },
			];
		}
	}
}

/**
 * Parses `<userDataDir>/DevToolsActivePort` (line 1: port, line 2: browser WebSocket path).
 * Returns null when the file is missing or malformed.
 */
export function readDevToolsActivePort(userDataDir: string): DevToolsActivePortInfo | null {
	let content: string;
	try {
		content = fs.readFileSync(path.join(userDataDir, "DevToolsActivePort"), "utf8");
	} catch {
		return null;
	}
	const [portLine, wsPathLine] = content.split(/\r?\n/).map((line) => line.trim());
	const port = Number.parseInt(portLine ?? "", 10);
	if (!isValidPort(port)) {
		return null;
	}
	return wsPathLine ? { port, wsPath: wsPathLine } : { port };
}

function devToolsActivePortCandidates(): EndpointCandidate[] {
	const candidates: EndpointCandidate[] = [];
	for (const { browserName, dir } of defaultUserDataDirs()) {
		const info = readDevToolsActivePort(dir);
		if (!info) {
			continue;
		}
		candidates.push({
			host: DEFAULT_CDP_HOST,
			port: info.port,
			source: `DevToolsActivePort:${browserName}`,
			userDataDir: dir,
			...(info.wsPath ? { fallbackWsPath: info.wsPath } : {}),
		});
	}
	return candidates;
}

function parsePort(raw: string | undefined): number | null {
	if (!raw) {
		return null;
	}
	const port = Number.parseInt(raw, 10);
	return isValidPort(port) ? port : null;
}

function mergeEndpointCandidates(candidates: EndpointCandidate[]): EndpointCandidate[] {
	const byKey = new Map<string, EndpointCandidate>();
	for (const candidate of candidates) {
		const key = `${candidate.host}:${candidate.port}`;
		const existing = byKey.get(key);
		if (!existing) {
			byKey.set(key, { ...candidate });
			continue;
		}
		if (!existing.fallbackWsPath && candidate.fallbackWsPath) {
			existing.fallbackWsPath = candidate.fallbackWsPath;
		}
		if (!existing.userDataDir && candidate.userDataDir) {
			existing.userDataDir = candidate.userDataDir;
		}
	}
	return [...byKey.values()];
}

/**
 * Finds running browsers exposing CDP: PI_CDP_PORT, 9222, `extraPorts`, and every
 * DevToolsActivePort file in the default Chrome/Edge/Brave/Chromium user-data dirs.
 * Unreachable or stale entries are skipped; results are de-duplicated by host:port.
 */
export async function discoverLiveEndpoints(extraPorts: number[] = []): Promise<LiveCdpEndpoint[]> {
	const raw: EndpointCandidate[] = [];
	const envPort = parsePort(process.env.PI_CDP_PORT);
	if (envPort !== null) {
		raw.push({ host: DEFAULT_CDP_HOST, port: envPort, source: "env:PI_CDP_PORT" });
	}
	raw.push({ host: DEFAULT_CDP_HOST, port: DEFAULT_CDP_PORT, source: `default:${DEFAULT_CDP_PORT}` });
	for (const port of extraPorts) {
		if (isValidPort(port)) {
			raw.push({ host: DEFAULT_CDP_HOST, port, source: "extra-port" });
		}
	}
	raw.push(...devToolsActivePortCandidates());

	const probed = await Promise.all(
		mergeEndpointCandidates(raw).map((candidate) =>
			probePortEndpoint(
				candidate.host,
				candidate.port,
				candidate.source,
				800,
				candidate.fallbackWsPath,
				candidate.userDataDir,
			),
		),
	);
	return probed.filter((endpoint): endpoint is LiveCdpEndpoint => endpoint !== null);
}

function findDevToolsActivePortForPort(port: number): EndpointCandidate | undefined {
	return devToolsActivePortCandidates().find((candidate) => candidate.port === port);
}

function approvalRefusal(endpoint: LiveCdpEndpoint): Error {
	return new Error(
		`${endpoint.browserName} at ${endpoint.host}:${endpoint.port} is in approval mode; connecting will prompt "Allow remote debugging?" in the browser. Pass includeApprovalMode: true to attach anyway, or relaunch it with --remote-debugging-port and a dedicated --user-data-dir.`,
	);
}

async function endpointFromWsUrl(wsUrl: string): Promise<LiveCdpEndpoint> {
	let parsed: URL;
	try {
		parsed = new URL(wsUrl);
	} catch {
		throw new Error(`Invalid CDP WebSocket URL: ${wsUrl}`);
	}
	if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
		throw new Error(`CDP WebSocket URL must use ws:// or wss://: ${wsUrl}`);
	}
	const host = parsed.hostname.replace(/^\[|\]$/g, "");
	const defaultPort = parsed.protocol === "wss:" ? 443 : 80;
	const port = parsed.port ? Number.parseInt(parsed.port, 10) : defaultPort;
	const probed = await probePortEndpoint(host, port, "explicit:wsUrl", 800, parsed.pathname);
	if (probed) {
		return { ...probed, wsUrl };
	}
	return {
		id: `${host}:${port}`,
		browserName: "Chromium",
		host,
		port,
		wsUrl,
		mode: "normal",
		source: "explicit:wsUrl",
		note: "Explicit WebSocket URL; HTTP /json/version discovery was unavailable.",
	};
}

/**
 * Chooses a live endpoint to attach to. Explicit `wsUrl` > explicit `host`/`port` > auto-discovery.
 * Approval-mode endpoints are only returned when `includeApprovalMode` is true.
 */
export async function selectLiveEndpointForAttach(
	opts: { host?: string; port?: number; wsUrl?: string; includeApprovalMode?: boolean } = {},
): Promise<LiveCdpEndpoint> {
	const includeApprovalMode = opts.includeApprovalMode === true;

	if (opts.wsUrl) {
		const endpoint = await endpointFromWsUrl(opts.wsUrl);
		if (endpoint.mode === "approval" && !includeApprovalMode) {
			throw approvalRefusal(endpoint);
		}
		return endpoint;
	}

	if (opts.port !== undefined || opts.host !== undefined) {
		const host = opts.host ?? DEFAULT_CDP_HOST;
		const port = opts.port ?? DEFAULT_CDP_PORT;
		const activePort = findDevToolsActivePortForPort(port);
		const endpoint = await probePortEndpoint(
			host,
			port,
			`explicit:${host}:${port}`,
			1500,
			activePort?.fallbackWsPath,
			activePort?.userDataDir,
		);
		if (!endpoint) {
			throw new Error(
				`No Chrome DevTools endpoint reachable at ${host}:${port}. Start the browser with --remote-debugging-port=${port} (and a dedicated --user-data-dir), or enable chrome://inspect/#remote-debugging.`,
			);
		}
		if (endpoint.mode === "approval" && !includeApprovalMode) {
			throw approvalRefusal(endpoint);
		}
		return endpoint;
	}

	const endpoints = await discoverLiveEndpoints();
	const normal = endpoints.find((endpoint) => endpoint.mode === "normal");
	if (normal) {
		return normal;
	}
	const approval = endpoints.find((endpoint) => endpoint.mode === "approval");
	if (approval) {
		if (includeApprovalMode) {
			return approval;
		}
		throw approvalRefusal(approval);
	}
	throw new Error(
		`No running browser with remote debugging found (checked PI_CDP_PORT, ${DEFAULT_CDP_PORT}, and DevToolsActivePort files). Launch Chrome with --remote-debugging-port=${DEFAULT_CDP_PORT} --user-data-dir=<dir>, or enable chrome://inspect/#remote-debugging (Chrome 144+).`,
	);
}

function readChromeRemoteDebuggingToggle(): BrowserDoctorReport["chromeRemoteDebuggingToggle"] {
	const chromeDir = defaultUserDataDirs().find((entry) => entry.browserName === "Google Chrome")?.dir;
	if (!chromeDir) {
		return undefined;
	}
	const localState = readJsonObjectFile(path.join(chromeDir, "Local State"));
	if (!localState) {
		return undefined;
	}
	const devtools = isRecord(localState.devtools) ? localState.devtools : {};
	const remoteDebugging = isRecord(devtools.remote_debugging) ? devtools.remote_debugging : {};
	const allowed = remoteDebugging.allowed;
	const userEnabled = remoteDebugging["user-enabled"];
	return {
		profileDir: chromeDir,
		allowed: typeof allowed === "boolean" ? allowed : true,
		userEnabled: typeof userEnabled === "boolean" ? userEnabled : false,
	};
}

function doctorGuidance(
	browsers: DiscoveredBrowser[],
	preferred: DiscoveredBrowser | null,
	liveEndpoints: LiveCdpEndpoint[],
	toggle: BrowserDoctorReport["chromeRemoteDebuggingToggle"],
): string[] {
	const guidance: string[] = [];
	if (browsers.length === 0) {
		guidance.push(
			"No Chromium-family browser found. Install Google Chrome, run `npx playwright install chromium`, or set PI_CDP_EXECUTABLE (or executablePath in .pi/cdp.json).",
		);
	} else if (preferred?.headlessOnly) {
		guidance.push(
			`Only headless-only builds were found (${preferred.name}); install Google Chrome or \`npx playwright install chromium\` for headed sessions.`,
		);
	} else if (preferred) {
		guidance.push(`Launch will use ${preferred.name} (${preferred.executablePath}).`);
	}

	const normal = liveEndpoints.filter((endpoint) => endpoint.mode === "normal");
	const approval = liveEndpoints.filter((endpoint) => endpoint.mode === "approval");
	for (const endpoint of normal) {
		guidance.push(`Live CDP endpoint ready to attach: ${endpoint.browserName} at ${endpoint.host}:${endpoint.port}.`);
	}
	for (const endpoint of approval) {
		guidance.push(
			`${endpoint.browserName} at ${endpoint.host}:${endpoint.port} is in approval mode: attaching will show an "Allow remote debugging?" dialog that must be accepted in the browser.`,
		);
	}
	if (liveEndpoints.length === 0) {
		guidance.push(
			`No live browser endpoint found. To attach to a running browser, start it with --remote-debugging-port=${DEFAULT_CDP_PORT} --user-data-dir=<dedicated dir> (Chrome 136+ ignores the flag on the default profile), or enable chrome://inspect/#remote-debugging in Chrome 144+.`,
		);
	}

	if (toggle) {
		if (!toggle.allowed) {
			guidance.push(
				`Chrome remote debugging is disallowed (devtools.remote_debugging.allowed=false in ${toggle.profileDir}); it is likely blocked by enterprise policy.`,
			);
		} else if (toggle.userEnabled && approval.length === 0 && normal.length === 0) {
			guidance.push(
				"Chrome's remote-debugging toggle is enabled but no endpoint is listening; restart Chrome so it writes a fresh DevToolsActivePort file.",
			);
		} else if (!toggle.userEnabled && approval.length === 0) {
			guidance.push(
				"Chrome's remote-debugging toggle (chrome://inspect/#remote-debugging) is off; enable it to attach to your everyday Chrome profile with per-connection approval.",
			);
		}
	}
	return guidance;
}

/** Collects installed browsers, live endpoints, Chrome's remote-debugging toggle, and actionable guidance. */
export async function runBrowserDoctor(cwd?: string): Promise<BrowserDoctorReport> {
	const browsers = discoverBrowsers(cwd);
	const preferred = browsers.find((browser) => browser.headlessOnly !== true) ?? browsers[0] ?? null;
	const liveEndpoints = await discoverLiveEndpoints();
	const toggle = readChromeRemoteDebuggingToggle();
	const report: BrowserDoctorReport = {
		platform: process.platform,
		arch: process.arch,
		preferredBrowser: preferred,
		browsers,
		liveEndpoints,
		guidance: doctorGuidance(browsers, preferred, liveEndpoints, toggle),
	};
	if (toggle) {
		report.chromeRemoteDebuggingToggle = toggle;
	}
	return report;
}
