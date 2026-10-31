import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// TPS-17 (touch targets) + TPS-20 (in-container scroll): pin the CSS rules in
// the built panel so the phone fixes cannot silently regress.

const dist = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "browser", "index.js"), "utf8");

test("panel CSS pins the phone fixes", () => {
  assert.match(dist, /overflow-x:\s*auto/, "tables scroll in-container, never the page");
  assert.match(dist, /min-height:\s*44px/, "coarse-pointer touch targets");
  assert.match(dist, /tps-narrow-hide/, "narrow-hide rule present");
  assert.match(dist, /max-width:\s*15ch/, "model ellipsis on narrow");
  assert.match(dist, /vertical-align:\s*middle/, "uniform row heights");
  assert.match(dist, /\.tps td button \{ min-height: 32px/, "dense table buttons on touch");
  assert.match(dist, /\.tps \.liveline/, "one-line live strip on mobile");
  assert.match(dist, /\.tps \.spark \{ height: 32px/, "short mobile sparkline");
});

test("the redundant header sections stay gone (TPS-42)", () => {
  // The owner asked for these to go: the last-message headline and the
  // "Last: N out tokens …" line repeated the newest table row, and a Refresh
  // button is dead weight next to a heartbeat-pushed channel.
  assert.doesNotMatch(dist, /\.tps \.headline/, "no idle headline duplicating row 1");
  assert.doesNotMatch(dist, /Last: \$\{last\.output\} out tokens/, "no duplicate last-message statusline");
  assert.doesNotMatch(dist, />\s*Refresh\s*</, "no manual Refresh button in the header");
  assert.match(dist, /liveline/, "the in-flight strip survives (the table has no in-flight row)");
  assert.match(dist, /Export turns/, "Export turns still exists, in the Fleet view where the preview lives");
});
