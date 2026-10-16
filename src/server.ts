// Server peer: serves "live" and "history" reads from the workspace files the
// companion extension writes. No host capabilities required; the workspace
// projection in the request context carries the absolute path.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PiWebServerPlugin } from "@jmfederico/pi-web/server-plugin-api";
import type { JsonValue } from "@jmfederico/pi-web/server-plugin-api";
import { isTpsLive, normalizeSample, normalizeTurn, type TpsLive, type TpsSample, type TpsTurn } from "./browser/protocol.js";

const HISTORY_FILE = ".pi-web/tps-history.jsonl";
const TURNS_FILE = ".pi-web/tps-turns.jsonl";
const LIVE_FILE = ".pi-web/tps-live.json";
const MAX_LIMIT = 500; // matches companion MAX_HISTORY so the panel can see every row on disk

const UNKNOWN_LIVE: TpsLive = {
  state: "unknown",
  chars: 0,
  elapsedMs: 0,
  approxTps: 0,
  updatedAt: new Date(0).toISOString(),
};

function readLive(root: string): TpsLive {
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

function readHistory(root: string, limit: number): TpsSample[] {
  const n = Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
  try {
    const lines = readFileSync(join(root, HISTORY_FILE), "utf8").split("\n").filter(Boolean);
    const out: TpsSample[] = [];
    for (const line of lines.slice(-n)) {
      try {
        const sample = normalizeSample(JSON.parse(line) as unknown);
        if (sample) out.push(sample);
      } catch {
        // skip corrupt line
      }
    }
    return out.reverse(); // newest first for the panel
  } catch {
    return [];
  }
}

function readTurns(root: string, limit: number): TpsTurn[] {
  const n = Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
  try {
    const lines = readFileSync(join(root, TURNS_FILE), "utf8").split("\n").filter(Boolean);
    const out: TpsTurn[] = [];
    for (const line of lines.slice(-n)) {
      try {
        const turn = normalizeTurn(JSON.parse(line) as unknown);
        if (turn) out.push(turn);
      } catch {
        // skip corrupt line
      }
    }
    return out.reverse(); // newest first for the panel
  } catch {
    return [];
  }
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
            const input = context.input as { limit?: unknown };
            const limit = typeof input?.limit === "number" ? input.limit : 20;
            return toJson(readHistory(root, limit));
          }
          if (context.operation === "turns") {
            const input = context.input as { limit?: unknown };
            const limit = typeof input?.limit === "number" ? input.limit : 50;
            return toJson(readTurns(root, limit));
          }
          throw new Error(`Unknown tps operation: ${context.operation}`);
        },
      },
    };
  },
} satisfies PiWebServerPlugin;

export default plugin;
