# Handoff after an external PI WEB restart (read this first, then act)

## What happened
- `e095-tps-monitor` v11 is DONE and pushed: main @ `0b7ce64`.
- 84/84 tests pass (`npm test` in `e095-tps-monitor/`).
- The daemon was restarted EXTERNALLY to serve the new plugin revision
  (browser bundles only load under the active revision; a rebuild alone 404s).
- You are a fresh agent in session `Revisa el plugin TPS de pi`
  (cwd `/home/vuos/code/p4`). The repo is the source of truth.

## Root causes found and fixed (your checks)
1. **Channel storm (fixed, proven):** first snapshot frame carried ~500 KB in
   one `send()` → host dropped it → reopen loop at ~11/s. Fixed with 50-row
   chunks + 10 s open throttle. Post-fix steady state: ONE watch channel,
   polls backed off to 15 s keepalive, `● live` dot on.
2. **1-row panel (fixed, needs your confirmation):** after minutes with an
   open panel the list shrank 500 → 1. Diagnosis: frames can arrive out of
   order / get dropped, so `snapshot-done` applied a partial accumulation and
   clobbered good state. Fix (in this build): the start frame carries
   `historyTotal`/`turnsTotal`; the browser only applies a complete snapshot
   and otherwise forces a full fetch (which provably works).

## Verify now (in order)
1. Plugin revision live: `activeRevision==desiredRevision`,
   `restartRequired: false`, health healthy, via `/api/plugins`.
2. TPS tab loads (PI WEB `p4 / master · main`): headline shows a rate,
   **`● live` dot present**, Turn column with `#N` badges, legend table.
3. **500-row persistence (the main check):** reload the page → expect
   `Page 1 of 50 (500 rows)`. Leave the panel open 2+ minutes (streaming
   activity helps), re-check via DOM (`tbody tr` count + `Page 1 of 50`).
   It must stay 500 — no shrink to 1.
4. Push quiet: `journalctl --user -u pi-web-sessiond --since "5 minutes ago" |
   grep -c "channels/watch"` should be ~1 per open panel, not ~100/min.
5. Re-screenshot the 4 views (desktop 1280 + mobile 390) into
   `e095-tps-monitor/docs/screenshots/` as `v11-live-*.png`.
6. Quick mobile pass (390×844): Fleet Cost visible without scroll, no
   page-level overflow.

## Then report to the user (in English, one verdict sentence first)
- What the screenshots prove, server URLs + PIDs, what remains open
  (known: `needs.json` removed; budgets persist; apiVersion 3 deprecation
  warning is upstream noise, migration to v5 is future work).
- Commit + push any new screenshots. Leave PI WEB running.
- Do NOT restart the daemon again unless a rebuild changed `dist/` —
  and then use `docs/restart-resume.sh` + a new handoff like this one.
