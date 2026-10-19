#!/usr/bin/env bash
# ROLLBACK for install-brouter.sh. Stops and removes the pm2 "brouter" process and deletes
# ~elnino/brouter (its private JRE, if any, goes with it). Nothing system-wide to undo.
# Does not touch the ElNino API, nginx or the database.
#
#   bash scripts/brouter/uninstall-brouter.sh        (as the app user)
#
# If ROUTING_URL is already set in /opt/elnino/.env, remove that line FIRST and restart the API
# (pm2 restart elnino-server --update-env, as elnino) — the Route Builder then reports
# "routing unavailable" instead of trying a server that is gone.

set -euo pipefail
APP_USER="${APP_USER:-elnino}"
DIR="${BROUTER_DIR:-$(eval echo "~$APP_USER")/brouter}"
# pm2 of the app user's own daemon (never the root one that runs commissaire-api).
pm2u() {
  if [ "$(id -un)" = "$APP_USER" ]; then bash -lc "pm2 $*"; else sudo -n -u "$APP_USER" -H bash -lc "pm2 $*"; fi
}


if grep -q '^ROUTING_URL=' /opt/elnino/.env 2>/dev/null; then
  echo "WARNING: /opt/elnino/.env still has ROUTING_URL — remove it and restart the API (see above)."
fi

pm2u delete brouter >/dev/null 2>&1 || true
pm2u save
rm -rf "$DIR"
echo "BRouter removed (pm2 process and $DIR). The API is untouched."
