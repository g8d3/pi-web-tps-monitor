import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import plugin from "../dist/browser/index.js";

// TPS-42: the panel header. The last-message headline, the "Last: …" status
// line and the Refresh button all repeated what the table already showed, so
// they are gone; the in-flight strip stays because no table row exists until a
// message finishes. Rendering is exercised for real so a broken template or a
// removed-section regression fails here instead of on the owner's screen.

const dist = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "browser", "index.js"), "utf8");

/** A stand-in for lit's html tag: keeps strings/values so the tree can be read. */
function html(strings, ...values) {
  return { __tpl: true, strings, values };
}

function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) textOf(item, out);
    return out;
  }
  if (node.__tpl === true) {
    node.strings.forEach((s, i) => {
      out.push(s);
      if (i < node.values.length) textOf(node.values[i], out);
    });
    return out;
  }
  return out;
}

/** Every @click handler in the tree with the text that follows it. */
function handlers(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) handlers(item, out);
    return out;
  }
  if (node?.__tpl === true) {
    node.strings.forEach((s, i) => {
      const value = node.values[i];
      if (typeof value === "function" && s.includes("@click")) out.push({ handler: value, after: node.strings[i + 1] ?? "" });
      else handlers(value, out);
    });
  }
  return out;
}

function sample(ts, extra = {}) {
  return {
    ts, model: "m", input: 1, output: 2, durationMs: 100, tps: 20, approx: false,
    ttftMs: 10, stalled: false, cacheRead: 0, cacheWrite: 0, streamed: true,
    status: "ok", stopReason: "stop", sessionId: "s", ...extra,
  };
}

function makeWorkspace() {
  const cwd = mkdtempSync(join(tmpdir(), "tps-panel-"));
  mkdirSync(join(cwd, ".pi-web"), { recursive: true });
  writeFileSync(join(cwd, ".pi-web/tps-history.jsonl"), JSON.stringify(sample("2026-01-01T00:00:01.000Z")) + "\n");
  writeFileSync(join(cwd, ".pi-web/tps-turns.jsonl"), "");
  return cwd;
}

function harness(live) {
  const cwd = makeWorkspace();
  const frames = [];
  const rendered = [];
  const host = { requestRender: () => {} };
  const context = {
    machine: { id: "m" },
    workspace: { id: "w", projectId: "p", path: cwd },
    host,
    peer: {
      request: async (operation) => {
        if (operation === "live") return live;
        if (operation === "history") return [sample("2026-01-01T00:00:01.000Z")];
        return [];
      },
      openChannel: async (_operation, _input, options) => {
        // Behave like the real server: one chunked snapshot, then silence.
        const rows = [sample("2026-01-01T00:00:01.000Z")];
        options.onData({ type: "snapshot-start", live, historyTotal: rows.length, turnsTotal: 0 });
        options.onData({ type: "snapshot-part", kind: "history", rows });
        options.onData({ type: "snapshot-done" });
        return { closed: new Promise(() => {}), close: () => {}, send: () => {} };
      },
    },
    navigate: undefined,
  };
  const activation = plugin.activate({ html, svg: html, apiVersion: 4 });
  const panel = activation.contributions.workspacePanels[0];
  const render = (ctx = context) => {
    const tree = panel.render(ctx);
    rendered.push(tree);
    return tree;
  };
  return { cwd, context, frames, render, activation };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("streaming renders one live strip and nothing else redundant", async () => {
  const live = {
    state: "streaming", model: "muse-spark-1.3", chars: 400, elapsedMs: 4000,
    approxTps: 11, updatedAt: new Date().toISOString(), ttftMs: 300, stalled: false,
  };
  const { render } = harness(live);
  render(); // first render kicks off the fetch
  await tick();
  const text = textOf(render()).join("");
  assert.match(text, /t\/s streaming/, "in-flight rate is shown");
  assert.match(text, /● live/, "push channel is reported as live");
  assert.doesNotMatch(text, /STALLED/, "stall wording is the quiet marker now, not a shout");
  assert.doesNotMatch(text, /Refresh/, "no manual Refresh button");
  assert.doesNotMatch(text, /Export turns/, "Export left the header");
  assert.doesNotMatch(text, /Last: .* out tokens/, "no duplicate last-message line");
});

test("a quiet live row is labelled as quiet, not as current speed", async () => {
  const live = {
    state: "streaming", model: "muse-spark-1.3", chars: 400, elapsedMs: 4000,
    approxTps: 11, updatedAt: new Date(Date.now() - 9000).toISOString(), stalled: false,
  };
  const { render } = harness(live);
  render(); // first render kicks off the fetch
  await tick();
  const text = textOf(render()).join("");
  assert.match(text, /quiet \d+/, "age of the live row surfaces mid-stream");
});

test("idle renders the table without any repeated header block", async () => {
  const live = { state: "idle", model: "m", chars: 0, elapsedMs: 0, approxTps: 0, updatedAt: new Date().toISOString() };
  const { render } = harness(live);
  render(); // first render kicks off the fetch
  await tick();
  const text = textOf(render()).join("");
  assert.doesNotMatch(text, /t\/s streaming/, "no streaming strip while idle");
  assert.doesNotMatch(text, /⚡ 20 <small>t\/s last/, "no idle headline repeating row 1");
  assert.match(text, /Messages/, "view switcher present");
});

test("Export turns lives in the Fleet view and still works", async () => {
  const live = { state: "idle", model: "m", chars: 0, elapsedMs: 0, approxTps: 0, updatedAt: new Date().toISOString() };
  const { render } = harness(live);
  render();
  await tick();
  const tree = render();
  const fleet = handlers(tree).find((h) => h.after.startsWith(">Fleet<"));
  assert.ok(fleet, "Fleet button exists");
  fleet.handler();
  const fleetText = textOf(render()).join("");
  assert.match(fleetText, /Export turns/, "Export turns moved into the Fleet view");
});

test("the built panel keeps automatic reconnection wiring", () => {
  assert.match(dist, /PUSH_DEAD_MS/, "a silent channel is detected");
  assert.match(dist, /rewatch/, "and replaced instead of trusted");
  assert.match(dist, /○ polling/, "the strip says so when push is down");
});
