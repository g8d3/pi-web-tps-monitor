import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import tpsMonitor from "../dist/companion.js";

// Priced family: sonnet-4 -> $3/MTok in, $15/MTok out.
const MODEL = "test/sonnet-4";

function makeWorkspace(turns) {
  const cwd = mkdtempSync(join(tmpdir(), "tps-waste-"));
  mkdirSync(join(cwd, ".pi-web"), { recursive: true });
  const headers = {
    ts: "2026-10-17T00:00:00.000Z",
    sessionId: "waste-session-001",
    model: MODEL,
    llmDurationMs: 1000,
    ttftMs: 100,
    input: 0,
    tps: 0,
    streamed: true,
    approx: false,
    tools: [],
    toolMsTotal: 0,
    turnMsTotal: 1200,
    outcome: "completed",
    toolErrors: 0,
  };
  const lines = turns.map((t, i) => JSON.stringify({ ...headers, turnIndex: i, ts: `2026-10-17T00:0${i}:00.000Z`, ...t }));
  writeFileSync(join(cwd, ".pi-web/tps-turns.jsonl"), lines.join("\n") + "\n");
  const commands = {};
  const notices = [];
  const pi = {
    on: () => () => {},
    events: { emit: () => {}, on: () => () => {} },
    registerCommand: (name, opts) => {
      commands[name] = opts;
    },
  };
  const ctx = {
    cwd,
    model: { id: MODEL },
    sessionManager: { getSessionId: () => "waste-session-001" },
    ui: { setStatus: () => {}, notify: (msg) => notices.push(msg) },
  };
  tpsMonitor(pi);
  return { cwd, commands, notices, ctx };
}

test("/tps cost reports wasted turns and their estimated spend", async () => {
  const h = makeWorkspace([
    { output: 200 }, // good
    { outcome: "error", output: 1_000_000 }, // wasted: 1M out = $15
    { output: 0 }, // wasted: empty
  ]);
  await h.commands.tps.handler("cost", h.ctx);
  const out = h.notices.at(-1);
  assert.match(out, /3 turns, 2 completed, 2 wasted ≈ \$15\.00 \(100% of turn spend\)/);
});

test("/tps cost stays quiet about waste when every turn was productive", async () => {
  const h = makeWorkspace([{ output: 100 }, { output: 200 }]);
  await h.commands.tps.handler("cost", h.ctx);
  assert.match(h.notices.at(-1), /2 turns, 2 completed$/);
});

test("/tps fleet shows a waste cell per session, unpriced waste labelled", async () => {
  const h = makeWorkspace([
    { output: 200 },
    { outcome: "aborted", input: 1_000_000, output: 0 },
    { model: "unknown/model-x", outcome: "error", output: 0, sessionId: "other-session" },
  ]);
  await h.commands.tps.handler("fleet", h.ctx);
  const out = h.notices.at(-1);
  assert.match(out, /waste\s+1 \$3\.00\s+ctx/);
  assert.match(out, /waste\s+1 unpriced\s+ctx/); // unpriced waste: count labelled, no invented dollars
});
