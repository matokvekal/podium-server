#!/usr/bin/env bash
# Routing test for the self-hosted BRouter: the same start/end in Road (moped, falling back to fastbike) and Off-road
# (mtb), with distance, climb, time and how much of each route is paved road vs dirt/track/path.
# Read-only. Exit 1 if any route fails.
#
#   bash scripts/brouter/check-brouter.sh [http://127.0.0.1:17777]

set -uo pipefail
BASE="${1:-http://127.0.0.1:${BROUTER_PORT:-17777}}"
fail=0

route() { # name lonlats profile
  local t0 t1 body
  t0=$(date +%s%N)
  body=$(curl -s -m 60 -w '\n%{http_code}' "$BASE/brouter?lonlats=$2&profile=$3&alternativeidx=0&format=geojson")
  t1=$(date +%s%N)
  local code="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [ "$code" != "200" ]; then
    printf '%-26s %-9s FAIL (%s) %s\n' "$1" "$3" "$code" "$(echo "$body" | head -c 120)"
    fail=1
    return
  fi
  echo "$body" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const f = JSON.parse(s).features[0], p = f.properties, [h, ...rows] = p.messages;
      const di = h.indexOf("Distance"), wi = h.indexOf("WayTags"), m = {};
      for (const r of rows) {
        const t = Object.fromEntries(r[wi].split(" ").filter((x) => x.includes("=")).map((x) => x.split("=")));
        const dirt = ["track", "path", "bridleway"].includes(t.highway) ||
          ["dirt", "gravel", "ground", "unpaved", "compacted", "fine_gravel", "sand"].includes(t.surface);
        const k = dirt ? "dirt/track/path" : t.highway === "cycleway" ? "cycleway" : "paved road";
        m[k] = (m[k] || 0) + Number(r[di]);
      }
      const tot = Object.values(m).reduce((a, b) => a + b, 0) || 1;
      const mix = Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round((100 * v) / tot)}%`).join(", ");
      console.log(`${process.argv[1].padEnd(26)} ${process.argv[2].padEnd(9)} ${(p["track-length"] / 1000).toFixed(1).padStart(5)} km  climb ${String(p["filtered ascend"]).padStart(4)} m  ${process.argv[3].padStart(5)} s  | ${mix}`);
    });' "$1" "$3" "$(awk -v ns=$((t1 - t0)) 'BEGIN{printf "%.2f", ns/1e9}')" 2>/dev/null || { echo "$1 $3: unreadable answer"; fail=1; }
}

echo "== BRouter routing test ($BASE)"
for p in moped fastbike mtb; do route "Pedaya -> Beit Shemesh" "34.948,31.853|34.99,31.75" $p; done
for p in fastbike mtb; do route "Ben Shemen forest" "34.94,31.95|34.99,31.92" $p; done
for p in moped fastbike mtb; do route "Tel Aviv -> Jerusalem" "34.78,32.08|35.21,31.77" $p; done
route "Eilat (south edge)" "34.95,29.56|35.02,29.70" fastbike
route "Golan (north edge)" "35.69,32.98|35.75,33.10" mtb
[ "$fail" -eq 0 ] && echo "OK — both profiles route" || echo "FAILED"
exit "$fail"
