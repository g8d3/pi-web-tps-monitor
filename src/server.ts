// Server peer: serves "live" and "history" reads from the workspace files the
// companion extension writes. No host capabilities required; the workspace
// projection in the request context carries the absolute path.
//
// TPS-26: "watch" opens a push channel. The server fs.watches the workspace
// .jsonl files and pushes fresh snapshots, so the panel stops refetching
// 500+500 rows every 2 s. Polling remains as the fallback.

import { readFileSync, watch } from "node:fs";
import { join } from "node:path";
import type { PiWebServerPlugin } from "@jmfederico/pi-web/server-plugin-api";
import type { JsonValue } from "@jmfederico/pi-web/server-plugin-api";
import { isTpsLive, normalizeSample, normalizeTurn, type TpsLive, type TpsSample, type TpsTurn } from "./browser/protocol.js";

const HISTORY_FILE = ".pi-web/tps-history.jsonl";
const TURNS_FILE = ".pi-web/tps-turns.jsonl";
const LIVE_FILE = ".pi-web/tps-live.json";
const MAX_LIMIT = 500; // matches companion MAX_HISTORY so the panel can see every row on disk
const WATCH_DEBOUNCE_MS = 750;
const MAX_WATCH_SNAPSHOTS = 200; // a channel that never closes still stops eventually

const UNKNOWN_LIVE: TpsLive = {
  state: "unknown",
  chars: 0,
  elapsedMs: 0,
  approxTps: 0,
  updatedAt: new Date(0).toISOString(),
};

export function readLive(root: string): TpsLive {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, LIVE_FILE), "utf8"));
    if (isTpsLive(parsed)) {
      if (parsed.last) {
        const last = normalizeSample(parsed.last);
        return last ? { ...parsed, last } : { ...parsed, last: undefined };
      }
      return parsed;
    }
  } catch {
    // missing or corrupt: fall through to unknown
  }
  return { ...UNKNOWN_LIVE };
}

function readJsonl<T>(root: string, file: string, limit: number, normalize: (v: unknown) => T | undefined): T[] {
  const n = Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
  try {
    const lines = readFileSync(join(root, file), "utf8").split("\n").filter(Boolean);
    const out: T[] = [];
    for (const line of lines.slice(-n)) {
      try {
        const row = normalize(JSON.parse(line) as unknown);
        if (row) out.push(row);
      } catch {
        // skip corrupt line
      }
    }
    return out.reverse(); // newest first for the panel
  } catch {
    return [];
  }
}

export function readHistory(root: string, limit: number, after?: string): TpsSample[] {
  const rows = readJsonl(root, HISTORY_FILE, limit, normalizeSample);
  return typeof after === "string" && after.length > 0 ? rows.filter((r) => r.ts > after) : rows;
}

export function readTurns(root: string, limit: number, after?: string): TpsTurn[] {
  const rows = readJsonl(root, TURNS_FILE, limit, normalizeTurn);
  return typeof after === "string" && after.length > 0 ? rows.filter((r) => r.ts > after) : rows;
}

function inputOf(input: unknown): { limit?: number; after?: string } {
  if (typeof input !== "object" || input === null) return {};
  const rec = input as Record<string, unknown>;
  return {
    ...(typeof rec.limit === "number" ? { limit: rec.limit } : {}),
    ...(typeof rec.after === "string" ? { after: rec.after } : {}),
  };
}

function snapshot(root: string, input: unknown): { live: TpsLive; history: TpsSample[]; turns: TpsTurn[] } {
  const { limit, after } = inputOf(input);
  return {
    live: readLive(root),
    history: readHistory(root, limit ?? 500, after),
    turns: readTurns(root, limit ?? 500, after),
  };
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

const plugin = {
  apiVersion: 3,
  name: "TPS Monitor",
  activate() {
    return {
      peer: {
        async request(context) {
          context.signal.throwIfAborted();
          const root = context.workspace.path;
          if (context.operation === "live") return toJson(readLive(root));
          if (context.operation === "history") {
            const { limit, after } = inputOf(context.input);
            return toJson(readHistory(root, limit ?? 20, after));
          }
          if (context.operation === "turns") {
            const { limit, after } = inputOf(context.input);
            return toJson(readTurns(root, limit ?? 50, after));
          }
          throw new Error(`Unknown tps operation: ${context.operation}`);
        },
        async openChannel(context) {
          if (context.operation !== "watch") throw new Error(`Unknown tps channel: ${context.operation}`);
          const root = context.workspace.path;
          const { limit } = inputOf(context.input);
          const cap = limit ?? MAX_LIMIT;
          let sent = 0;
          // Newest ts already delivered; later pushes carry only newer rows.
          let cursor = "";
          let timer: ReturnType<typeof setTimeout> | undefined;
          let watcher: ReturnType<typeof watch> | undefined;
          const track = (rows: Array<{ ts: string }>): void => {
            for (const r of rows) {
              if (r.ts > cursor) cursor = r.ts;
            }
          };
          // One bounded frame cannot carry 500 rows: overflow throws and kills
          // the channel. The snapshot goes out in small chunk frames instead.
          const CHUNK = 50;
          const pushFull = () => {
            if (context.signal.aborted) return;
            sent += 1;
            try {
              const snap = snapshot(root, { limit: cap });
              track(snap.history);
              track(snap.turns);
              context.send(toJson({ type: "snapshot-start", live: snap.live, historyTotal: snap.history.length, turnsTotal: snap.turns.length }));
              for (let i = 0; i < snap.history.length; i += CHUNK) {
                context.send(toJson({ type: "snapshot-part", kind: "history", rows: snap.history.slice(i, i + CHUNK) }));
              }
              for (let i = 0; i < snap.turns.length; i += CHUNK) {
                context.send(toJson({ type: "snapshot-part", kind: "turns", rows: snap.turns.slice(i, i + CHUNK) }));
              }
              context.send(toJson({ type: "snapshot-done" }));
            } catch {
              dispose();
            }
          };
          const push = () => {
            if (context.signal.aborted) return;
            sent += 1;
            if (sent > MAX_WATCH_SNAPSHOTS) {
              dispose();
              return;
            }
            try {
              const snap = snapshot(root, { limit: cap });
              const fresh = {
                live: snap.live,
                history: snap.history.filter((r) => r.ts > cursor),
                turns: snap.turns.filter((r) => r.ts > cursor),
              };
              track(snap.history);
              track(snap.turns);
              context.send(toJson({ type: "update", ...fresh }));
            } catch {
              dispose();
            }
          };
          const schedule = () => {
            if (timer !== undefined) return;
            timer = setTimeout(() => {
              timer = undefined;
              push();
            }, WATCH_DEBOUNCE_MS);
          };
          const dispose = () => {
            if (timer !== undefined) {
              clearTimeout(timer);
              timer = undefined;
            }
            try {
              watcher?.close();
            } catch {
              // already closed
            }
            watcher = undefined;
          };
          context.signal.addEventListener("abort", dispose, { once: true });
          try {
            watcher = watch(join(root, ".pi-web"), { persistent: false }, (_event, filename) => {
              if (
                filename === "tps-live.json" ||
                filename === "tps-history.jsonl" ||
                filename === "tps-turns.jsonl"
              ) {
                schedule();
              }
            });
            watcher.on("error", dispose);
          } catch {
            // unwatched workspace (read-only fs): single snapshot, then close
            pushFull();
            dispose();
            return { receive() {} };
          }
          pushFull(); // initial snapshot
          return {
            receive() {
              // browser-authored frames are keepalives; the server pushes.
            },
            close() {
              dispose();
            },
          };
        },
      },
    };
  },
} satisfies PiWebServerPlugin;

export default plugin;
