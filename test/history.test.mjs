import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { isTpsLive, isTpsSample, normalizeSample } from "../dist/browser/protocol.js";
import { readHistory } from "../dist/companion.js";
import plugin from "../dist/server.js";

function sample(over = {}) {
  return {
    ts: "2026-10-16T03:00:00.000Z",
    model: "test/model",
    input: 100,
    output: 200,
    durationMs: 5000,
    tps: 40,
    approx: false,
    ...over,
  };
}

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "tps-"));
  mkdirSync(join(root, ".pi-web"), { recursive: true });
  return root;
}

function fakeContext(root, operation, input = null) {
  return {
    project: { id: "p1", name: "t", path: root },
    workspace: { id: "w1", projectId: "p1", path: root, label: "t", isMain: true },
    operation,
    input,
    signal: AbortSignal.timeout(5000),
  };
}

test("protocol guards accept good shapes, reject bad ones", () => {
  assert.equal(isTpsSample(sample()), true);
  assert.equal(isTpsSample({ ...sample(), tps: "fast" }), false);
  assert.equal(isTpsSample(null), false);
  assert.equal(
    isTpsLive({ state: "streaming", chars: 10, elapsedMs: 100, approxTps: 25, updatedAt: "x" }),
    true,
  );
  assert.equal(isTpsLive({ state: "bogus" }), false);
});

test("history normalizes v1 rows with defaults", () => {
  const root = makeWorkspace();
  const lines = [JSON.stringify(sample({ output: 1 })), "not-json{", JSON.stringify(sample({ output: 2 }))];
  writeFileSync(join(root, ".pi-web/tps-history.jsonl"), lines.join("\n") + "\n");
  const out = readHistory(root, 10);
  assert.equal(out.length, 2);
  assert.equal(out[1].output, 2);
  assert.deepEqual(readHistory(root, 1).map((s) => s.output), [2]);
  assert.equal(out[0].ttftMs, -1);
  assert.equal(out[0].stalled, false);
  assert.equal(out[0].cacheRead, 0);
});

test("v1 rows: fast bulk rows normalize to unstreamed, slow ones stay rated", () => {
  const fast = normalizeSample(sample({ output: 313, durationMs: 9 }));
  assert.equal(fast.streamed, false);
  assert.equal(fast.status, "ok");
  assert.equal(fast.sessionId, "");
  const slow = normalizeSample(sample({ output: 313, durationMs: 5000 }));
  assert.equal(slow.streamed, true);
});

test("server peer serves live + history, rejects unknown op", async () => {
  const root = makeWorkspace();
  const s = sample();
  writeFileSync(join(root, ".pi-web/tps-history.jsonl"), JSON.stringify(s) + "\n");
  writeFileSync(
    join(root, ".pi-web/tps-live.json"),
    JSON.stringify({ state: "idle", chars: 0, elapsedMs: 0, approxTps: 0, updatedAt: s.ts, last: s }),
  );
  const api = plugin.activate({});
  assert.ok(api.peer?.request);

  const live = await api.peer.request(fakeContext(root, "live"));
  assert.equal(live.state, "idle");
  assert.equal(live.last.output, 200);

  const hist = await api.peer.request(fakeContext(root, "history", { limit: 5 }));
  assert.ok(Array.isArray(hist));
  assert.equal(hist.length, 1);
  assert.equal(hist[0].tps, 40);

  const empty = await api.peer.request(fakeContext(makeWorkspace(), "history", { limit: 5 }));
  assert.deepEqual(empty, []);

  const noTurns = await api.peer.request(fakeContext(root, "turns", { limit: 10 }));
  assert.deepEqual(noTurns, []);

  await assert.rejects(api.peer.request(fakeContext(root, "nope")), /Unknown tps operation/);
});
