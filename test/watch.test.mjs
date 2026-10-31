import { strict as assert } from "node:assert";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { test } from "node:test";

import plugin from "../dist/server.js";

// TPS-41: the push channel must never be open-but-mute. The 0.11.0 code closed
// its own watcher after 200 snapshots (and on any send error) without ending the
// channel, so a long-lived tab showed `● live` while quietly polling every 15 s.

function makeWorkspace() {
  const cwd = mkdtempSync(join(tmpdir(), "tps-watch-"));
  mkdirSync(join(cwd, ".pi-web"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi-web/tps-history.jsonl"),
    JSON.stringify({
      ts: "2026-01-01T00:00:01.000Z", model: "m", input: 1, output: 2, durationMs: 100,
      tps: 20, approx: false, ttftMs: 10, stalled: false, cacheRead: 0, cacheWrite: 0,
      streamed: true, status: "ok", stopReason: "stop", sessionId: "s",
    }) + "\n",
  );
  writeFileSync(join(cwd, ".tps-live-placeholder"), "");
  return cwd;
}

function openWatch(cwd, onFrame) {
  const activation = plugin.activate({});
  const controller = new AbortController();
  const channel = activation.peer.openChannel({
    operation: "watch",
    input: { limit: 500 },
    scope: { kind: "workspace", project: { id: "p" }, workspace: { id: "w", path: cwd } },
    project: { id: "p" },
    workspace: { path: cwd },
    signal: controller.signal,
    send: (data) => onFrame(data),
  });
  return { channel, controller };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a fresh row is pushed within the debounce window", async () => {
  const cwd = makeWorkspace();
  const frames = [];
  const { channel, controller } = openWatch(cwd, (f) => frames.push(f));
  await channel;
  frames.length = 0; // drop the initial snapshot
  appendFileSync(join(cwd, ".pi-web/tps-live.json"), JSON.stringify({ state: "streaming", chars: 40, elapsedMs: 2000, approxTps: 20, updatedAt: new Date().toISOString() }));
  await sleep(1500);
  controller.abort();
  assert.ok(frames.some((f) => f.type === "update" && f.live.state === "streaming"), "file change produced an update frame");
});

test("the channel heartbeats while the files sit still", async () => {
  const cwd = makeWorkspace();
  const frames = [];
  const { channel, controller } = openWatch(cwd, (f) => frames.push(f));
  await channel;
  frames.length = 0;
  // No file writes at all: this is a stream thinking between deltas, the exact
  // moment the old channel went silent and the panel froze.
  await sleep(2600);
  controller.abort();
  assert.ok(frames.filter((f) => f.type === "update").length >= 1, "heartbeat pushed the live row with no file change");
});

test("a refused frame ends the channel instead of leaving it mute", async () => {
  const cwd = makeWorkspace();
  const activation = plugin.activate({});
  let sent = 0;
  const channel = await activation.peer.openChannel({
    operation: "watch",
    input: { limit: 500 },
    scope: { kind: "workspace", project: { id: "p" }, workspace: { id: "w", path: cwd } },
    project: { id: "p" },
    workspace: { path: cwd },
    signal: new AbortController().signal,
    send: () => {
      sent += 1;
      throw new Error("bounded transport refused the frame");
    },
  });
  // closed must settle so the host closes the transport and the panel reconnects.
  await channel.closed;
  assert.ok(sent >= 1, "at least one frame was attempted");
});

test("the channel has no snapshot lifetime cap", async () => {
  // 0.11.0 stopped pushing after 200 snapshots (~2.5 min of activity) and
  // closed only its watcher, leaving the transport open forever. Reaching 200
  // heartbeats takes 7 minutes, so pin the absence of the counter instead, and
  // prove the channel outlives the debounce window under sustained writes.
  const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js"), "utf8");
  assert.doesNotMatch(server, /MAX_WATCH_SNAPSHOTS/, "no snapshot counter that silently stops the channel");
  assert.match(server, /resolveClosed/, "the channel can end itself, so the browser learns to reconnect");
  assert.match(server, /HEARTBEAT_MS/, "a heartbeat keeps the live row moving without file writes");

  const cwd = makeWorkspace();
  const frames = [];
  const { channel, controller } = openWatch(cwd, (f) => frames.push(f));
  await channel;
  for (let i = 0; i < 12; i += 1) {
    appendFileSync(join(cwd, ".pi-web/tps-live.json"), JSON.stringify({ state: "idle", chars: 0, elapsedMs: 0, approxTps: 0, updatedAt: new Date().toISOString() }));
    await sleep(800);
  }
  controller.abort();
  assert.ok(frames.filter((f) => f.type === "update").length >= 5, "still pushing after a sustained burst of writes");
});
