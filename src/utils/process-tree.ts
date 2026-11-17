/**
 * Cross-platform executable lookup, path resolution, and process-tree cleanup
 * (macOS, Linux, Windows). Zero runtime dependencies.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const POLL_INTERVAL_MS = 40;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = error.code;
		return typeof code === "string" ? code : undefined;
	}
	return undefined;
}

function safeKill(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		// Process (or group) already exited or is not ours to signal.
	}
}

/**
 * True only for regular files that are executable by the current user.
 * Directories (e.g. a `chromium/` folder on PATH) are never treated as executables.
 */
export function isExecutableFile(candidate: string): boolean {
	if (!candidate) {
		return false;
	}
	try {
		const stat = fs.statSync(candidate);
		if (!stat.isFile()) {
			return false;
		}
		if (process.platform !== "win32") {
			fs.accessSync(candidate, fs.constants.X_OK);
		}
		return true;
	} catch {
		return false;
	}
}

function looksLikeExplicitPath(binaryName: string): boolean {
	return (
		path.isAbsolute(binaryName) ||
		binaryName.startsWith("./") ||
		binaryName.startsWith("../") ||
		binaryName.startsWith(".\\") ||
		binaryName.startsWith("..\\")
	);
}

function executableExtensions(binaryName: string): string[] {
	if (process.platform !== "win32") {
		return [""];
	}
	const pathExt = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.map((ext) => ext.trim())
		.filter(Boolean);
	const lowerName = binaryName.toLowerCase();
	const alreadyHasExt = pathExt.some((ext) => lowerName.endsWith(ext.toLowerCase()));
	return alreadyHasExt ? ["", ...pathExt] : pathExt;
}

/**
 * Finds an executable file in `extraPathDirs` followed by PATH (honouring PATHEXT on Windows).
 * Explicit absolute/relative paths are resolved directly. Never returns directories.
 */
export function whichExecutable(binaryName: string, extraPathDirs: string[] = []): string | null {
	if (!binaryName) {
		return null;
	}
	if (looksLikeExplicitPath(binaryName)) {
		const absolute = path.resolve(binaryName);
		return isExecutableFile(absolute) ? absolute : null;
	}

	const searchDirs = [
		...extraPathDirs,
		...(process.env.PATH ?? "").split(path.delimiter),
	].filter(Boolean);
	const extensions = executableExtensions(binaryName);

	for (const dir of searchDirs) {
		for (const ext of extensions) {
			const candidate = path.join(dir, `${binaryName}${ext}`);
			if (isExecutableFile(candidate)) {
				return candidate;
			}
		}
	}
	return null;
}

/**
 * Liveness check via signal 0. EPERM means the process exists but belongs to
 * another user (alive); ESRCH means it is gone.
 */
export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

/**
 * Collects all descendant PIDs of `rootPid` via `pgrep -P` (POSIX only), ordered
 * bottom-up: deepest descendants first, direct children last.
 */
export function collectDescendantPids(rootPid: number): number[] {
	if (process.platform === "win32" || !Number.isInteger(rootPid) || rootPid <= 0) {
		return [];
	}
	const visited = new Set<number>([rootPid]);
	const queue: number[] = [rootPid];
	const topDown: number[] = [];

	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) {
			continue;
		}
		let output = "";
		try {
			output = execFileSync("pgrep", ["-P", String(current)], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 1000,
			});
		} catch {
			// pgrep exits with status 1 when there are no children.
			continue;
		}
		for (const raw of output.split(/\s+/)) {
			const childPid = Number.parseInt(raw, 10);
			if (Number.isInteger(childPid) && childPid > 0 && !visited.has(childPid)) {
				visited.add(childPid);
				topDown.push(childPid);
				queue.push(childPid);
			}
		}
	}
	return topDown.reverse();
}

/**
 * Terminates `pid` and its entire descendant tree.
 * - Windows: `taskkill /PID <pid> /T /F`.
 * - POSIX: SIGTERM to the process group (-pid), every descendant, and the root;
 *   polls liveness and escalates to SIGKILL after `graceMs`.
 */
export async function terminateProcessTree(pid: number, graceMs = 1200): Promise<void> {
	if (!Number.isInteger(pid) || pid <= 0) {
		return;
	}

	if (process.platform === "win32") {
		const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
			stdio: "ignore",
			timeout: 5000,
			windowsHide: true,
		});
		if (result.error && isPidAlive(pid)) {
			safeKill(pid, "SIGKILL");
		}
		return;
	}

	const descendants = collectDescendantPids(pid);
	safeKill(-pid, "SIGTERM");
	for (const childPid of descendants) {
		safeKill(childPid, "SIGTERM");
	}
	safeKill(pid, "SIGTERM");

	const anyAlive = (pids: number[]): boolean => isPidAlive(pid) || pids.some(isPidAlive);
	const deadline = Date.now() + Math.max(0, graceMs);
	while (Date.now() < deadline) {
		if (!anyAlive(descendants)) {
			return;
		}
		await sleep(POLL_INTERVAL_MS);
	}

	const lateDescendants = collectDescendantPids(pid);
	const allDescendants = [...new Set([...lateDescendants, ...descendants])];
	safeKill(-pid, "SIGKILL");
	for (const childPid of allDescendants) {
		safeKill(childPid, "SIGKILL");
	}
	safeKill(pid, "SIGKILL");

	const killDeadline = Date.now() + 500;
	while (Date.now() < killDeadline && anyAlive(allDescendants)) {
		await sleep(POLL_INTERVAL_MS);
	}
}

/**
 * Normalises a user/tool-supplied path: strips a leading `@` (Pi file mention),
 * expands `~` / `~/…`, and resolves relative paths against `cwd ?? process.cwd()`.
 */
export function resolveToolPath(rawPath: string, cwd?: string): string {
	let value = rawPath.trim();
	if (value.startsWith("@")) {
		value = value.slice(1);
	}
	if (value === "~") {
		return os.homedir();
	}
	if (value.startsWith("~/") || value.startsWith("~\\")) {
		return path.join(os.homedir(), value.slice(2));
	}
	return path.resolve(cwd ?? process.cwd(), value);
}
