import { strict as assert } from "node:assert";
import { test } from "node:test";

import { contextPressure, fleetStats, fmtCost, modelInfo, sampleCostUsd } from "../dist/models.js";

test("modelInfo matches specific families, unknown ids yield undefined", () => {
  const sonnet = modelInfo("anthropic/claude-sonnet-4-5");
  assert.equal(sonnet?.label, "Claude Sonnet");
  assert.equal(sonnet?.contextLimit, 200_000);
  assert.equal(modelInfo("openai/gpt-5-mini")?.label, "GPT-5");
  assert.equal(modelInfo("muse-spark-1.3-contributor"), undefined);
});

test("contextPressure is input+cache over the window", () => {
  assert.equal(contextPressure("x/sonnet-4", 100_000, 60_000), 0.8);
  assert.equal(contextPressure("muse-spark-1.3-contributor", 1, 1), undefined);
});

test("sampleCostUsd prices known models, unknown yields undefined", () => {
  assert.equal(sampleCostUsd("x/sonnet-4", 1_000_000, 1_000_000, 1_000_000), 18.3);
  assert.equal(sampleCostUsd("muse-spark-1.3-contributor", 100, 100, 0), undefined);
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
  assert.equal(stats[1].sessionId, "bbb");
});
