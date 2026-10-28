# Handoff after an external PI WEB restart (read this first, then act)

## What happened
- `e095-tps-monitor` v11 is DONE and pushed: main @ `8e6a0cb`
  ("Fix channel open race: one watch per panel, not one per render").
- 84/84 tests pass (`npm test` in `e095-tps-monitor/`).
- The daemon was restarted EXTERNALLY to serve the new plugin revision
  (browser bundles only load under the active revision; a rebuild alone 404s).
- You are a fresh agent in session `Revisa el plugin TPS de pi`
  (cwd `/home/vuos/code/p4`). Prior transcript is archived in-session; the
  repo is the source of truth.

## Verify now (in order)
1. Plugin revision live:
   `curl -s http://127.0.0.1:8504/api/plugins | python3 -c "...tps-monitor activeRevision==desiredRevision, restartRequired false, health healthy"`
2. TPS tab loads: open PI WEB `p4 / master · main`, click the TPS tab
   (`agent-browser`). Expect: headline `⚡ N t/s last (...)`, `● live` dot,
   Refresh + Export turns buttons, Turn column with `#N` badges, legend table.
3. Push working, not polling: `journalctl --user -u pi-web-sessiond --since "5 minutes ago" | grep -c "channels/watch"` should be ~1 per open
   panel, not ~100/min. Many hits = the open race is back; fix
   `opening` guard in `src/browser/index.ts`, rebuild, re-verify.
4. Re-screenshot (desktop 1280 + mobile 390) the 4 views into
   `e095-tps-monitor/docs/screenshots/` as `v11-live-*.png`, replacing the
   pre-restart shots if the UI matches.
5. Quick mobile pass (viewport 390x844): Fleet Cost visible without scroll,
   no page-level overflow.

## Then report to the user (in English, one verdict sentence first)
- What the screenshots prove, server URLs + PIDs, what remains open
  (known: `needs.json` removed; budgets persist; apiVersion 3 deprecation
  warning is upstream noise, migration to v5 is future work).
- Commit + push any new screenshots. Leave PI WEB running.
- Do NOT restart the daemon again unless a rebuild changed `dist/` —
  and then use `docs/restart-resume.sh` + a new handoff like this one.
