import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import tpsMonitor, { slugOf, summarizeArgs, tuning } from "../dist/companion.js";

tuning.minStreamMs = 0;

function makeHarness(cwd, sessionId = "test-session-abcdef123456") {
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
  const ctx = {
    cwd,
    model: { id: "test/model-x" },
    sessionManager: { getSessionId: () => sessionId },
    ui: { setStatus: () => {}, notify: (msg) => notices.push(msg) },
  };
  return { handlers, commands, notices, pi, ctx };
}

function endMessage(h, usage = { input: 10, output: 40, cacheRead: 0, cacheWrite: 0 }) {
  h.handlers.message_end(
    { message: { role: "assistant", stopReason: "toolUse", usage, content: [] } },
    h.ctx,
  );
}

test("a turn streaming only tool calls is rated, not replayed (TPS-01)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tps-toolstream-"));
  const h = makeHarness(cwd);
  tpsMonitor(h.pi);
  h.handlers.message_start({ message: { role: "assistant" } }, h.ctx);
  const toolDelta = () => ({
    message: { role: "assistant" },
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"command": "ls', partial: {} },
  });
  h.handlers.message_update(toolDelta(), h.ctx);
  h.handlers.message_update(toolDelta(), h.ctx);
  endMessage(h);
  const sample = JSON.parse(readFileSync(join(cwd, ".pi-web/tps-history.jsonl"), "utf8").split("\n").filter(Boolean).at(-1));
  assert.equal(sample.streamed, true);
  assert.ok(sample.tps > 0, "tool-call-only turn yields a rate");
});

test("samples carry the current turn index (TPS-32)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tps-turnidx-"));
  const h = makeHarness(cwd);
  tpsMonitor(h.pi);
  h.handlers.turn_start({ turnIndex: 7, timestamp: Date.now() }, h.ctx);
  h.handlers.message_start({ message: { role: "assistant" } }, h.ctx);
  h.handlers.message_update({ message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial: {} } }, h.ctx);
  endMessage(h);
  const sample = JSON.parse(readFileSync(join(cwd, ".pi-web/tps-history.jsonl"), "utf8").split("\n").filter(Boolean).at(-1));
  assert.equal(sample.turnIndex, 7);
  h.handlers.turn_end({ type: "turn_end", turnIndex: 7, outcome: "completed" }, h.ctx);
});

test("tool detail is captured from start args (TPS-36)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tps-detail-"));
  const h = makeHarness(cwd);
  tpsMonitor(h.pi);
  h.handlers.turn_start({ turnIndex: 0, timestamp: Date.now() }, h.ctx);
  h.handlers.tool_execution_start({ toolCallId: "a", toolName: "bash", args: { command: "npm run build" } }, h.ctx);
  h.handlers.tool_execution_start({ toolCallId: "b", toolName: "read", args: { path: "/tmp/x.txt" } }, h.ctx);
  h.handlers.tool_execution_end({ toolCallId: "a", toolName: "bash", result: null, isError: false, durationMs: 100 }, h.ctx);
  h.handlers.tool_execution_end({ toolCallId: "b", toolName: "read", result: null, isError: false, durationMs: 10 }, h.ctx);
  h.handlers.turn_end({ type: "turn_end", turnIndex: 0, outcome: "completed" }, h.ctx);
  const turn = JSON.parse(readFileSync(join(cwd, ".pi-web/tps-turns.jsonl"), "utf8").split("\n").filter(Boolean).at(-1));
  const byName = Object.fromEntries(turn.tools.map((t) => [t.name, t.detail]));
  assert.equal(byName.bash, "npm run build");
  assert.equal(byName.read, "/tmp/x.txt");
});

test("summarizeArgs prefers command/path, truncates, ignores junk", () => {
  assert.equal(summarizeArgs("bash", { command: "  npm run build  " }), "npm run build");
  assert.equal(summarizeArgs("read", { path: "/tmp/x.txt" }), "/tmp/x.txt");
  assert.equal(summarizeArgs("other", null), undefined);
  assert.equal(summarizeArgs("other", {}), undefined);
  const long = summarizeArgs("other", { a: "x".repeat(200) });
  assert.ok(typeof long === "string" && long.length <= 60);
});

test("slugOf keeps unicode letters (TPS-22)", () => {
  assert.equal(slugOf("Revisa el plugin TPS de pi web"), "revisa-el-plugin-tps-de-pi-web");
  assert.ok((slugOf("Análisis de costos") ?? "").includes("costos"));
});

test("budget cap persists to disk and reloads (TPS-04)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tps-budgetpersist-"));
  const h = makeHarness(cwd);
  tpsMonitor(h.pi);
  await h.commands.tps.handler("budget 12", h.ctx);
  assert.ok(existsSync(join(cwd, ".pi-web/tps-budgets.json")), "budgets file written");
  // Simulate a restart: drop in-memory state, mount a fresh monitor on the same cwd.
  h.handlers.session_shutdown();
  const h2 = makeHarness(cwd);
  tpsMonitor(h2.pi);
  await h2.commands.tps.handler("budget", h2.ctx);
  assert.match(h2.notices.at(-1), /\$12\.00 budget/);
});
