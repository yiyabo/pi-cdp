import type { CdpClientInterface, CdpEventMessage, CdpSendOptions, LaunchBrowserProcessOptions, LaunchedBrowserHandle } from "../types.ts";

export class CdpMultiplexClient implements CdpClientInterface {
	readonly wsUrl: string = "";
	get isOpen(): boolean { return false; }
	static async connect(_wsUrl: string, _timeoutMs?: number, _signal?: AbortSignal): Promise<CdpMultiplexClient> { throw new Error("stub"); }
	async send<T = Record<string, unknown>>(_method: string, _params?: Record<string, unknown>, _options?: CdpSendOptions): Promise<T> { throw new Error("stub"); }
	onEvent(_listener: (event: CdpEventMessage) => void): () => void { throw new Error("stub"); }
	async close(): Promise<void> {}
}
export async function fetchJsonVersion(_host: string, _port: number, _timeoutMs?: number): Promise<{ browser: string; webSocketDebuggerUrl: string } | null> { throw new Error("stub"); }
export async function launchBrowserProcess(_opts?: LaunchBrowserProcessOptions): Promise<LaunchedBrowserHandle> { throw new Error("stub"); }
