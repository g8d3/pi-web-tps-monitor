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

## Voice review round (2026-10-28, phone walkthrough)

The user walked the live panel on mobile and dictated findings. Verified
against `plugin-api.d.ts` / `server-plugin-api.d.ts` (pi-web 1.202610.6):

- **Push is feasible (TPS-26).** Both halves exist: browser
  `PluginPeer.openChannel(operation, input, options)` and server
  `openChannel(ctx) -> { receive, send, closed }` with `send()` pushing JSON
  frames. Panel could open a channel; the server peer (same machine,
  `machineSpecific`) `fs.watch`es the JSONL files and pushes new rows.
  Needs browser `apiVersion` 4 -> 5 + server peer channel handler. Refresh
  then becomes a manual fallback / connection indicator, not the data path.
- **Click-to-session is feasible (TPS-27).** `WorkspacePanelContext` carries
  `navigate: PluginNavigate`, and `PluginNavigationDestination` accepts
  `{ sessionId }` ("full, exact session ID", route failures surface in host
  UI). Rows already carry full session ids. The README claim ("host support
  … not exposed") is outdated — wire session buttons to
  `navigate({ sessionId })` and verify at runtime.
- **Cache-Hit and Secs columns already exist on desktop** (`Hit`, `Secs`)
  but both are `tps-narrow-hide`, i.e. invisible on the phone the user
  reviewed on. Several "missing data" complaints below are really this.

### TPS-26 Push instead of poll (major)
Panel opens a peer channel; server watches `.pi-web/tps-*.jsonl` and pushes
new rows. Polling + Refresh become fallback. Requires apiVersion 5, channel
on both ends, reconnect/backoff. Accept: no 2 s full refetch in steady state;
Refresh never disables during normal use.

### TPS-27 Session buttons navigate to the session
Use `context.navigate({ sessionId })` (full id, already on every row).
Accept: clicking a session cell in any view opens that session; failure
surfaces host-side, then keep filter-fallback.

### TPS-28 Collapse the headline into the table
The two headline paragraphs restate table row 1. Once Duration (TPS-40) and
Cache-Hit are visible everywhere, delete both paragraphs; keep one compact
status line (live state or last-rated rate). Accept: no duplicated numbers
between header and row 1.

### TPS-29 Row height / broken divider lines
Sess cells (wrapping session buttons) render taller than siblings and row
rules look cut. Fix: `vertical-align`, button `line-height`, no-wrap rules
for the label cells. Accept: uniform row heights at 1280 and 390 px.

### TPS-30 Legend, not scattered tips
Replace the tip paragraph with a compact legend (icons + one-line meaning
 each). Reword: `stalled` = "paused mid-stream > 3 s" (was misread),
`replay` = "replayed/buffered, not generated live, excluded from averages",
`failed` = provider/stop failure. Accept: every mark in the table resolves to
one legend row.

### TPS-31 Same-session visibility on mobile
Messages hides Sess < 640 px, so consecutive rows can't be attributed.
Keep a session chip on narrow (short label or 8-hex), or group rows under a
session subheader. Accept: on a phone, two adjacent rows show same/different
session without scrolling.

### TPS-32 Turn grouping in Messages
Record `turnIndex` on samples (the companion knows the current turn) and
show it as a badge; Messages filter already understands `#N` for turns —
extend it to messages. Show inter-row gap ("+3 s since previous") on
unrated follow-ups so chains read as chains. Accept: the 531-token row and
its replay follow-ups visibly belong together.

### TPS-33 One table or four? (decision: keep four, link them)
Views have different grain (message / turn / call / session); merging them
into one table duplicates or hides. Keep the four, but every row in every
view must answer "which turn / which session" (badges + existing jumps).
Document here; revisit only if TPS-32 badges prove insufficient.

### TPS-34 Turn Total must show its arithmetic
`turnMsTotal` is wall-clock (LLM stream + tools + pre-response + unexplained
gap). Users try to add the visible cells and fail (8.2 + 0.1 != 10.4).
Expander/tooltip must print the sum: `LLM + tools + pre + gap = total`, with
the gap named ("provider/harness wait"). Accept: every Total decomposes
without remainder.

### TPS-35 Sort buttons sit above the wrong table
"Newest-first / Slowest-first" render above "Most expensive tools" but sort
the call list below it. Move them next to the call list with a label ("Sort
call list:"). Accept: no control is separated from its table by another table.

### TPS-36 bash dominates Tools (research, document first)
376 calls / 1368 s / 15 errors makes the totals table one row that matters.
Breaking it down needs the command behind each call — check whether
`tool_execution_end` carries args; if yes, group by argv[0]. If no, file as
blocked-on-hook-data, don't guess. Document, don't build yet.

### TPS-37 Session names stay frozen (decision)
Slug is captured once from the first prompt; Pi session rename already wins
when set. Do NOT auto-update as the session evolves — Fleet history needs
stable identity. Long slugs wrap; allow CSS ellipsis + full name in tooltip
(already full id; add full name). Document here.

### TPS-38 Fleet columns labelled and completed
- "Done" -> "Completed" (turns with `outcome: completed`), with tooltip.
- Msgs ~= Turns is normal (usually 1 assistant message per turn); keep both,
  add tooltip for when they differ (multi-message turns).
- t/s header -> "avg t/s" (it is the mean over rated rows).
- Add LLM time next to tool time, plus wall span (first message -> last
  message): working time vs elapsed, as requested.
Accept: every Fleet header is self-explanatory or one hover away.

### TPS-39 Cost per model (minor)
Multi-model sessions mix prices; actuals already handle it per message.
Add a per-model cost split in the Fleet row expander/tooltip. Cheap, do with
TPS-38.

### TPS-40 Duration on every row, including mobile
`Secs` is `tps-narrow-hide` — phone users never see how long a message took.
Keep Secs visible on narrow (it is a short column) or fold it into the Time
cell title + legend. Accept: duration reachable on 390 px without scrolling.

## Resume instructions (connection lost? start here)

1. `cd e095-tps-monitor && npm test` — expect 67 pass.
2. Implement topmost open item, add/extend the matching `test/*.test.mjs`.
3. CHANGELOG entry + version bump per repo habit (v0.10.x).
4. Rebuild (`npm run build`), re-screenshot the touched view at 1280 and 390
   (`agent-browser set viewport …`), compare with `docs/screenshots/`.
5. Commit + push to origin; leave PI WEB (PID 2023, port 8504) running.
