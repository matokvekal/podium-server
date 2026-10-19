#!/usr/bin/env bash
# Self-hosted BRouter for the Route Builder (POST /api/v1/route-builder/segment).
#
# Why self-hosted: the public brouter.de server publishes no terms allowing other apps to use it
# from production. BRouter is free and open source (MIT), on OpenStreetMap data.
#
# Isolation — what this touches and what it does not:
#   touches   /opt/brouter (new), one pm2 process "brouter" under the app user, and — only if no
#             Java 11+ is installed — the package openjdk-21-jre-headless.
#   never     the ElNino API process, nginx, /opt/elnino/.env, the database, firewall rules.
#   network   listens on 127.0.0.1:17777 only; nothing new is reachable from outside.
#   limits    heap 256 MB (~450 MB resident at peak), 2 routing threads, nice 10 so the API
#             always gets the CPU first.
# The API does not use BRouter until ROUTING_URL is set — installing changes nothing for riders.
#
#   sudo bash scripts/brouter/preflight-brouter.sh     # read-only GO / NO-GO first
#   sudo bash scripts/brouter/install-brouter.sh       # install + start + test
#   sudo bash scripts/brouter/check-brouter.sh         # routing test any time
#   sudo bash scripts/brouter/uninstall-brouter.sh     # rollback
#
# Re-run with --reinstall to refresh the map data (weekly upstream; monthly is plenty).

set -euo pipefail

VERSION="1.7.10"
DIR="${BROUTER_DIR:-/opt/brouter}"
PORT="${BROUTER_PORT:-17777}"
APP_USER="${APP_USER:-elnino}"
HEAP="256M"
THREADS="2"
# 5x5-degree data tiles covering Israel, Eilat to the Golan. Add tiles to route elsewhere.
TILES="E30_N25 E30_N30 E35_N25 E35_N30"
HERE="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
REINSTALL=0
[ "${1:-}" = "--reinstall" ] && REINSTALL=1

echo "== pre-flight"
if ! bash "$HERE/preflight-brouter.sh"; then
  if [ "$REINSTALL" -eq 1 ] && ss -ltnp "sport = :$PORT" 2>/dev/null | grep -q java; then
    echo "(port $PORT is our own BRouter — reinstalling)"
  else
    echo "pre-flight said NO-GO — nothing was changed."; exit 1
  fi
fi
if [ "$REINSTALL" -eq 0 ] && sudo -u "$APP_USER" bash -lc 'pm2 describe brouter' >/dev/null 2>&1; then
  echo "pm2 already has a 'brouter' process. Use --reinstall to replace it."; exit 1
fi

echo "== java"
JAVA_INSTALLED_BY_US=0
if ! command -v java >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq openjdk-21-jre-headless
  JAVA_INSTALLED_BY_US=1
fi
JAVA_BIN="$(command -v java)"
command -v unzip >/dev/null || apt-get install -y -qq unzip
"$JAVA_BIN" -version 2>&1 | head -1

echo "== files ($DIR)"
mkdir -p "$DIR/segments4" "$DIR/customprofiles"
[ "$JAVA_INSTALLED_BY_US" -eq 1 ] && touch "$DIR/.java-installed-by-brouter"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if [ ! -f "$DIR/brouter-$VERSION/brouter-$VERSION-all.jar" ]; then
  curl -fsSL -o "$TMP/brouter.zip" "https://github.com/abrensch/brouter/releases/download/v$VERSION/brouter-$VERSION.zip"
  unzip -q -o "$TMP/brouter.zip" -d "$DIR"
fi
for p in fastbike mtb; do
  [ -f "$DIR/brouter-$VERSION/profiles2/$p.brf" ] || { echo "profile $p.brf missing from the release"; exit 1; }
done
for t in $TILES; do
  curl -fsSL -o "$TMP/$t.rd5" "https://brouter.de/brouter/segments4/$t.rd5"
  [ "$(stat -c %s "$TMP/$t.rd5")" -gt 1000000 ] || { echo "$t.rd5 looks truncated"; exit 1; }
  mv "$TMP/$t.rd5" "$DIR/segments4/$t.rd5"   # replaced whole, never half-written
done
chown -R "$APP_USER:$APP_USER" "$DIR"

echo "== start (pm2 '$APP_USER', 127.0.0.1:$PORT)"
sudo -u "$APP_USER" bash -lc "
  pm2 delete brouter >/dev/null 2>&1 || true
  pm2 start nice --interpreter none --name brouter --cwd '$DIR' --max-memory-restart 700M -- -n 10 '$JAVA_BIN' \
    -Xmx$HEAP -cp 'brouter-$VERSION/brouter-$VERSION-all.jar' \
    btools.server.RouteServer segments4 'brouter-$VERSION/profiles2' customprofiles $PORT $THREADS 127.0.0.1
  pm2 save
"

echo "== test"
for i in $(seq 1 30); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/brouter?lonlats=34.95,31.85|34.98,31.80&profile=fastbike&format=geojson" && break
  sleep 1
done
bash "$HERE/check-brouter.sh"
echo
echo "Installed. Riders are not affected until /opt/elnino/.env gets ROUTING_URL=http://127.0.0.1:$PORT"
echo "and the Route Builder server release is deployed. Rollback: sudo bash $HERE/uninstall-brouter.sh"
