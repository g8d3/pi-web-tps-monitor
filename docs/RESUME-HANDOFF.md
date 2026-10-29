# Handoff after an external PI WEB restart (read this first, then act)

## What happened
- `e095-tps-monitor` v11 is DONE and pushed. 87/87 tests pass.
- The TPS tab disappeared: ANY file change under the experiment (this time
  docs/screenshots) changes the host's whole-dir revision hash → stale →
  the versioned browser module 404s → no tab. Rule now in AGENTS.md.
- New: repeated manual checks are codified in `docs/verify-tps.sh`
  (`suite | revision | files | panel | watch | report`). Run it instead of
  re-deriving the checklist. It currently reports revision FAIL (expected —
  that is why the daemon was restarted).
- The daemon was restarted EXTERNALLY. You are a fresh agent in session
  `Revisa el plugin TPS de pi` (cwd `/home/vuos/code/p4`).

## Verify now (in order)
1. Run `docs/verify-tps.sh suite revision files` — all must PASS.
   (If revision still FAILs: the tree changed again; find what with
   `git status`, then restart via `docs/restart-resume.sh` + a new handoff.)
2. Run `docs/verify-tps.sh panel` — asserts the TPS tab exists, `● live`
   is on, screenshots 4 views to /tmp/tps-verify.
3. Run `docs/verify-tps.sh watch report` (3 min) — no channel storm.
4. Copy proving shots to `e095-tps-monitor/docs/screenshots/` ONLY if the UI
   changed; note that ANY new file under the experiment stales the revision
   again (screenshots committed ⇒ another restart). Prefer reusing shots.
5. Quick mobile pass only if the panel code changed (it did not).

## Then report to the user (in English, one verdict sentence first)
- Paste the verify-tps.sh PASS/FAIL table. State plainly the tab broke from
  the screenshot commit, the rule that prevents recurrence, server URLs +
  PIDs. Proving screenshots already exist from the last verification; only
  re-take if something actually changed.
- Commit + push anything you changed. Leave PI WEB running.
