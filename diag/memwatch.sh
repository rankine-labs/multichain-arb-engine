#!/usr/bin/env bash
# memwatch.sh - READ-ONLY memory watch for the arb server (owner asked Oct 26: "if it needs a bigger server alert me").
# Every run (cron, every 10 min) it checks:
#   - copy (arbsim) and bot (dex-arb-shadow) memory from pm2
#   - memory still available on the server (/proc/meminfo)
#   - new pm2 "too much memory" restarts and new kernel out-of-memory kills since the last run
# If something is wrong it sends ONE Telegram message (same reason at most once every 6 hours).
# It never changes the bot, settings or pm2. Secrets are read from .env and never printed.
# Run with "test" as the first argument to send a test message.
set -u
APP="$HOME/multichain-arb-engine"
STATE="$HOME/rx/memwatch.state"; mkdir -p "$HOME/rx"; touch "$STATE"
COPY_WARN_MB=1200      # copy restart limit is 1300 MB
AVAIL_WARN_MB=500      # server close to running out
QUIET_S=21600          # same alert at most every 6 h

envval() { grep -E "^$1=" "$APP/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }
TOKEN="$(envval TELEGRAM_BOT_TOKEN)"
CHAT="$(envval TELEGRAM_CHAT_ID)"; [ -z "$CHAT" ] && CHAT="$(envval TELEGRAM_CHAT_IDS | cut -d, -f1)"

send() {  # send a plain Telegram message (token never echoed)
  [ -z "$TOKEN" ] || [ -z "$CHAT" ] && { echo "no telegram settings"; return 1; }
  curl -s -m 15 -o /dev/null -w '%{http_code}' "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${CHAT}" --data-urlencode "text=$1"
}
get() { grep -E "^$1=" "$STATE" | cut -d= -f2; }
put() { grep -vE "^$1=" "$STATE" > "$STATE.tmp"; echo "$1=$2" >> "$STATE.tmp"; mv "$STATE.tmp" "$STATE"; }

# Memory numbers (MB).
read COPY BOT <<<"$(pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const m=n=>{const p=a.find(x=>x.name===n);return p?Math.round(p.monit.memory/1048576):0};console.log(m("arbsim"),m("dex-arb-shadow"))}catch{console.log("0 0")}})')"
AVAIL=$(( $(grep MemAvailable /proc/meminfo | awk '{print $2}') / 1024 ))
RESTARTS=$(grep -c 'exceeds --max-memory' "$HOME/.pm2/pm2.log" 2>/dev/null || echo 0)
KILLS=$(sudo -n dmesg 2>/dev/null | grep -c 'Killed process' || echo 0)
LINE="Copy ${COPY} MB (restart limit 1300), bot ${BOT} MB, server free ${AVAIL} MB of 3800."

if [ "${1:-}" = "test" ]; then
  code=$(send "Memory watch is ON (test). ${LINE} You will get a message if the server needs more memory.")
  echo "telegram http ${code}"; put restarts "$RESTARTS"; put kills "$KILLS"; exit 0
fi

REASONS=()
[ "$COPY" -ge "$COPY_WARN_MB" ] && REASONS+=("copy is near its memory limit")
[ "$AVAIL" -lt "$AVAIL_WARN_MB" ] && REASONS+=("server is almost out of memory")
[ "$RESTARTS" -gt "$(get restarts || echo 0)" ] 2>/dev/null && REASONS+=("copy was restarted for using too much memory")
[ "$KILLS" -gt "$(get kills || echo 0)" ] 2>/dev/null && REASONS+=("the server killed a program for running out of memory")
put restarts "$RESTARTS"; put kills "$KILLS"

[ ${#REASONS[@]} -eq 0 ] && exit 0
KEY=$(printf '%s|' "${REASONS[@]}"); NOW=$(date +%s); LAST=$(get "last_${KEY//[^a-z]/}" || echo 0)
[ $((NOW - ${LAST:-0})) -lt $QUIET_S ] && exit 0
put "last_${KEY//[^a-z]/}" "$NOW"
send "Server memory alert: $(IFS='; '; echo "${REASONS[*]}"). ${LINE} This means the bot needs a bigger server (m7i-flex.large, 8 GB, about 70 USD a month) or a higher copy limit. Ask Claude before changing anything." >/dev/null
