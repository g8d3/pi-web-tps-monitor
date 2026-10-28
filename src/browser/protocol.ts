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
  /** Tokens/second over the whole window (blended: includes time-to-first-token). */
  tps: number;
  /** Decode rate: output tokens over the window AFTER the first token arrived
   * (durationMs - ttftMs). This is generation speed; `tps` above blends in the
   * pre-first-token latency. UNKNOWN for rows where TTFT was not observed. */
  decodeTps?: number;
  approx: boolean;
  /** ms from message start to first streamed token; UNKNOWN_TTFT when unobserved. */
  ttftMs: number;
  /** true when any inter-token gap exceeded the stall threshold while streaming. */
  stalled: boolean;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  /** Actual billed USD for this message, from Pi's own usage cost
   * (provider registry pricing — the number behind the session footer).
   * Absent on pre-fix rows, which fall back to the table estimate. */
  costUsd?: number;
  /** false when no streamed deltas were observed (replay/buffered flush): tps is 0 and excluded from averages. */
  streamed: boolean;
  status: "ok" | "failed";
  stopReason: string;
  sessionId: string;
  /** 0-based index of the agent turn that produced this message (#0 = first
   * step). Absent on pre-fix rows; lets Messages rows group with their turn. */
  turnIndex?: number;
  /** Human label captured at record time: Pi's session name when set, else an
   * auto-slug of the session's first user message. Absent when neither
   * existed — views fall back to the 8-hex id. Per-row because names can
   * change mid-session. */
  sessionName?: string;
}

export interface TpsToolCall {
  name: string;
  durationMs: number;
  isError: boolean;
  /** Wall-clock end of the call; absent in pre-v16 rows (timeline unknown). */
  endedAt?: number;
  /** Short summary of the call's arguments (e.g. the bash command head,
   * max ~60 chars). Absent when the start event was missed. */
  detail?: string;
}

export interface TpsTurn {
  ts: string;
  sessionId: string;
  model: string;
  /** Provider that served this turn's messages (e.g. "opencode-go"). Absent on pre-v24
   * rows. The route is part of the cost: the same model costs different amounts and
   * answers at different first-token latencies depending on where it enters. */
  provider?: string;
  turnIndex: number;
  llmDurationMs: number;
  ttftMs: number;
  input: number;
  output: number;
  /** Accumulated actual billed USD across the turn's messages; present only
   * when every message in the turn carried an actual. Else the table estimate. */
  costUsd?: number;
  /** Blended rate over the whole turn (includes pre-first-token latency). */
  tps: number;
  /** Decode rate: llmMessages output over the post-first-token window. */
  decodeTps?: number;
  /** turn_start -> first assistant message_start of this turn (ms): the provider
   * roundtrip window. Absent on pre-v23 rows. */
  preResponseMs?: number;
  streamed: boolean;
  approx: boolean;
  tools: TpsToolCall[];
  toolMsTotal: number;
  turnMsTotal: number;
  outcome: "completed" | "aborted" | "error";
  toolErrors: number;
  /** Tool calls the model requested (toolUse stops); may exceed completed tools. */
  requestedTools: number;
  /** Assistant messages folded into this turn's LLM slice. */
  llmMessages: number;
  /** Same human label as the sample rows (see above). */
  sessionName?: string;
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
    isOptionalNumber(v, "decodeTps") &&
    typeof v.approx === "boolean" &&
    isOptionalNumber(v, "ttftMs") &&
    (v.stalled === undefined || typeof v.stalled === "boolean") &&
    isOptionalNumber(v, "cacheRead") &&
    isOptionalNumber(v, "cacheWrite") &&
    isOptionalNumber(v, "reasoning") &&
    isOptionalNumber(v, "costUsd") &&
    (v.streamed === undefined || typeof v.streamed === "boolean") &&
    (v.status === undefined || v.status === "ok" || v.status === "failed") &&
    (v.stopReason === undefined || typeof v.stopReason === "string") &&
    (v.sessionId === undefined || typeof v.sessionId === "string") &&
    (v.sessionName === undefined || typeof v.sessionName === "string") &&
    (v.turnIndex === undefined || typeof v.turnIndex === "number")
  );
}

/** Decode rate: output over the post-first-token window. Falls back to the stored
 * field (new rows), else computes from tps-blended figures, else UNKNOWN (-1). */
export function decodeRateOf(v: {
  output: number;
  durationMs: number;
  ttftMs?: number;
  decodeTps?: number;
}): number {
  if (typeof v.decodeTps === "number" && v.decodeTps >= 0) return v.decodeTps;
  const ttft = typeof v.ttftMs === "number" ? v.ttftMs : UNKNOWN_TTFT;
  const window = v.durationMs - (ttft >= 0 ? ttft : 0);
  return window > 0 ? Math.round((v.output / (window / 1000)) * 10) / 10 : UNKNOWN_TTFT;
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
    decodeTps: decodeRateOf(v),
    stalled: v.stalled ?? false,
    cacheRead: v.cacheRead ?? 0,
    cacheWrite: v.cacheWrite ?? 0,
    ...(typeof v.reasoning === "number" ? { reasoning: v.reasoning } : {}),
    ...(typeof v.costUsd === "number" ? { costUsd: v.costUsd } : {}),
    ...(typeof v.sessionName === "string" ? { sessionName: v.sessionName } : {}),
    streamed,
    status: v.status === "failed" ? "failed" : "ok",
    stopReason: typeof v.stopReason === "string" ? v.stopReason : "",
    sessionId: typeof v.sessionId === "string" ? v.sessionId : "",
    ...(typeof v.turnIndex === "number" ? { turnIndex: v.turnIndex } : {}),
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
  if (typeof v.toolErrors !== "number") return false;
  if (typeof v.requestedTools !== "undefined" && typeof v.requestedTools !== "number") return false;
  if (typeof v.llmMessages !== "undefined" && typeof v.llmMessages !== "number") return false;
  if (typeof v.decodeTps !== "undefined" && typeof v.decodeTps !== "number") return false;
  if (typeof v.preResponseMs !== "undefined" && typeof v.preResponseMs !== "number") return false;
  if (typeof v.provider !== "undefined" && typeof v.provider !== "string") return false;
  if (typeof v.costUsd !== "undefined" && typeof v.costUsd !== "number") return false;
  if (typeof v.sessionName !== "undefined" && typeof v.sessionName !== "string") return false;
  return true;
}

function isTpsToolCall(v: unknown): v is TpsToolCall {
  if (!isRecord(v)) return false;
  if (typeof v.name !== "string" || typeof v.durationMs !== "number" || typeof v.isError !== "boolean") return false;
  if (v.endedAt !== undefined && typeof v.endedAt !== "number") return false;
  return v.detail === undefined || typeof v.detail === "string";
}

/** Pre-v15 rows lack requestedTools/llmMessages; backfill neutral defaults. */
export function normalizeTurn(v: unknown): TpsTurn | undefined {
  if (!isTpsTurn(v)) return undefined;
  const raw = v as unknown as { requestedTools?: unknown; llmMessages?: unknown; decodeTps?: unknown; preResponseMs?: unknown };
  const decodeTps =
    typeof raw.decodeTps === "number"
      ? raw.decodeTps
      : decodeRateOf({ output: v.output, durationMs: v.llmDurationMs, ttftMs: v.ttftMs });
  return {
    ...v,
    requestedTools: typeof raw.requestedTools === "number" ? raw.requestedTools : v.tools.length,
    llmMessages: typeof raw.llmMessages === "number" ? raw.llmMessages : 1,
    // Pre-v23 rows have no pre-response window; 0 renders as unknown ('–').
    preResponseMs: typeof raw.preResponseMs === "number" ? raw.preResponseMs : 0,
    ...(decodeTps >= 0 ? { decodeTps } : {}),
  };
}
