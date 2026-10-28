import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readHistory, readLive, readTurns } from "../dist/server.js";

// TPS-05 (incremental `after` cursor) + TPS-23 (limits, corrupt lines).

function makeWorkspace(historyLines, turnLines, live) {
  const cwd = mkdtempSync(join(tmpdir(), "tps-server-"));
  mkdirSync(join(cwd, ".pi-web"), { recursive: true });
  writeFileSync(join(cwd, ".pi-web/tps-history.jsonl"), historyLines.join("\n") + "\n");
  writeFileSync(join(cwd, ".pi-web/tps-turns.jsonl"), turnLines.join("\n") + "\n");
  if (live !== undefined) writeFileSync(join(cwd, ".pi-web/tps-live.json"), JSON.stringify(live));
  return cwd;
}

function sample(ts, extra = {}) {
  return JSON.stringify({
    ts, model: "m", input: 1, output: 2, durationMs: 100, tps: 20,
    approx: false, ttftMs: 10, stalled: false, cacheRead: 0, cacheWrite: 0,
    streamed: true, status: "ok", stopReason: "stop", sessionId: "s",
    ...extra,
  });
}

function turn(ts, turnIndex, extra = {}) {
  return JSON.stringify({
    ts, sessionId: "s", model: "m", turnIndex, llmDurationMs: 100, ttftMs: 10,
    input: 1, output: 2, tps: 20, streamed: true, approx: false, tools: [],
    toolMsTotal: 0, turnMsTotal: 200, outcome: "completed", toolErrors: 0,
    ...extra,
  });
}

const TS = ["2026-01-01T00:00:01.000Z", "2026-01-01T00:00:02.000Z", "2026-01-01T00:00:03.000Z"];

test("readHistory returns newest-first and honors after (TPS-05)", () => {
  const cwd = makeWorkspace(TS.map((ts) => sample(ts)), []);
  const all = readHistory(cwd, 500);
  assert.equal(all.length, 3);
  assert.equal(all[0].ts, TS[2]);
  const fresh = readHistory(cwd, 500, TS[1]);
  assert.deepEqual(fresh.map((s) => s.ts), [TS[2]]);
  const none = readHistory(cwd, 500, TS[2]);
  assert.equal(none.length, 0);
});

test("readHistory clamps the limit and skips corrupt lines (TPS-23)", () => {
  const cwd = makeWorkspace(["NOT JSON{{{", sample(TS[0]), "42", sample(TS[1])], []);
  const rows = readHistory(cwd, 500);
  assert.equal(rows.length, 2);
  const one = readHistory(cwd, 1);
  assert.equal(one.length, 1);
  assert.equal(one[0].ts, TS[1]);
  const zero = readHistory(cwd, 0);
  assert.equal(zero.length, 1, "limit clamps to a minimum of 1");
});

test("readTurns honors after and skips corrupt lines", () => {
  const cwd = makeWorkspace([], [turn(TS[0], 0), "junk", turn(TS[1], 1)]);
  assert.equal(readTurns(cwd, 500).length, 2);
  assert.deepEqual(readTurns(cwd, 500, TS[0]).map((t) => t.turnIndex), [1]);
});

test("readLive falls back to unknown on missing/corrupt files", () => {
  const cwd = makeWorkspace([], []);
  assert.equal(readLive(cwd).state, "unknown");
  const cwd2 = makeWorkspace([], [], { state: "streaming", chars: 5, elapsedMs: 9, approxTps: 1, updatedAt: TS[0] });
  assert.equal(readLive(cwd2).state, "streaming");
});
