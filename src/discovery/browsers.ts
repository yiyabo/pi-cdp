import type { BrowserDoctorReport, DiscoveredBrowser, LiveCdpEndpoint } from "../types.ts";

export function discoverBrowsers(_cwd?: string): DiscoveredBrowser[] { throw new Error("stub"); }
export function selectPreferredBrowser(_cwd?: string, _explicitExecutable?: string, _opts?: { requireHeaded?: boolean }): DiscoveredBrowser { throw new Error("stub"); }
export async function probePortEndpoint(_host: string, _port: number, _source: string, _timeoutMs?: number, _fallbackWsPath?: string, _userDataDir?: string): Promise<LiveCdpEndpoint | null> { throw new Error("stub"); }
export async function discoverLiveEndpoints(_extraPorts?: number[]): Promise<LiveCdpEndpoint[]> { throw new Error("stub"); }
export async function selectLiveEndpointForAttach(_opts?: { host?: string; port?: number; wsUrl?: string; includeApprovalMode?: boolean }): Promise<LiveCdpEndpoint> { throw new Error("stub"); }
export async function runBrowserDoctor(_cwd?: string): Promise<BrowserDoctorReport> { throw new Error("stub"); }
