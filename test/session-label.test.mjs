import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import tpsMonitor, { readHistory, readTurns, slugOf, tuning } from "../dist/companion.js";
import { fleetStats, sessionLabel, shortSessionId } from "../dist/browser/models.js";
import { isTpsSample, normalizeSample } from "../dist/browser/protocol.js";

tuning.minStreamMs = 0;

test("slugOf turns an opening prompt into a short label", () => {
  assert.equal(slugOf("Fix fleet cost table!"), "fix-fleet-cost-table");
  assert.equal(slugOf("  Hello,   world  "), "hello-world");
  assert.equal(slugOf(""), undefined);
  assert.equal(slugOf("!!!"), undefined);
  const long = slugOf("a".repeat(100));
  assert.ok(long !== undefined && long.length <= 40);
});

test("sessionLabel prefers the recorded name, else the 8-hex id", () => {
  assert.equal(sessionLabel("01a14c62-bd8a", "my feature"), "my feature");
  assert.equal(sessionLabel("01a14c62-bd8a", undefined), "01a14c62");
  assert.equal(sessionLabel("01a14c62-bd8a", ""), "01a14c62");
  assert.equal(sessionLabel("", undefined), "–");
  assert.equal(shortSessionId("01a14c62-bd8a"), "01a14c62");
});

test("protocol keeps the recorded label and rejects a non-string one", () => {
  const base = {
    ts: "2026-10-17T00:00:00.000Z", model: "m", input: 1, output: 2, durationMs: 10,
    tps: 200, approx: false, ttftMs: 1, stalled: false, cacheRead: 0, cacheWrite: 0,
    streamed: true, status: "ok", stopReason: "stop", sessionId: "s",
  };
  assert.equal(normalizeSample({ ...base, sessionName: "my feature" })?.sessionName, "my feature");
  assert.equal(normalizeSample(base)?.sessionName, undefined);
  assert.equal(isTpsSample({ ...base, sessionName: 42 }), false);
});

test("fleetStats takes the latest recorded name, else leaves it undefined", () => {
  const s = (over) => ({
    ts: "2026-10-17T00:00:00.000Z", model: "m", input: 1, output: 1,
    durationMs: 100, tps: 10, approx: false, ttftMs: 1, stalled: false,
    cacheRead: 0, cacheWrite: 0, streamed: true, status: "ok",
    stopReason: "stop", sessionId: "s1", ...over,
  });
  const [named] = fleetStats(
    [s({ sessionName: "old" }), s({ ts: "2026-10-17T00:01:00.000Z", sessionName: "new" })],
    [],
  );
  assert.equal(named.name, "new");
  const [unnamed] = fleetStats([s({})], []);
  assert.equal(unnamed.name, undefined);
});

function makeHarness(cwd, { sessionName, modelId = "m" } = {}) {
  const handlers = {};
  const commands = {};
  const notices = [];
  const pi = {
    on: (event, fn) => {
      handlers[event] = fn;
      return () => {};
    },
    events: { emit: () => {}, on: () => () => {} },
    registerCommand: (name, opts) => {
      commands[name] = opts;
    },
  };
  const sessionManager = { getSessionId: () => "sess-label-1" };
  if (sessionName !== undefined) sessionManager.getSessionName = () => sessionName;
  const ctx = {
    cwd,
    model: { id: modelId },
    sessionManager,
    ui: { setStatus: () => {}, notify: (msg) => notices.push(msg) },
  };
  return { handlers, commands, notices, pi, ctx };
}

const usage = {
  input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
};

function runAssistant(h, text = "hi") {
  h.handlers.message_start({ message: { role: "assistant" } }, h.ctx);
  h.handlers.message_update(
    { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: text } },
    h.ctx,
  );
  h.handlers.message_end(
    { message: { role: "assistant", stopReason: "stop", usage, content: [] } },
    h.ctx,
  );
}

test("Pi session name wins over the first-prompt slug on message and turn rows", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tps-label-"));
  const h = makeHarness(cwd, { sessionName: "my feature" });
  tpsMonitor(h.pi);
  h.handlers.message_start({ message: { role: "user", content: "Fix fleet cost table" } }, h.ctx);
  h.handlers.turn_start({ turnIndex: 1, timestamp: Date.now() });
  runAssistant(h);
  h.handlers.turn_end({ turnIndex: 1, outcome: "completed" }, h.ctx);
  assert.equal(readHistory(cwd, 10)[0].sessionName, "my feature");
  assert.equal(readTurns(cwd, 10)[0].sessionName, "my feature");
});

test("without a Pi name the first user message becomes the label", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tps-slug-"));
  const h = makeHarness(cwd);
  tpsMonitor(h.pi);
  h.handlers.message_start({ message: { role: "user", content: "Fix fleet cost table!" } }, h.ctx);
  h.handlers.turn_start({ turnIndex: 1, timestamp: Date.now() });
  runAssistant(h);
  h.handlers.turn_end({ turnIndex: 1, outcome: "completed" }, h.ctx);
  assert.equal(readHistory(cwd, 10)[0].sessionName, "fix-fleet-cost-table");
  assert.equal(readTurns(cwd, 10)[0].sessionName, "fix-fleet-cost-table");
});

test("with neither a name nor a prompt the rows stay anonymous", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tps-anon-"));
  const h = makeHarness(cwd);
  tpsMonitor(h.pi);
  h.handlers.turn_start({ turnIndex: 1, timestamp: Date.now() });
  runAssistant(h);
  h.handlers.turn_end({ turnIndex: 1, outcome: "completed" }, h.ctx);
  assert.equal(readHistory(cwd, 10)[0].sessionName, undefined);
});

test("/tps fleet and budget show the label instead of the hash", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tps-fleetlabel-"));
  const h = makeHarness(cwd, { sessionName: "my feature" });
  tpsMonitor(h.pi);
  h.handlers.turn_start({ turnIndex: 1, timestamp: Date.now() });
  runAssistant(h);
  h.handlers.turn_end({ turnIndex: 1, outcome: "completed" }, h.ctx);
  await h.commands.tps.handler("fleet", h.ctx);
  assert.match(h.notices[0], /my feature/);
  assert.doesNotMatch(h.notices[0], /sess-label/);
  await h.commands.tps.handler("budget", h.ctx);
  assert.match(h.notices[1], /my feature/);
});
