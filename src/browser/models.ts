// Reference data for well-known model families: context windows and list prices.
// Indicative public pricing in USD per 1M tokens; reviewed when providers move.
// Unknown models yield undefined everywhere so the UI shows "–" instead of
// inventing numbers. Dependency-free: imported by companion, browser and tests.

import type { TpsSample, TpsTurn } from "./protocol.js";

export interface ModelInfo {
  /** Substrings matched against the lowercase model id; first hit wins. */
  match: string[];
  label: string;
  /** Context window in tokens. */
  contextLimit: number;
  /** USD per 1M tokens; absent when the price is unknown (subscription, BYOK…). */
  inputPerMTok?: number;
  outputPerMTok?: number;
  cacheReadPerMTok?: number;
}

export const KNOWN_MODELS: ModelInfo[] = [
  { match: ["opus-4", "claude-opus"], label: "Claude Opus 4", contextLimit: 200_000, inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5 },
  { match: ["sonnet-4", "sonnet-3.7", "sonnet-3-7", "sonnet-3.5", "sonnet-3-5", "claude-sonnet"], label: "Claude Sonnet", contextLimit: 200_000, inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
  { match: ["haiku-4", "haiku-3.5", "haiku-3-5", "claude-haiku"], label: "Claude Haiku", contextLimit: 200_000, inputPerMTok: 0.8, outputPerMTok: 4, cacheReadPerMTok: 0.08 },
  { match: ["gpt-5"], label: "GPT-5", contextLimit: 400_000, inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125 },
  { match: ["gpt-4o", "gpt-4"], label: "GPT-4o", contextLimit: 128_000, inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 1.25 },
  { match: ["o3", "o4"], label: "OpenAI reasoning", contextLimit: 200_000, inputPerMTok: 10, outputPerMTok: 40, cacheReadPerMTok: 2.5 },
  { match: ["gemini-2.5-pro", "gemini-3-pro", "gemini-pro"], label: "Gemini Pro", contextLimit: 1_000_000, inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.31 },
  { match: ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash"], label: "Gemini Flash", contextLimit: 1_000_000, inputPerMTok: 0.3, outputPerMTok: 2.5, cacheReadPerMTok: 0.075 },
  { match: ["grok-4", "grok-3", "grok"], label: "Grok", contextLimit: 256_000, inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.75 },
  { match: ["deepseek"], label: "DeepSeek", contextLimit: 128_000, inputPerMTok: 0.27, outputPerMTok: 1.1, cacheReadPerMTok: 0.07 },
  { match: ["qwen3", "qwen-3", "qwen-max", "qwen-plus", "qwen"], label: "Qwen", contextLimit: 256_000 },
  { match: ["glm-4"], label: "GLM", contextLimit: 128_000 },
];

export function modelInfo(id: string): ModelInfo | undefined {
  const low = id.toLowerCase();
  return KNOWN_MODELS.find((m) => m.match.some((s) => low.includes(s)));
}

/** Share of the context window used by the latest message; undefined when unknown. */
export function contextPressure(model: string, input: number, cacheRead: number): number | undefined {
  const info = modelInfo(model);
  if (!info || info.contextLimit <= 0) return undefined;
  return (input + cacheRead) / info.contextLimit;
}

/** Estimated USD for one measured message; undefined when unpriced. */
export function sampleCostUsd(model: string, input: number, output: number, cacheRead: number): number | undefined {
  const info = modelInfo(model);
  if (!info || info.inputPerMTok === undefined || info.outputPerMTok === undefined) return undefined;
  const cache = info.cacheReadPerMTok === undefined ? 0 : (cacheRead / 1_000_000) * info.cacheReadPerMTok;
  return (input / 1_000_000) * info.inputPerMTok + (output / 1_000_000) * info.outputPerMTok + cache;
}

/** Accumulated priced spend for one session; unpriced messages counted separately. */
export function sessionCostUsd(samples: TpsSample[], sessionId: string): { cost: number; priced: number; unpriced: number } {
  let cost = 0;
  let priced = 0;
  let unpriced = 0;
  for (const s of samples) {
    if (s.sessionId !== sessionId) continue;
    const c = sampleCostUsd(s.model, s.input, s.output, s.cacheRead);
    if (c === undefined) unpriced += 1;
    else {
      cost += c;
      priced += 1;
    }
  }
  return { cost, priced, unpriced };
}

export function fmtCost(usd: number): string {
  return `$${usd.toFixed(usd < 0.1 ? 4 : 2)}`;
}

/** Render a spend figure, flagging it as a PARTIAL total when some of the messages
 * behind it had no list price. A cost with unpriced messages in it is a floor, not
 * the session's spend, so every surface must say `+` instead of implying completeness.
 * All-or-nothing (everything unpriced) renders as unknown, never as a number. */
export function fmtPartialCost(usd: number, priced: number, unpriced: number): string {
  if (priced <= 0) return "–";
  return unpriced > 0 ? `${fmtCost(usd)}+` : fmtCost(usd);
}

/** Share of messages with no list price, as a `NN% unpriced` tag; empty when fully priced. */
export function unpricedTag(priced: number, unpriced: number): string {
  const total = priced + unpriced;
  if (unpriced <= 0 || total <= 0) return "";
  return `${Math.round((unpriced / total) * 100)}% unpriced`;
}

export function fmtLimit(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return `${tokens}`;
}

/** Wall-clock in a turn that is neither measured LLM, measured tools, nor the
 * measured pre-token window (v23+ preResponseMs: turn_start -> first message_start,
 * which is the provider roundtrip pi never attributes to llmDurationMs — N3
 * subsession showed this window IS the bulk of what older rows called
 * "unaccounted"). On pre-v23 rows the window is absent, so behavior is unchanged. */
export const UNACCOUNTED_MIN_MS = 2000;
export const UNACCOUNTED_MIN_FRAC = 0.3;

export function unaccountedMs(turn: { turnMsTotal: number; llmDurationMs: number; toolMsTotal: number; preResponseMs?: number }): number {
  return Math.max(0, turn.turnMsTotal - turn.llmDurationMs - turn.toolMsTotal - (turn.preResponseMs ?? 0));
}

/** True when the gap is big enough in both absolute and relative terms to flag. */
export function hasUnaccountedGap(turn: { turnMsTotal: number; llmDurationMs: number; toolMsTotal: number; preResponseMs?: number }): boolean {
  const u = unaccountedMs(turn);
  return u > UNACCOUNTED_MIN_MS && u > turn.turnMsTotal * UNACCOUNTED_MIN_FRAC;
}

/** A turn that burned tokens without producing usable output: failed, aborted or empty. */
export function isWastedTurn(t: Pick<TpsTurn, "outcome" | "output">): boolean {
  return t.outcome !== "completed" || t.output === 0;
}

/** Priced cost estimate of one turn's LLM slice (no cache-read split at turn level). */
export function turnCostUsd(t: Pick<TpsTurn, "model" | "input" | "output">): number | undefined {
  return sampleCostUsd(t.model, t.input, t.output, 0);
}

export interface TurnWaste {
  /** Wasted turn count. */
  turns: number;
  /** Estimated USD burned on wasted turns; turns with unknown prices are excluded. */
  cost: number;
  /** Wasted turns whose model has no list price. */
  unpriced: number;
  /** Estimated USD across every priced turn, wasted or not (the denominator). */
  total: number;
}

/** Waste rollup for one session's turns, all numbers from the same turn rows. */
export function turnWaste(turns: TpsTurn[]): TurnWaste {
  const out: TurnWaste = { turns: 0, cost: 0, unpriced: 0, total: 0 };
  for (const t of turns) {
    const wasted = isWastedTurn(t);
    if (wasted) out.turns += 1;
    const c = turnCostUsd(t);
    if (c === undefined) {
      if (wasted) out.unpriced += 1;
      continue;
    }
    out.total += c;
    if (wasted) out.cost += c;
  }
  return out;
}

export interface SessionStat {
  sessionId: string;
  latestTs: string;
  msgs: number;
  avgTps: number;
  turns: number;
  done: number;
  failedTurns: number;
  /** Turns that burned tokens without usable output (failed, aborted, empty). */
  wastedTurns: number;
  /** Estimated USD burned on those turns; unpriced wasted turns counted apart. */
  wastedCost: number;
  wastedUnpriced: number;
  /** Turn-derived spend estimate for this session (may differ from message-derived cost). */
  turnCost: number;
  toolMs: number;
  /** Estimated USD from priced messages; unknowns counted separately. */
  cost: number;
  unknownCost: number;
  /** Fraction of this session's messages with no list price (0..1). When > 0 the
   * `cost` above is a PARTIAL total, and every surface must say so rather than
   * presenting it as the session's whole spend. */
  unpricedShare: number;
  pressure?: number;
}

/** Per-session rollup across one workspace, newest activity first. */
export function fleetStats(history: TpsSample[], turns: TpsTurn[]): SessionStat[] {
  const bySession = new Map<string, { samples: TpsSample[]; turns: TpsTurn[] }>();
  for (const s of history) {
    const e = bySession.get(s.sessionId) ?? { samples: [], turns: [] };
    e.samples.push(s);
    bySession.set(s.sessionId, e);
  }
  for (const t of turns) {
    const e = bySession.get(t.sessionId) ?? { samples: [], turns: [] };
    e.turns.push(t);
    bySession.set(t.sessionId, e);
  }
  const out: SessionStat[] = [];
  for (const [sessionId, { samples, turns: ts }] of bySession) {
    const rated = samples.filter((s) => s.streamed && s.status === "ok");
    const outTok = rated.reduce((a, s) => a + s.output, 0);
    const ms = rated.reduce((a, s) => a + s.durationMs, 0);
    let cost = 0;
    let unknownCost = 0;
    for (const s of samples) {
      const c = sampleCostUsd(s.model, s.input, s.output, s.cacheRead);
      if (c === undefined) unknownCost += 1;
      else cost += c;
    }
    const latest = [...samples.map((s) => s.ts), ...ts.map((t) => t.ts)].sort().at(-1) ?? "";
    const newest = [...samples].sort((a, b) => a.ts.localeCompare(b.ts)).at(-1);
    const waste = turnWaste(ts);
    out.push({
      sessionId,
      latestTs: latest,
      msgs: samples.length,
      avgTps: ms > 0 ? Math.round((outTok / (ms / 1000)) * 10) / 10 : 0,
      turns: ts.length,
      done: ts.filter((t) => t.outcome === "completed").length,
      failedTurns: ts.filter((t) => t.outcome !== "completed").length,
      wastedTurns: waste.turns,
      wastedCost: waste.cost,
      wastedUnpriced: waste.unpriced,
      turnCost: waste.total,
      toolMs: ts.reduce((a, t) => a + t.toolMsTotal, 0),
      cost,
      unknownCost,
      unpricedShare: samples.length > 0 ? unknownCost / samples.length : 0,
      pressure: newest ? contextPressure(newest.model, newest.input, newest.cacheRead) : undefined,
    });
  }
  return out.sort((a, b) => b.latestTs.localeCompare(a.latestTs));
}
