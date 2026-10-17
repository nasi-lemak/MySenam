#!/usr/bin/env bash
#
# Run one of the app's own commands on the server, as the app, with the app's
# settings. Installed by setup.sh as /usr/local/sbin/mysenam-run.
#
#   mysenam-run npm run backup
#   mysenam-run npm run restore -- /var/lib/mysenam/backups/mysenam-….dump --force
#   mysenam-run npm run import-sqlite -- /var/lib/mysenam/mysenam.db
#
# The settings are read exactly as the service reads them, from
# /etc/mysenam/env, so a value with spaces or quotes in it means the same here.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run this as root." >&2; exit 1; }
[[ $# -gt 0 ]] || { echo "Usage: mysenam-run <command…>" >&2; exit 1; }
exec systemd-run --quiet --wait --pipe --collect --uid=mysenam --gid=mysenam \
  -p EnvironmentFile=/etc/mysenam/env -p WorkingDirectory=/srv/mysenam/current \
  --setenv=HOME=/srv/mysenam --setenv=PATH=/usr/local/bin:/usr/bin:/bin "$@"
