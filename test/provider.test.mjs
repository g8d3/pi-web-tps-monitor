import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import tpsMonitor, { tuning } from "../dist/companion.js";
import { normalizeTurn } from "../dist/browser/protocol.js";

// The route is part of the measurement: the same model on another provider has a different
// price and a different first-token latency (measured and published in the route matrix at
// https://focalis.cc/audit/routes/). v0.10.8 records which provider served each turn.

tuning.minStreamMs = 0;

function makeHarness(cwd) {
  const handlers = {};
  const pi = {
    on: (event, fn) => {
      handlers[event] = fn;
      return () => {};
    },
    events: { emit: () => {}, on: () => () => {} },
    registerCommand: () => {},
  };
  const ctx = {
    cwd,
    model: { id: "test/model-x" },
    sessionManager: { getSessionId: () => "provider-session-abcdef" },
    ui: { setStatus: () => {}, notify: () => {} },
  };
  return { handlers, ctx, pi };
}

function runTurn(h, provider) {
  h.handlers.turn_start({ turnIndex: 0, timestamp: Date.now() }, h.ctx);
  h.handlers.message_start({ message: { role: "assistant" } }, h.ctx);
  h.handlers.message_update(
    { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "PONG", partial: {} } },
    h.ctx,
  );
  h.handlers.message_end(
    {
      message: {
        role: "assistant",
        stopReason: "stop",
        ...(provider ? { provider } : {}),
        usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [{ type: "text", text: "PONG" }],
      },
    },
    h.ctx,
  );
  h.handlers.turn_end({ turnIndex: 0, outcome: "completed" }, h.ctx);
  return JSON.parse(readFileSync(join(h.ctx.cwd, ".pi-web/tps-turns.jsonl"), "utf8").trim().split("\n").pop());
}

test("the turn row records the provider that served it", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tps-provider-"));
  const h = makeHarness(cwd);
  tpsMonitor(h.pi);
  const row = runTurn(h, "opencode-go");
  assert.equal(row.provider, "opencode-go");
  assert.equal(row.model, "test/model-x", "the model is unchanged");
});

test("a turn with no provider on the message omits the field (pre-v24 shape)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tps-provider-none-"));
  const h = makeHarness(cwd);
  tpsMonitor(h.pi);
  const row = runTurn(h, undefined);
  assert.equal("provider" in row, false, "absent, not an empty string");
});

test("normalizeTurn keeps a recorded provider and rejects a non-string one", () => {
  const base = {
    ts: "2026-10-18T00:00:00.000Z",
    sessionId: "s",
    model: "m",
    turnIndex: 0,
    llmDurationMs: 10,
    ttftMs: 1,
    input: 1,
    output: 1,
    tps: 1,
    streamed: true,
    approx: false,
    tools: [],
    toolMsTotal: 0,
    turnMsTotal: 20,
    outcome: "completed",
    toolErrors: 0,
  };
  assert.equal(normalizeTurn({ ...base, provider: "dashscope" }).provider, "dashscope");
  assert.equal(normalizeTurn(base).provider, undefined);
  assert.equal(normalizeTurn({ ...base, provider: 7 }), undefined, "a non-string provider is not a row");
});
