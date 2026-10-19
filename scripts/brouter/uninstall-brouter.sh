#!/usr/bin/env bash
# ROLLBACK for install-brouter.sh. Stops and removes the pm2 "brouter" process, deletes
# /opt/brouter, and removes Java only if install-brouter.sh was the one that installed it.
# Does not touch the ElNino API, nginx or the database.
#
#   sudo bash scripts/brouter/uninstall-brouter.sh
#
# If ROUTING_URL is already set in /opt/elnino/.env, remove that line FIRST and restart the API
# (sudo -u elnino pm2 restart elnino-server --update-env) — the Route Builder then reports
# "routing unavailable" instead of trying a server that is gone.

set -euo pipefail
DIR="${BROUTER_DIR:-/opt/brouter}"
APP_USER="${APP_USER:-elnino}"
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }

if grep -q '^ROUTING_URL=' /opt/elnino/.env 2>/dev/null; then
  echo "WARNING: /opt/elnino/.env still has ROUTING_URL — remove it and restart the API (see above)."
fi

sudo -u "$APP_USER" bash -lc 'pm2 delete brouter >/dev/null 2>&1 || true; pm2 save'
removed_java=0
if [ -f "$DIR/.java-installed-by-brouter" ]; then
  apt-get remove -y -qq openjdk-21-jre-headless && removed_java=1
fi
rm -rf "$DIR"
echo "BRouter removed (pm2 process, $DIR$([ $removed_java -eq 1 ] && echo ', Java')). The API is untouched."
