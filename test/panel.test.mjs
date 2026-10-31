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

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "browser");
const dist = readFileSync(join(distDir, "index.js"), "utf8");
const distPaired = readFileSync(join(distDir, "paired.js"), "utf8");

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
  const rows = [sample("2026-01-01T00:00:01.000Z")];
  const rendered = [];
  const seen = { requests: [], sockets: [], opens: [] };
  const host = { requestRender: () => {} };
  // No context.peer: the split panel must reach the backend over the paired
  // proxy (plain HTTP + WebSocket), like it does in the real host.
  const context = {
    machine: { id: "m" },
    workspace: { id: "w", projectId: "p", path: cwd },
    host,
    navigate: undefined,
  };
  globalThis.location = { protocol: "http:", host: "h" };
  globalThis.fetch = async (url, opts) => {
    const text = String(url);
    const payload = text === "/api/plugins"
      ? { plugins: [{ id: "tps-monitor", server: { activeRevision: "rev-test" } }] }
      : null;
    if (payload) {
      const body = JSON.stringify(payload);
      return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
    }
    const body = JSON.parse(opts.body);
    if (body.revision !== "rev-test") throw new Error("panel must send the backend's active revision");
    const op = text.slice(text.lastIndexOf("/") + 1);
    seen.requests.push(op);
    const data = op === "live" ? live : op === "history" ? rows : op === "turns" ? [] : null;
    const encoded = JSON.stringify(data);
    return { ok: true, status: 200, text: async () => encoded, json: async () => JSON.parse(encoded) };
  };
  globalThis.WebSocket = class {
    constructor(url) {
      seen.sockets.push(String(url));
      this.handlers = {};
      setTimeout(() => {
        this.emit("open");
        // Behave like the real server: ready, one chunked snapshot, then silence.
        this.emit("message", { data: JSON.stringify({ version: 1, kind: "ready" }) });
        this.emit("message", { data: JSON.stringify({ version: 1, kind: "data", data: { type: "snapshot-start", live, historyTotal: rows.length, turnsTotal: 0 } }) });
        this.emit("message", { data: JSON.stringify({ version: 1, kind: "data", data: { type: "snapshot-part", kind: "history", rows } }) });
        this.emit("message", { data: JSON.stringify({ version: 1, kind: "data", data: { type: "snapshot-done" } }) });
      }, 0);
    }
    addEventListener(event, fn) {
      (this.handlers[event] ??= []).push(fn);
    }
    emit(event, arg) {
      for (const fn of this.handlers[event] ?? []) fn(arg);
    }
    send(frame) {
      seen.opens.push(String(frame));
    }
    close() {
      this.emit("close");
    }
  };
  const activation = plugin.activate({ html, svg: html, apiVersion: 4 });
  const panel = activation.contributions.workspacePanels[0];
  const render = (ctx = context) => {
    const tree = panel.render(ctx);
    rendered.push(tree);
    return tree;
  };
  return { cwd, context, seen, render, activation };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("streaming adds nothing above the tables (owner: the table is enough)", async () => {
  const live = {
    state: "streaming", model: "muse-spark-1.3", chars: 400, elapsedMs: 4000,
    approxTps: 11, updatedAt: new Date().toISOString(), ttftMs: 300, stalled: false,
  };
  const { render } = harness(live);
  render(); // first render kicks off the fetch
  await tick();
  const text = textOf(render()).join("");
  assert.doesNotMatch(text, /t\/s streaming/, "no live strip while streaming");
  assert.doesNotMatch(text, /quiet \d+/, "no staleness line");
  assert.doesNotMatch(text, /● live|○ polling/, "no push indicator above the table");
  assert.doesNotMatch(text, /Refresh/, "no manual Refresh button");
  assert.doesNotMatch(text, /Export turns/, "Export left the header");
  assert.doesNotMatch(text, /Last: .* out tokens/, "no duplicate last-message line");
  assert.match(text, /Messages/, "the view switcher is the first thing offered");
});

test("idle and streaming render the same header shape", async () => {
  const streaming = harness({
    state: "streaming", model: "m", chars: 40, elapsedMs: 1000, approxTps: 9,
    updatedAt: new Date().toISOString(), stalled: true,
  });
  const idle = harness({ state: "idle", model: "m", chars: 0, elapsedMs: 0, approxTps: 0, updatedAt: new Date().toISOString() });
  streaming.render();
  idle.render();
  await tick();
  const strip = (tree) => {
    const parts = textOf(tree).join("").split("</style>")[1] ?? "";
    return parts.split("<p")[0].trim();
  };
  assert.equal(strip(streaming.render()), strip(idle.render()), "the live state never adds a block above the tables");
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
  assert.doesNotMatch(dist, /○ polling/, "no push-state text above the table: silent recovery only");
});

test("the split panel reaches the backend over the paired proxy, never an in-process peer", async () => {
  const live = { state: "idle", model: "m", chars: 0, elapsedMs: 0, approxTps: 0, updatedAt: new Date().toISOString() };
  const { render, seen } = harness(live);
  render(); // first render kicks off fetch + channel
  await tick();
  await tick();
  assert.ok(seen.requests.includes("live"), "reads via paired POST: " + seen.requests.join(","));
  assert.ok(seen.requests.includes("history"), "reads via paired POST: " + seen.requests.join(","));
  assert.ok(seen.sockets.some((u) => u.includes("/channels/watch")), "watch opens over the paired WebSocket route");
  assert.ok(seen.opens.some((f) => f.includes('"kind":"open"') && f.includes('"revision":"rev-test"')), "channel handshake carries the open envelope with the backend revision");
  const text = textOf(render()).join("");
  assert.match(text, /Messages/, "the table renders from proxy data");
  assert.match(distPaired, /paired-plugin-backends/, "the built panel calls the proxy, not context.peer");
  assert.match(distPaired, /\/channels\/watch/, "watch opens over the paired WebSocket route");
});
