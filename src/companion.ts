// Pi companion: measures tokens/sec per assistant message and persists it
// to the workspace (<cwd>/.pi-web/tps-live.json + tps-history.jsonl) where the
// PI WEB server peer (same package) can read it. Also provides /tps in chat.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isTpsLive, normalizeSample, normalizeTurn, UNKNOWN_TTFT, type TpsLive, type TpsSample, type TpsToolCall, type TpsTurn } from "./browser/protocol.js";
import { contextPressure, fleetStats, fmtCost, fmtLimit, modelInfo, sampleCostUsd } from "./browser/models.js";

const HISTORY_FILE = ".pi-web/tps-history.jsonl";
const TURNS_FILE = ".pi-web/tps-turns.jsonl";
const LIVE_FILE = ".pi-web/tps-live.json";
const STATUS_KEY = "tps-monitor";
const CHARS_PER_TOKEN = 4;
const LIVE_THROTTLE_MS = 500;
const MAX_HISTORY = 500;

/** Mutable only so tests can shrink the stall window; leave at default in prod. */
export const tuning = { stallThresholdMs: 3000 };

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
  tools: TpsToolCall[];
}

interface LastLlm {
  durationMs: number;
  ttftMs: number;
  input: number;
  output: number;
  tps: number;
  streamed: boolean;
  approx: boolean;
  model: string;
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

function appendTurn(cwd: string, turn: TpsTurn): void {
  try {
    ensureDir(cwd);
    const path = join(cwd, TURNS_FILE);
    appendFileSync(path, JSON.stringify(turn) + "\n");
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    if (lines.length > MAX_HISTORY) {
      writeFileSync(path, lines.slice(-MAX_HISTORY).join("\n") + "\n");
    }
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
    const path = join(cwd, HISTORY_FILE);
    appendFileSync(path, JSON.stringify(sample) + "\n");
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    if (lines.length > MAX_HISTORY) {
      writeFileSync(path, lines.slice(-MAX_HISTORY).join("\n") + "\n");
    }
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
    const cost = f.unknownCost >= f.msgs ? "       –" : fmtCost(f.cost).padStart(8);
    return `${shortSession(f.sessionId).padEnd(8)}  msgs ${String(f.msgs).padStart(3)}  turns ${String(f.turns).padStart(3)} (${String(f.done).padStart(3)} done)  ${fmtRate(f.avgTps).padStart(5)} t/s  tools ${(f.toolMs / 1000).toFixed(0).padStart(5)}s  ${cost}  ctx ${ctx}`;
  });
  return "```\n" + rows.join("\n") + "\n```";
}

function renderCost(history: TpsSample[], turns: TpsTurn[]): string {
  if (!history.length) return "No samples yet.";
  const rated = history.filter((s) => s.streamed && s.status === "ok");
  const input = history.reduce((a, s) => a + s.input, 0);
  const output = history.reduce((a, s) => a + s.output, 0);
  const cached = history.reduce((a, s) => a + s.cacheRead, 0);
  let cost = 0;
  let priced = 0;
  for (const s of history) {
    const c = sampleCostUsd(s.model, s.input, s.output, s.cacheRead);
    if (c === undefined) continue;
    cost += c;
    priced += 1;
  }
  const done = turns.filter((t) => t.outcome === "completed").length;
  const per = done > 0 && cost > 0 ? `  ≈ ${fmtCost(cost / done)}/completed turn` : "";
  return `⚡ ${history.length} messages (${rated.length} rated), in ${input} / out ${output} / cached ${cached} tokens\nest ${fmtCost(cost)} across ${priced} priced messages (${history.length - priced} unpriced)${per}\n${turns.length} turns, ${done} completed`;}

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
  const rows = turns.map((t) => {
    const llm = t.streamed ? `${(t.llmDurationMs / 1000).toFixed(1)}s ${fmtRate(t.tps)}t/s ttft ${fmtMs(t.ttftMs)}` : "– replay";
    const tools = t.tools.length
      ? `${t.tools.length} (${t.tools.slice(0, 3).map((c) => `${c.name}${c.isError ? "✗" : ""}`).join(",")}${t.tools.length > 3 ? `+${t.tools.length - 3}` : ""} ${(t.toolMsTotal / 1000).toFixed(1)}s)`
      : "–";
    const mark = t.outcome !== "completed" ? ` ${t.outcome.toUpperCase()}` : "";
    return `${t.ts.slice(11, 19)} #${t.turnIndex} ${shortSession(t.sessionId)} ${shortModel(t.model).padEnd(18)} | llm ${llm} | tools ${tools} | turn ${(t.turnMsTotal / 1000).toFixed(1)}s${mark}`;
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
  let lastLlm: LastLlm | undefined;
  const pressureBand = new Map<string, number>();

  pi.on("session_start", () => {
    active = undefined;
    turn = undefined;
    lastLlm = undefined;
    pressureBand.clear();
  });

  pi.on("session_shutdown", () => {
    active = undefined;
    turn = undefined;
    lastLlm = undefined;
    pressureBand.clear();
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "assistant") return;
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
    const streamed = finished.deltas > 0 && output > 0;
    const durationMs = Math.max(1, Date.now() - finished.startedAt);
    const tps = streamed ? Math.round((output / (durationMs / 1000)) * 10) / 10 : 0;
    const sample: TpsSample = {
      ts: new Date().toISOString(),
      model: ctx.model?.id ?? finished.model,
      input: usage?.input ?? 0,
      output,
      durationMs,
      tps,
      approx: usage == null,
      ttftMs: streamed && finished.firstTokenAt !== undefined ? finished.firstTokenAt - finished.startedAt : UNKNOWN_TTFT,
      stalled: finished.stalled,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      ...(typeof usage?.reasoning === "number" ? { reasoning: usage.reasoning } : {}),
      streamed,
      status: failed ? "failed" : "ok",
      stopReason,
      sessionId: sessionIdOf(ctx),
    };
    appendSample(ctx.cwd, sample);
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
    lastLlm = {
      durationMs: sample.durationMs,
      ttftMs: sample.ttftMs,
      input: sample.input,
      output: sample.output,
      tps: sample.tps,
      streamed: sample.streamed,
      approx: sample.approx,
      model: sample.model,
    };
  });

  pi.on("turn_start", (event) => {
    turn = { index: event.turnIndex, startedAt: event.timestamp ?? Date.now(), tools: [] };
  });

  pi.on("tool_execution_end", (event) => {
    if (!turn) return;
    turn.tools.push({
      name: event.toolName,
      durationMs: event.durationMs ?? 0,
      isError: event.isError,
    });
  });

  pi.on("turn_end", (event, ctx) => {
    const now = Date.now();
    const startedAt = turn?.startedAt ?? now;
    const tools = turn?.tools ?? [];
    const llm = lastLlm;
    const toolMsTotal = tools.reduce((a, t) => a + t.durationMs, 0);
    const row: TpsTurn = {
      ts: new Date().toISOString(),
      sessionId: sessionIdOf(ctx),
      model: llm?.model ?? ctx.model?.id ?? "unknown",
      turnIndex: turn?.index ?? event.turnIndex,
      llmDurationMs: llm?.durationMs ?? 0,
      ttftMs: llm?.ttftMs ?? UNKNOWN_TTFT,
      input: llm?.input ?? 0,
      output: llm?.output ?? 0,
      tps: llm?.tps ?? 0,
      streamed: llm?.streamed ?? false,
      approx: llm?.approx ?? false,
      tools,
      toolMsTotal,
      turnMsTotal: Math.max(1, now - startedAt),
      outcome: event.outcome,
      toolErrors: tools.filter((t) => t.isError).length,
    };
    appendTurn(ctx.cwd, row);
    pi.events.emit("tps:turn", row);
    turn = undefined;
  });

  pi.registerCommand("tps", {
    description: "Show tokens/sec: /tps [n] recent, /tps live, /tps totals, /tps models, /tps turns [n], /tps tools [n]",
    handler: async (args, ctx: ExtensionContext) => {
      const [sub, rawN] = args.trim().split(/\s+/);
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
