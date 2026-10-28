# Handoff after an external PI WEB restart (read this first, then act)

## What happened
- `e095-tps-monitor` v11 is DONE and pushed: main @ `fa65bd1`.
- 87/87 tests pass (`npm test` in `e095-tps-monitor/`).
- The daemon was restarted EXTERNALLY to serve the new plugin revision
  (browser bundles only load under the active revision; a rebuild alone 404s).
- You are a fresh agent in session `Revisa el plugin TPS de pi`
  (cwd `/home/vuos/code/p4`). The repo is the source of truth.

## Root causes found and fixed (your checks)
1. **Channel storm (fixed, proven):** first snapshot frame carried ~500 KB in
   one `send()` → host dropped it → reopen loop at ~11/s. Fixed with 50-row
   chunks + 10 s open throttle. Steady state: ONE watch channel, polls backed
   off to 15 s keepalive, `● live` dot on.
2. **Out-of-order snapshot (fixed):** start frame carries
   `historyTotal`/`turnsTotal`; incomplete snapshots fall back to fetch.
3. **500 → 1 shrink (fixed, needs your confirmation):** after minutes open the
   list collapsed to 1 row. Prime suspect: the companion's rotation rewrote
   the JSONL with truncate+write, so a concurrent server read observed a torn
   (near-empty) file and the panel replaced good state with it. Fixes (both
   in this build, either alone would do):
   - rotation is atomic (tmp file + rename, never truncate-in-place);
   - every read path merges (`mergeSamples`/`mergeTurns` in protocol.ts):
     state only ever grows toward the 500 cap, never shrinks.

## Verify now (in order)
1. Plugin revision live: `activeRevision==desiredRevision`,
   `restartRequired: false`, health healthy, via `/api/plugins`.
2. TPS tab loads (PI WEB `p4 / master · main`): headline shows a rate,
   **`● live` dot present**, Turn column with `#N` badges, legend table.
3. **500-row persistence (the main check):** reload → `Page 1 of 50
   (500 rows)`. Leave the panel open 3+ minutes WITH streaming activity
   (the shrink needed concurrent writes), re-check the DOM count. Must stay
   at/near 500 — never collapse to a handful of rows. Some rotation churn at
   exactly 500 is normal; a collapse is the bug.
4. Push quiet: `journalctl --user -u pi-web-sessiond --since "5 minutes ago" |
   grep -c "channels/watch"` should be ~1 per open panel, not ~100/min.
5. Re-screenshot the 4 views (desktop 1280 + mobile 390) into
   `e095-tps-monitor/docs/screenshots/` as `v11-live-*.png` (replace the
   pre-fix shots only if the UI matches).
6. Quick mobile pass (390×844): Fleet Cost visible without scroll, no
   page-level overflow.

## Then report to the user (in English, one verdict sentence first)
- What the screenshots prove, server URLs + PIDs, what remains open
  (known: `needs.json` removed; budgets persist; apiVersion 3 deprecation
  warning is upstream noise, migration to v5 is future work).
- Commit + push any new screenshots. Leave PI WEB running.
- Do NOT restart the daemon again unless a rebuild changed `dist/` —
  and then use `docs/restart-resume.sh` + a new handoff like this one.
