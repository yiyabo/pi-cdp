import type { AriaSnapshot, AriaSnapshotOptions, CdpClientInterface, SnapshotDiff } from "../types.ts";

export async function captureAriaSnapshot(_client: CdpClientInterface, _sessionId: string, _generation: number, _options?: AriaSnapshotOptions): Promise<AriaSnapshot> { throw new Error("stub"); }
export function diffAriaSnapshots(_previous: AriaSnapshot, _current: AriaSnapshot): SnapshotDiff { throw new Error("stub"); }
