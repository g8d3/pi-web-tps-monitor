import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import tpsMonitor from "../dist/companion.js";

// TPS-07 (LLM seconds always shown), TPS-32 (turn badge), TPS-34 (total
// arithmetic), TPS-38 (completed label), TPS-39 (per-model split), TPS-25
// (turns are 0-based).

const MODEL = "test/sonnet-4";

function makeWorkspace(turns, samples = []) {
  const cwd = mkdtempSync(join(tmpdir(), "tps-render-"));
  mkdirSync(join(cwd, ".pi-web"), { recursive: true });
  const headers = {
    ts: "2026-10-17T00:00:00.000Z",
    sessionId: "render-session-001",
    model: MODEL,
    llmDurationMs: 1000,
    ttftMs: 100,
    input: 0,
    output: 100,
    tps: 0,
    streamed: true,
    approx: false,
    tools: [],
    toolMsTotal: 0,
    turnMsTotal: 1200,
    outcome: "completed",
    toolErrors: 0,
    requestedTools: 0,
    llmMessages: 1,
  };
  writeFileSync(
    join(cwd, ".pi-web/tps-turns.jsonl"),
    turns.map((t, i) => JSON.stringify({ ...headers, turnIndex: i, ts: `2026-10-17T00:0${i}:00.000Z`, ...t })).join("\n") + "\n",
  );
  const sh = {
    ts: "2026-10-17T00:00:00.000Z", model: MODEL, input: 0, output: 100,
    durationMs: 1000, tps: 100, approx: false, ttftMs: 100, stalled: false,
    cacheRead: 0, cacheWrite: 0, streamed: true, status: "ok",
    stopReason: "stop", sessionId: "render-session-001", turnIndex: 1,
  };
  writeFileSync(
    join(cwd, ".pi-web/tps-history.jsonl"),
    samples.map((s, i) => JSON.stringify({ ...sh, ts: `2026-10-17T00:1${i}:00.000Z`, ...s })).join("\n") + "\n",
  );
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
    sessionManager: { getSessionId: () => "render-session-001" },
    ui: { setStatus: () => {}, notify: (msg) => notices.push(msg) },
  };
  tpsMonitor(pi);
  return { commands, notices, ctx };
}

test("/tps turns shows LLM seconds even when unrated, with gap arithmetic", async () => {
  const h = makeWorkspace([{ streamed: false, turnMsTotal: 8000, llmDurationMs: 2000, toolMsTotal: 100, preResponseMs: 2000 }]);
  await h.commands.tps.handler("turns", h.ctx);
  const out = h.notices.at(-1);
  assert.match(out, /llm 2\.0s unrated/, "seconds shown, rate withheld");
  assert.match(out, /\[2\.0s\+100ms\+2\.0s\+gap 3\.9s\]/, "total decomposes without remainder");
});

test("/tps messages table carries the turn badge (TPS-32)", async () => {
  const h = makeWorkspace([], [{ turnIndex: 1 }]);
  await h.commands.tps.handler("", h.ctx);
  assert.match(h.notices.at(-1), /#\s*1/, "turn badge present");
});

test("/tps fleet says completed and /tps cost splits by model", async () => {
  const h = makeWorkspace(
    [{}, { requestedTools: 2 }],
    [{ model: "test/sonnet-4" }, { model: "test/haiku-4", output: 50 }],
  );
  await h.commands.tps.handler("fleet", h.ctx);
  assert.match(h.notices.at(-1), /2 completed/, "done renamed to completed");
  await h.commands.tps.handler("cost", h.ctx);
  assert.match(h.notices.at(-1), /sonnet-4/, "per-model cost split present");
});
