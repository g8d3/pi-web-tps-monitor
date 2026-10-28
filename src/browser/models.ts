// Reference data for well-known model families: context windows and list prices.
// Context windows and prices track the pi-ai provider registry bundled with Pi
// (node_modules/@earendil-works/pi-ai/dist/providers/data/*.json) — the same
// registry Pi's own calculateCost() bills from, so table estimates stay close to
// actuals on rows recorded before actuals existed. Since the companion records
// usage.cost.total per message, new rows don't need this table at all; it is
// only the fallback for old rows and the ctx denominator. Unknown models yield
// undefined everywhere so the UI shows "–" instead of inventing numbers.
// Dependency-free: imported by companion, browser and tests.

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
  { match: ["deepseek-v4.1-flash"], label: "DeepSeek V4.1 Flash", contextLimit: 1_000_000, inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.003 },
  { match: ["deepseek-v4-pro", "deepseek-v4"], label: "DeepSeek V4", contextLimit: 1_000_000, inputPerMTok: 0.66, outputPerMTok: 1.98, cacheReadPerMTok: 0.022 },
  { match: ["deepseek"], label: "DeepSeek", contextLimit: 1_000_000 },
  { match: ["muse-spark"], label: "Muse Spark", contextLimit: 1_048_576, inputPerMTok: 0.1, outputPerMTok: 0.2, cacheReadPerMTok: 0.002 },
  { match: ["glm-5.3-flash"], label: "GLM Flash", contextLimit: 1_000_000, inputPerMTok: 0.15, outputPerMTok: 0.5, cacheReadPerMTok: 0.03 },
  { match: ["glm-5"], label: "GLM", contextLimit: 1_000_000, inputPerMTok: 1.4, outputPerMTok: 4.4, cacheReadPerMTok: 0.26 },
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

/** Billed USD for one message: the recorded actual when present (Pi's own
 * usage cost, i.e. provider registry pricing), else the table estimate.
 * Undefined only when neither exists — those rows are the `+` floor. */
export function sampleCostOf(s: Pick<TpsSample, "model" | "input" | "output" | "cacheRead"> & { costUsd?: number }): number | undefined {
  if (typeof s.costUsd === "number" && Number.isFinite(s.costUsd)) return s.costUsd;
  return sampleCostUsd(s.model, s.input, s.output, s.cacheRead);
}

/** Accumulated priced spend for one session; unpriced messages counted separately. */
export function sessionCostUsd(samples: TpsSample[], sessionId: string): { cost: number; priced: number; unpriced: number } {
  let cost = 0;
  let priced = 0;
  let unpriced = 0;
  for (const s of samples) {
    if (s.sessionId !== sessionId) continue;
    const c = sampleCostOf(s);
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

/** Priced cost of one turn's LLM slice: recorded actuals when the turn carried
 * them, else the table estimate (no cache-read split at turn level). */
export function turnCostUsd(t: Pick<TpsTurn, "model" | "input" | "output"> & { costUsd?: number }): number | undefined {
  if (typeof t.costUsd === "number" && Number.isFinite(t.costUsd)) return t.costUsd;
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

export interface PerModelCost {
  model: string;
  msgs: number;
  cost: number;
  priced: number;
  unpriced: number;
}

/** Priced spend split by model for one session, priced messages first. */
export function perModelCost(history: TpsSample[], sessionId: string): PerModelCost[] {
  const byModel = new Map<string, PerModelCost>();
  for (const s of history) {
    if (s.sessionId !== sessionId) continue;
    const e = byModel.get(s.model) ?? { model: s.model, msgs: 0, cost: 0, priced: 0, unpriced: 0 };
    e.msgs += 1;
    const c = sampleCostOf(s);
    if (c === undefined) e.unpriced += 1;
    else {
      e.cost += c;
      e.priced += 1;
    }
    byModel.set(s.model, e);
  }
  return [...byModel.values()].sort((a, b) => b.cost - a.cost);
}

/** Human duration: `85ms` under a second, `4.3s` above. Tool tables use this
 * everywhere so sub-second calls stop reading as `0.0`. */
export function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "–";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export interface SessionStat {
  sessionId: string;
  /** Human label: Pi's session name when set, else the first-prompt slug,
   * taken from the latest row that carried one. Undefined when neither
   * existed — views fall back to the 8-hex id. */
  name?: string;
  latestTs: string;
  /** First activity in this session (wall-clock span = latestTs − earliestTs). */
  earliestTs: string;
  /** Sum of turn LLM-slice seconds across this session (working time). */
  llmMs: number;
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
  /** Turn-derived spend for this session (actuals when recorded, else table
   * estimate; may differ from message-derived cost). */
  turnCost: number;
  toolMs: number;
  /** USD from priced messages (recorded actuals first, table fallback);
   * unknowns counted separately. */
  cost: number;
  unknownCost: number;
  /** Fraction of this session's messages with neither an actual nor a list
   * price (0..1). When > 0 the `cost` above is a PARTIAL total, and every
   * surface must say so rather than presenting it as the session's whole spend. */
  unpricedShare: number;
  pressure?: number;
}

export function shortSessionId(id: string): string {
  return id ? id.slice(0, 8) : "–";
}

/** Display label for a session: the recorded human name when present, else the
 * 8-hex id. Every view (panel tables, /tps fleet, budget line) goes through
 * this so a named session never shows as a hash. */
export function sessionLabel(sessionId: string, name?: string): string {
  return typeof name === "string" && name.length > 0 ? name : shortSessionId(sessionId);
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
      const c = sampleCostOf(s);
      if (c === undefined) unknownCost += 1;
      else cost += c;
    }
    const allTs = [...samples.map((s) => s.ts), ...ts.map((t) => t.ts)].sort();
    const latest = allTs.at(-1) ?? "";
    const earliest = allTs.at(0) ?? "";
    const llmMs = ts.reduce((a, t) => a + t.llmDurationMs, 0);
    const newest = [...samples].sort((a, b) => a.ts.localeCompare(b.ts)).at(-1);
    // Latest human label wins: names can be set mid-session, so the newest
    // row carrying one is what the user most recently called it.
    const named = [...ts.map((t) => ({ ts: t.ts, name: t.sessionName })), ...samples.map((s) => ({ ts: s.ts, name: s.sessionName }))]
      .filter((r) => typeof r.name === "string" && r.name.length > 0)
      .sort((a, b) => a.ts.localeCompare(b.ts)).at(-1)?.name;
    const waste = turnWaste(ts);
    out.push({
      sessionId,
      ...(named !== undefined ? { name: named } : {}),
      latestTs: latest,
      earliestTs: earliest,
      llmMs,
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
