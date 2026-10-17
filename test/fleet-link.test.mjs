import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The panel is a lit-html template, so there is no DOM harness here: this asserts the
// shape in the source the same way the /tps description test does. What matters is that
// the link is (a) present, (b) only in the Fleet view, where the turn file is the subject,
// and (c) opened the way an external link has to be from inside the panel.
const src = readFileSync(new URL("../src/browser/index.ts", import.meta.url), "utf8");

test("the Fleet view links the free self-serve preview of the turn file", () => {
  assert.match(src, /focalis\.cc\/audit\/preview\//);
  const guard = src.indexOf("${isFleet");
  assert.ok(guard > 0, "the link must be rendered under an isFleet guard");
  const block = src.slice(guard, guard + 700);
  assert.match(block, /audit\/preview\//, "the link belongs to the Fleet branch");
  assert.match(block, /target="_blank"/, "external link must open in a new tab");
  assert.match(block, /rel="noopener"/, "external link must carry rel=noopener");
  assert.match(block, /tps-turns\.jsonl/, "say which file it reads");
});

test("no other view carries the link", () => {
  const hits = [...src.matchAll(/audit\/preview\//g)].length;
  assert.equal(hits, 1, `expected exactly one occurrence, found ${hits}`);
});
