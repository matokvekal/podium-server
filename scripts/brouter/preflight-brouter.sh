#!/usr/bin/env bash
# READ-ONLY pre-flight check for the Route Builder's BRouter. Installs nothing, starts nothing,
# changes nothing — safe to run on production at any time:
#
#   sudo bash scripts/brouter/preflight-brouter.sh
#
# Ends with GO or NO-GO and the reasons. install-brouter.sh runs the same checks itself.

set -uo pipefail

PORT="${BROUTER_PORT:-17777}"
DIR="${BROUTER_DIR:-/opt/brouter}"
APP_USER="${APP_USER:-elnino}"
NEED_MEM_MB=600     # BRouter measured ~450 MB peak at -Xmx256M under 6 parallel 120 km routes
NEED_DISK_MB=300    # ~75 MB map data + ~25 MB release + headroom; + ~200 MB if Java must be installed

problems=()
warnings=()
say() { printf '%-28s %s\n' "$1" "$2"; }

echo "== BRouter pre-flight ($(date -Is)) — read-only"
say "host" "$(hostname) · $(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown OS}") · $(uname -m)"
say "cpu cores" "$(nproc)"
say "load (1/5/15 min)" "$(cut -d' ' -f1-3 /proc/loadavg)"

mem_total=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
mem_avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
swap_total=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
say "memory" "${mem_total} MB total · ${mem_avail} MB available · swap ${swap_total} MB"
if [ "$mem_avail" -lt "$NEED_MEM_MB" ]; then
  problems+=("only ${mem_avail} MB RAM available; BRouter needs ~${NEED_MEM_MB} MB")
elif [ "$mem_avail" -lt $((NEED_MEM_MB * 2)) ]; then
  warnings+=("${mem_avail} MB RAM available — enough, but little headroom left afterwards")
fi

disk_dir="$DIR"; [ -d "$disk_dir" ] || disk_dir="$(dirname "$DIR")"
disk_free=$(df -Pm "$disk_dir" | awk 'NR==2 {print $4}')
say "disk free at $disk_dir" "${disk_free} MB"
[ "$disk_free" -lt "$NEED_DISK_MB" ] && problems+=("only ${disk_free} MB free at $disk_dir; need ${NEED_DISK_MB} MB")

if command -v java >/dev/null 2>&1; then
  jv=$(java -version 2>&1 | head -1)
  jmajor=$(java -version 2>&1 | awk -F'"' '/version/ {split($2,a,"."); print (a[1]=="1"?a[2]:a[1])}')
  say "java" "$jv"
  [ "${jmajor:-0}" -lt 11 ] && problems+=("installed Java is too old (${jmajor}); BRouter needs 11+ — install would NOT replace it automatically")
else
  say "java" "not installed (install-brouter.sh adds openjdk-21-jre-headless; nothing else uses it)"
fi

if id "$APP_USER" >/dev/null 2>&1; then
  say "app user" "$APP_USER exists"
else
  problems+=("user $APP_USER does not exist")
fi

if sudo -u "$APP_USER" bash -lc 'command -v pm2' >/dev/null 2>&1; then
  procs=$(sudo -u "$APP_USER" bash -lc 'pm2 jlist 2>/dev/null' | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const l=JSON.parse(s);
    console.log(l.map(p=>`${p.name}:${p.pm2_env.status}:${Math.round((p.monit?.memory||0)/1048576)}MB`).join(" "))}catch{console.log("?")}})' 2>/dev/null)
  say "pm2 ($APP_USER)" "${procs:-none}"
  case " $procs " in *" brouter:"*) warnings+=("a pm2 process named 'brouter' already exists (install will refuse unless --reinstall)") ;; esac
else
  problems+=("pm2 not found for $APP_USER")
fi

if ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN; then
  problems+=("port $PORT is already in use: $(ss -ltnp "sport = :$PORT" 2>/dev/null | tail -1)")
else
  say "port $PORT (127.0.0.1)" "free"
fi

[ -e "$DIR" ] && warnings+=("$DIR already exists (install reuses it; uninstall removes it)")

for url in https://github.com https://brouter.de/brouter/segments4/; do
  code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$url" || echo 000)
  say "outbound $url" "$code"
  [ "$code" = "000" ] && problems+=("cannot reach $url to download")
done

api=$(curl -s -o /dev/null -m 10 -w '%{http_code}' http://127.0.0.1:6500/api/v1/routes || echo 000)
say "ElNino API (127.0.0.1:6500)" "$api (401 = up and healthy)"

echo
for w in "${warnings[@]}"; do echo "WARN  $w"; done
if [ ${#problems[@]} -eq 0 ]; then
  echo "GO — BRouter can be installed without touching the running app."
  exit 0
fi
for p in "${problems[@]}"; do echo "STOP  $p"; done
echo "NO-GO"
exit 1
