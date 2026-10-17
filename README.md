# TPS Monitor for PI WEB + Pi

Live **tokens/sec**, **TTFT**, per-turn step timing and per-tool costs — in the
terminal and in a PI WEB workspace tab. A Pi companion extension measures every
assistant message and agent turn; a PI WEB plugin renders it.

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
Opening a PI WEB session or chat position from the tab needs host support that
PI WEB's plugin API does not expose yet — the rows are ready for it.

## Reading the numbers

- **Cost is an estimate, not an invoice.** It comes from the indicative list
  price of each model (see `src/browser/models.ts`). A model we have no price for
  contributes nothing to the number.
- **A trailing `+` means the cost is a floor, not a total.** Some messages in that
  session ran on a model with no list price, so the real spend is at least the
  figure shown. Hover the cell for the unpriced share. A session that is *entirely*
  unpriced shows `–` rather than a number, because `$0.00` would read as "free".
- **The budget guardrail is a floor too**, for the same reason: it warns off the
  priced part of your spend and tells you what share it left out.
- **Dec vs blended t/s.** `Dec` is decode tok/s — generation speed measured from
  the first token onward, so a slow provider is not scored as a slow decoder.
  Without `Dec` the rate is blended and includes time-to-first-token.
- **Wasted turns** are turns that failed, were aborted, or produced no output.
  Their tokens were still billed, so they show a cost even though nothing shipped.

## Install

In PI WEB: **Settings → Pi packages → install** `npm:pi-web-tps-monitor`,
then **Settings → PI WEB plugins → enable TPS Monitor**, restart the session
daemon when safe (`systemctl --user restart pi-web-sessiond`), reload the
browser. New sessions pick up the companion automatically; `/reload` an idle
session to add it to a live one.

Terminal only: `pi --extension ./dist/companion.js`, then `/tps`.

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
