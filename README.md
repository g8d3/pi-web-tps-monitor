# TPS Monitor for PI WEB + Pi

Live **tokens/sec**, **TTFT**, per-turn step timing and per-tool costs — in the
terminal and in a PI WEB workspace tab. A Pi companion extension measures every
assistant message and agent turn; a PI WEB plugin renders it.

Built for [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), the
terminal coding agent, and [PI WEB](https://www.npmjs.com/package/@jmfederico/pi-web), its
browser UI. Free and MIT licensed.

## Quick start

```bash
pi install git:github.com/g8d3/pi-web-tps-monitor
```

Then type `/tps` in any Pi session. In PI WEB, enable **TPS Monitor** in
**Settings → PI WEB plugins** and open the `TPS` tab. Details and troubleshooting are in
[Install](#install).

## What you get

| Surface | Details |
|---|---|
| PI WEB `TPS` tab — Messages | Live tok/s while streaming, last-message stats, sparkline, filterable + paginated history (filter by model, session or `#turn`). TTFT, **decode tok/s (generation speed after the first token)**, cache-hit %, STALL / FAIL / replay marks. |
| PI WEB `TPS` tab — Turns | One row per agent step: LLM slice (time, blended tok/s, **decode tok/s**, TTFT) vs tool slice, totals, outcome. Rows expand to the tool breakdown. |
| PI WEB `TPS` tab — Tools | Every tool call, newest- or slowest-first, plus most-expensive-tools totals. |
| PI WEB `TPS` tab — Fleet | Per-session rollup: messages, turns, done, avg t/s, tool time, estimated cost (**`+` marks a floor**, see [Reading the numbers](#reading-the-numbers)), **wasted turns + their cost**, context pressure. |
| Workspace label | Glanceable `⚡ 42 t/s` next to the workspace name. |
| Chat `/tps` | `/tps [n]`, `/tps live`, `/tps totals`, `/tps models`, `/tps turns [n]`, `/tps tools [n]`, `/tps fleet`, `/tps cost`, `/tps budget [usd]` (session spend cap, default $5). Warns in chat at 80%/95% context pressure and at 80%/100% of session spend. `/tps cost` and Fleet report wasted spend (failed, aborted or empty turns, priced from turn rows). |

Sessions, turns and tools link to each other inside the tab (filter/expand/jump).
Sessions show Pi's session name when set, else a slug of the session's first
prompt, else the 8-hex id (full id in the cell tooltip; filter matches names).
Opening a PI WEB session or chat position from the tab needs host support that
PI WEB's plugin API does not expose yet — the rows are ready for it.

## Fleet monitoring and the retainer

This repo is the **instrument**. It measures continuously and writes machine-
readable rows to your workspace — `.pi-web/tps-history.jsonl` (per message),
`.pi-web/tps-turns.jsonl` (per turn) and `.pi-web/tps-live.json` (the live
stream) — and the Fleet tab rolls those up per session. A supervisor can read
those files directly to review another agent's work; no agent access is needed.

The **retainer ("Fleet Tax Monitoring") is a human service sold alongside this
tool**, not a feature of it. Knowing which rows matter, and what counts as a
regression, is judgement — so the tool measures and the service watches:

| Retainer deliverable | Backed by this tool | Human service |
|---|---|---|
| Wall floor per loop | yes — turn rows carry `turnMsTotal` + tool/LLM split | sets the baseline, decides the floor |
| Cache-hit rate | yes — per message, plus the STALL/FAIL marks | trend it, judge a bad month |
| Share of turns that failed / produced nothing | yes — the Waste column and `/tps cost` | define the threshold, explain the cause |
| Spend by session | yes — Fleet cost, `/tps budget`, the `+` floor marker | reconcile against your invoice |
| Context pressure vs each window | yes — Fleet Ctx column, 80/95% chat warnings | pick the compaction policy |
| **Alert on a >20% regression vs baseline** | **no** — nothing here stores a baseline or alerts across time | **yes — this is the service** |
| Quarterly re-measurement + regression script | no — the monitor is not a benchmark harness | yes — the service |

Read it that way: if you want the numbers, this tool gives them to you for free
and forever. If you want someone to tell you when they get worse, and what to do
about it, that is the retainer.

## Where the numbers come from, and who to hire

Every claim in this README is measured, and the measurement is public: the working
paper (65 runs across 3 harnesses, plus 500 turns from our own live fleet), the raw
CSV and the analysis script are at **<https://focalis.cc/tps/>**, and the offer page
for the audit and the retainer is at **<https://focalis.cc/audit/>** (with a
calculator you can run on your own numbers — it will tell you not to buy if the
numbers do not support it).

That paper also retracts three mechanisms we used to sell (cache discipline,
startup-scan scoping, a size coefficient) because they failed to reproduce in our
own data. We mention it here because it is the same standard this README is held to.

**The file this plugin writes is the input to a free self-serve preview**: drop your
`<workspace>/.pi-web/tps-turns.jsonl` into <https://focalis.cc/audit/preview/> and it
decomposes the turns in your browser (pre-response, stream, tools, residual, tail,
wasted turns) and uploads nothing. It also matches the model names in your file against
the route matrix we measure (<https://focalis.cc/audit/routes/>) and tells you, per model,
whether the same one is sold on another route we measured and how far its price and its
first token move — including the cases where the list price is identical on both routes
and only the latency differs. If you want the part the file cannot see — the process
boot before the first event, and a before/after series on your own loops — that is the
audit: what to send is at <https://focalis.cc/audit/intake/>.

Contact: **hello@focalis.cc**.

## Reading the numbers

- **Cost is the billed number, not a re-estimate.** Each message row carries
  Pi's own `usage.cost.total` (provider registry pricing — the same math behind
  the session footer), and every cost surface sums those actuals. Rows recorded
  before actuals existed fall back to the table in `src/browser/models.ts`,
  which tracks the pi-ai registry bundled with Pi; a model with neither an
  actual nor a table price contributes nothing.
- **A trailing `+` means the cost is a floor, not a total.** Some messages in that
  session have neither a recorded actual nor a list price, so the real spend is
  at least the figure shown. Hover the cell for the unpriced share. A session that is *entirely*
  unpriced shows `–` rather than a number, because `$0.00` would read as "free".
- **The budget guardrail is a floor too**, for the same reason: it warns off the
  priced part of your spend and tells you what share it left out.
- **The route is in the row.** Every turn records the `provider` that served it
  (`… via opencode-go` in `/tps turns`, named in the panel's row tooltip), because the same
  model costs different amounts and answers at different speeds depending on where it enters —
  measured in the published route matrix: <https://focalis.cc/audit/routes/>.
- **Dec vs blended t/s.** `Dec` is decode tok/s — generation speed measured from
  the first token onward, so a slow provider is not scored as a slow decoder.
  Without `Dec` the rate is blended and includes time-to-first-token.
- **Wasted turns** are turns that failed, were aborted, or produced no output.
  Their tokens were still billed, so they show a cost even though nothing shipped.

## Install

Two paths, both one command.

**As a Pi package (recommended).** Pi installs the package's dependencies and runs its
`prepare` script, which builds `dist/`:

```bash
pi install git:github.com/g8d3/pi-web-tps-monitor
```

If your npm blocks lifecycle scripts (npm 12 does this by default in some configurations, and
`--allow-scripts` is rejected for project installs), allow this package in the consuming
project and reinstall — verified working:

```json
{ "allowScripts": ["pi-web-tps-monitor"] }
```

If the install finishes without a build, `npm run build` inside the installed package is the
fallback.

**From a local checkout** (what this workspace uses):

```bash
git clone https://github.com/g8d3/pi-web-tps-monitor && cd pi-web-tps-monitor
npm install && npm run build
```

`dist/` is not committed — the plugin loads built artifacts (`dist/companion.js`,
`dist/browser/`, `dist/server.js`), so a checkout must be built once (the `prepare` script
does it for you).

> The package is **not on npm yet** — `npm:pi-web-tps-monitor` is the intended name for when
> it is published. `npm pack` now builds `dist/` into the tarball (`prepare`), so the published
> package would work; publishing needs a valid npm token, which this machine does not have
> (`npm whoami` → 401).

Then add that directory as a Pi package in **Settings → Pi packages**, and
enable **TPS Monitor** in **Settings → PI WEB plugins**.

Then restart the session daemon when safe (`systemctl --user restart
pi-web-sessiond`) and reload the browser. New sessions pick up the companion
automatically; `/reload` an idle session to add it to a live one.

Terminal only: `pi --extension ./dist/companion.js`, then `/tps`.

`needs.json` is local machine configuration (host, port, file names) and is
intentionally not part of the public mirror. The plugin does not read it: it
defines its own constants, e.g. `DEFAULT_BUDGET_USD` in `src/companion.ts`.

See [CHANGELOG.md](CHANGELOG.md) for what each release changed.

## How it works

- `src/companion.ts` — Pi extension. Tracks `message_start/update/end`,
  `turn_start/end` and `tool_execution_end`; writes `.pi-web/tps-live.json`,
  `.pi-web/tps-history.jsonl` and `.pi-web/tps-turns.jsonl` in the workspace.
- `src/server.ts` — server peer serving `live`, `history` and `turns` reads.
- `src/browser/index.ts` — workspace panel + label.
- `src/browser/protocol.ts` — shared shapes with back-compatible normalization.
- `src/browser/models.ts` — context limits + indicative prices for known model families; unknown models show `–` instead of invented numbers.

Live rates during streaming are estimated from streamed chars (`chars/4`);
final rates use provider `usage.output / duration`. Rows with no observed
streaming (replays, buffered flushes — e.g. 313 tokens in 9ms) are recorded
with `streamed: false`, show `–`/`↺` and are excluded from every average.
Failed requests (`error`/`aborted`) are recorded with `✗` and also excluded.

History and turn logs are capped by rows (500) and by size (`max_history_bytes`,
default 2 MiB). The cap is enforced with an in-memory counter seeded from disk,
so a normal append is a plain write — the file is re-read only when rotation is
due, not on every message.

The JSONL files are the machine-readable API: a supervisor agent can read them
straight from the workspace to review another agent's work. Cross-workspace
fleets are a supervisor-side file read: each workspace keeps its own
`.pi-web/tps-*.jsonl`, so a watchdog with filesystem access can aggregate
`sessions × workspaces` with the same `fleetStats` math for provider-headroom
and cost-per-outcome decisions.

Context pressure (`input + cacheRead` vs the model's window) is estimated,
not measured against the live context: treat the 80%/95% bands as an early
warning, not a precise gauge.

## Develop

```bash
npm install
npm run build   # tsc -> dist/
npm test        # node --test
```

## License

MIT
