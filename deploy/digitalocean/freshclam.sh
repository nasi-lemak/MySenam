#!/usr/bin/env bash
#
# Fetch new ClamAV signatures, never while the app's on-demand clamd is
# running. Installed by setup.sh (on-demand scanner mode) as
# /usr/local/sbin/mysenam-freshclam and run by mysenam-freshclam.timer.
#
# On a 2 GB Droplet the app, Postgres and clamd fit only if freshclam (which
# loads each new database once to test it: about 700 MiB at its peak) is not
# running beside clamd (about 1 GiB). So the two take turns: this script marks
# that freshclam is about to run, then looks for the app's clamd lock; the app
# marks its own lock first and then looks for this mark (and for any process
# named freshclam). Each marks before it looks, so both can never run at once.
# If clamd is busy, this waits for it to stop (it stops a few minutes after the
# last document is scanned), for at most an hour, then gives up until the next
# run. See docs/operations/deployment.md#the-malware-scanner.
#
#   mysenam-freshclam [lock folder] [longest wait, seconds]
#
# The lock folder is the app's data folder's scanner/ (/var/lib/mysenam/scanner).
set -euo pipefail

LOCK_DIR="${1:-/var/lib/mysenam/scanner}"
WAIT_SECONDS="${2:-3600}"
MINE="$LOCK_DIR/freshclam.lock"
THEIRS="$LOCK_DIR/clamd-ondemand.lock"
STEP=$(( WAIT_SECONDS < 30 ? (WAIT_SECONDS > 0 ? WAIT_SECONDS : 1) : 30 ))

install -d -m 750 "$LOCK_DIR"
boot="$(cat /proc/sys/kernel/random/boot_id)"

# Is the app's clamd lock held by a process that is still running on this boot?
clamd_held() {
  [[ -f "$THEIRS" ]] || return 1
  local app lock_boot
  app="$(sed -n 's/^app=//p' "$THEIRS")"
  lock_boot="$(sed -n 's/^boot=//p' "$THEIRS")"
  [[ "$lock_boot" == "$boot" && -n "$app" ]] && kill -0 "$app" 2>/dev/null
}

waited=0
while :; do
  # Mark first (refusing to overwrite another run's mark)...
  if ( set -o noclobber; echo "$$" > "$MINE" ) 2>/dev/null; then
    trap 'rm -f "$MINE"' EXIT
    # ...then look.
    if ! clamd_held; then
      freshclam --stdout
      exit $?
    fi
    rm -f "$MINE"
    trap - EXIT
  elif ! kill -0 "$(cat "$MINE" 2>/dev/null || echo 0)" 2>/dev/null; then
    # A mark left by a run that is gone.
    rm -f "$MINE"
    continue
  else
    echo "Another freshclam run is in progress; nothing to do."
    exit 0
  fi
  if (( waited >= WAIT_SECONDS )); then
    echo "The app's clamd stayed up for ${WAIT_SECONDS} seconds: this update is skipped until the next run." >&2
    exit 0
  fi
  sleep "$STEP"
  waited=$((waited + STEP))
done
