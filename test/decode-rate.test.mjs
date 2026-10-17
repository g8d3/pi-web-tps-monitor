// N9: decode rate must measure generation speed over the post-first-token window,
// not the blended window. A slow provider (long TTFT) is not a slow decoder.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { decodeRateOf, normalizeSample, UNKNOWN_TTFT } from "../dist/browser/protocol.js";

test("decodeRateOf measures output over the post-TTFT window", () => {
  // 600 output tokens, first token at 1000ms, total 3000ms => decode window 2000ms
  assert.equal(decodeRateOf({ output: 600, durationMs: 3000, ttftMs: 1000 }), 300);
  // Blended tps over the full window would be 600/3 = 200, a different number.
});

test("decodeRateOf prefers the stored field when present", () => {
  assert.equal(decodeRateOf({ output: 10, durationMs: 1000, ttftMs: 900, decodeTps: 123 }), 123);
});

test("decodeRateOf is UNKNOWN when the decode window is empty", () => {
  // First token at/after the end => no measured decode span.
  assert.equal(decodeRateOf({ output: 10, durationMs: 1000, ttftMs: 1000 }), UNKNOWN_TTFT);
  // Negative/absent TTFT falls back to the full window (nothing to subtract).
  assert.equal(decodeRateOf({ output: 100, durationMs: 2000, ttftMs: -1 }), 50);
});

test("normalizeSample backfills decodeTps for a streamed v2 row", () => {
  const s = normalizeSample({
    ts: "2026-10-17T00:00:00.000Z", model: "deepseek-v4.1-flash", input: 10, output: 300,
    durationMs: 1500, tps: 200, approx: false, ttftMs: 500, stalled: false,
    cacheRead: 0, cacheWrite: 0, streamed: true, status: "ok", stopReason: "stop", sessionId: "s",
  });
  assert.equal(s.decodeTps, 300);
});
