import { strict as assert } from "node:assert";
import { test } from "node:test";

import { mergeSamples, mergeTurns } from "../dist/browser/protocol.js";

// State can never shrink: torn reads, partial snapshots and empty polls merge
// into the cache instead of replacing it (newest N survive, deduped).

function sample(ts, session = "s") {
  return {
    ts, model: "m", input: 1, output: 2, durationMs: 100, tps: 20,
    approx: false, ttftMs: 10, stalled: false, cacheRead: 0, cacheWrite: 0,
    streamed: true, status: "ok", stopReason: "stop", sessionId: session,
  };
}

function turn(ts, idx) {
  return {
    ts, sessionId: "s", model: "m", turnIndex: idx, llmDurationMs: 100,
    ttftMs: 10, input: 1, output: 2, tps: 20, streamed: true, approx: false,
    tools: [], toolMsTotal: 0, turnMsTotal: 200, outcome: "completed",
    toolErrors: 0,
  };
}

test("mergeSamples never shrinks: empty and partial reads keep good state", () => {
  const full = [sample("2026-01-01T00:00:03.000Z"), sample("2026-01-01T00:00:02.000Z"), sample("2026-01-01T00:00:01.000Z")];
  assert.deepEqual(mergeSamples(full, [], 500), full);
  const partial = mergeSamples(full, [sample("2026-01-01T00:00:02.000Z")], 500);
  assert.equal(partial.length, 3);
  assert.equal(partial[0].ts, "2026-01-01T00:00:03.000Z", "newest first");
});

test("mergeSamples dedups and caps at the newest N", () => {
  const cur = [sample("2026-01-01T00:00:02.000Z"), sample("2026-01-01T00:00:01.000Z")];
  const inc = [sample("2026-01-01T00:00:02.000Z"), sample("2026-01-01T00:00:03.000Z")];
  const merged = mergeSamples(cur, inc, 2);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((s) => s.ts), ["2026-01-01T00:00:03.000Z", "2026-01-01T00:00:02.000Z"]);
});

test("mergeTurns keys on session+index and never shrinks", () => {
  const full = [turn("2026-01-01T00:00:02.000Z", 1), turn("2026-01-01T00:00:01.000Z", 0)];
  assert.deepEqual(mergeTurns(full, [], 500), full);
  const merged = mergeTurns([], full, 500);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].turnIndex, 1);
});
