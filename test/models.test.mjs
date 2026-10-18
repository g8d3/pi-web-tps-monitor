import { strict as assert } from "node:assert";
import { test } from "node:test";

import { contextPressure, fleetStats, fmtCost, fmtPartialCost, modelInfo, sampleCostUsd } from "../dist/browser/models.js";

test("modelInfo matches specific families, unknown ids yield undefined", () => {
  const sonnet = modelInfo("anthropic/claude-sonnet-4-5");
  assert.equal(sonnet?.label, "Claude Sonnet");
  assert.equal(sonnet?.contextLimit, 200_000);
  assert.equal(modelInfo("openai/gpt-5-mini")?.label, "GPT-5");
  const spark = modelInfo("muse-spark-1.3-contributor");
  assert.equal(spark?.label, "Muse Spark");
  assert.equal(spark?.contextLimit, 1_048_576);
  assert.equal(modelInfo("some-future-model"), undefined);
});

test("contextPressure is input+cache over the window", () => {
  assert.equal(contextPressure("x/sonnet-4", 100_000, 60_000), 0.8);
  assert.equal(contextPressure("muse-spark-1.3-contributor", 1, 1), 2 / 1_048_576);
  assert.equal(contextPressure("some-future-model", 1, 1), undefined);
});

test("sampleCostUsd prices known models, unknown yields undefined", () => {
  assert.equal(sampleCostUsd("x/sonnet-4", 1_000_000, 1_000_000, 1_000_000), 18.3);
  assert.ok(Math.abs((sampleCostUsd("muse-spark-1.3-contributor", 1_000_000, 1_000_000, 1_000_000) ?? NaN) - 0.302) < 1e-12);
  assert.equal(sampleCostUsd("qwen3-235b", 100, 100, 0), undefined);
  assert.equal(fmtCost(0.02344), "$0.0234");
});

test("fleetStats rolls sessions up newest-first with cost and pressure", () => {
  const s = (over) => ({
    ts: "2026-10-17T00:00:00.000Z",
    model: "x/sonnet-4",
    input: 1000,
    output: 200,
    durationMs: 1000,
    tps: 200,
    approx: false,
    streamed: true,
    status: "ok",
    stopReason: "stop",
    sessionId: "aaa",
    ...over,
  });
  const history = [
    s({ sessionId: "aaa", ts: "2026-10-17T00:02:00.000Z", input: 190_000, cacheRead: 0 }),
    s({ sessionId: "bbb", ts: "2026-10-17T00:01:00.000Z", cacheRead: 0 }),
    s({ sessionId: "aaa", ts: "2026-10-17T00:00:00.000Z", cacheRead: 0 }),
  ];
  const turns = [{
    ts: "2026-10-17T00:02:01.000Z",
    sessionId: "aaa",
    model: "x/sonnet-4",
    turnIndex: 0,
    llmDurationMs: 1000,
    ttftMs: 100,
    input: 1000,
    output: 200,
    tps: 200,
    streamed: true,
    approx: false,
    tools: [],
    toolMsTotal: 5000,
    turnMsTotal: 6000,
    outcome: "completed",
    toolErrors: 0,
  }];
  const stats = fleetStats(history, turns);
  assert.equal(stats.length, 2);
  assert.equal(stats[0].sessionId, "aaa");
  assert.equal(stats[0].msgs, 2);
  assert.equal(stats[0].turns, 1);
  assert.equal(stats[0].done, 1);
  assert.equal(stats[0].toolMs, 5000);
  assert.equal(stats[0].pressure, 0.95);
  assert.ok(stats[0].cost > 0);
  assert.equal(stats[0].wastedTurns, 0);
  assert.equal(stats[0].wastedCost, 0);
  assert.ok(stats[0].turnCost > 0);
  assert.equal(stats[1].sessionId, "bbb");
});

test("isWastedTurn catches failures and empty turns", async () => {
  const { isWastedTurn } = await import("../dist/browser/models.js");
  assert.equal(isWastedTurn({ outcome: "completed", output: 12 }), false);
  assert.equal(isWastedTurn({ outcome: "aborted", output: 12 }), true);
  assert.equal(isWastedTurn({ outcome: "error", output: 0 }), true);
  assert.equal(isWastedTurn({ outcome: "completed", output: 0 }), true);
});

test("turnWaste prices only wasted priced turns and keeps the denominator honest", async () => {
  const { turnWaste } = await import("../dist/browser/models.js");
  const turn = (over) => ({
    ts: "2026-10-17T00:00:00.000Z", sessionId: "s", model: "x/sonnet-4", turnIndex: 0,
    llmDurationMs: 100, ttftMs: 10, input: 0, output: 0, tps: 0,
    streamed: true, approx: false, tools: [], toolMsTotal: 0, turnMsTotal: 100,
    outcome: "completed", toolErrors: 0, ...over,
  });
  // sonnet: $3/M in, $15/M out. Wasted: error turn 15, aborted 0, empty 0.
  const w = turnWaste([
    turn({ outcome: "error", output: 1_000_000 }),
    turn({ outcome: "aborted", output: 0 }),
    turn({ output: 0 }),
    turn({ input: 1_000_000, output: 1_000_000 }),
    turn({ model: "qwen3-235b", outcome: "error" }),
  ]);
  assert.equal(w.turns, 4); // error + aborted + empty + one unpriced wasted
  assert.equal(w.unpriced, 1);
  assert.equal(w.cost, 15);
  assert.equal(w.total, 33); // 15 wasted + 18 on the good turn
  assert.ok(w.cost < w.total);
});

test("unaccounted gap flags big unexplained remainders only", async () => {
  const { unaccountedMs, hasUnaccountedGap } = await import("../dist/browser/models.js");
  assert.equal(unaccountedMs({ turnMsTotal: 9903, llmDurationMs: 2063, toolMsTotal: 0 }), 7840);
  assert.equal(hasUnaccountedGap({ turnMsTotal: 9903, llmDurationMs: 2063, toolMsTotal: 0 }), true);
  assert.equal(hasUnaccountedGap({ turnMsTotal: 9903, llmDurationMs: 9000, toolMsTotal: 0 }), false);
  assert.equal(hasUnaccountedGap({ turnMsTotal: 1500, llmDurationMs: 200, toolMsTotal: 0 }), false);
});

test("the measured pre-token window is not double-counted as unaccounted", async () => {
  const { unaccountedMs, hasUnaccountedGap } = await import("../dist/browser/models.js");
  // The N3 shape: a PONG turn where the provider wait (preResponseMs) IS the gap.
  const pongTurn = { turnMsTotal: 2414, llmDurationMs: 2, toolMsTotal: 0, preResponseMs: 2410 };
  assert.equal(unaccountedMs(pongTurn), 2, "remainder after the measured windows");
  assert.equal(hasUnaccountedGap(pongTurn), false, "provider wait is measured, not unexplained");
  // Pre-v23 rows have no preResponseMs: identical to the old behavior.
  assert.equal(unaccountedMs({ turnMsTotal: 2414, llmDurationMs: 2, toolMsTotal: 0 }), 2412);
  assert.equal(hasUnaccountedGap({ turnMsTotal: 2414, llmDurationMs: 2, toolMsTotal: 0 }), true);
  // A genuinely unexplained remainder still flags even with a pre-token window.
  assert.equal(hasUnaccountedGap({ turnMsTotal: 9903, llmDurationMs: 2063, toolMsTotal: 0, preResponseMs: 1500 }), true);
});

test("normalizeTurn backfills legacy rows without the new fields", async () => {
  const { normalizeTurn } = await import("../dist/browser/protocol.js");
  const legacy = {
    ts: "2026-10-17T00:00:00.000Z", sessionId: "s", model: "m", turnIndex: 0,
    llmDurationMs: 100, ttftMs: 10, input: 5, output: 6, tps: 60,
    streamed: true, approx: false, tools: [{ name: "bash", durationMs: 7, isError: false }],
    toolMsTotal: 7, turnMsTotal: 200, outcome: "completed", toolErrors: 0,
  };
  const turn = normalizeTurn(legacy);
  assert.equal(turn.requestedTools, 1);
  assert.equal(turn.llmMessages, 1);
  // pre-v23 rows predate the pre-response window: backfilled 0, which the UI shows as "–".
  assert.equal(turn.preResponseMs, 0);
});

test("normalizeTurn keeps a recorded preResponseMs", async () => {
  const { normalizeTurn } = await import("../dist/browser/protocol.js");
  const row = {
    ts: "2026-10-17T00:00:00.000Z", sessionId: "s", model: "m", turnIndex: 0,
    llmDurationMs: 100, ttftMs: 10, input: 5, output: 6, tps: 60,
    streamed: true, approx: false, tools: [], toolMsTotal: 0, turnMsTotal: 200,
    outcome: "completed", toolErrors: 0, preResponseMs: 1451,
  };
  assert.equal(normalizeTurn(row).preResponseMs, 1451);
});

test("a turn's preResponseMs is rejected when it is not a number", async () => {
  const { isTpsTurn } = await import("../dist/browser/protocol.js");
  const base = {
    ts: "2026-10-17T00:00:00.000Z", sessionId: "s", model: "m", turnIndex: 0,
    llmDurationMs: 100, ttftMs: 10, input: 5, output: 6, tps: 60,
    streamed: true, approx: false, tools: [], toolMsTotal: 0, turnMsTotal: 200,
    outcome: "completed", toolErrors: 0,
  };
  assert.equal(isTpsTurn({ ...base, preResponseMs: 1451 }), true);
  assert.equal(isTpsTurn({ ...base, preResponseMs: "soon" }), false);
});

test("a mixed session's cost renders as a floor, never as a complete total", () => {
  // sonnet-4 is priced; "mystery-model-x" matches nothing => no list price.
  const s = (over) => ({
    ts: "2026-10-17T00:00:00.000Z", model: "x/sonnet-4", input: 1000, output: 200,
    durationMs: 1000, tps: 200, approx: false, streamed: true, status: "ok",
    stopReason: "stop", sessionId: "mix", cacheRead: 0,
    ...over,
  });
  const history = [
    s({ ts: "2026-10-17T00:02:00.000Z" }),
    s({ ts: "2026-10-17T00:01:00.000Z", model: "mystery-model-x" }),
    s({ ts: "2026-10-17T00:00:00.000Z" }),
  ];
  const [f] = fleetStats(history, []);
  assert.equal(f.msgs, 3);
  assert.equal(f.unknownCost, 1);
  assert.equal(f.unpricedShare, 1 / 3);

  // Mixed: the number carries a "+" so it can never be read as the whole spend.
  assert.equal(fmtPartialCost(f.cost, f.msgs - f.unknownCost, f.unknownCost), `${fmtCost(f.cost)}+`);
  // Fully priced: plain number, no qualifier.
  assert.equal(fmtPartialCost(0.5, 2, 0), fmtCost(0.5));
  // Nothing priced: unknown, never "$0.00" (that would read as "free").
  assert.equal(fmtPartialCost(0, 0, 3), "\u2013");

  const allUnpriced = fleetStats([s({ model: "mystery-model-x" })], [])[0];
  assert.equal(fmtPartialCost(allUnpriced.cost, allUnpriced.msgs - allUnpriced.unknownCost, allUnpriced.unknownCost), "\u2013");
});
