#!/usr/bin/env bash
# Self-hosted BRouter for the Route Builder (POST /api/v1/route-builder/segment).
#
# Why self-hosted: the public brouter.de server publishes no terms allowing other apps to use it
# from production. BRouter is free and open source (MIT), on OpenStreetMap data.
#
# Isolation — what this touches and what it does not:
#   touches   ~elnino/brouter (new; with a private JRE inside if the host has no Java 11+) and one
#             pm2 process "brouter" in the app user's pm2. Runs as the app user — no root, no apt.
#   never     the ElNino API process, nginx, /opt/elnino/.env, the database, firewall rules.
#   network   listens on 127.0.0.1:17777 only; nothing new is reachable from outside.
#   limits    heap 256 MB (~450 MB resident at peak), 2 routing threads, nice 10 so the API
#             always gets the CPU first.
# The API does not use BRouter until ROUTING_URL is set — installing changes nothing for riders.
#
#   bash scripts/brouter/preflight-brouter.sh     # read-only GO / NO-GO first
#   bash scripts/brouter/install-brouter.sh       # install + start + test
#   bash scripts/brouter/check-brouter.sh         # routing test any time
#   bash scripts/brouter/uninstall-brouter.sh     # rollback
#
# Re-run with --reinstall to refresh the map data (weekly upstream; monthly is plenty).

set -euo pipefail

VERSION="1.7.10"
PORT="${BROUTER_PORT:-17777}"
APP_USER="${APP_USER:-elnino}"
DIR="${BROUTER_DIR:-$(eval echo "~$APP_USER")/brouter}"
HEAP="256M"
THREADS="2"
# 5x5-degree data tiles covering Israel, Eilat to the Golan. Add tiles to route elsewhere.
TILES="E30_N25 E30_N30 E35_N25 E35_N30"
HERE="$(cd "$(dirname "$0")" && pwd)"

# pm2 of the app user's own daemon (never the root one that runs commissaire-api).
pm2u() {
  if [ "$(id -un)" = "$APP_USER" ]; then bash -lc "pm2 $*"; else sudo -n -u "$APP_USER" -H bash -lc "pm2 $*"; fi
}
[ "$(id -un)" = "$APP_USER" ] || { echo "run as $APP_USER (it owns $DIR and the pm2 process)"; exit 1; }
REINSTALL=0
[ "${1:-}" = "--reinstall" ] && REINSTALL=1

echo "== pre-flight"
if ! bash "$HERE/preflight-brouter.sh"; then
  if [ "$REINSTALL" -eq 1 ] && pm2u describe brouter >/dev/null 2>&1; then
    echo "(port $PORT is our own BRouter — reinstalling)"
  else
    echo "pre-flight said NO-GO — nothing was changed."; exit 1
  fi
fi
if [ "$REINSTALL" -eq 0 ] && pm2u describe brouter >/dev/null 2>&1; then
  echo "pm2 already has a 'brouter' process. Use --reinstall to replace it."; exit 1
fi

mkdir -p "$DIR/segments4" "$DIR/customprofiles"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== java"
JAVA_BIN=""
if command -v java >/dev/null 2>&1; then
  major=$(java -version 2>&1 | awk -F'"' '/version/ {split($2,a,"."); print (a[1]=="1"?a[2]:a[1])}')
  [ "${major:-0}" -ge 11 ] && JAVA_BIN="$(command -v java)"
fi
if [ -z "$JAVA_BIN" ]; then
  # A private JRE inside $DIR — nothing installed system-wide; uninstall removes it with $DIR.
  if [ ! -x "$DIR/jre/bin/java" ]; then
    curl -fsSL -o "$TMP/jre.tgz" "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jre/hotspot/normal/eclipse"
    mkdir -p "$DIR/jre" && tar -xzf "$TMP/jre.tgz" -C "$DIR/jre" --strip-components=1
  fi
  JAVA_BIN="$DIR/jre/bin/java"
fi
"$JAVA_BIN" -version 2>&1 | head -1

echo "== files ($DIR)"
if [ ! -f "$DIR/brouter-$VERSION/brouter-$VERSION-all.jar" ]; then
  curl -fsSL -o "$TMP/brouter.zip" "https://github.com/abrensch/brouter/releases/download/v$VERSION/brouter-$VERSION.zip"
  # unzip may be missing and we cannot apt-get without root: Python's zipfile is always there.
  if command -v unzip >/dev/null; then unzip -q -o "$TMP/brouter.zip" -d "$DIR"
  else python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$TMP/brouter.zip" "$DIR"; fi
fi
for p in moped fastbike mtb; do
  [ -f "$DIR/brouter-$VERSION/profiles2/$p.brf" ] || { echo "profile $p.brf missing from the release"; exit 1; }
done
for t in $TILES; do
  curl -fsSL -o "$TMP/$t.rd5" "https://brouter.de/brouter/segments4/$t.rd5"
  [ "$(stat -c %s "$TMP/$t.rd5")" -gt 1000000 ] || { echo "$t.rd5 looks truncated"; exit 1; }
  mv "$TMP/$t.rd5" "$DIR/segments4/$t.rd5"   # replaced whole, never half-written
done

echo "== start (pm2 '$APP_USER', 127.0.0.1:$PORT)"
pm2u delete brouter >/dev/null 2>&1 || true
pm2u start nice --interpreter none --name brouter --cwd "$DIR" --max-memory-restart 700M -- -n 10 "$JAVA_BIN" \
  -Xmx$HEAP -cp "brouter-$VERSION/brouter-$VERSION-all.jar" \
  btools.server.RouteServer segments4 "brouter-$VERSION/profiles2" customprofiles $PORT $THREADS 127.0.0.1
pm2u save

echo "== test"
for i in $(seq 1 30); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/brouter?lonlats=34.95,31.85|34.98,31.80&profile=fastbike&format=geojson" && break
  sleep 1
done
bash "$HERE/check-brouter.sh"
echo
echo "Installed. Riders are not affected until /opt/elnino/.env gets ROUTING_URL=http://127.0.0.1:$PORT"
echo "and the Route Builder server release is deployed. Rollback: bash $HERE/uninstall-brouter.sh"
