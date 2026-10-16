// Shared shapes between companion (writer), server peer (reader) and browser (view).
// Kept dependency-free so all three entries can import it.
//
// v2 adds TTFT, stall flag and cache split. v1 rows (without the new fields)
// are accepted everywhere and normalized with defaults on read.

export const UNKNOWN_TTFT = -1;

export interface TpsSample {
  ts: string;
  model: string;
  input: number;
  output: number;
  durationMs: number;
  tps: number;
  approx: boolean;
  /** ms from message start to first streamed token; UNKNOWN_TTFT when unobserved. */
  ttftMs: number;
  /** true when any inter-token gap exceeded the stall threshold while streaming. */
  stalled: boolean;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  /** false when no streamed deltas were observed (replay/buffered flush): tps is 0 and excluded from averages. */
  streamed: boolean;
  status: "ok" | "failed";
  stopReason: string;
  sessionId: string;
}

export interface TpsToolCall {
  name: string;
  durationMs: number;
  isError: boolean;
}

export interface TpsTurn {
  ts: string;
  sessionId: string;
  model: string;
  turnIndex: number;
  llmDurationMs: number;
  ttftMs: number;
  input: number;
  output: number;
  tps: number;
  streamed: boolean;
  approx: boolean;
  tools: TpsToolCall[];
  toolMsTotal: number;
  turnMsTotal: number;
  outcome: "completed" | "aborted" | "error";
  toolErrors: number;
}

export interface TpsLive {
  state: "streaming" | "idle" | "unknown";
  model?: string;
  chars: number;
  elapsedMs: number;
  approxTps: number;
  updatedAt: string;
  last?: TpsSample;
  ttftMs?: number;
  stalled?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isOptionalNumber(v: Record<string, unknown>, key: string): boolean {
  return v[key] === undefined || typeof v[key] === "number";
}

export function isTpsSample(v: unknown): v is TpsSample {
  if (!isRecord(v)) return false;
  return (
    typeof v.ts === "string" &&
    typeof v.model === "string" &&
    typeof v.input === "number" &&
    typeof v.output === "number" &&
    typeof v.durationMs === "number" &&
    typeof v.tps === "number" &&
    typeof v.approx === "boolean" &&
    isOptionalNumber(v, "ttftMs") &&
    (v.stalled === undefined || typeof v.stalled === "boolean") &&
    isOptionalNumber(v, "cacheRead") &&
    isOptionalNumber(v, "cacheWrite") &&
    isOptionalNumber(v, "reasoning") &&
    (v.streamed === undefined || typeof v.streamed === "boolean") &&
    (v.status === undefined || v.status === "ok" || v.status === "failed") &&
    (v.stopReason === undefined || typeof v.stopReason === "string") &&
    (v.sessionId === undefined || typeof v.sessionId === "string")
  );
}

/** Fill v1/v2-row gaps with defaults so readers see one uniform shape. */
export function normalizeSample(v: unknown): TpsSample | undefined {
  if (!isTpsSample(v)) return undefined;
  // Rows written before the streamed flag that never observed streaming
  // (no TTFT) yet finished suspiciously fast with real output are replays or
  // buffered flushes, not generation: exclude them from rate math.
  const streamed =
    typeof v.streamed === "boolean"
      ? v.streamed
      : (typeof v.ttftMs === "number" && v.ttftMs >= 0) || v.durationMs >= 1000;
  return {
    ts: v.ts,
    model: v.model,
    input: v.input,
    output: v.output,
    durationMs: v.durationMs,
    tps: v.tps,
    approx: v.approx,
    ttftMs: typeof v.ttftMs === "number" ? v.ttftMs : UNKNOWN_TTFT,
    stalled: v.stalled ?? false,
    cacheRead: v.cacheRead ?? 0,
    cacheWrite: v.cacheWrite ?? 0,
    ...(typeof v.reasoning === "number" ? { reasoning: v.reasoning } : {}),
    streamed,
    status: v.status === "failed" ? "failed" : "ok",
    stopReason: typeof v.stopReason === "string" ? v.stopReason : "",
    sessionId: typeof v.sessionId === "string" ? v.sessionId : "",
  };
}

export function isTpsLive(v: unknown): v is TpsLive {
  if (!isRecord(v)) return false;
  const state = v.state;
  if (state !== "streaming" && state !== "idle" && state !== "unknown") return false;
  if (v.model !== undefined && typeof v.model !== "string") return false;
  if (typeof v.chars !== "number" || typeof v.elapsedMs !== "number") return false;
  if (typeof v.approxTps !== "number" || typeof v.updatedAt !== "string") return false;
  if (v.last !== undefined && !isTpsSample(v.last)) return false;
  if (v.ttftMs !== undefined && typeof v.ttftMs !== "number") return false;
  if (v.stalled !== undefined && typeof v.stalled !== "boolean") return false;
  return true;
}

export function isTpsTurn(v: unknown): v is TpsTurn {
  if (!isRecord(v)) return false;
  if (typeof v.ts !== "string" || typeof v.model !== "string") return false;
  if (typeof v.sessionId !== "string" || typeof v.turnIndex !== "number") return false;
  if (typeof v.llmDurationMs !== "number" || typeof v.ttftMs !== "number") return false;
  if (typeof v.input !== "number" || typeof v.output !== "number" || typeof v.tps !== "number") return false;
  if (typeof v.streamed !== "boolean" || typeof v.approx !== "boolean") return false;
  if (!Array.isArray(v.tools) || !v.tools.every(isTpsToolCall)) return false;
  if (typeof v.toolMsTotal !== "number" || typeof v.turnMsTotal !== "number") return false;
  if (v.outcome !== "completed" && v.outcome !== "aborted" && v.outcome !== "error") return false;
  return typeof v.toolErrors === "number";
}

function isTpsToolCall(v: unknown): v is TpsToolCall {
  if (!isRecord(v)) return false;
  return typeof v.name === "string" && typeof v.durationMs === "number" && typeof v.isError === "boolean";
}

/** Turns have no legacy versions yet; the guard is strict and corrupt lines are dropped. */
export function normalizeTurn(v: unknown): TpsTurn | undefined {
  return isTpsTurn(v) ? v : undefined;
}
