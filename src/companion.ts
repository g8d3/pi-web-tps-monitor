// Pi companion: measures tokens/sec per assistant message and persists it
// to the workspace (<cwd>/.pi-web/tps-live.json + tps-history.jsonl) where the
// PI WEB server peer (same package) can read it. Also provides /tps in chat.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decodeRateOf, isTpsLive, normalizeSample, normalizeTurn, UNKNOWN_TTFT, type TpsLive, type TpsSample, type TpsToolCall, type TpsTurn } from "./browser/protocol.js";
import { contextPressure, fleetStats, fmtCost, fmtPartialCost, fmtLimit, hasUnaccountedGap, modelInfo, sampleCostOf, sessionCostUsd, turnWaste, unaccountedMs, unpricedTag } from "./browser/models.js";

const HISTORY_FILE = ".pi-web/tps-history.jsonl";
const TURNS_FILE = ".pi-web/tps-turns.jsonl";
const LIVE_FILE = ".pi-web/tps-live.json";
const STATUS_KEY = "tps-monitor";
const CHARS_PER_TOKEN = 4;
const LIVE_THROTTLE_MS = 500;
const MAX_HISTORY = 500;
// Byte ceiling as well as a row ceiling: one turn with a large tool list must not
// make every later append expensive. Rotation reads the file once per rotation.
const MAX_HISTORY_BYTES = 2 * 1024 * 1024;

/** Mutable only so tests can shrink the stall window; leave at default in prod. */
export const tuning = { stallThresholdMs: 3000, minStreamMs: 50 };

/** Session spend cap in USD. Default mirrors needs.json `default_budget_usd`. */
export const DEFAULT_BUDGET_USD = 5;

interface ActiveMessage {
  startedAt: number;
  chars: number;
  deltas: number;
  model: string;
  lastWrite: number;
  firstTokenAt?: number;
  lastDeltaAt?: number;
  stalled: boolean;
}

const OK_STOPS = new Set(["stop", "length", "toolUse"]);

function sessionIdOf(ctx: { sessionManager?: { getSessionId?: () => string } }): string {
  try {
    // Call as a method: the real implementation reads `this.sessionId`.
    const sm = ctx.sessionManager;
    if (sm && typeof sm.getSessionId === "function") {
      const id = sm.getSessionId();
      if (id) return id;
    }
  } catch {
    // fall through to env fallback
  }
  try {
    return process.env.PI_SESSION_ID ?? "";
  } catch {
    return "";
  }
}

export function shortSession(id: string): string {
  return id ? id.slice(0, 8) : "–";
}

interface ActiveTurn {
  index: number;
  startedAt: number;
  /** turn_start -> first assistant message_start of this turn (provider roundtrip
   * window). Set once; undefined when the turn produced no assistant message. */
  preResponseMs?: number;
  tools: TpsToolCall[];
}

/** Per-turn LLM accumulation: every assistant message folds in, not just the last. */
interface TurnLlmAcc {
  messages: number;
  durationMs: number;
  ttftMs: number;
  input: number;
  output: number;
  /** Sum of recorded actuals; valid only when costMessages === messages. */
  cost: number;
  costMessages: number;
  streamed: boolean;
  approx: boolean;
  model: string;
  requested: number;
}

function freshAcc(): TurnLlmAcc {
  return { messages: 0, durationMs: 0, ttftMs: UNKNOWN_TTFT, input: 0, output: 0, cost: 0, costMessages: 0, streamed: false, approx: false, model: "unknown", requested: 0 };
}

/** Tool calls the model asked for: explicit call blocks (real shape: {type: "toolCall"}),
else the stop reason as evidence of at least one. */
function countRequestedTools(message: { stopReason?: string; content?: unknown }): number {
  const content = (message as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const blocks = content.filter(
      (b) => typeof b === "object" && b !== null && ((b as { type?: unknown }).type === "toolCall" || (b as { type?: unknown }).type === "toolUse"),
    );
    if (blocks.length > 0) return blocks.length;
  }
  return message.stopReason === "toolUse" ? 1 : 0;
}

export function readTurns(cwd: string, limit: number): TpsTurn[] {
  try {
    const lines = readFileSync(join(cwd, TURNS_FILE), "utf8").split("\n").filter(Boolean);
    const out: TpsTurn[] = [];
    for (const line of lines.slice(-Math.max(1, limit))) {
      try {
        const turn = normalizeTurn(JSON.parse(line) as unknown);
        if (turn) out.push(turn);
      } catch {
        // skip corrupt line
      }
    }
    return out;
  } catch {
    return [];
  }
}

// Per-file row/byte counts, seeded from disk once per process and updated on every
// append, so the file is re-read only when rotation is actually due.
const logState = new Map<string, { lines: number; bytes: number; seeded: boolean }>();

/** Keep the newest lines that fit both ceilings (at least one). */
export function trimLog(lines: string[], cap: number, byteCap: number): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(lines[i]) + 1;
    if (kept.length > 0 && (kept.length >= cap || bytes + size > byteCap)) break;
    kept.push(lines[i]);
    bytes += size;
  }
  return kept.reverse();
}

function stateOf(path: string): { lines: number; bytes: number; seeded: boolean } {
  let st = logState.get(path);
  if (!st) {
    st = { lines: 0, bytes: 0, seeded: false };
    logState.set(path, st);
  }
  if (!st.seeded) {
    try {
      const text = readFileSync(path, "utf8");
      st.lines = text.split("\n").filter(Boolean).length;
      st.bytes = Buffer.byteLength(text);
    } catch {
      // no file yet
    }
    st.seeded = true;
  }
  return st;
}

/** Append one JSONL row, rotating only when the row or byte ceiling is crossed. */
export function appendLine(path: string, row: unknown): void {
  const line = JSON.stringify(row) + "\n";
  appendFileSync(path, line);
  const st = stateOf(path);
  st.lines += 1;
  st.bytes += Buffer.byteLength(line);
  if (st.lines > MAX_HISTORY || st.bytes > MAX_HISTORY_BYTES) {
    const kept = trimLog(readFileSync(path, "utf8").split("\n").filter(Boolean), MAX_HISTORY, MAX_HISTORY_BYTES);
    const body = kept.join("\n") + "\n";
    writeFileSync(path, body);
    st.lines = kept.length;
    st.bytes = Buffer.byteLength(body);
  }
}

function appendTurn(cwd: string, turn: TpsTurn): void {
  try {
    ensureDir(cwd);
    appendLine(join(cwd, TURNS_FILE), turn);
  } catch {
    // ignore: turn history is best-effort
  }
}

function ensureDir(cwd: string): void {
  try {
    mkdirSync(join(cwd, ".pi-web"), { recursive: true });
  } catch {
    // read-only workspace: tracking silently degrades to in-memory only
  }
}

function writeLive(cwd: string, live: TpsLive): void {
  try {
    ensureDir(cwd);
    writeFileSync(join(cwd, LIVE_FILE), JSON.stringify(live));
  } catch {
    // ignore: live view is best-effort
  }
}

function appendSample(cwd: string, sample: TpsSample): void {
  try {
    ensureDir(cwd);
    appendLine(join(cwd, HISTORY_FILE), sample);
  } catch {
    // ignore: history is best-effort
  }
}

export function readHistory(cwd: string, limit: number): TpsSample[] {
  try {
    const lines = readFileSync(join(cwd, HISTORY_FILE), "utf8").split("\n").filter(Boolean);
    const out: TpsSample[] = [];
    for (const line of lines.slice(-Math.max(1, limit))) {
      try {
        const sample = normalizeSample(JSON.parse(line) as unknown);
        if (sample) out.push(sample);
      } catch {
        // skip corrupt line
      }
    }
    return out;
  } catch {
    return [];
  }
}

function fmtRate(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`;
}

function fmtMs(ms: number): string {
  if (ms < 0) return "–";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function cacheHit(s: TpsSample): string {
  const total = s.input + s.cacheRead;
  if (s.cacheRead <= 0 || total <= 0) return "–";
  return `${Math.round((s.cacheRead / total) * 100)}%`;
}

function shortModel(id: string): string {
  const base = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return base.length > 24 ? base.slice(0, 23) + "…" : base;
}

function rateable(samples: TpsSample[]): TpsSample[] {
  return samples.filter((s) => s.streamed && s.status === "ok");
}

interface FlatTool {
  ts: string;
  sessionId: string;
  turnIndex: number;
  name: string;
  durationMs: number;
  isError: boolean;
}

export function flattenTools(turns: TpsTurn[]): FlatTool[] {
  const out: FlatTool[] = [];
  for (const t of turns) {
    for (const c of t.tools) {
      out.push({ ts: t.ts, sessionId: t.sessionId, turnIndex: t.turnIndex, name: c.name, durationMs: c.durationMs, isError: c.isError });
    }
  }
  return out.sort((a, b) => b.durationMs - a.durationMs);
}

function renderFleet(history: TpsSample[], turns: TpsTurn[]): string {
  const stats = fleetStats(history, turns);
  if (!stats.length) return "No sessions yet in this workspace.";
  const rows = stats.map((f) => {
    const ctx = f.pressure === undefined ? "   –" : `${String(Math.round(f.pressure * 100)).padStart(3)}%${f.pressure >= 0.8 ? "!" : " "}`;
    const cost = fmtPartialCost(f.cost, f.msgs - f.unknownCost, f.unknownCost).padStart(9);
    const waste = f.wastedTurns === 0 ? "   –" : `${String(f.wastedTurns).padStart(2)}${f.wastedCost > 0 ? " " + fmtCost(f.wastedCost) : ""}`;
    return `${shortSession(f.sessionId).padEnd(8)}  msgs ${String(f.msgs).padStart(3)}  turns ${String(f.turns).padStart(3)} (${String(f.done).padStart(3)} done)  ${fmtRate(f.avgTps).padStart(5)} t/s  tools ${(f.toolMs / 1000).toFixed(0).padStart(5)}s  ${cost}  waste ${waste}  ctx ${ctx}`;
  });
  return "```\n" + rows.join("\n") + "\n```";
}

/** Actual billed USD from a message usage block (Pi's own registry pricing).
 * Defensive read: never throws, yields undefined when the provider reported
 * no cost (approx rows, older runtimes). */
function actualCostUsd(usage: unknown): number | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const cost = (usage as { cost?: unknown }).cost;
  if (typeof cost !== "object" || cost === null) return undefined;
  const total = (cost as { total?: unknown }).total;
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : undefined;
}

function renderCost(history: TpsSample[], turns: TpsTurn[]): string {
  if (!history.length && !turns.length) return "No samples yet.";
  const rated = history.filter((s) => s.streamed && s.status === "ok");
  const input = history.reduce((a, s) => a + s.input, 0);
  const output = history.reduce((a, s) => a + s.output, 0);
  const cached = history.reduce((a, s) => a + s.cacheRead, 0);
  let cost = 0;
  let priced = 0;
  let unpriced = 0;
  for (const s of history) {
    const c = sampleCostOf(s);
    if (c === undefined) unpriced += 1;
    else {
      cost += c;
      priced += 1;
    }
  }
  const done = turns.filter((t) => t.outcome === "completed").length;
  const waste = turnWaste(turns);
  const per = done > 0 && cost > 0 ? `  ≈ ${fmtCost(cost / done)}/completed turn` : "";
  // Waste is measured on turn rows, so its denominator is the turn-derived spend
  // (not the message-derived `cost` above); unpriced wasted turns only count as turns.
  const pct = waste.total > 0 ? Math.round((waste.cost / waste.total) * 100) : 0;
  const wasted = waste.cost > 0 ? `, ${waste.turns} wasted ≈ ${fmtCost(waste.cost)} (${pct}% of turn spend)` : waste.turns > 0 ? `, ${waste.turns} wasted` : "";
  const lines: string[] = [];
  // Turn rows can outlive the (rotated) sample history, so report whatever is left.
  if (history.length) {
    lines.push(`⚡ ${history.length} messages (${rated.length} rated), in ${input} / out ${output} / cached ${cached} tokens`);
    lines.push(`est ${fmtCost(cost)} across ${priced} of ${history.length} messages${unpriced > 0 ? ` (${unpricedTag(priced, unpriced)} — cost is a floor)` : ""}${per}`);
  }
  lines.push(`${turns.length} turns, ${done} completed${wasted}`);
  return lines.join("\n");
}

function renderTools(turns: TpsTurn[], limit: number): string {
  const calls = flattenTools(turns);
  if (!calls.length) return "No tool calls logged yet.";
  const rows = calls.slice(0, limit).map(
    (c) => `${c.ts.slice(11, 19)}  ${shortSession(c.sessionId).padEnd(8)}  #${String(c.turnIndex).padStart(3)}  ${c.name.padEnd(16)}  ${((c.durationMs / 1000).toFixed(1)).padStart(7)}s${c.isError ? "  FAIL" : ""}`,
  );
  const totals = new Map<string, { ms: number; n: number; fails: number }>();
  for (const c of calls) {
    const t = totals.get(c.name) ?? { ms: 0, n: 0, fails: 0 };
    t.ms += c.durationMs;
    t.n += 1;
    if (c.isError) t.fails += 1;
    totals.set(c.name, t);
  }
  const top = [...totals.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8);
  const foot = top.map(([name, t]) => `${name.padEnd(16)}  ${String(t.n).padStart(3)} calls  ${(t.ms / 1000).toFixed(1).padStart(7)}s total${t.fails ? `  ${t.fails} fails` : ""}`);
  return "```\n" + rows.join("\n") + "\n--- most expensive tools ---\n" + foot.join("\n") + "\n```";
}

function renderTurns(turns: TpsTurn[]): string {
  if (!turns.length) return "No turns yet. Turns are logged when each agent step finishes its tools.";
  // 0 = pre-v23 row or a turn with no assistant message; both read as unknown.
  const pre = (ms?: number) => (ms && ms > 0 ? fmtMs(ms) : "–");
  const rows = turns.map((t) => {
    const msgs = t.llmMessages > 1 ? ` (${t.llmMessages} msgs)` : "";
    const llm = t.streamed ? `${(t.llmDurationMs / 1000).toFixed(1)}s ${fmtRate(t.tps)}t/s ttft ${fmtMs(t.ttftMs)}${msgs}` : "– replay";
    const missing = t.requestedTools > t.tools.length ? ` (${t.tools.length}/${t.requestedTools} ran)` : "";
    const tools = t.tools.length
      ? `${t.tools.length} (${t.tools.slice(0, 3).map((c) => `${c.name}${c.isError ? "✗" : ""}`).join(",")}${t.tools.length > 3 ? `+${t.tools.length - 3}` : ""} ${(t.toolMsTotal / 1000).toFixed(1)}s)${missing}`
      : t.requestedTools > 0 ? `– (${t.requestedTools} requested, none ran)` : "–";
    const gap = hasUnaccountedGap(t) ? ` +${(unaccountedMs(t) / 1000).toFixed(1)}s?` : "";
    const mark = t.outcome !== "completed" ? ` ${t.outcome.toUpperCase()}` : "";
    return `${t.ts.slice(11, 19)} #${t.turnIndex} ${shortSession(t.sessionId)} ${shortModel(t.model).padEnd(18)} | pre ${pre(t.preResponseMs)} | llm ${llm} | tools ${tools} | turn ${(t.turnMsTotal / 1000).toFixed(1)}s${gap}${mark}`;
  });
  return "```\n" + rows.join("\n") + "\n```";
}

function renderTable(samples: TpsSample[]): string {
  if (!samples.length) return "No samples yet. Ask something so the model streams a reply.";
  const rows = samples.map((s) => {
    const time = s.ts.slice(11, 19);
    const secs = (s.durationMs / 1000).toFixed(1);
    const rate = s.streamed ? `${s.approx ? "~" : ""}${fmtRate(s.tps).padStart(5)} t/s` : "  – replay";
    const marks = `${s.status === "failed" ? " FAIL(" + s.stopReason + ")" : ""}${s.stalled ? " STALL" : ""}`;
    return `${time}  ${shortSession(s.sessionId).padEnd(8)}  ${shortModel(s.model).padEnd(20)}  out ${String(s.output).padStart(6)}  ${secs.padStart(5)}s  ${rate}  ttft ${fmtMs(s.ttftMs).padStart(6)}  hit ${cacheHit(s).padStart(3)}${marks}`;
  });
  return "```\n" + rows.join("\n") + "\n```";
}

function renderModels(samples: TpsSample[]): string {
  if (!samples.length) return "No samples yet.";
  const byModel = new Map<string, TpsSample[]>();
  for (const s of samples) {
    const list = byModel.get(s.model) ?? [];
    list.push(s);
    byModel.set(s.model, list);
  }
  const rows = [...byModel.entries()].map(([model, list]) => {
    const good = rateable(list);
    const out = good.reduce((a, s) => a + s.output, 0);
    const ms = good.reduce((a, s) => a + s.durationMs, 0);
    const avg = ms > 0 ? Math.round((out / (ms / 1000)) * 10) / 10 : 0;
    const ttfts = good.map((s) => s.ttftMs).filter((t) => t >= 0);
    const avgTtft = ttfts.length ? ttfts.reduce((a, t) => a + t, 0) / ttfts.length : UNKNOWN_TTFT;
    const fails = list.filter((s) => s.status === "failed").length;
    const sess = new Set(list.map((s) => s.sessionId).filter(Boolean)).size;
    return `${shortModel(model).padEnd(20)}  n ${String(list.length).padStart(3)}  sess ${String(sess).padStart(2)}  avg ${fmtRate(avg).padStart(5)} t/s  ttft ${fmtMs(avgTtft).padStart(6)}${fails ? `  fails ${fails}` : ""}`;
  });
  return "```\n" + rows.join("\n") + "\n```";
}

export default function tpsMonitor(pi: ExtensionAPI): void {
  let active: ActiveMessage | undefined;
  let turn: ActiveTurn | undefined;
  let acc: TurnLlmAcc = freshAcc();
  const pressureBand = new Map<string, number>();
  const budgets = new Map<string, number>();
  const budgetBand = new Map<string, number>();

  const budgetFor = (sessionId: string): number => budgets.get(sessionId) ?? DEFAULT_BUDGET_USD;

  function renderBudget(cwd: string, sessionId: string): string {
    const budget = budgetFor(sessionId);
    const { cost, priced, unpriced } = sessionCostUsd(readHistory(cwd, MAX_HISTORY), sessionId);
    const pct = budget > 0 ? Math.round((cost / budget) * 100) : 0;
    const spend = unpriced > 0 ? `${fmtCost(cost)}+` : fmtCost(cost);
    const note = unpriced > 0 ? ` (floor: ${unpricedTag(priced, unpriced)} unpriced, not counted)` : "";
    return `💰 session ${shortSession(sessionId)} spend ${spend} of ${fmtCost(budget)} budget (${pct}%)${note}`;
  }

  pi.on("session_start", () => {
    active = undefined;
    turn = undefined;
    acc = freshAcc();
    pressureBand.clear();
    budgets.clear();
    budgetBand.clear();
  });

  pi.on("session_shutdown", () => {
    active = undefined;
    turn = undefined;
    acc = freshAcc();
    pressureBand.clear();
    budgets.clear();
    budgetBand.clear();
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    // First assistant message of the turn: this is where the provider roundtrip
    // lands. Pi emits message_start *after* the provider responds, so the window
    // turn_start -> here is the tax llmDurationMs cannot see (it times the stream).
    if (turn && turn.preResponseMs === undefined) {
      turn.preResponseMs = Math.max(0, Date.now() - turn.startedAt);
    }
    active = {
      startedAt: Date.now(),
      chars: 0,
      deltas: 0,
      model: ctx.model?.id ?? "unknown",
      lastWrite: 0,
      stalled: false,
    };
    writeLive(ctx.cwd, {
      state: "streaming",
      model: active.model,
      chars: 0,
      elapsedMs: 0,
      approxTps: 0,
      updatedAt: new Date().toISOString(),
    });
  });

  pi.on("message_update", (event, ctx) => {
    if (!active || event.message.role !== "assistant") return;
    const e = event.assistantMessageEvent;
    if (e.type !== "text_delta" && e.type !== "thinking_delta") return;
    active.chars += e.delta.length;
    active.deltas += 1;
    const now = Date.now();
    if (active.firstTokenAt === undefined) active.firstTokenAt = now;
    if (active.lastDeltaAt !== undefined && now - active.lastDeltaAt > tuning.stallThresholdMs) {
      active.stalled = true;
    }
    active.lastDeltaAt = now;
    const ttftMs = active.firstTokenAt - active.startedAt;
    if (now - active.lastWrite < LIVE_THROTTLE_MS) return;
    active.lastWrite = now;
    const elapsedMs = Math.max(1, now - active.startedAt);
    const approxTps = Math.round(((active.chars / CHARS_PER_TOKEN) / (elapsedMs / 1000)) * 10) / 10;
    writeLive(ctx.cwd, {
      state: "streaming",
      model: active.model,
      chars: active.chars,
      elapsedMs,
      approxTps,
      updatedAt: new Date().toISOString(),
      ttftMs,
      stalled: active.stalled,
    });
    const stallMark = active.stalled ? " STALL" : "";
    ctx.ui.setStatus(STATUS_KEY, `⚡ ~${fmtRate(approxTps)} t/s${stallMark}`);
    pi.events.emit("tps:live", { chars: active.chars, elapsedMs, approxTps, ttftMs, stalled: active.stalled });
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const usage = event.message.usage;
    const chars = active?.chars ?? 0;
    // Without an observed start we cannot compute a rate; skip rather than log 0.
    if (!active) return;
    const finished = active;
    active = undefined;
    const output = usage?.output ?? Math.round(chars / CHARS_PER_TOKEN);
    const stopReason = event.message.stopReason;
    const failed = !OK_STOPS.has(stopReason);
    // Silent no-op messages carry no signal; failed ones are always recorded.
    if (output <= 0 && !failed) {
      writeLive(ctx.cwd, {
        state: "idle",
        model: finished.model,
        chars: 0,
        elapsedMs: 0,
        approxTps: 0,
        updatedAt: new Date().toISOString(),
      });
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const durationMs = Math.max(1, Date.now() - finished.startedAt);
    // A rate needs a window that actually covers the provider call. Pi's
    // message_start sometimes fires at the first streamed chunk instead of when
    // the request is dispatched, which collapses the window to ~0 ms and turns a
    // 3-token reply into a fabricated 1000 t/s. Below the floor the window is not
    // a measurement, so the row is recorded as unrated (`–`, excluded from
    // averages) rather than as a rate.
    const streamed = finished.deltas > 0 && output > 0 && durationMs >= tuning.minStreamMs;
    const tps = streamed ? Math.round((output / (durationMs / 1000)) * 10) / 10 : 0;
    const ttftMs = streamed && finished.firstTokenAt !== undefined ? finished.firstTokenAt - finished.startedAt : UNKNOWN_TTFT;
    // Decode rate: generation speed over the window after the first token landed,
    // so a slow provider (long TTFT) is not scored as a slow decoder.
    const decodeTps = streamed ? decodeRateOf({ output, durationMs, ttftMs }) : UNKNOWN_TTFT;
    // The billed number for this message. On rows that carry it every cost
    // surface below is an actual, not an estimate; older rows without it
    // fall back to the table in models.ts.
    const actual = actualCostUsd(usage);
    const sample: TpsSample = {
      ts: new Date().toISOString(),
      model: ctx.model?.id ?? finished.model,
      input: usage?.input ?? 0,
      output,
      durationMs,
      tps,
      ...(decodeTps >= 0 ? { decodeTps } : {}),
      approx: usage == null,
      ttftMs,
      stalled: finished.stalled,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      ...(typeof usage?.reasoning === "number" ? { reasoning: usage.reasoning } : {}),
      ...(actual !== undefined ? { costUsd: actual } : {}),
      streamed,
      status: failed ? "failed" : "ok",
      stopReason,
      sessionId: sessionIdOf(ctx),
    };
    appendSample(ctx.cwd, sample);
    // Session budget guardrail: history-backed so it survives restarts.
    // Unpriced models (undefined cost) never trip it.
    const guard = sessionCostUsd(readHistory(ctx.cwd, MAX_HISTORY), sample.sessionId);
    const total = guard.cost;
    const cap = budgetFor(sample.sessionId);
    // The guardrail is a floor when some messages are unpriced; say so once a
    // session is actually mixed, so "spent" is never read as a complete figure.
    const floorNote = guard.unpriced > 0 ? `, floor: ${Math.round((guard.unpriced / (guard.priced + guard.unpriced)) * 100)}% unpriced and not counted` : "";
    const frac = cap > 0 ? total / cap : 0;
    const band = frac >= 1 ? 1 : frac >= 0.8 ? 0.8 : 0;
    const prevBand = budgetBand.get(sample.sessionId) ?? 0;
    if (band > prevBand) {
      budgetBand.set(sample.sessionId, band);
      ctx.ui.notify(
        band >= 1
          ? `💰 Session spend ${fmtCost(total)}${floorNote} hit 100% of the ${fmtCost(cap)} budget (${shortModel(sample.model)}) — further replies keep billing. Raise it with /tps budget <usd>.`
          : `💰 Session spend ${fmtCost(total)}${floorNote} passed 80% of the ${fmtCost(cap)} budget (${shortModel(sample.model)}) — consider /tps budget <usd> or wrapping up.`,
        "warning",
      );
    }
    const pressure = contextPressure(sample.model, sample.input, sample.cacheRead);
    if (pressure !== undefined) {
      const band = pressure >= 0.95 ? 0.95 : pressure >= 0.8 ? 0.8 : 0;
      const prev = pressureBand.get(sample.sessionId) ?? 0;
      if (band > prev) {
        const limit = modelInfo(sample.model)?.contextLimit ?? 0;
        ctx.ui.notify(
          `⚠ Context at ${Math.round(pressure * 100)}% of the ~${fmtLimit(limit)} window (${shortModel(sample.model)}) — compact or hand off soon.`,
          "warning",
        );
      }
      pressureBand.set(sample.sessionId, band);
    }
    writeLive(ctx.cwd, {
      state: "idle",
      model: sample.model,
      chars: 0,
      elapsedMs: 0,
      approxTps: 0,
      updatedAt: new Date().toISOString(),
      last: sample,
    });
    ctx.ui.setStatus(STATUS_KEY, failed ? `⚠ ${stopReason}` : `⚡ ${fmtRate(tps)} t/s`);
    pi.events.emit("tps:sample", sample);
    if (turn !== undefined) {
      acc.messages += 1;
      acc.durationMs += sample.durationMs;
      acc.input += sample.input;
      acc.output += sample.output;
      if (actual !== undefined) {
        acc.cost += actual;
        acc.costMessages += 1;
      }
      acc.streamed = acc.streamed || sample.streamed;
      acc.approx = acc.approx || sample.approx;
      if (acc.ttftMs === UNKNOWN_TTFT && sample.ttftMs >= 0) acc.ttftMs = sample.ttftMs;
      acc.model = sample.model;
      acc.requested += countRequestedTools(event.message);
    }
  });

  pi.on("turn_start", (event) => {
    turn = { index: event.turnIndex, startedAt: event.timestamp ?? Date.now(), tools: [] };
    acc = freshAcc();
  });

  pi.on("tool_execution_end", (event) => {
    if (!turn) return;
    turn.tools.push({
      name: event.toolName,
      durationMs: event.durationMs ?? 0,
      isError: event.isError,
      endedAt: Date.now(),
    });
  });

  pi.on("turn_end", (event, ctx) => {
    const now = Date.now();
    const startedAt = turn?.startedAt ?? now;
    const tools = turn?.tools ?? [];
    const toolMsTotal = tools.reduce((a, t) => a + t.durationMs, 0);
    const tps = acc.streamed && acc.durationMs > 0 ? Math.round((acc.output / (acc.durationMs / 1000)) * 10) / 10 : 0;
    const decodeTps = acc.streamed ? decodeRateOf({ output: acc.output, durationMs: acc.durationMs, ttftMs: acc.ttftMs }) : UNKNOWN_TTFT;
    const row: TpsTurn = {
      ts: new Date().toISOString(),
      sessionId: sessionIdOf(ctx),
      model: acc.messages > 0 ? acc.model : (ctx.model?.id ?? "unknown"),
      turnIndex: turn?.index ?? event.turnIndex,
      llmDurationMs: acc.durationMs,
      ...(turn?.preResponseMs !== undefined ? { preResponseMs: turn.preResponseMs } : {}),
      ttftMs: acc.ttftMs,
      input: acc.input,
      output: acc.output,
      // Whole-turn actual only when every message carried one; a partial sum
      // would pose as a total, so mixed turns fall back to the table estimate.
      ...(acc.messages > 0 && acc.costMessages === acc.messages ? { costUsd: acc.cost } : {}),
      tps,
      ...(decodeTps >= 0 ? { decodeTps } : {}),
      streamed: acc.streamed,
      approx: acc.approx,
      tools,
      toolMsTotal,
      turnMsTotal: Math.max(1, now - startedAt),
      outcome: event.outcome,
      toolErrors: tools.filter((t) => t.isError).length,
      requestedTools: acc.requested,
      llmMessages: acc.messages,
    };
    appendTurn(ctx.cwd, row);
    pi.events.emit("tps:turn", row);
    turn = undefined;
    acc = freshAcc();
  });

  pi.registerCommand("tps", {
    description: "Show tokens/sec: /tps [n] recent, /tps live, /tps totals, /tps models, /tps turns [n], /tps tools [n], /tps fleet, /tps cost, /tps budget [usd]",
    handler: async (args, ctx: ExtensionContext) => {
      const [sub, rawN] = args.trim().split(/\s+/);
      if (sub === "budget") {
        const sid = sessionIdOf(ctx);
        if (rawN === undefined || rawN === "") {
          ctx.ui.notify(renderBudget(ctx.cwd, sid), "info");
          return;
        }
        const usd = parseFloat(rawN);
        if (!Number.isFinite(usd) || usd <= 0) {
          ctx.ui.notify(`Usage: /tps budget [usd] — positive number, e.g. /tps budget 5. ${renderBudget(ctx.cwd, sid)}`, "info");
          return;
        }
        budgets.set(sid, usd);
        // Sync the warned band so lowering the cap under current spend reports
        // the overage once in the confirmation instead of nagging every message.
        const frac = sessionCostUsd(readHistory(ctx.cwd, MAX_HISTORY), sid).cost / usd;
        budgetBand.set(sid, frac >= 1 ? 1 : frac >= 0.8 ? 0.8 : 0);
        ctx.ui.notify(`💰 session budget set to ${fmtCost(usd)}. ${renderBudget(ctx.cwd, sid)}`, "info");
        return;
      }
      if (sub === "tools") {
        const n = Math.min(100, Math.max(1, parseInt(rawN ?? "10", 10) || 10));
        ctx.ui.notify(renderTools(readTurns(ctx.cwd, MAX_HISTORY), n), "info");
        return;
      }
      if (sub === "fleet") {
      ctx.ui.notify(renderFleet(readHistory(ctx.cwd, MAX_HISTORY), readTurns(ctx.cwd, MAX_HISTORY)), "info");
      return;
    }
    if (sub === "cost") {
      ctx.ui.notify(renderCost(readHistory(ctx.cwd, MAX_HISTORY), readTurns(ctx.cwd, MAX_HISTORY)), "info");
      return;
    }
    if (sub === "turns") {
        const n = Math.min(100, Math.max(1, parseInt(rawN ?? "10", 10) || 10));
        ctx.ui.notify(renderTurns(readTurns(ctx.cwd, n)), "info");
        return;
      }
      if (sub === "live") {
        let live: TpsLive | undefined;
        try {
          const parsed: unknown = JSON.parse(readFileSync(join(ctx.cwd, LIVE_FILE), "utf8"));
          if (isTpsLive(parsed)) live = parsed;
        } catch {
          live = undefined;
        }
        if (!live || live.state !== "streaming") {
          ctx.ui.notify("No message streaming right now.", "info");
          return;
        }
        const secs = (live.elapsedMs / 1000).toFixed(1);
        const ttft = live.ttftMs !== undefined && live.ttftMs >= 0 ? `, ttft ${fmtMs(live.ttftMs)}` : "";
        const stallMark = live.stalled ? " STALL" : "";
        ctx.ui.notify(`⚡ ~${fmtRate(live.approxTps)} t/s — ${shortModel(live.model ?? "?")} (${secs}s, ~${Math.round(live.chars / CHARS_PER_TOKEN)} tok${ttft})${stallMark}`, "info");
        return;
      }
      if (sub === "models") {
        ctx.ui.notify(renderModels(readHistory(ctx.cwd, MAX_HISTORY)), "info");
        return;
      }
      const limit = sub === "totals" ? MAX_HISTORY : Math.min(100, Math.max(1, parseInt(rawN ?? sub ?? "10", 10) || 10));
      const samples = readHistory(ctx.cwd, limit);
      if (sub === "totals") {
        const good = rateable(samples);
        const out = good.reduce((a, s) => a + s.output, 0);
        const ms = good.reduce((a, s) => a + s.durationMs, 0);
        const avg = ms > 0 ? Math.round((out / (ms / 1000)) * 10) / 10 : 0;
        const ttfts = good.map((s) => s.ttftMs).filter((t) => t >= 0);
        const avgTtft = ttfts.length ? ttfts.reduce((a, t) => a + t, 0) / ttfts.length : UNKNOWN_TTFT;
        const fails = samples.filter((s) => s.status === "failed").length;
        const skipped = samples.length - good.length - fails;
        ctx.ui.notify(
          `⚡ ${good.length} rated messages, ${out} out tokens, avg ${fmtRate(avg)} t/s, ttft ${fmtMs(avgTtft)}${fails ? `, ${fails} failed` : ""}${skipped ? `, ${skipped} replayed` : ""}`,
          "info",
        );
        return;
      }
      ctx.ui.notify(renderTable(samples.slice(-10)), "info");
    },
  });
}
