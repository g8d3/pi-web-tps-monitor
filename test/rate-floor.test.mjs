import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import tpsMonitor, { tuning } from "../dist/companion.js";

// v19 — a rate needs a window that covers the provider call. Pi's message_start
// sometimes fires at the first streamed chunk, collapsing the window to ~0 ms;
// dividing tokens by that window fabricates rates like 1000 t/s for a 3-token
// reply. Below the floor the row must be recorded as unrated, not as a rate.

function harness(cwd) {
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
    sessionManager: { getSessionId: () => "rate-floor-session" },
    ui: { setStatus: () => {}, notify: () => {} },
  };
  tpsMonitor(pi);
  return { handlers, ctx };
}

const delta = (text) => ({
  message: { role: "assistant" },
  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: {} },
});

const end = (text, output) => ({
  message: {
    role: "assistant",
    stopReason: "stop",
    usage: { input: 100, output, cacheRead: 0, cacheWrite: 0 },
    content: [{ type: "text", text }],
  },
});

function lastSample(cwd) {
  const rows = readFileSync(join(cwd, ".pi-web/tps-history.jsonl"), "utf8").split("\n").filter(Boolean);
  return JSON.parse(rows.at(-1));
}

test("a collapsed window yields no rate instead of a fabricated one", async () => {
  const prev = tuning.minStreamMs;
  tuning.minStreamMs = 50;
  try {
    const cwd = mkdtempSync(join(tmpdir(), "tps-floor-"));
    const h = harness(cwd);
    h.handlers.message_start({ message: { role: "assistant" } }, h.ctx);
    h.handlers.message_update(delta("PONG"), h.ctx);
    h.handlers.message_end(end("PONG", 3), h.ctx); // same tick: window ~0 ms
    const s = lastSample(cwd);
    assert.equal(s.streamed, false, "instant window is not a measured stream");
    assert.equal(s.tps, 0, "no rate from a window that cannot hold one");
    assert.equal(s.ttftMs, -1, "ttft from a collapsed window is not a measurement");
    assert.equal(s.output, 3, "tokens are still recorded");
  } finally {
    tuning.minStreamMs = prev;
  }
});

test("a real streaming window still yields a rate", async () => {
  const prev = tuning.minStreamMs;
  tuning.minStreamMs = 50;
  try {
    const cwd = mkdtempSync(join(tmpdir(), "tps-floor-ok-"));
    const h = harness(cwd);
    h.handlers.message_start({ message: { role: "assistant" } }, h.ctx);
    h.handlers.message_update(delta("PO"), h.ctx);
    await new Promise((r) => setTimeout(r, 80));
    h.handlers.message_update(delta("NG"), h.ctx);
    h.handlers.message_end(end("PONG", 4), h.ctx);
    const s = lastSample(cwd);
    assert.equal(s.streamed, true);
    assert.ok(s.tps > 0, `expected a rate, got ${s.tps}`);
    assert.ok(s.ttftMs >= 0 && s.ttftMs < s.durationMs);
  } finally {
    tuning.minStreamMs = prev;
  }
});
