export function isExecutableFile(_candidate: string): boolean { throw new Error("stub"); }
export function whichExecutable(_binaryName: string, _extraPathDirs?: string[]): string | null { throw new Error("stub"); }
export function isPidAlive(_pid: number): boolean { throw new Error("stub"); }
export function collectDescendantPids(_rootPid: number): number[] { throw new Error("stub"); }
export async function terminateProcessTree(_pid: number, _graceMs?: number): Promise<void> { throw new Error("stub"); }
export function resolveToolPath(_rawPath: string, _cwd?: string): string { throw new Error("stub"); }
