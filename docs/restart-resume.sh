#!/bin/bash
# pi-web restart-and-resume: restarts the session daemon from OUTSIDE any agent
# session, waits for it to become healthy, then wakes a session with a handoff
# message so work continues after the restart kills all agent processes.
#
# Why this exists: `systemctl --user restart pi-web-sessiond` terminates every
# agent process hosted by the daemon — including the agent that issued the
# restart. This script is launched detached (systemd-run --on-active) so it
# survives, then re-injects the agent via the sessiond prompt API, which wakes
# idle sessions (verified: probe round-trip create -> prompt -> reply).
#
# Usage:
#   restart-resume.sh <session-id> <cwd> <message-file>
#
# Launch detached (does not die with your shell/session):
#   systemd-run --user --on-active=10s --unit=pi-web-restart-resume \
#     /path/to/restart-resume.sh <session-id> <cwd> <message-file>
#
# The message file must be SELF-SUFFICIENT: the woken agent is fresh, so it
# needs repo state (commit hashes), what to verify, and what to report.
set -u

SID="${1:?session id required}"
CWD="${2:?cwd required}"
MSGFILE="${3:?message file required}"
BASE="http://127.0.0.1:8504/api/machines/local"
LOG="/tmp/pi-web-restart-resume.log"

log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

urlenc() { printf '%s' "$1" | sed 's|/|%2F|g'; }

log "restart requested for session $SID ($CWD)"
systemctl --user restart pi-web-sessiond 2>>"$LOG"
log "restart issued, waiting for healthy daemon"

READY=""
for _ in $(seq 1 90); do
  if curl -sf -m 3 "$BASE/sessions?cwd=$(urlenc "$CWD")" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done

if [ -z "$READY" ]; then
  log "ERROR: daemon not healthy after 180s, resume message NOT sent"
  exit 1
fi
log "daemon healthy, sending resume prompt"

TEXT="$(cat "$MSGFILE")"
RESP="$(curl -s -m 15 -X POST "$BASE/sessions/$SID/prompt" \
  -H 'Content-Type: application/json' \
  -d "$(python3 -c "import json,sys; print(json.dumps({'cwd': sys.argv[1], 'text': open(sys.argv[2], encoding='utf-8').read()}))" "$CWD" "$MSGFILE")")"
log "prompt response: $RESP"
echo "$RESP" | grep -q '"accepted":true' && log "resume delivered" || { log "ERROR: resume NOT accepted"; exit 1; }
