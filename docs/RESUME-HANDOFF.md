# Handoff after an external PI WEB restart (read this first, then act)

## What happened
- `e095-tps-monitor` v11 is DONE and pushed: main @ `088a062`
  (chunked channel snapshots — the fix below).
- 84/84 tests pass (`npm test` in `e095-tps-monitor/`).
- The daemon was restarted EXTERNALLY to serve the new plugin revision
  (browser bundles only load under the active revision; a rebuild alone 404s).
- You are a fresh agent in session `Revisa el plugin TPS de pi`
  (cwd `/home/vuos/code/p4`). The repo is the source of truth.

## Root cause found for the channel storm (your main check)
- The push channel opened ~11×/sec and never showed `● live`.
- Diagnosis: the first snapshot frame carried 500+500 rows (~500 KB) in ONE
  `send()`; the host transport bounds a single frame, so `send()` threw and
  the channel died instantly, every time.
- Fix (in this build): `snapshot-start` + 50-row `snapshot-part` chunks +
  `snapshot-done`; browser accumulates then applies. Plus a 10 s open-attempt
  throttle and an `opening` guard, so a failing transport can never storm.

## Verify now (in order)
1. Plugin revision live: `activeRevision==desiredRevision`,
   `restartRequired: false`, health healthy, via `/api/plugins`.
2. TPS tab loads (PI WEB `p4 / master · main`): headline shows a rate,
   **`● live` dot present next to it** — this is the proof the channel works.
3. Push quiet: `journalctl --user -u pi-web-sessiond --since "5 minutes ago" |
   grep -c "channels/watch"` should be ~1 per open panel, not ~100/min.
4. Re-screenshot the 4 views (desktop 1280 + mobile 390) into
   `e095-tps-monitor/docs/screenshots/` as `v11-live-*.png`.
5. Quick mobile pass (390×844): Fleet Cost visible without scroll, no
   page-level overflow.

## Then report to the user (in English, one verdict sentence first)
- What the screenshots prove, server URLs + PIDs, what remains open
  (known: `needs.json` removed; budgets persist; apiVersion 3 deprecation
  warning is upstream noise, migration to v5 is future work).
- Commit + push any new screenshots. Leave PI WEB running.
- Do NOT restart the daemon again unless a rebuild changed `dist/` —
  and then use `docs/restart-resume.sh` + a new handoff like this one.
