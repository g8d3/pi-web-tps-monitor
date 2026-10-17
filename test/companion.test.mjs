import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import tpsMonitor, { tuning } from "../dist/companion.js";

// The fabricated-rate floor (v19) is about wall-clock windows, but these
// lifecycle fixtures emit their deltas instantly, so the measured window is
// ~0 ms. Tests that assert a rate run with the floor disabled; the dedicated
// floor test below sets it explicitly.
tuning.minStreamMs = 0;

function makeHarness(cwd) {
  const handlers = {};
  const commands = {};
  const emitted = [];
  const statuses = [];
  const notices = [];
  const pi = {
    on: (event, fn) => {
      handlers[event] = fn;
      return () => {};
    },
    events: {
      emit: (channel, data) => emitted.push({ channel, data }),
      on: () => () => {},
    },
    registerCommand: (name, opts) => {
      commands[name] = opts;
    },
  };
  const ctx = {
    cwd,
    model: { id: "test/model-x" },
    sessionManager: {
      getSessionId: () => "test-session-abcdef123456",
    },
    ui: {
      setStatus: (key, text) => statuses.push({ key, text }),
      notify: (msg) => notices.push(msg),
    },
  };
  return { handlers, commands, emitted, statuses, notices, pi, ctx };
}

test("companion tracks a streaming reply into live + history files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tps-comp-"));
  const h = makeHarness(cwd);
  tpsMonitor(h.pi);

  const start = h.handlers.message_start;
  const update = h.handlers.message_update;
  const end = h.handlers.message_end;
  assert.ok(start && update && end, "lifecycle handlers registered");
  assert.ok(h.commands.tps, "/tps command registered");

  start({ message: { role: "assistant" } }, h.ctx);
  let live = JSON.parse(readFileSync(join(cwd, ".pi-web/tps-live.json"), "utf8"));
  assert.equal(live.state, "streaming");

  const delta = (text) => ({
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: {} },
  });
  update(delta("hello world, "), h.ctx);
  live = JSON.parse(readFileSync(join(cwd, ".pi-web/tps-live.json"), "utf8"));
  assert.equal(live.state, "streaming");
  assert.ok(live.chars > 0);
  assert.ok(live.approxTps >= 0);
  assert.ok(
    h.emitted.some((e) => e.channel === "tps:live"),
    "live event emitted",
  );

  end(
    {
      message: {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 50, output: 120, cacheRead: 0, cacheWrite: 0, totalTokens: 170, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [{ type: "text", text: "done" }],
      },
    },
    h.ctx,
  );
  const lines = readFileSync(join(cwd, ".pi-web/tps-history.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const sample = JSON.parse(lines[0]);
  assert.equal(sample.output, 120);
  assert.equal(sample.model, "test/model-x");
  assert.equal(sample.approx, false);
  assert.ok(sample.tps > 0);
  assert.ok(sample.ttftMs >= 0, "ttft observed");
  assert.equal(sample.stalled, false);
  assert.equal(sample.cacheRead, 0);
  assert.equal(sample.streamed, true);
  assert.equal(sample.status, "ok");
  assert.equal(sample.sessionId, "test-session-abcdef123456");
  live = JSON.parse(readFileSync(join(cwd, ".pi-web/tps-live.json"), "utf8"));
  assert.equal(live.state, "idle");
  assert.equal(live.last.output, 120);
  assert.ok(
    h.emitted.some((e) => e.channel === "tps:sample"),
    "sample event emitted",
  );
  assert.ok(h.statuses.length > 0);
});

test("replayed message without deltas is recorded unstreamed with tps 0", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tps-replay-"));
  const h = makeHarness(cwd);
  tpsMonitor(h.pi);
  h.handlers.message_start({ message: { role: "assistant" } }, h.ctx);
  // no message_update: provider flushed the whole message at once
  h.handlers.message_end(
    {
      message: {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 5, output: 313, cacheRead: 0, cacheWrite: 0, totalTokens: 318, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [{ type: "text", text: "bulk" }],
      },
    },
    h.ctx,
  );
  const sample = JSON.parse(readFileSync(join(cwd, ".pi-web/tps-history.jsonl"), "utf8"));
  assert.equal(sample.streamed, false);
  assert.equal(sample.tps, 0);
  assert.equal(sample.ttftMs, -1);
  assert.equal(sample.status, "ok");
});

test("failed request is recorded with status failed", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tps-fail-"));
  const h = makeHarness(cwd);
  tpsMonitor(h.pi);
  h.handlers.message_start({ message: { role: "assistant" } }, h.ctx);
  h.handlers.message_end(
    {
      message: {
        role: "assistant",
        stopReason: "aborted",
        usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [],
      },
    },
    h.ctx,
  );
  const sample = JSON.parse(readFileSync(join(cwd, ".pi-web/tps-history.jsonl"), "utf8"));
  assert.equal(sample.status, "failed");
  assert.equal(sample.stopReason, "aborted");
  assert.ok(h.statuses.some((s) => s.text === "⚠ aborted"));
});

test("sessionId works with this-dependent getSessionId and env fallback", () => {
  for (const mgr of [
    { sessionId: "cls-1234567890", getSessionId() { return this.sessionId; } },
    undefined,
  ]) {
    const cwd = mkdtempSync(join(tmpdir(), "tps-sess-"));
    const h = makeHarness(cwd);
    if (mgr !== undefined) h.ctx.sessionManager = mgr;
    else delete h.ctx.sessionManager;
    tpsMonitor(h.pi);
    h.handlers.message_start({ message: { role: "assistant" } }, h.ctx);
    h.handlers.message_update(
      { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: {} } },
      h.ctx,
    );
    h.handlers.message_end(
      {
        message: {
          role: "assistant",
          stopReason: "stop",
          usage: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          content: [{ type: "text", text: "x" }],
        },
      },
      h.ctx,
    );
    const sample = JSON.parse(readFileSync(join(cwd, ".pi-web/tps-history.jsonl"), "utf8"));
    if (mgr !== undefined) assert.equal(sample.sessionId, "cls-1234567890");
    else assert.equal(typeof sample.sessionId, "string");
  }
});

test("stall flag trips on inter-token gaps", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tps-stall-"));
  const h = makeHarness(cwd);
  tpsMonitor(h.pi);
  const usage = { input: 1, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const msg = (text) => ({
    message: { role: "assistant", stopReason: "stop", usage, content: [{ type: "text", text }] },
  });
  const delta = (text) => ({
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: {} },
  });
  const prev = tuning.stallThresholdMs;
  tuning.stallThresholdMs = 1;
  try {
    h.handlers.message_start({ message: { role: "assistant" } }, h.ctx);
    h.handlers.message_update(delta("a"), h.ctx);
    await new Promise((r) => setTimeout(r, 10));
    h.handlers.message_update(delta("b"), h.ctx);
    h.handlers.message_end(msg("ab"), h.ctx);
  } finally {
    tuning.stallThresholdMs = prev;
  }
  const sample = JSON.parse(readFileSync(join(cwd, ".pi-web/tps-history.jsonl"), "utf8"));
  assert.equal(sample.stalled, true);
});

test("/tps history reports samples without a crash", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "tps-cmd-"));
  const h = makeHarness(cwd);
  tpsMonitor(h.pi);
  // seed one sample via lifecycle
  h.handlers.message_start({ message: { role: "assistant" } }, h.ctx);
  h.handlers.message_update(
    {
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial: {} },
    },
    h.ctx,
  );
  h.handlers.message_end(
    {
      message: {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 1, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [{ type: "text", text: "x" }],
      },
    },
    h.ctx,
  );
  await h.commands.tps.handler("5", h.ctx);
  assert.ok(h.notices.length === 1);
  assert.match(h.notices[0], /t\/s/);
  await h.commands.tps.handler("totals", h.ctx);
  assert.match(h.notices[1], /avg/);
  await h.commands.tps.handler("models", h.ctx);
  assert.match(h.notices[2], /avg/);
  await h.commands.tps.handler("turns 5", h.ctx);
  assert.match(h.notices[3], /No turns yet/);
  // seed a turn, then check /tps tools ranks slowest first
  h.handlers.turn_start({ turnIndex: 0, timestamp: Date.now() }, h.ctx);
  h.handlers.tool_execution_end({ toolCallId: "a", toolName: "read", args: {}, result: null, isError: false, durationMs: 50 }, h.ctx);
  h.handlers.tool_execution_end({ toolCallId: "b", toolName: "bash", args: {}, result: null, isError: false, durationMs: 900 }, h.ctx);
  h.handlers.turn_end({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [], messageEntryId: "m", toolResultEntryIds: [], entries: [], continue: false, context: {}, outcome: "completed" }, h.ctx);
  await h.commands.tps.handler("tools 5", h.ctx);
  assert.match(h.notices[4], /bash[\s\S]*most expensive tools/);
});

test("turn lifecycle logs one step row with llm + tool split", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tps-turn-"));
  const h = makeHarness(cwd);
  tpsMonitor(h.pi);
  const usage = { input: 20, output: 40, cacheRead: 8, cacheWrite: 0, totalTokens: 60, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  h.handlers.turn_start({ turnIndex: 3, timestamp: Date.now() }, h.ctx);
  h.handlers.message_start({ message: { role: "assistant" } }, h.ctx);
  h.handlers.message_update(
    { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: {} } },
    h.ctx,
  );
  h.handlers.message_end(
    { message: { role: "assistant", stopReason: "toolUse", usage, content: [{ type: "text", text: "hi" }] } },
    h.ctx,
  );
  h.handlers.tool_execution_end({ toolCallId: "a", toolName: "bash", args: {}, result: null, isError: false, durationMs: 1200 }, h.ctx);
  h.handlers.tool_execution_end({ toolCallId: "b", toolName: "read", args: {}, result: null, isError: true, durationMs: 50 }, h.ctx);
  h.handlers.turn_end({ type: "turn_end", turnIndex: 3, message: {}, toolResults: [], messageEntryId: "m", toolResultEntryIds: [], entries: [], continue: false, context: {}, outcome: "completed" }, h.ctx);
  const lines = readFileSync(join(cwd, ".pi-web/tps-turns.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const turn = JSON.parse(lines[0]);
  assert.equal(turn.turnIndex, 3);
  assert.equal(turn.output, 40);
  assert.equal(turn.streamed, true);
  assert.equal(turn.tools.length, 2);
  assert.equal(turn.toolMsTotal, 1250);
  assert.equal(turn.toolErrors, 1);
  assert.equal(turn.outcome, "completed");
  assert.equal(turn.sessionId, "test-session-abcdef123456");
});

test("turn accumulates every message, not just the last", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tps-acc-"));
  const h = makeHarness(cwd);
  tpsMonitor(h.pi);
  const usageFor = (output) => ({ input: 10, output, cacheRead: 0, cacheWrite: 0, totalTokens: 10 + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  h.handlers.turn_start({ turnIndex: 0, timestamp: Date.now() }, h.ctx);
  h.handlers.message_start({ message: { role: "assistant" } }, h.ctx);
  h.handlers.message_update({ message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a", partial: {} } }, h.ctx);
  h.handlers.message_end({ message: { role: "assistant", stopReason: "stop", usage: usageFor(100), content: [{ type: "text", text: "a" }] } }, h.ctx);
  h.handlers.message_start({ message: { role: "assistant" } }, h.ctx);
  h.handlers.message_update({ message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "b", partial: {} } }, h.ctx);
  h.handlers.message_end({ message: { role: "assistant", stopReason: "stop", usage: usageFor(200), content: [{ type: "text", text: "b" }] } }, h.ctx);
  h.handlers.turn_end({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [], messageEntryId: "m", toolResultEntryIds: [], entries: [], continue: false, context: {}, outcome: "completed" }, h.ctx);
  const lines = readFileSync(join(cwd, ".pi-web/tps-turns.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const turn = JSON.parse(lines[0]);
  assert.equal(turn.llmMessages, 2);
  assert.equal(turn.output, 300);
  assert.equal(turn.input, 20);
  assert.ok(turn.llmDurationMs >= 2);
  assert.ok(turn.tps > 0);
});

test("turn records requested tools from toolUse blocks, flagging uncompleted ones", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tps-req-"));
  const h = makeHarness(cwd);
  tpsMonitor(h.pi);
  const usage = { input: 10, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 60, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  h.handlers.turn_start({ turnIndex: 1, timestamp: Date.now() }, h.ctx);
  h.handlers.message_start({ message: { role: "assistant" } }, h.ctx);
  h.handlers.message_update({ message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: {} } }, h.ctx);
  h.handlers.message_end({
    message: {
      role: "assistant",
      stopReason: "toolUse",
      usage,
      content: [{ type: "toolCall", id: "1", name: "bash" }, { type: "toolCall", id: "2", name: "read" }],
    },
  }, h.ctx);
  h.handlers.tool_execution_end({ toolCallId: "1", toolName: "bash", args: {}, result: null, isError: false, durationMs: 100 }, h.ctx);
  h.handlers.turn_end({ type: "turn_end", turnIndex: 1, message: {}, toolResults: [], messageEntryId: "m", toolResultEntryIds: [], entries: [], continue: false, context: {}, outcome: "completed" }, h.ctx);
  const lines = readFileSync(join(cwd, ".pi-web/tps-turns.jsonl"), "utf8").split("\n").filter(Boolean);
  const turn = JSON.parse(lines[lines.length - 1]);
  assert.equal(turn.requestedTools, 2);
  assert.equal(turn.tools.length, 1);
});

test("the /tps description advertises every subcommand the handler implements", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tps-desc-"));
  const h = makeHarness(cwd);
  tpsMonitor(h.pi);
  const desc = h.commands.tps.description;
  assert.ok(desc, "description present");

  // Every sub === "x" branch in the handler must be named in the description a
  // user sees in autocomplete, or the help silently falls behind the code.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "companion.ts"), "utf8");
  const subs = [...new Set([...src.matchAll(/sub === "([a-z]+)"/g)].map((m) => m[1]))];
  assert.ok(subs.length >= 8, `expected to find subcommand branches, found ${subs.length}`);
  const missing = subs.filter((s) => !desc.includes(`/tps ${s}`));
  assert.deepEqual(missing, [], `description is missing: ${missing.join(", ")}`);
});
