#!/usr/bin/env bash
#
# Put a new version live. Installed by setup.sh as /usr/local/sbin/mysenam-deploy.
#
#   mysenam-deploy             the branch in /etc/mysenam/deploy.conf
#   mysenam-deploy v1.4.0      a tag, branch or commit
#
# Builds the new version beside the live one, so the site stays up while it
# does; takes a backup; switches over; and checks the site answers. If it does
# not, the previous version goes straight back. The last three versions are
# kept for that.
#
# The database schema moves forward when the new version starts, and does not
# move back with a rollback — so a migration has to leave the database usable
# by the version before it, which is how they are written.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run this as root." >&2; exit 1; }
. /etc/mysenam/deploy.conf
REF="${1:-$BRANCH}"
RELEASES=/srv/mysenam/releases
CURRENT=/srv/mysenam/current
RELEASE="$RELEASES/$(date +%Y%m%d-%H%M%S)"
# The build needs the development packages, so it runs without the app's
# settings (NODE_ENV=production would leave them out).
build() { runuser -u mysenam -- env -C "$RELEASE" HOME=/srv/mysenam bash -c "$*"; }
# Anything that touches the database runs with the settings exactly as the
# service reads them: with_settings <release folder> <command…>
with_settings() {
  local dir="$1"; shift
  systemd-run --quiet --wait --pipe --collect --uid=mysenam --gid=mysenam \
    -p EnvironmentFile=/etc/mysenam/env -p WorkingDirectory="$dir" --setenv=HOME=/srv/mysenam "$@"
}

echo "== Fetching $REF"
runuser -u mysenam -- git init -q "$RELEASE"
runuser -u mysenam -- git -C "$RELEASE" remote add origin "$REPO"
runuser -u mysenam -- git -C "$RELEASE" fetch -q --depth 1 origin "$REF"
runuser -u mysenam -- git -C "$RELEASE" checkout -q FETCH_HEAD
echo "   $(runuser -u mysenam -- git -C "$RELEASE" log -1 --format='%h %s')"

echo "== Building"
if ! build "npm ci --no-audit --no-fund --loglevel=error && npm run build >/dev/null"; then
  echo "Build failed; nothing changed." >&2
  rm -rf "$RELEASE"
  exit 1
fi

PREVIOUS="$(readlink -f "$CURRENT" 2>/dev/null || true)"
if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
  echo "== Backing up before the switch"
  # The new version may move the schema on as it starts; this is the copy
  # from just before. Taken by the live version, which has nothing left to
  # migrate — the new one would apply its migrations as it opened the
  # database, before the copy.
  with_settings "$PREVIOUS" /usr/bin/node scripts/backup.mjs || { echo "Backup failed; not deploying." >&2; exit 1; }
fi

echo "== Switching"
ln -sfn "$RELEASE" "$CURRENT.new" && mv -T "$CURRENT.new" "$CURRENT"
systemctl restart mysenam

healthy=0
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then healthy=1; break; fi
  sleep 1
done

if [[ $healthy -ne 1 ]]; then
  echo "The new version did not answer within a minute." >&2
  journalctl -u mysenam -n 30 --no-pager >&2 || true
  if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
    echo "== Putting $(basename "$PREVIOUS") back" >&2
    ln -sfn "$PREVIOUS" "$CURRENT.new" && mv -T "$CURRENT.new" "$CURRENT"
    systemctl restart mysenam
  fi
  exit 1
fi

echo "== Live: $(basename "$RELEASE")"
# Keep the last three, for putting one back by hand:
#   ln -sfn /srv/mysenam/releases/<one> /srv/mysenam/current && systemctl restart mysenam
ls -1d "$RELEASES"/*/ | sort | head -n -3 | while read -r old; do
  [[ "$(readlink -f "$old")" == "$(readlink -f "$CURRENT")" ]] || rm -rf "$old"
done
