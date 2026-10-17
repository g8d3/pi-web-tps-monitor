import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appendLine, trimLog } from "../dist/companion.js";

const CAP = 5;
const BYTES = 1000;

test("trimLog keeps the newest lines under both ceilings", () => {
  const lines = ["a", "b", "c", "d", "e", "f", "g"];
  assert.deepEqual(trimLog(lines, CAP, BYTES), ["c", "d", "e", "f", "g"]);
  assert.deepEqual(trimLog(["a", "b"], CAP, BYTES), ["a", "b"]);
  assert.deepEqual(trimLog([], CAP, BYTES), []);
});

test("trimLog stops at the byte ceiling before the row ceiling", () => {
  const row = "x".repeat(100);
  const lines = Array.from({ length: 10 }, () => row);
  // 9 rows fit in 1000 bytes (909 + newlines); the row cap of 5 binds first here.
  assert.equal(trimLog(lines, CAP, BYTES).length, CAP);
  const big = Array.from({ length: 4 }, () => "y".repeat(400));
  const kept = trimLog(big, 100, BYTES);
  assert.equal(kept.length, 2); // 400+1 each: third would exceed 1000
  assert.equal(kept[0], big[2]);
  assert.equal(kept[1], big[3]);
});

test("trimLog always keeps at least one row, even over the byte ceiling", () => {
  const huge = "z".repeat(5000);
  assert.deepEqual(trimLog(["old", huge], CAP, BYTES), [huge]);
});

test("appendLine rotates at the row cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "tps-rot-"));
  const path = join(dir, "rows.jsonl");
  for (let i = 0; i < 501; i++) appendLine(path, { i });
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 500);
  assert.deepEqual(JSON.parse(lines[0]), { i: 1 });
  assert.deepEqual(JSON.parse(lines[499]), { i: 500 });
});

test("appendLine rotates at the byte cap, keeping the newest rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "tps-rotb-"));
  const path = join(dir, "rows.jsonl");
  const blob = (i) => ({ i, pad: "p".repeat(900 * 1024) });
  appendLine(path, blob(1));
  appendLine(path, blob(2));
  assert.ok(statSync(path).size > 1_800_000, "two rows stay under the cap");
  appendLine(path, blob(3));
  const size = statSync(path).size;
  assert.ok(size < 2 * 1024 * 1024, `rotated file is under the cap (${size})`);
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  assert.deepEqual(lines.map((l) => JSON.parse(l).i), [2, 3]);
});
