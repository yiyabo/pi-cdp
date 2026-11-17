import type { CdpClientInterface, ClickOptions, ResolvedDomTarget, ScreenshotOptions, ScreenshotResult, TargetResolutionContext, WaitConditionOptions } from "../types.ts";

export async function resolveDomTarget(_ctx: TargetResolutionContext, _target: string): Promise<ResolvedDomTarget> { throw new Error("stub"); }
export async function clickTarget(_ctx: TargetResolutionContext, _target: string, _options?: ClickOptions): Promise<{ clicked: string; x: number; y: number }> { throw new Error("stub"); }
export async function fillTarget(_ctx: TargetResolutionContext, _target: string, _value: string): Promise<{ filled: string; value: string }> { throw new Error("stub"); }
export async function selectTarget(_ctx: TargetResolutionContext, _target: string, _values: string[]): Promise<{ selected: string[]; target: string }> { throw new Error("stub"); }
export async function hoverTarget(_ctx: TargetResolutionContext, _target: string): Promise<{ hovered: string; x: number; y: number }> { throw new Error("stub"); }
export async function typeText(_client: CdpClientInterface, _sessionId: string, _text: string, _submit?: boolean, _timeoutMs?: number, _signal?: AbortSignal): Promise<void> { throw new Error("stub"); }
export async function pressKey(_client: CdpClientInterface, _sessionId: string, _key: string, _timeoutMs?: number, _signal?: AbortSignal): Promise<void> { throw new Error("stub"); }
export async function scrollViewport(_ctx: TargetResolutionContext, _opts: { direction?: "up" | "down" | "left" | "right" | "top" | "bottom"; amountPx?: number; target?: string }): Promise<{ scrollX: number; scrollY: number }> { throw new Error("stub"); }
export async function waitForCondition(_client: CdpClientInterface, _sessionId: string, _options: WaitConditionOptions): Promise<{ matched: string; elapsedMs: number }> { throw new Error("stub"); }
export async function evaluateExpression(_client: CdpClientInterface, _sessionId: string, _expression: string, _timeoutMs?: number, _signal?: AbortSignal): Promise<{ valueText: string; isError: boolean }> { throw new Error("stub"); }
export async function capturePageScreenshot(_ctx: TargetResolutionContext, _options?: ScreenshotOptions, _cwd?: string): Promise<ScreenshotResult> { throw new Error("stub"); }
