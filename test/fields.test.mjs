import { strict as assert } from "node:assert";
import { test } from "node:test";

import { fleetStats, fmtDur, perModelCost } from "../dist/browser/models.js";

// TPS-10 (ms precision), TPS-38 (span + working time), TPS-39 (per-model cost).

function sample(ts, model = "m/x", cost = 0.01) {
  return {
    ts, model, input: 1, output: 2, durationMs: 100, tps: 20, approx: false,
    ttftMs: 10, stalled: false, cacheRead: 0, cacheWrite: 0, costUsd: cost,
    streamed: true, status: "ok", stopReason: "stop", sessionId: "s",
  };
}

function turn(ts, turnIndex, llmMs = 100, toolMs = 50) {
  return {
    ts, sessionId: "s", model: "m/x", turnIndex, llmDurationMs: llmMs, ttftMs: 10,
    input: 1, output: 2, tps: 20, streamed: true, approx: false, tools: [],
    toolMsTotal: toolMs, turnMsTotal: llmMs + toolMs, outcome: "completed",
    toolErrors: 0, requestedTools: 0, llmMessages: 1,
  };
}

test("fmtDur renders ms under a second (TPS-10)", () => {
  assert.equal(fmtDur(85), "85ms");
  assert.equal(fmtDur(0), "0ms");
  assert.equal(fmtDur(1500), "1.5s");
  assert.equal(fmtDur(-1), "–");
});

test("fleetStats carries wall span and LLM working time (TPS-38)", () => {
  const history = [sample("2026-01-01T00:00:01.000Z"), sample("2026-01-01T00:01:01.000Z")];
  const turns = [turn("2026-01-01T00:00:02.000Z", 0, 8000, 4000), turn("2026-01-01T00:01:00.000Z", 1, 2000, 1000)];
  const [f] = fleetStats(history, turns);
  assert.equal(f.earliestTs, "2026-01-01T00:00:01.000Z");
  assert.equal(f.latestTs, "2026-01-01T00:01:01.000Z");
  assert.equal(f.llmMs, 10000);
  assert.equal(f.toolMs, 5000);
});

test("perModelCost splits priced spend by model (TPS-39)", () => {
  const history = [
    sample("2026-01-01T00:00:01.000Z", "m/a", 0.05),
    sample("2026-01-01T00:00:02.000Z", "m/a", 0.05),
    sample("2026-01-01T00:00:03.000Z", "m/b"),
  ];
  delete history[2].costUsd;
  const rows = perModelCost(history, "s");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].model, "m/a");
  assert.equal(rows[0].cost, 0.1);
  assert.equal(rows[1].model, "m/b");
  assert.equal(rows[1].unpriced, 1);
  assert.ok(!rows.some((r) => r.model !== "m/a" && r.model !== "m/b"));
});
