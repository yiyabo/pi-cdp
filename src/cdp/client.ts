/**
 * Zero-dependency Chrome DevTools Protocol client.
 *
 * - `CdpMultiplexClient` speaks CDP over Node 22's built-in global `WebSocket` and multiplexes
 *   browser-level and target-level commands on one connection via flattened `sessionId` routing.
 * - `fetchJsonVersion` probes `/json/version` on a DevTools HTTP endpoint.
 * - `launchBrowserProcess` spawns a local Chromium-family browser with an isolated profile and
 *   returns a connected handle with a leak-free `shutdown()`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { selectPreferredBrowser } from "../discovery/browsers.ts";
import type {
	CdpClientInterface,
	CdpEventMessage,
	CdpSendOptions,
	LaunchBrowserProcessOptions,
	LaunchedBrowserHandle,
} from "../types.ts";
import { terminateProcessTree } from "../utils/process-tree.ts";

const DEFAULT_SEND_TIMEOUT_MS = 30_000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
const CLOSE_WAIT_MS = 1_000;
const STDERR_TAIL_LIMIT = 64 * 1024;
const EARLY_EXIT_WINDOW_MS = 3_000;
const DEVTOOLS_LISTENING_RE = /^DevTools listening on (ws:\/\/\S+)$/m;
const SANDBOX_FAILURE_RE = /sandbox|namespace|SUID/i;

/** Error returned by the browser for a failed CDP command (`{ id, error: { code, message } }`). */
export class CdpProtocolError extends Error {
	readonly code: number | undefined;
	readonly method: string;

	constructor(method: string, message: string, code?: number, data?: string) {
		super(`CDP ${method} failed: ${message}${data ? ` (${data})` : ""}`);
		this.name = "CdpProtocolError";
		this.method = method;
		this.code = code;
	}
}

interface PendingCall {
	method: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

interface IncomingFrame {
	id?: unknown;
	result?: unknown;
	error?: { code?: unknown; message?: unknown; data?: unknown };
	method?: unknown;
	params?: unknown;
	sessionId?: unknown;
}

function abortReason(signal: AbortSignal, fallback: string): Error {
	return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeFrameData(data: unknown): string | null {
	if (typeof data === "string") {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return new TextDecoder().decode(data);
	}
	if (ArrayBuffer.isView(data)) {
		return new TextDecoder().decode(data);
	}
	return null;
}

/** Decodes and JSON-parses one WebSocket message; malformed or non-object frames yield null. */
function parseIncomingFrame(data: unknown): IncomingFrame | null {
	const text = decodeFrameData(data);
	if (text === null) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function protocolErrorFrom(method: string, error: NonNullable<IncomingFrame["error"]>): CdpProtocolError {
	const code = typeof error.code === "number" ? error.code : undefined;
	const message = typeof error.message === "string" ? error.message : "Unknown CDP error";
	const data = typeof error.data === "string" ? error.data : undefined;
	return new CdpProtocolError(method, message, code, data);
}

function validateWsUrl(wsUrl: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(wsUrl);
	} catch {
		throw new Error(`Invalid CDP WebSocket URL: ${wsUrl}`);
	}
	if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
		throw new Error(`CDP WebSocket URL must use ws: or wss: (got ${parsed.protocol} in ${wsUrl})`);
	}
	return parsed;
}

export class CdpMultiplexClient implements CdpClientInterface {
	readonly wsUrl: string;
	readonly #ws: WebSocket;
	readonly #pending = new Map<number, PendingCall>();
	readonly #listeners = new Set<(event: CdpEventMessage) => void>();
	#nextId = 0;
	#closed = false;
	#closedPromise: Promise<void>;
	#markClosed: () => void = () => {};

	private constructor(ws: WebSocket, wsUrl: string) {
		this.#ws = ws;
		this.wsUrl = wsUrl;
		this.#closedPromise = new Promise<void>((resolve) => {
			this.#markClosed = resolve;
		});
		ws.addEventListener("message", (event) => {
			this.#handleFrame(event.data);
		});
		ws.addEventListener("close", () => {
			this.#handleClosed("CDP WebSocket connection closed");
		});
		ws.addEventListener("error", () => {
			this.#handleClosed("CDP WebSocket connection error");
		});
	}

	get isOpen(): boolean {
		return !this.#closed && this.#ws.readyState === WebSocket.OPEN;
	}

	/**
	 * Opens a CDP WebSocket. No custom headers are sent: Chromium rejects foreign `Origin`
	 * headers with HTTP 403, and Node's built-in WebSocket sends none by default.
	 */
	static async connect(wsUrl: string, timeoutMs = 15_000, signal?: AbortSignal): Promise<CdpMultiplexClient> {
		const url = validateWsUrl(wsUrl);
		if (signal?.aborted) {
			throw abortReason(signal, `Connecting to ${wsUrl} aborted`);
		}
		const ws = new WebSocket(url.href);
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const cleanup = (): void => {
				settled = true;
				clearTimeout(timer);
				ws.removeEventListener("open", onOpen);
				ws.removeEventListener("error", onError);
				ws.removeEventListener("close", onClose);
				signal?.removeEventListener("abort", onAbort);
			};
			const fail = (error: Error): void => {
				if (settled) {
					return;
				}
				cleanup();
				try {
					ws.close();
				} catch {
					// Socket may already be closed; nothing else to release.
				}
				reject(error);
			};
			const onOpen = (): void => {
				if (settled) {
					return;
				}
				cleanup();
				resolve();
			};
			const onError = (): void => {
				fail(new Error(`Failed to connect to CDP WebSocket ${wsUrl}`));
			};
			const onClose = (event: CloseEvent): void => {
				fail(new Error(`CDP WebSocket ${wsUrl} closed during handshake (code ${event.code})`));
			};
			const onAbort = (): void => {
				fail(signal ? abortReason(signal, `Connecting to ${wsUrl} aborted`) : new Error("aborted"));
			};
			const timer = setTimeout(() => {
				fail(new Error(`Timed out after ${timeoutMs}ms connecting to CDP WebSocket ${wsUrl}`));
			}, timeoutMs);
			ws.addEventListener("open", onOpen);
			ws.addEventListener("error", onError);
			ws.addEventListener("close", onClose);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		return new CdpMultiplexClient(ws, wsUrl);
	}

	async send<T = Record<string, unknown>>(
		method: string,
		params?: Record<string, unknown>,
		options?: CdpSendOptions,
	): Promise<T> {
		const signal = options?.signal;
		if (signal?.aborted) {
			throw abortReason(signal, `CDP ${method} aborted`);
		}
		if (!this.isOpen) {
			throw new Error(`CDP connection to ${this.wsUrl} is closed (cannot send ${method})`);
		}
		const timeoutMs = options?.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
		this.#nextId += 1;
		const id = this.#nextId;
		const message = {
			id,
			method,
			params: params ?? {},
			...(options?.sessionId ? { sessionId: options.sessionId } : {}),
		};

		return new Promise<T>((resolve, reject) => {
			const cleanup = (): void => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.#pending.delete(id);
			};
			const onAbort = (): void => {
				cleanup();
				reject(signal ? abortReason(signal, `CDP ${method} aborted`) : new Error(`CDP ${method} aborted`));
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			signal?.addEventListener("abort", onAbort, { once: true });
			this.#pending.set(id, {
				method,
				resolve: (value) => {
					cleanup();
					// SAFETY: the CDP result payload shape is defined by the command-specific generic T.
					resolve(value as T);
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			});
			try {
				this.#ws.send(JSON.stringify(message));
			} catch (error) {
				cleanup();
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	onEvent(listener: (event: CdpEventMessage) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	async close(): Promise<void> {
		if (this.#closed) {
			return;
		}
		const readyState = this.#ws.readyState;
		if (readyState === WebSocket.OPEN || readyState === WebSocket.CONNECTING) {
			try {
				this.#ws.close();
			} catch {
				// Already closing.
			}
			let waitTimer: NodeJS.Timeout | undefined;
			await Promise.race([
				this.#closedPromise,
				new Promise<void>((resolve) => {
					waitTimer = setTimeout(resolve, CLOSE_WAIT_MS);
				}),
			]);
			clearTimeout(waitTimer);
		}
		this.#handleClosed("CDP client closed");
	}

	#handleClosed(reason: string): void {
		if (this.#closed) {
			return;
		}
		this.#closed = true;
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const call of pending) {
			call.reject(new Error(`${reason} before ${call.method} completed`));
		}
		this.#markClosed();
	}

	#handleFrame(data: unknown): void {
		const frame = parseIncomingFrame(data);
		if (!frame) {
			return;
		}
		if (typeof frame.id === "number") {
			this.#settleResponse(frame.id, frame);
			return;
		}
		if (typeof frame.method === "string") {
			this.#dispatchEvent({
				method: frame.method,
				params: isRecord(frame.params) ? frame.params : {},
				...(typeof frame.sessionId === "string" ? { sessionId: frame.sessionId } : {}),
			});
		}
	}

	#settleResponse(id: number, frame: IncomingFrame): void {
		const call = this.#pending.get(id);
		if (!call) {
			return;
		}
		if (frame.error) {
			call.reject(protocolErrorFrom(call.method, frame.error));
		} else {
			call.resolve(isRecord(frame.result) ? frame.result : {});
		}
	}

	#dispatchEvent(event: CdpEventMessage): void {
		for (const listener of [...this.#listeners]) {
			try {
				listener(event);
			} catch {
				// A faulty listener must not break dispatch to the others.
			}
		}
	}
}

/** Queries `http://host:port/json/version`; returns null when the endpoint is absent or malformed. */
export async function fetchJsonVersion(
	host: string,
	port: number,
	timeoutMs = 1_500,
): Promise<{ browser: string; webSocketDebuggerUrl: string } | null> {
	const hostname = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	return new Promise((resolve) => {
		let done = false;
		const finish = (value: { browser: string; webSocketDebuggerUrl: string } | null): void => {
			if (done) {
				return;
			}
			done = true;
			clearTimeout(timer);
			resolve(value);
		};
		const req = http.get({ hostname, port, path: "/json/version", timeout: timeoutMs }, (res) => {
			if (res.statusCode !== 200) {
				res.resume();
				finish(null);
				return;
			}
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				body = `${body}${chunk}`;
				if (body.length > 1_000_000) {
					req.destroy();
					finish(null);
				}
			});
			res.on("end", () => {
				try {
					const parsed: unknown = JSON.parse(body);
					if (isRecord(parsed) && typeof parsed.webSocketDebuggerUrl === "string") {
						finish({
							browser: typeof parsed.Browser === "string" ? parsed.Browser : "unknown",
							webSocketDebuggerUrl: parsed.webSocketDebuggerUrl,
						});
					} else {
						finish(null);
					}
				} catch {
					finish(null);
				}
			});
			res.on("error", () => finish(null));
		});
		const timer = setTimeout(() => {
			req.destroy();
			finish(null);
		}, timeoutMs);
		req.on("error", () => finish(null));
		req.on("timeout", () => {
			req.destroy();
			finish(null);
		});
	});
}

type DevToolsWaitOutcome =
	| { kind: "ready"; wsUrl: string }
	| { kind: "exited"; code: number | null; exitSignal: NodeJS.Signals | null; elapsedMs: number; stderr: string };

function readDevToolsActivePort(userDataDir: string, notBeforeMs: number): string | null {
	const file = path.join(userDataDir, "DevToolsActivePort");
	try {
		const stat = fs.statSync(file);
		// Ignore a stale file left behind by an earlier browser run on a reused profile.
		if (stat.mtimeMs + 1_000 < notBeforeMs) {
			return null;
		}
		const [portLine, pathLine] = fs.readFileSync(file, "utf8").split(/\r?\n/);
		const port = Number.parseInt(portLine?.trim() ?? "", 10);
		const wsPath = pathLine?.trim() ?? "";
		if (!Number.isInteger(port) || port <= 0 || !wsPath.startsWith("/")) {
			return null;
		}
		const url = new URL(wsPath, `http://127.0.0.1:${port}`);
		url.protocol = "ws:";
		return url.href;
	} catch {
		return null;
	}
}

function waitForDevToolsEndpoint(
	child: ChildProcess,
	userDataDir: string,
	startedAt: number,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	stderrTail: { text: string },
): Promise<DevToolsWaitOutcome> {
	return new Promise<DevToolsWaitOutcome>((resolve, reject) => {
		let settled = false;
		const cleanup = (): void => {
			settled = true;
			clearTimeout(timer);
			clearInterval(poller);
			child.stderr?.off("data", onStderr);
			child.off("exit", onExit);
			child.off("error", onError);
			signal?.removeEventListener("abort", onAbort);
		};
		const succeed = (wsUrl: string): void => {
			if (settled) {
				return;
			}
			cleanup();
			resolve({ kind: "ready", wsUrl });
		};
		const onStderr = (): void => {
			const match = DEVTOOLS_LISTENING_RE.exec(stderrTail.text);
			if (match?.[1]) {
				succeed(match[1]);
			}
		};
		const onExit = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
			if (settled) {
				return;
			}
			cleanup();
			resolve({ kind: "exited", code, exitSignal, elapsedMs: Date.now() - startedAt, stderr: stderrTail.text });
		};
		const onError = (error: Error): void => {
			if (settled) {
				return;
			}
			cleanup();
			reject(new Error(`Failed to spawn browser: ${error.message}`));
		};
		const onAbort = (): void => {
			if (settled) {
				return;
			}
			cleanup();
			reject(signal ? abortReason(signal, "Browser launch aborted") : new Error("Browser launch aborted"));
		};
		const timer = setTimeout(() => {
			if (settled) {
				return;
			}
			cleanup();
			reject(
				new Error(
					`Timed out after ${timeoutMs}ms waiting for the browser DevTools endpoint. stderr: ${stderrTail.text.trim().slice(-2_000)}`,
				),
			);
		}, timeoutMs);
		const poller = setInterval(() => {
			const fromFile = readDevToolsActivePort(userDataDir, startedAt);
			if (fromFile) {
				succeed(fromFile);
			}
		}, 100);
		// Registered after the shared tail collector so the accumulated text includes this chunk.
		child.stderr?.on("data", onStderr);
		child.once("exit", onExit);
		child.once("error", onError);
		signal?.addEventListener("abort", onAbort, { once: true });
		onStderr();
	});
}

function spawnBrowser(
	executablePath: string,
	args: string[],
	cwd: string | undefined,
): { child: ChildProcess; stderrTail: { text: string } } {
	const child = spawn(executablePath, args, {
		cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
		detached: process.platform !== "win32",
		stdio: ["ignore", "ignore", "pipe"],
		env: process.env,
	});
	const stderrTail = { text: "" };
	// Keep draining stderr for the browser's whole lifetime so a full pipe never blocks it.
	child.stderr?.on("data", (chunk: Buffer) => {
		const next = `${stderrTail.text}${chunk.toString("utf8")}`;
		stderrTail.text = next.length > STDERR_TAIL_LIMIT ? next.slice(-STDERR_TAIL_LIMIT) : next;
	});
	return { child, stderrTail };
}

async function killQuietly(child: ChildProcess): Promise<void> {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	try {
		await terminateProcessTree(child.pid);
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {
			// Process already gone.
		}
	}
}

function removeDirQuietly(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	} catch {
		// Best-effort cleanup of the temporary profile.
	}
}

/** Graceful-then-forceful teardown: Browser.close, socket close, process-tree kill, owned profile removal. */
async function shutdownLaunchedBrowser(client: CdpMultiplexClient, pid: number, ownedUserDataDir?: string): Promise<void> {
	try {
		await client.send("Browser.close", {}, { timeoutMs: 500 });
	} catch {
		// Browser may already be gone or slow to acknowledge; force-terminate below.
	}
	try {
		await client.close();
	} catch {
		// Socket already torn down.
	}
	try {
		await terminateProcessTree(pid);
	} catch {
		// Process tree already exited.
	}
	if (ownedUserDataDir) {
		removeDirQuietly(ownedUserDataDir);
	}
}

async function spawnUntilDevToolsReady(
	browserName: string,
	executablePath: string,
	baseArgs: string[],
	userDataDir: string,
	deadline: number,
	signal: AbortSignal | undefined,
	cwd: string | undefined,
	launch: { child?: ChildProcess },
): Promise<{ wsUrl: string; pid: number }> {
	let args = [...baseArgs, "about:blank"];
	let retriedWithoutSandbox = false;
	for (;;) {
		const startedAt = Date.now();
		const spawned = spawnBrowser(executablePath, args, cwd);
		launch.child = spawned.child;
		const outcome = await waitForDevToolsEndpoint(
			spawned.child,
			userDataDir,
			startedAt,
			Math.max(1, deadline - Date.now()),
			signal,
			spawned.stderrTail,
		);
		if (outcome.kind === "ready") {
			if (spawned.child.pid === undefined) {
				throw new Error(`${browserName} started without a process id`);
			}
			return { wsUrl: outcome.wsUrl, pid: spawned.child.pid };
		}
		// Containers often lack user namespaces / SUID sandbox helpers: retry once without the sandbox.
		const sandboxFailure =
			process.platform === "linux" &&
			!retriedWithoutSandbox &&
			outcome.elapsedMs < EARLY_EXIT_WINDOW_MS &&
			SANDBOX_FAILURE_RE.test(outcome.stderr) &&
			!args.includes("--no-sandbox");
		if (!sandboxFailure) {
			const exitDesc = outcome.exitSignal ? `signal ${outcome.exitSignal}` : `code ${String(outcome.code)}`;
			throw new Error(
				`${browserName} exited (${exitDesc}) before exposing a DevTools endpoint. stderr: ${outcome.stderr.trim().slice(-2_000)}`,
			);
		}
		retriedWithoutSandbox = true;
		args = [...baseArgs, "--no-sandbox", "about:blank"];
	}
}

/** Launches a local Chromium-family browser with remote debugging on an ephemeral port. */
export async function launchBrowserProcess(opts?: LaunchBrowserProcessOptions): Promise<LaunchedBrowserHandle> {
	const signal = opts?.signal;
	if (signal?.aborted) {
		throw abortReason(signal, "Browser launch aborted");
	}
	const browser = selectPreferredBrowser(opts?.cwd, opts?.executablePath, { requireHeaded: opts?.headless === false });
	const useHeadlessFlag = opts?.headless !== false && browser.headlessOnly !== true;
	const headless = opts?.headless !== false || browser.headlessOnly === true;
	const ownsUserDataDir = opts?.userDataDir === undefined;
	const userDataDir = opts?.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-cdp-profile-"));
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
	const viewport = opts?.viewport;
	const extraArgs = opts?.extraArgs ?? [];

	const baseArgs = [
		"--remote-debugging-port=0",
		`--user-data-dir=${userDataDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		"--disable-sync",
		"--metrics-recording-only",
		"--password-store=basic",
		"--use-mock-keychain",
		...(useHeadlessFlag ? ["--headless=new"] : []),
		...(viewport ? [`--window-size=${viewport.width},${viewport.height}`] : ["--window-size=1280,800"]),
		...extraArgs,
	];

	const deadline = Date.now() + timeoutMs;
	const launch: { child?: ChildProcess } = {};
	try {
		const { wsUrl, pid } = await spawnUntilDevToolsReady(
			browser.name,
			browser.executablePath,
			baseArgs,
			userDataDir,
			deadline,
			signal,
			opts?.cwd,
			launch,
		);
		const client = await CdpMultiplexClient.connect(wsUrl, Math.max(1_000, deadline - Date.now()), signal);
		const port = Number.parseInt(new URL(wsUrl).port, 10);

		let shutdownPromise: Promise<void> | undefined;
		const shutdown = (): Promise<void> => {
			shutdownPromise ??= shutdownLaunchedBrowser(client, pid, ownsUserDataDir ? userDataDir : undefined);
			return shutdownPromise;
		};

		return {
			client,
			pid,
			executablePath: browser.executablePath,
			browserName: browser.name,
			wsUrl,
			port,
			userDataDir,
			ownsUserDataDir,
			headless,
			shutdown,
		};
	} catch (error) {
		if (launch.child) {
			await killQuietly(launch.child);
		}
		if (ownsUserDataDir) {
			removeDirQuietly(userDataDir);
		}
		throw error;
	}
}
