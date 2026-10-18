import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import tpsMonitor, { readHistory, readTurns, tuning } from "../dist/companion.js";
import { contextPressure, fleetStats, modelInfo, sampleCostOf, sessionCostUsd, turnCostUsd } from "../dist/browser/models.js";
import { normalizeSample } from "../dist/browser/protocol.js";

tuning.minStreamMs = 0;

const REGISTRY = {
  flash: { input: 0.15, output: 0.6, cacheRead: 0.003, ctx: 1_000_000 },
  spark: { input: 0.1, output: 0.2, cacheRead: 0.002, ctx: 1_048_576 },
};

test("recorded actuals beat the table; table stays as fallback", () => {
  const row = { model: "deepseek-v4.1-flash", input: 300, output: 400, cacheRead: 165_000, costUsd: 0.0012 };
  assert.equal(sampleCostOf(row), 0.0012);
  const noActual = { model: "deepseek-v4.1-flash", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 };
  const { input, output, cacheRead } = REGISTRY.flash;
  assert.equal(sampleCostOf(noActual), input + output + cacheRead);
  assert.ok(Math.abs((sampleCostOf({ model: "muse-spark-1.3-contributor", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }) ?? NaN) - 0.302) < 1e-12);
  assert.equal(sampleCostOf({ model: "some-future-model", input: 1, output: 1, cacheRead: 0 }), undefined);
});

test("table tracks the provider registry for the models in our history", () => {
  const flash = modelInfo("deepseek-v4.1-flash");
  assert.equal(flash?.contextLimit, REGISTRY.flash.ctx);
  assert.equal(flash?.inputPerMTok, REGISTRY.flash.input);
  assert.equal(flash?.outputPerMTok, REGISTRY.flash.output);
  assert.equal(flash?.cacheReadPerMTok, REGISTRY.flash.cacheRead);
  const spark = modelInfo("muse-spark-1.3-contributor");
  assert.equal(spark?.contextLimit, REGISTRY.spark.ctx);
  assert.equal(spark?.inputPerMTok, REGISTRY.spark.input);
  assert.equal(spark?.outputPerMTok, REGISTRY.spark.output);
  assert.equal(spark?.cacheReadPerMTok, REGISTRY.spark.cacheRead);
  assert.equal(contextPressure("deepseek-v4.1-flash", 100_000, 160_000), 0.26);
});

test("fleet and session spend count actual-carrying rows as priced", () => {
  const s = (over) => ({
    ts: "2026-10-17T00:00:00.000Z", model: "deepseek-v4.1-flash", input: 300, output: 400,
    durationMs: 1000, tps: 400, approx: false, ttftMs: 5, stalled: false,
    cacheRead: 165_000, cacheWrite: 0, streamed: true, status: "ok",
    stopReason: "stop", sessionId: "s1", ...over,
  });
  const history = [s({ costUsd: 0.001 }), s({ ts: "2026-10-17T00:01:00.000Z" })];
  const guard = sessionCostUsd(history, "s1");
  assert.equal(guard.priced, 2);
  assert.equal(guard.unpriced, 0);
  const [stat] = fleetStats(history, []);
  assert.equal(stat.unknownCost, 0);
  assert.equal(stat.unpricedShare, 0);
  assert.ok(stat.cost > 0.001);
});

test("turn waste prefers recorded turn actuals", () => {
  const base = {
    ts: "2026-10-17T00:00:00.000Z", sessionId: "s", model: "deepseek-v4.1-flash",
    turnIndex: 0, llmDurationMs: 100, ttftMs: 10, input: 300, output: 0, tps: 0,
    streamed: true, approx: false, tools: [], toolMsTotal: 0, turnMsTotal: 100,
    outcome: "error", toolErrors: 0, requestedTools: 1, llmMessages: 1,
  };
  assert.equal(turnCostUsd({ ...base, costUsd: 0.004 }), 0.004);
  assert.ok((turnCostUsd(base) ?? 0) > 0);
});

test("normalizeSample keeps the recorded actual", () => {
  const row = normalizeSample({
    ts: "2026-10-17T00:00:00.000Z", model: "m", input: 1, output: 2, durationMs: 10,
    tps: 200, approx: false, ttftMs: 1, stalled: false, cacheRead: 0, cacheWrite: 0,
    streamed: true, status: "ok", stopReason: "stop", sessionId: "s", costUsd: 0.00001,
  });
  assert.equal(row?.costUsd, 0.00001);
});

function makeHarness(cwd, model = "deepseek-v4.1-flash") {
  const handlers = {};
  const pi = {
    on: (event, fn) => {
      handlers[event] = fn;
      return () => {};
    },
    events: { emit: () => {}, on: () => () => {} },
    registerCommand: () => {},
  };
  const ctx = {
    cwd,
    model: { id: model },
    sessionManager: { getSessionId: () => "sess-actual-1" },
    ui: { setStatus: () => {}, notify: () => {} },
  };
  return { handlers, pi, ctx };
}

const usageWith = (total) => ({
  input: 300, output: 400, cacheRead: 165_000, cacheWrite: 0, totalTokens: 165_700,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

test("companion records usage.cost.total on the message and turn rows", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tps-cost-"));
  const h = makeHarness(cwd);
  tpsMonitor(h.pi);
  h.handlers.turn_start({ turnIndex: 1, timestamp: Date.now() });
  h.handlers.message_start({ message: { role: "assistant" } }, h.ctx);
  h.handlers.message_update(
    { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "hello" } },
    h.ctx,
  );
  h.handlers.message_end(
    { message: { role: "assistant", stopReason: "stop", usage: usageWith(0.00123), content: [] } },
    h.ctx,
  );
  h.handlers.turn_end({ turnIndex: 1, outcome: "completed" }, h.ctx);
  const [sample] = readHistory(cwd, 10);
  assert.equal(sample.costUsd, 0.00123);
  const [turn] = readTurns(cwd, 10);
  assert.equal(turn.costUsd, 0.00123);
});

test("a turn mixing actual and approx messages falls back to the table", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tps-costmix-"));
  const h = makeHarness(cwd);
  tpsMonitor(h.pi);
  h.handlers.turn_start({ turnIndex: 2, timestamp: Date.now() });
  h.handlers.message_start({ message: { role: "assistant" } }, h.ctx);
  h.handlers.message_end(
    { message: { role: "assistant", stopReason: "stop", usage: usageWith(0.001), content: [] } },
    h.ctx,
  );
  h.handlers.message_start({ message: { role: "assistant" } }, h.ctx);
  // Approx row: streamed text but no usage block, so no actual — the turn
  // total must not pose as complete.
  h.handlers.message_update(
    { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "hello approx" } },
    h.ctx,
  );
  h.handlers.message_end({ message: { role: "assistant", stopReason: "stop", content: [] } }, h.ctx);
  h.handlers.turn_end({ turnIndex: 2, outcome: "completed" }, h.ctx);
  const [turn] = readTurns(cwd, 10);
  assert.equal(turn.costUsd, undefined);
  assert.ok((turnCostUsd(turn) ?? 0) > 0);
});
