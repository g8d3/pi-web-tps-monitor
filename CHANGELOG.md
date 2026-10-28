# Changelog

## v0.11.0 — push, links and honest tables (TPS-01..40)

Photo review of all four views on desktop and phone (see `IMPROVEMENTS.md`
and `docs/screenshots/`) drove this release. 84 tests pass (67 before).

- **Push instead of poll (TPS-26).** The panel opens a `watch` channel; the
  server `fs.watch`es the workspace files and pushes only newer rows
  (`after` cursor, TPS-05). Polling is the fallback, Refresh is always
  clickable, and a `● live` dot shows the channel is open.
- **Sessions link (TPS-27).** Session cells call `navigate({sessionId})`
  with filter fallback. The old "host cannot do it" note was wrong.
- **90% of rows were fake replays (TPS-01).** `toolcall_delta` now counts as
  streaming evidence, so tool-only turns rate instead of showing `–`.
  Samples also carry `turnIndex`, and Messages shows a `#N` turn badge with
  `#N` filtering (TPS-32).
- **Turns add up (TPS-07/34).** LLM seconds always show; the Total cell and
  the expander print `LLM + tools + pre + gap = total`.
- **Fleet is about money (TPS-08/16/38/39).** Cost moves left of the scroll
  on desktop and stays visible on phones; new LLM/Span columns (working
  vs wall time); expandable per-model cost split; Done is Completed;
  avg t/s labelled; unpriced waste reads `N unpriced` (TPS-14).
- **Tools make sense (TPS-10/35/36).** Durations render `85ms`-style;
  sort controls sit with the call list they sort; tool-arg details
  (bash command head) surface in tooltips, expanders and `/tps tools`;
  server records them from `tool_execution_start` args.
- **Header shrunk to one status line (TPS-06/28)** showing the last *rated*
  message; Refresh + Export turns; sparkline draws faint ticks for unrated
  rows (TPS-09/13/15); compact legend table replaces scattered tips
  (TPS-30), including `#0 = first step` (TPS-25).
- **Phone (TPS-16..20).** Sess chip stays in Messages (TPS-31), Secs stays
  everywhere (TPS-40), 44 px touch targets, one-line sort toggle, full
  row-height/ellipsis rules, CSS pinned by `test/css.test.mjs`.
- **Config honesty (TPS-03/04).** `needs.json` is gone; budget caps persist
  in `.pi-web/tps-budgets.json` and survive restarts.
- Chat mirrors the panel: turn badges, gap arithmetic, per-model cost
  split, `translate`d waste labels. Slugs keep unicode letters (TPS-22).

## v0.10.9 — sessions have human names

Fleet, Messages, Turns, Tools and `/tps fleet` showed raw 8-hex session ids.
Each sample and turn row now carries a human label recorded at write time:
Pi's session name when the session was renamed, else a slug of the session's
first user prompt (`fix-fleet-cost-table`, ≤40 chars), else nothing and the
views fall back to the hash. Full ids stay in the cell tooltips and the
filter matches names as well as id prefixes. `test/session-label.test.mjs`
pins it: Pi name wins over slug, slug appears with no Pi name, rows stay
anonymous with neither, fleet/budget print the label. All 67 tests pass.

## v0.10.8 — the turn row says which route served it

The same model on a different provider has a different price and a different first-token
latency — measured on the providers we hold keys for and published at
<https://focalis.cc/audit/routes/> (input price up to 20.5x apart for one model; the cheapest
route 5.7x slower to first token than the fastest on another). Until now the monitor recorded
the model but not the route, so a panel could not tell `deepseek-v4.1-flash` served by
`opencode-go` from the same model served by `openrouter`.

Now every turn row carries `provider` (from the assistant message's own `provider` field),
`/tps turns` prints `… via <provider> …`, and the panel's Turns row tooltip names the model and
the route. Rows written before this version have no `provider` and render exactly as before.
`test/provider.test.mjs` pins the three shapes: recorded, absent (pre-v0.10.8), and rejected
when it is not a string.

## v0.10.7 — cost is the billed number, ctx windows match the registry

Fleet cost, `/tps cost`, `/tps fleet` and the budget guardrail used to
re-estimate spend from a hardcoded price table whose deepseek row was 12x too
high on live traffic ($6.94 shown vs $0.58 billed across 415 deepseek-v4.1-flash
messages in `.pi-web/tps-history.jsonl`) and whose context windows were 8x too
small (deepseek-v4.1-flash read 203% pressure vs 26% true; muse-spark showed `–`).
Each message row now carries Pi's own `usage.cost.total`, and every cost surface
sums those actuals — equal to the billed cost by construction, not by table
maintenance. Rows recorded before actuals existed fall back to a table
corrected against the bundled pi-ai registry (deepseek-v4.1-flash 1M ctx +
0.15/0.6/0.003, deepseek-v4-pro, muse-spark 1M ctx + 0.1/0.2/0.002, glm-5.x);
turn rows accumulate message actuals the same way. Repricing the same 500 live
rows with the fix totals $0.577 with zero rows over 100% ctx. `test/
cost-actuals.test.mjs` pins it: actuals beat the table, mixed turns fall back,
old-table fixtures now bill from the harness model. All 56 tests pass.

## v0.10.6 — the package can be installed with one command

A git install (`pi install git:github.com/g8d3/pi-web-tps-monitor`) previously produced a
package **without `dist/`**: the plugin declares `dist/companion.js`, `dist/browser/` and
`dist/server.js`, and nothing built them for the installer, so a fresh install loaded nothing.
`npm pack --dry-run` confirmed the published tarball would have been broken the same way
(22 files, no `dist/`).

Now `package.json` carries `"prepare": "npm run build"`. Verified: `npm pack --dry-run` runs
prepare and lists `dist/browser/index.js`, `dist/browser/models.js`, `dist/browser/protocol.js`,
`dist/companion.js`, `dist/server.js` in the tarball. README documents both install paths and the
npm 12 caveat: lifecycle scripts can be blocked, and the fix that was verified end to end is
`"allowScripts": ["pi-web-tps-monitor"]` in the consuming project (a fresh install then builds
`dist/`; `--allow-scripts` is rejected for project installs).

Still true and unchanged: the package is **not on npm** — `npm whoami` on this machine returns
401, so publishing needs a valid token.

## v0.10.5 — the Fleet view points at the free preview

The Fleet view reads `.pi-web/tps-turns.jsonl`; the same file is the input to the free
self-serve preview at <https://focalis.cc/audit/preview/> (parsed in the browser, nothing
uploaded). One line under the tip text, Fleet view only, so the number in the panel and the
offer that follows from it are one click apart. `test/fleet-link.test.mjs` pins the shape:
one occurrence, inside the `isFleet` branch, `target="_blank"` + `rel="noopener"`.


All notable changes to TPS Monitor. Versions follow the tags on `main`.

Measured numbers below come from our own runs and are cited with their source;
where a number is an assumption rather than a measurement, it says so.

## v0.10.4 — 2026-10-17

**The "unexplained" remainder no longer swallows the provider wait.**
`preResponseMs` (v0.10.2) measures the turn-start → first-token window, which
external measurement showed is the bulk of what `unaccountedMs` used to report
as unknown. `unaccountedMs()` now excludes that window when a turn row carries
it, so the ⚠ flag means *still* unexplained after LLM + tools + provider wait,
not "provider waited". Pre-v23 rows carry no `preResponseMs`, so their numbers
are unchanged. Tooltip wording updated to say what remains.

From the N3 startup-measurement subsession (5 reps, one-word reply): the
1.5–2.2 s "unaccounted" was the provider roundtrip, which pi attributes to
neither the model nor the harness — `message_start` fires only once the
response body is in hand, so `llmDurationMs` records stream duration (2 ms),
never time-to-first-byte. Process startup (~0.98 s) is real but sits *before*
the turn clock entirely.

## v0.10.3 — 2026-10-17

**A rate floor for very short replies, plus packaging honesty.** Replies whose
stream window collapsed below 50 ms (`tuning.minStreamMs`) were recorded as
unrated rather than as a fabricated rate — a 3-token reply had been reported as
1000 t/s because `message_start` can fire at the first streamed chunk,
collapsing the window to ~0 ms. Tokens are still recorded; only the rate is
withheld, and those rows are excluded from averages.

Same release: this repository gained a `CHANGELOG.md`, the version field was
bumped to match its tag (three earlier tags shipped without it), and the
install docs now describe building from a checkout instead of an npm package
that does not exist.

## v0.10.2 — 2026-10-17

**The provider roundtrip is now a column, not a mystery.** Adds `preResponseMs`
to each turn row: the window from turn start to the provider's first token.
Shown as a `Pre` column in the Turns view and a `pre` segment in `/tps turns`;
older rows and turns with no assistant message read as `–`.

This is the number the monitor could not previously see. `llmDurationMs` times
only the stream, so a network call looked like milliseconds — measured
externally (5 reps, one-word reply), the pre-response window is **1451 ms
median (1193–1605)** while the stream itself is 2 ms. Pi emits `message_start`
after the provider responds, so the roundtrip lands before the clock the
companion reads. No new hooks were needed: the companion already receives both
events.

Also fixes the Turns expander's `colspan`, left at 10 when a column was added
in v14 (the table is 13 columns wide).

## v0.10.1 — 2026-10-17

**A partial spend no longer poses as a session total.** A session mixing priced
and unpriced models used to show its priced subtotal as if it were the whole
spend. Every cost surface now treats a spend with unpriced messages in it as a
floor and says so: a trailing `+` in the Fleet cost cell (hover for the unpriced
share), a `NN% unpriced` note in `/tps cost` and `/tps fleet`, and the same
qualifier on `/tps budget` and the spend guardrail. A fully unpriced session
reads as `–`, never `$0.00`, because that would read as "free".

## v0.10.0 — 2026-10-17

**Two rates instead of one.** `tps` stays the blended rate over the whole
window — what a caller actually waits for — and a new `decodeTps` measures
generation speed after the first token landed (`output / (duration − ttft)`),
shown as a `Dec` column. A provider that is slow to respond is no longer scored
as a slow decoder. Rows without a TTFT fall back to the full window; a
zero-length decode window is unknown, never a fabricated rate.

## v0.9.0 — 2026-10-17

**Wasted spend is now visible.** Turns that failed, were aborted, or produced
no output still bill for their tokens. `turnWaste()` prices those turns from
their own rows and reports them as a Waste cell in the Fleet view, `waste` in
`/tps fleet`, and `N wasted ≈ $X (Y% of turn spend)` in `/tps cost`. Turns on
models with no list price are counted as turns, never as invented dollars.
`/tps cost` also reports turns when the message history is empty.

## v0.8.7 — 2026-10-17

**Cheaper appends, bounded files.** Every append used to re-read the whole
`.jsonl` just to count rows — measured at **762 µs of synchronous work per
assistant message and per turn**, versus **7.9 µs** for an append that keeps an
in-memory counter (≈100×). Appends now rotate only when a row or byte ceiling
(default 2 MiB) is crossed, so one turn with a large tool list can no longer
grow the file without bound. Also fixes a fabricated rate: a window under
`tuning.minStreamMs` is recorded unrated instead of reporting e.g. "1000 t/s"
for a three-token reply.

## Earlier

Versions through v0.8.6 added TTFT, stall and cache marking, per-turn step
rows, the Tools and Fleet views, per-model averages, session budgets, and the
context-pressure gauge. See `git log` for the full history.
