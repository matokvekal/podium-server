#!/usr/bin/env bash
# Self-hosted BRouter for the Route Builder (POST /api/v1/route-builder/segment).
#
# Why self-hosted: the public brouter.de server publishes no terms allowing other apps to use it
# from production, so production routes on its own BRouter. Free and open source (MIT), OSM data.
# It listens on 127.0.0.1 only — nothing new is exposed; the API reaches it through ROUTING_URL.
#
# Run once as root on the API server:   sudo bash scripts/brouter/install-brouter.sh
# Re-run any time to refresh the map data (weekly upstream; monthly is plenty) — it is idempotent.
# Then add to /opt/elnino/.env:          ROUTING_URL=http://127.0.0.1:17777
# and restart the API:                   sudo -u elnino pm2 restart elnino-server --update-env
#
# Resources: ~75 MB of map data for Israel, ~300-500 MB RAM, a route in about a second.

set -euo pipefail

VERSION="1.7.10"
DIR="/opt/brouter"
PORT="17777"
# 5x5-degree data tiles covering Israel (Eilat to the Golan). Add tiles here to route elsewhere.
TILES="E30_N25 E30_N30 E35_N25 E35_N30"

command -v java >/dev/null || apt-get install -y openjdk-21-jre-headless
command -v unzip >/dev/null || apt-get install -y unzip

mkdir -p "$DIR/segments4" "$DIR/customprofiles"
if [ ! -f "$DIR/brouter-$VERSION/brouter-$VERSION-all.jar" ]; then
  curl -fsSL -o /tmp/brouter.zip "https://github.com/abrensch/brouter/releases/download/v$VERSION/brouter-$VERSION.zip"
  unzip -q -o /tmp/brouter.zip -d "$DIR"
  rm -f /tmp/brouter.zip
fi
for t in $TILES; do
  curl -fsSL -o "$DIR/segments4/$t.rd5.tmp" "https://brouter.de/brouter/segments4/$t.rd5"
  mv "$DIR/segments4/$t.rd5.tmp" "$DIR/segments4/$t.rd5"
done
chown -R elnino:elnino "$DIR"

# Same process manager as the API (see EL_NINO_PRODUCTION_GUIDE.md, "PM2").
sudo -u elnino bash -c "
  pm2 delete brouter >/dev/null 2>&1 || true
  pm2 start java --name brouter --cwd '$DIR' -- -Xmx512M -cp 'brouter-$VERSION/brouter-$VERSION-all.jar' \
    btools.server.RouteServer segments4 'brouter-$VERSION/profiles2' customprofiles $PORT 4 127.0.0.1
  pm2 save
"

# Smoke test: Pedaya -> Beit Shemesh, both profiles the Route Builder uses.
sleep 5
for p in fastbike mtb; do
  curl -fsS "http://127.0.0.1:$PORT/brouter?lonlats=34.948,31.853|34.99,31.75&profile=$p&alternativeidx=0&format=geojson" \
    | grep -o '"track-length": "[0-9]*"' | sed "s/^/$p: /"
done
echo "BRouter is up on 127.0.0.1:$PORT. Set ROUTING_URL=http://127.0.0.1:$PORT in /opt/elnino/.env."
