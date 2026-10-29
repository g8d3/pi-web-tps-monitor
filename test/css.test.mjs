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
});
