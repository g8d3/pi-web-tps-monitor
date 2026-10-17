import { strict as assert } from "node:assert";
import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appendLine, trimLog } from "../dist/companion.js";

function tmpFile() {
  return join(mkdtempSync(join(tmpdir(), "tps-log-")), "log.jsonl");
}

function rows(path) {
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

test("trimLog keeps the newest rows under the row cap", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `{"n":${i}}`);
  const kept = trimLog(lines, 3, 1_000_000);
  assert.deepEqual(kept, ['{"n":7}', '{"n":8}', '{"n":9}']);
});

test("trimLog never drops the newest row even past the byte cap", () => {
  const big = `{"pad":"${"x".repeat(5000)}"}`;
  const kept = trimLog(["small", big, big, big], 500, 1024);
  assert.deepEqual(kept, [big]);
});

test("appendLine caps rows at 500 and keeps the newest", () => {
  const path = tmpFile();
  for (let i = 0; i < 600; i++) appendLine(path, { n: i });
  const out = rows(path);
  assert.equal(out.length, 500);
  assert.equal(JSON.parse(out[0]).n, 100);
  assert.equal(JSON.parse(out.at(-1)).n, 599);
});

test("appendLine seeds its counter from an existing file", () => {
  const path = tmpFile();
  writeFileSync(path, Array.from({ length: 500 }, (_, i) => JSON.stringify({ n: -i })).join("\n") + "\n");
  for (let i = 0; i < 5; i++) appendLine(path, { n: i });
  const out = rows(path);
  assert.equal(out.length, 500, "existing rows must be counted, not ignored");
  assert.deepEqual(JSON.parse(out.at(-1)), { n: 4 });
});

test("appendLine rotates on the byte ceiling too", () => {
  const path = tmpFile();
  const chunk = "y".repeat(400_000); // ~0.4 MB per row
  for (let i = 0; i < 12; i++) appendLine(path, { i, chunk });
  assert.ok(statSync(path).size <= 2 * 1024 * 1024, `size ${statSync(path).size} over byte cap`);
  assert.equal(JSON.parse(rows(path).at(-1)).i, 11, "newest row survives rotation");
});

test("appendLine keeps a plain append cheap (no rotation before the cap)", () => {
  const path = tmpFile();
  for (let i = 0; i < 499; i++) appendFileSync(path, JSON.stringify({ n: i }) + "\n");
  const before = statSync(path).size;
  appendLine(path, { n: "tail" });
  assert.equal(statSync(path).size > before, true);
  assert.equal(rows(path).length, 500);
});
