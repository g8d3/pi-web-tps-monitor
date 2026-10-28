# TPS Monitor — improvement backlog (photo review, 2026-10-28)

Status: **reviewed, not implemented**. Photo review of all four panel views
(Messages / Turns / Tools / Fleet) on desktop (~1280px) and mobile (390×844)
is done; screenshots live in `docs/screenshots/`. Next agent: pick the top
item, implement with tests, bump CHANGELOG, ship as v0.10.10+.

## Screenshot inventory (`docs/screenshots/`)

| File | What it proves |
|---|---|
| `m-tps-messages.png` | Mobile Messages fits (Time/Model/Out/t/s/TTFT); ~80% rows `–` unrated |
| `m-tps-turns.png` | Mobile Turns fits, but LLM column is all `–`; Pre ~2s everywhere |
| `m-tps-tools.png` | Mobile Tools fits; sort buttons wrap; sub-second calls read `0.0s` |
| `m-tps-fleet.png` | Mobile Fleet needs h-scroll; Cost/Waste/Ctx hidden right |
| `desktop-messages-right.png` | Right-scrolled Messages: t/s, Dec, TTFT `– – –` on ~90% rows, Hit 98–100% |
| `desktop-fleet-right.png` | Right-scrolled Fleet: Cost $0.0014–$0.19, Waste bare counts, Ctx 1–25% |
| `desktop-turns.png` | Turns LLM column all `–`, header showed live 144 t/s at the same time |
| `desktop-tools.png` | bash dominates: 376 calls, 1252s; caption "471 call(s) from 500 turn(s)" |

Live workspace at review time: `.pi-web/tps-history.jsonl` and
`.pi-web/tps-turns.jsonl` both at the 500-row cap; 5 sessions; model
`muse-spark-1.3-contributor` via `opencode-go`.

## P0 — data correctness (do first)

### TPS-01 Count tool-call streaming toward `streamed`
Problem: `message_update` only counts `text_delta`/`thinking_delta`, so turns
that stream mostly tool calls record `streamed:false, tps:0`. Photos prove it:
~90% of Messages rows unrated, Turns LLM column all dashes, headline stuck on
"last was replayed", sparkline nearly empty — all one root cause.
Fix: count any assistant update (including tool-call deltas) toward
`deltas`; keep the `minStreamMs` floor.
Accept: same workload yields a majority of rated rows; new test pins a
tool-call-only stream as rated.

### TPS-02 Fleet quietly biased by the 500-row / 2 MiB cap
Both JSONL files were exactly at cap during review, so Fleet = "last N rows",
not the session. Either persist a small per-session rollup (msgs, turns,
cost, waste) alongside the JSONL, or stamp the visible window in the UI
("last 500 messages").
Accept: Fleet states its window, or numbers survive rotation.

### TPS-03 `needs.json` honesty
It declares `history_file`, `max_history_rows`, `default_budget_usd`, but the
code hardcodes its own constants and the README admits the plugin ignores the
file. Read it or delete it (repo rule: config, never hardcode — or no fake config).

### TPS-04 Budgets survive restarts
Spend history is disk-backed; the `$5` cap lives in a `Map` and forgets on
restart. Persist per session (one small JSON file).
Accept: set budget, restart daemon, `/tps budget` still reports it.

## P1 — desktop UX (photo-grounded)

### TPS-05 Incremental panel fetch
The panel refetches history-500 + turns-500 (~500 KB) every 2 s while open.
Add an `after: ts` cursor to the server peer; back off when the tab is idle.
Accept: steady-state poll transfers only new rows.

### TPS-06 Headline shows the last *rated* message
In 4 of 6 desktop shots the headline reads "`⚡ –` last was replayed" — the
steady state is the uninformative state. Show last rated; demote "replayed"
to the subline.

### TPS-07 Turns LLM seconds always shown
Turns LLM column is a dash column in both form factors. Show LLM seconds
always; dash only the rate. Same for the `/tps turns` line.

### TPS-08 Fleet: money columns must not need scrolling
Cost / Waste / Ctx sit right of a horizontal scroll on desktop and are
effectively invisible on mobile. Move Cost left (after t/s) on desktop; see
TPS-16 for mobile.

### TPS-09 Unrated-count caption in Messages
Right-scrolled Messages shows `– – –` with 98–100% cache hits and no
explanation. Add: "N of last 10 unrated: tool-only turns don't stream text"
(temporary — TPS-01 shrinks N, the caption explains the rest).

### TPS-10 Sub-second tool precision + `ask_user 0.0s` question
Mobile Tools shows `0.0s`/`0.1s` for everything fast; render ms under 1 s.
Separately, `ask_user` (2 calls, waits on a human) totals `0.0s` — verify what
`durationMs` means for waiting-on-human tools; if it excludes wait time, say
so in the Tools caption.

## P2 — mobile (390 px photos)

### TPS-16 Fleet mobile: Sess + Cost + Waste first
Phone Fleet keeps all 9 columns and scrolls; the money the tab exists to show
is off-screen. Apply the `tps-narrow-hide` treatment Fleet currently lacks:
keep Sess/Cost/Waste visible, hide the rest (still reachable by scroll).

### TPS-17 Touch targets ≥ 44 px
Session/tool jump buttons, `+` expanders, Prev/Next are dense text buttons
(photo: easy to miss-tap). Minimum 44 px hit area; expanders keep position.

### TPS-18 Sort toggle wraps
"478 call(s) from 500 turn(s), sorted [Newest-first] / [Slowest-first]" —
`Slowest-first` drops to its own line. Keep the segmented control on one line
(full-width on narrow) so it reads as one control.

### TPS-19 Headline + subline wrap cost
On 390 px the headline ("126 t/s last (muse-spark-1.3-contri…)") plus the
two-line "Last: 591 out tokens…" subline push tables far down. Cap the model
name shorter on narrow (e.g. 12 ch) and single-line the subline key facts.

### TPS-20 Zero page-level overflow regression test
v9/v10 phone fixes held in the photos (in-container scroll only). Pin it: a
test or check script asserting no `document.scrollingElement.scrollWidth >
innerWidth + 1` at 390 px with 500 rows loaded.

## P3 — polish

- TPS-11 Workspace label staleness: nav showed `⚡ –` while the panel showed
  183 t/s a minute later (label refreshes only on panel fetch). Own
  lightweight poll or an age indicator.
- TPS-12 Filter goes live on input (debounced); placeholder adapts per view
  ("model, session or tool" promises tool filtering in Messages, where it
  matches nothing).
- TPS-13 Sparkline faint ticks for unrated rows so density survives TPS-01's
  absence and complements it afterwards.
- TPS-14 Fleet Waste bare counts (`2`, `3`) are unpriced wasted turns — label
  them ("2 unpriced" + tooltip), not a naked number.
- TPS-15 One-click Export/Download of `tps-turns.jsonl` from Fleet (audit
  intake funnel in one click; the preview link is already there).
- TPS-21 Dead CSS (`border-bottom: 1px solid #888` overridden by the
  `color-mix` line), screen-reader text for the sparkline, non-color-only
  stall/waste marks.
- TPS-22 `slugOf` strips accents — Spanish first prompts degrade worse than
  English ones; keep unicode letters.
- TPS-23 `server.ts` has no tests (limit clamping, corrupt-line skip,
  `live.last` normalization). Companion is pinned (67 tests); the peer isn't.
- TPS-24 Fleet shows message-derived cost while `/tps cost` also quotes
  turn-derived spend — they diverge after rotation. Name one canonical per
  surface.
- TPS-25 Turns `#0` row in mobile photo: turnIndex 0 among #1–#7 suggests an
  unnumbered/pre-history turn leaking in; check `turn_start` without index.

## Resume instructions (connection lost? start here)

1. `cd e095-tps-monitor && npm test` — expect 67 pass.
2. Implement topmost open item, add/extend the matching `test/*.test.mjs`.
3. CHANGELOG entry + version bump per repo habit (v0.10.x).
4. Rebuild (`npm run build`), re-screenshot the touched view at 1280 and 390
   (`agent-browser set viewport …`), compare with `docs/screenshots/`.
5. Commit + push to origin; leave PI WEB (PID 2023, port 8504) running.
