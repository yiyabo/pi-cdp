import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import {
	discoverBrowsers,
	discoverLiveEndpoints,
	probePortEndpoint,
	readDevToolsActivePort,
	runBrowserDoctor,
	selectLiveEndpointForAttach,
	selectPreferredBrowser,
} from "../src/discovery/browsers.ts";
import {
	collectDescendantPids,
	isExecutableFile,
	isPidAlive,
	resolveToolPath,
	terminateProcessTree,
	whichExecutable,
} from "../src/utils/process-tree.ts";

const IS_WINDOWS = process.platform === "win32";
const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-cdp-${prefix}-`));
	tempRoots.push(dir);
	return dir;
}

function writeExecutable(filePath: string): string {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(filePath, 0o755);
	return filePath;
}

async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(overrides)) {
		previous.set(key, process.env[key]);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

const NO_BROWSER_OVERRIDES = {
	PI_CDP_EXECUTABLE: undefined,
	CHROME_BIN: undefined,
	PUPPETEER_EXECUTABLE_PATH: undefined,
};

/** Relative executable path for a Playwright `chromium-<rev>` dir on this platform. */
function playwrightHeadedLayout(legacy: boolean): string {
	switch (process.platform) {
		case "darwin":
			return legacy
				? path.join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")
				: path.join(
						"chrome-mac-arm64",
						"Google Chrome for Testing.app",
						"Contents",
						"MacOS",
						"Google Chrome for Testing",
					);
		case "win32":
			return legacy ? path.join("chrome-win", "chrome.exe") : path.join("chrome-win64", "chrome.exe");
		default:
			return legacy ? path.join("chrome-linux", "chrome") : path.join("chrome-linux64", "chrome");
	}
}

function playwrightHeadlessShellLayout(): string {
	switch (process.platform) {
		case "darwin":
			return path.join("chrome-headless-shell-mac-arm64", "chrome-headless-shell");
		case "win32":
			return path.join("chrome-headless-shell-win64", "chrome-headless-shell.exe");
		default:
			return path.join("chrome-headless-shell-linux64", "chrome-headless-shell");
	}
}

function createPlaywrightRevision(root: string, dirName: string, relativeExe: string, complete: boolean): string {
	const revisionDir = path.join(root, dirName);
	const exe = writeExecutable(path.join(revisionDir, relativeExe));
	if (complete) {
		fs.writeFileSync(path.join(revisionDir, "INSTALLATION_COMPLETE"), "");
	}
	return exe;
}

type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

interface TestServer {
	port: number;
	hostHeaders: string[];
	upgradeAttempts: number;
	close: () => Promise<void>;
}

async function startServer(handler: RequestHandler): Promise<TestServer> {
	const state = { hostHeaders: [] as string[], upgradeAttempts: 0 };
	const server = http.createServer((req, res) => {
		state.hostHeaders.push(req.headers.host ?? "");
		handler(req, res);
	});
	server.on("upgrade", (_req, socket) => {
		state.upgradeAttempts += 1;
		socket.destroy();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object", "server must listen on a TCP port");
	const { port } = address satisfies AddressInfo;
	return {
		port,
		get hostHeaders() {
			return state.hostHeaders;
		},
		get upgradeAttempts() {
			return state.upgradeAttempts;
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

function jsonVersionHandler(port: () => number): RequestHandler {
	return (req, res) => {
		if (req.url === "/json/version") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					Browser: "Chrome/146.0.7680.0",
					"Protocol-Version": "1.3",
					webSocketDebuggerUrl: `ws://127.0.0.1:${port()}/devtools/browser/normal-id`,
				}),
			);
			return;
		}
		res.writeHead(404);
		res.end();
	};
}

const notFoundHandler: RequestHandler = (_req, res) => {
	res.writeHead(404, { "Content-Type": "text/plain" });
	res.end("Not Found");
};

async function getClosedPort(): Promise<number> {
	const server = http.createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const { port } = address;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

after(() => {
	for (const dir of tempRoots) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("process-tree utilities", () => {
	test("isExecutableFile rejects directories and non-executable files", () => {
		const dir = makeTempDir("exec");
		const subdir = path.join(dir, "chromium");
		fs.mkdirSync(subdir);
		assert.equal(isExecutableFile(subdir), false);
		assert.equal(isExecutableFile(path.join(dir, "missing")), false);
		assert.equal(isExecutableFile(""), false);

		const exe = writeExecutable(path.join(dir, "real-binary"));
		assert.equal(isExecutableFile(exe), true);

		if (!IS_WINDOWS) {
			const plain = path.join(dir, "plain.txt");
			fs.writeFileSync(plain, "data");
			fs.chmodSync(plain, 0o644);
			assert.equal(isExecutableFile(plain), false);
		}
	});

	test("whichExecutable skips a same-named directory and finds the real executable", { skip: IS_WINDOWS }, () => {
		const collisionDir = makeTempDir("which-collision");
		const binDir = makeTempDir("which-bin");
		fs.mkdirSync(path.join(collisionDir, "fake-chromium"));
		const realExe = writeExecutable(path.join(binDir, "fake-chromium"));

		assert.equal(whichExecutable("fake-chromium", [collisionDir]), null);
		assert.equal(whichExecutable("fake-chromium", [collisionDir, binDir]), realExe);
		assert.equal(whichExecutable(""), null);
		assert.equal(whichExecutable(realExe), realExe);
		assert.equal(whichExecutable(path.join(collisionDir, "fake-chromium")), null);
	});

	test("whichExecutable searches PATH after extra dirs", { skip: IS_WINDOWS }, async () => {
		const binDir = makeTempDir("which-path");
		const exe = writeExecutable(path.join(binDir, "pi-cdp-path-probe"));
		await withEnv({ PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` }, () => {
			assert.equal(whichExecutable("pi-cdp-path-probe"), exe);
		});
	});

	test("resolveToolPath strips @, expands ~, and resolves relative to cwd", () => {
		const home = os.homedir();
		const cwd = makeTempDir("resolve");
		assert.equal(resolveToolPath("~"), home);
		assert.equal(resolveToolPath("~/bin/chrome"), path.join(home, "bin", "chrome"));
		assert.equal(resolveToolPath("@~/bin/chrome"), path.join(home, "bin", "chrome"));
		assert.equal(resolveToolPath("@shots/out.png", cwd), path.join(cwd, "shots", "out.png"));
		assert.equal(resolveToolPath("./a/../b.txt", cwd), path.join(cwd, "b.txt"));
		assert.equal(resolveToolPath("rel.txt"), path.resolve(process.cwd(), "rel.txt"));
		const absolute = path.join(cwd, "abs.txt");
		assert.equal(resolveToolPath(`@${absolute}`, "/somewhere/else"), absolute);
	});

	test("isPidAlive handles live, invalid, and dead pids", () => {
		assert.equal(isPidAlive(process.pid), true);
		assert.equal(isPidAlive(0), false);
		assert.equal(isPidAlive(-5), false);
		assert.equal(isPidAlive(1.5), false);
		assert.equal(isPidAlive(2_147_483_646), false);
	});

	test("terminateProcessTree kills the root and its descendants", { skip: IS_WINDOWS }, async () => {
		const child = spawn("sh", ["-c", "sleep 30 & sleep 30 & wait"], { detached: true, stdio: "ignore" });
		const rootPid = child.pid;
		assert.ok(rootPid, "child must have a pid");
		let descendants: number[] = [];
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline && descendants.length < 2) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			descendants = collectDescendantPids(rootPid);
		}
		assert.equal(descendants.length, 2, `expected two sleep children, got ${descendants.join(",")}`);
		assert.ok(descendants.every(isPidAlive));

		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		await terminateProcessTree(rootPid, 1000);
		await exited;
		assert.equal(isPidAlive(rootPid), false);
		for (const pid of descendants) {
			assert.equal(isPidAlive(pid), false, `descendant ${pid} should be dead`);
		}
		assert.deepEqual(collectDescendantPids(0), []);
		await terminateProcessTree(0);
	});
});

describe("discoverBrowsers", () => {
	test("finds a real Chrome or Playwright Chromium on this machine", async () => {
		await withEnv({ ...NO_BROWSER_OVERRIDES, PLAYWRIGHT_BROWSERS_PATH: undefined }, () => {
			const browsers = discoverBrowsers();
			assert.ok(browsers.length > 0, "expected at least one Chromium-family browser");
			assert.ok(
				browsers.some((browser) => browser.channel === "chrome" || browser.channel === "playwright-chromium"),
				`expected Chrome or Playwright Chromium, got ${browsers.map((browser) => browser.channel).join(", ")}`,
			);
			for (const browser of browsers) {
				assert.equal(isExecutableFile(browser.executablePath), true, browser.executablePath);
			}
			const realPaths = browsers.map((browser) => fs.realpathSync(browser.executablePath));
			assert.equal(new Set(realPaths).size, realPaths.length, "results must be de-duplicated by real path");
			const ids = browsers.map((browser) => browser.id);
			assert.equal(new Set(ids).size, ids.length, "browser ids must be unique");

			const preferred = selectPreferredBrowser(undefined, undefined, { requireHeaded: true });
			assert.notEqual(preferred.headlessOnly, true);
			assert.equal(isExecutableFile(preferred.executablePath), true);
		});
	});

	test("Playwright cache: numeric revision sort, headed before headless shell, skips partial installs", async () => {
		const cacheRoot = makeTempDir("pw-cache");
		const headed1246 = createPlaywrightRevision(cacheRoot, "chromium-1246", playwrightHeadedLayout(false), true);
		const headed999 = createPlaywrightRevision(cacheRoot, "chromium-999", playwrightHeadedLayout(true), true);
		createPlaywrightRevision(cacheRoot, "chromium-2000", playwrightHeadedLayout(false), false);
		const shell1300 = createPlaywrightRevision(
			cacheRoot,
			"chromium_headless_shell-1300",
			playwrightHeadlessShellLayout(),
			true,
		);
		createPlaywrightRevision(cacheRoot, "chromium_headless_shell-1400", playwrightHeadlessShellLayout(), false);
		fs.mkdirSync(path.join(cacheRoot, "chromium-1500"));
		fs.writeFileSync(path.join(cacheRoot, "chromium-1500", "INSTALLATION_COMPLETE"), "");
		fs.mkdirSync(path.join(cacheRoot, "ffmpeg-1011"));

		await withEnv({ ...NO_BROWSER_OVERRIDES, PLAYWRIGHT_BROWSERS_PATH: cacheRoot }, () => {
			const playwright = discoverBrowsers().filter((browser) => browser.source === `playwright:${cacheRoot}`);
			assert.deepEqual(
				playwright.map((browser) => [browser.channel, browser.revision, browser.headlessOnly]),
				[
					["playwright-chromium", 1246, false],
					["playwright-chromium", 999, false],
					["playwright-headless-shell", 1300, true],
				],
			);
			assert.deepEqual(
				playwright.map((browser) => browser.executablePath),
				[headed1246, headed999, shell1300],
			);
			assert.deepEqual(
				playwright.map((browser) => browser.id),
				["playwright-chromium-1246", "playwright-chromium-999", "playwright-headless-shell-1300"],
			);
		});
	});

	test("PLAYWRIGHT_BROWSERS_PATH=0 falls back to the default cache location", async () => {
		const cacheRoot = makeTempDir("pw-zero");
		createPlaywrightRevision(cacheRoot, "chromium-1", playwrightHeadedLayout(false), true);
		await withEnv({ ...NO_BROWSER_OVERRIDES, PLAYWRIGHT_BROWSERS_PATH: "0" }, () => {
			const browsers = discoverBrowsers();
			assert.ok(browsers.every((browser) => !browser.source.includes(cacheRoot)));
		});
	});

	test("env override wins, directories are ignored, and explicit executables are validated", async () => {
		const dir = makeTempDir("env-override");
		const fake = writeExecutable(path.join(dir, "my-chrome"));
		const directory = path.join(dir, "not-a-binary");
		fs.mkdirSync(directory);

		await withEnv({ ...NO_BROWSER_OVERRIDES, PI_CDP_EXECUTABLE: fake, CHROME_BIN: directory }, () => {
			const browsers = discoverBrowsers();
			assert.equal(browsers[0]?.executablePath, fake);
			assert.equal(browsers[0]?.channel, "custom");
			assert.equal(browsers[0]?.source, "env:PI_CDP_EXECUTABLE");
			assert.ok(browsers.every((browser) => browser.executablePath !== directory));
			assert.equal(selectPreferredBrowser().executablePath, fake);
		});

		const explicit = selectPreferredBrowser(dir, "@./my-chrome");
		assert.equal(explicit.executablePath, fake);
		assert.equal(explicit.channel, "custom");
		assert.equal(explicit.source, "explicit");
		assert.throws(() => selectPreferredBrowser(dir, "./does-not-exist"), /not found or not executable/);
		assert.throws(() => selectPreferredBrowser(dir, directory), /not found or not executable/);
	});

	test("project .pi/cdp.json executablePath is resolved relative to cwd", async () => {
		const cwd = makeTempDir("config");
		const fake = writeExecutable(path.join(cwd, "bin", "configured-chrome"));
		fs.mkdirSync(path.join(cwd, ".pi"));
		fs.writeFileSync(path.join(cwd, ".pi", "cdp.json"), JSON.stringify({ executablePath: "./bin/configured-chrome" }));

		await withEnv(NO_BROWSER_OVERRIDES, () => {
			const browsers = discoverBrowsers(cwd);
			const configured = browsers.find((browser) => browser.executablePath === fake);
			assert.ok(configured, "configured executable must be discovered");
			assert.equal(configured.channel, "custom");
			assert.equal(configured.source, `config:${path.join(cwd, ".pi", "cdp.json")}`);
			assert.equal(browsers[0]?.executablePath, fake);
		});
	});

	test("malformed cdp.json is ignored", async () => {
		const cwd = makeTempDir("bad-config");
		fs.mkdirSync(path.join(cwd, ".pi"));
		fs.writeFileSync(path.join(cwd, ".pi", "cdp.json"), "{ not json");
		await withEnv(NO_BROWSER_OVERRIDES, () => {
			assert.ok(discoverBrowsers(cwd).every((browser) => !browser.source.startsWith(`config:${cwd}`)));
		});
	});
});

describe("probePortEndpoint (never opens a WebSocket)", () => {
	test("normal mode: HTTP 200 /json/version", async () => {
		let serverPort = 0;
		const server = await startServer(jsonVersionHandler(() => serverPort));
		serverPort = server.port;
		try {
			const endpoint = await probePortEndpoint("127.0.0.1", server.port, "test");
			assert.ok(endpoint);
			assert.equal(endpoint.mode, "normal");
			assert.equal(endpoint.wsUrl, `ws://127.0.0.1:${server.port}/devtools/browser/normal-id`);
			assert.equal(endpoint.browserName, "Chrome/146.0.7680.0");
			assert.equal(endpoint.browserVersion, "Chrome/146.0.7680.0");
			assert.equal(endpoint.id, `127.0.0.1:${server.port}`);
			assert.equal(endpoint.source, "test");
			assert.deepEqual(server.hostHeaders, [`127.0.0.1:${server.port}`]);
			assert.equal(server.upgradeAttempts, 0, "probing must never attempt a WebSocket upgrade");
		} finally {
			await server.close();
		}
	});

	test("approval mode: HTTP 404 + DevToolsActivePort ws path", async () => {
		const server = await startServer(notFoundHandler);
		try {
			const userDataDir = path.join(os.tmpdir(), "Google", "Chrome");
			const endpoint = await probePortEndpoint(
				"127.0.0.1",
				server.port,
				"DevToolsActivePort:test",
				800,
				"/devtools/browser/approval-id",
				userDataDir,
			);
			assert.ok(endpoint);
			assert.equal(endpoint.mode, "approval");
			assert.equal(endpoint.wsUrl, `ws://127.0.0.1:${server.port}/devtools/browser/approval-id`);
			assert.equal(endpoint.userDataDir, userDataDir);
			assert.equal(endpoint.browserName, "Google Chrome");
			assert.match(endpoint.note ?? "", /Allow remote debugging\?/);

			assert.equal(await probePortEndpoint("127.0.0.1", server.port, "no-fallback"), null);
			assert.equal(server.upgradeAttempts, 0, "probing must never attempt a WebSocket upgrade");
		} finally {
			await server.close();
		}
	});

	test("closed port and invalid responses return null", async () => {
		const closedPort = await getClosedPort();
		assert.equal(await probePortEndpoint("127.0.0.1", closedPort, "closed", 300, "/devtools/browser/x"), null);
		assert.equal(await probePortEndpoint("127.0.0.1", 0, "invalid-port"), null);

		const badJson = await startServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("{ nope");
		});
		const missingWs = await startServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ Browser: "Chrome/1" }));
		});
		const serverError = await startServer((_req, res) => {
			res.writeHead(500);
			res.end();
		});
		try {
			assert.equal(await probePortEndpoint("127.0.0.1", badJson.port, "bad-json"), null);
			assert.equal(await probePortEndpoint("127.0.0.1", missingWs.port, "missing-ws"), null);
			assert.equal(await probePortEndpoint("127.0.0.1", serverError.port, "500", 800, "/devtools/browser/x"), null);
		} finally {
			await Promise.all([badJson.close(), missingWs.close(), serverError.close()]);
		}
	});

	test("hanging HTTP server times out to null", async () => {
		const hanging = await startServer(() => {
			// Never respond.
		});
		try {
			const started = Date.now();
			assert.equal(await probePortEndpoint("127.0.0.1", hanging.port, "hang", 300), null);
			assert.ok(Date.now() - started < 2000, "probe must honour its timeout");
		} finally {
			await hanging.close();
		}
	});
});

describe("live endpoint discovery & attach selection", () => {
	test("readDevToolsActivePort parses port + ws path and rejects junk", () => {
		const dir = makeTempDir("active-port");
		assert.equal(readDevToolsActivePort(dir), null);
		fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "9333\n/devtools/browser/abc-123\n");
		assert.deepEqual(readDevToolsActivePort(dir), { port: 9333, wsPath: "/devtools/browser/abc-123" });
		fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "9444\r\n");
		assert.deepEqual(readDevToolsActivePort(dir), { port: 9444 });
		fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "garbage\n/devtools/browser/x\n");
		assert.equal(readDevToolsActivePort(dir), null);
	});

	test("discoverLiveEndpoints includes extra and PI_CDP_PORT ports, de-duplicated by host:port", async () => {
		let serverPort = 0;
		const server = await startServer(jsonVersionHandler(() => serverPort));
		serverPort = server.port;
		const closedPort = await getClosedPort();
		try {
			await withEnv({ PI_CDP_PORT: String(server.port) }, async () => {
				const endpoints = await discoverLiveEndpoints([server.port, server.port, closedPort]);
				const matching = endpoints.filter((endpoint) => endpoint.port === server.port);
				assert.equal(matching.length, 1);
				assert.equal(matching[0]?.mode, "normal");
				assert.equal(matching[0]?.source, "env:PI_CDP_PORT");
				assert.ok(endpoints.every((endpoint) => endpoint.port !== closedPort));
				const keys = endpoints.map((endpoint) => `${endpoint.host}:${endpoint.port}`);
				assert.equal(new Set(keys).size, keys.length);
			});
			assert.equal(server.upgradeAttempts, 0);
		} finally {
			await server.close();
		}
	});

	test("selectLiveEndpointForAttach honours explicit port and wsUrl", async () => {
		let serverPort = 0;
		const normal = await startServer(jsonVersionHandler(() => serverPort));
		serverPort = normal.port;
		const approval = await startServer(notFoundHandler);
		try {
			const byPort = await selectLiveEndpointForAttach({ port: normal.port });
			assert.equal(byPort.mode, "normal");
			assert.equal(byPort.wsUrl, `ws://127.0.0.1:${normal.port}/devtools/browser/normal-id`);

			const approvalWs = `ws://127.0.0.1:${approval.port}/devtools/browser/approval-id`;
			const byWs = await selectLiveEndpointForAttach({ wsUrl: approvalWs });
			assert.equal(byWs.mode, "approval");
			assert.equal(byWs.wsUrl, approvalWs);

			await assert.rejects(selectLiveEndpointForAttach({ port: approval.port }), /No Chrome DevTools endpoint/);
			await assert.rejects(selectLiveEndpointForAttach({ wsUrl: "http://127.0.0.1:1/x" }), /ws:\/\/ or wss:\/\//);
			await assert.rejects(selectLiveEndpointForAttach({ wsUrl: "not a url" }), /Invalid CDP WebSocket URL/);

			const closedPort = await getClosedPort();
			const unreachableWs = `ws://127.0.0.1:${closedPort}/devtools/browser/gone`;
			const fallback = await selectLiveEndpointForAttach({ wsUrl: unreachableWs });
			assert.equal(fallback.wsUrl, unreachableWs);
			assert.equal(fallback.port, closedPort);
			assert.equal(normal.upgradeAttempts + approval.upgradeAttempts, 0);
		} finally {
			await Promise.all([normal.close(), approval.close()]);
		}
	});
});

describe("runBrowserDoctor", () => {
	test("reports platform, browsers, live endpoints, and actionable guidance", async () => {
		await withEnv(NO_BROWSER_OVERRIDES, async () => {
			const report = await runBrowserDoctor();
			assert.equal(report.platform, process.platform);
			assert.equal(report.arch, process.arch);
			assert.ok(Array.isArray(report.browsers));
			assert.ok(Array.isArray(report.liveEndpoints));
			assert.ok(report.guidance.length > 0);
			if (report.browsers.length > 0) {
				assert.ok(report.preferredBrowser);
				assert.notEqual(report.preferredBrowser.headlessOnly, true);
			}
			if (report.chromeRemoteDebuggingToggle) {
				assert.equal(typeof report.chromeRemoteDebuggingToggle.allowed, "boolean");
				assert.equal(typeof report.chromeRemoteDebuggingToggle.userEnabled, "boolean");
			}
		});
	});
});
