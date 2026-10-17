import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import tpsMonitor, { DEFAULT_BUDGET_USD } from "../dist/companion.js";
import { sessionCostUsd } from "../dist/browser/models.js";

// Priced family: sonnet-4 matches "sonnet-4" -> $3/MTok in, $15/MTok out.
const PRICED_MODEL = "test/sonnet-4";

function makeHarness(cwd) {
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
    model: { id: PRICED_MODEL },
    sessionManager: { getSessionId: () => "budget-session-001" },
    ui: { setStatus: () => {}, notify: (msg) => notices.push(msg) },
  };
  return { handlers, commands, notices, pi, ctx };
}

function sendMessage(h, { input, output }) {
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
        usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [{ type: "text", text: "x" }],
      },
    },
    h.ctx,
  );
}

const warnings = (h) => h.notices.filter((m) => m.includes("💰") && (m.includes("80%") || m.includes("100%")));

test("sessionCostUsd totals one session, skipping others and counting unpriced", () => {
  const s = (over) => ({
    ts: "2026-10-17T00:00:00.000Z", model: "x/sonnet-4", input: 1_000_000, output: 0,
    durationMs: 1000, tps: 10, approx: false, ttftMs: 5, stalled: false,
    cacheRead: 0, cacheWrite: 0, streamed: true, status: "ok", stopReason: "stop",
    sessionId: "aaa", ...over,
  });
  const rows = [
    s({ sessionId: "aaa" }), // $3.00
    s({ sessionId: "aaa", output: 1_000_000 }), // $3 + $15 = $18
    s({ sessionId: "bbb" }), // other session: ignored
    s({ sessionId: "aaa", model: "muse-spark-1.3-contributor" }), // unpriced
  ];
  assert.deepEqual(sessionCostUsd(rows, "aaa"), { cost: 21, priced: 2, unpriced: 1 });
  assert.deepEqual(sessionCostUsd(rows, "zzz"), { cost: 0, priced: 0, unpriced: 0 });
});

test("/tps budget shows the default with zero spend, sets and rejects values", async () => {
  const h = makeHarness(mkdtempSync(join(tmpdir(), "tps-budget-")));
  tpsMonitor(h.pi);

  await h.commands.tps.handler("budget", h.ctx);
  assert.match(h.notices[0], new RegExp(`\\$${DEFAULT_BUDGET_USD.toFixed(2)}`));
  assert.match(h.notices[0], /\$0\.0000/);

  await h.commands.tps.handler("budget 0.5", h.ctx);
  assert.match(h.notices[1], /\$0\.50/);
  await h.commands.tps.handler("budget", h.ctx);
  assert.match(h.notices[2], /\$0\.50/);

  for (const bad of ["budget abc", "budget -3", "budget 0"]) {
    await h.commands.tps.handler(bad, h.ctx);
  }
  assert.match(h.notices[3], /Usage: \/tps budget/);
  await h.commands.tps.handler("budget", h.ctx);
  assert.match(h.notices[6], /\$0\.50/, "invalid values leave the budget unchanged");
});

test("companion warns once at 80% and once at 100% of session spend", () => {
  const h = makeHarness(mkdtempSync(join(tmpdir(), "tps-guard-")));
  tpsMonitor(h.pi);

  h.commands.tps.handler("budget 0.5", h.ctx);
  // $0.30 + $0.15 = $0.45 -> 90%: trips the 80% band only.
  sendMessage(h, { input: 100_000, output: 10_000 });
  assert.equal(warnings(h).length, 1);
  assert.match(warnings(h)[0], /80%/);

  // +$0.003 -> still under 100%: no repeat warning.
  sendMessage(h, { input: 1_000, output: 0 });
  assert.equal(warnings(h).length, 1);

  // +$1.80 -> over 100%: trips the 100% band once.
  sendMessage(h, { input: 100_000, output: 100_000 });
  assert.equal(warnings(h).length, 2);
  assert.match(warnings(h)[1], /100%/);

  // Further spend: no more warnings.
  sendMessage(h, { input: 100_000, output: 100_000 });
  assert.equal(warnings(h).length, 2);
});

test("unpriced models never trip the guardrail", () => {
  const h = makeHarness(mkdtempSync(join(tmpdir(), "tps-free-")));
  h.ctx.model = { id: "muse-spark-1.3-contributor" };
  tpsMonitor(h.pi);
  h.commands.tps.handler("budget 0.000001", h.ctx);
  sendMessage(h, { input: 5_000_000, output: 5_000_000 });
  assert.equal(warnings(h).length, 0);
});
