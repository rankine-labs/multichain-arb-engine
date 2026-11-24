#!/usr/bin/env bash
# ============================================================================
# live-start.sh: start the sniper in LIVE mode by hand (real money).
#
# Plain English:
#   The cron never starts live mode. This script does, once, when the owner
#   has approved it. It runs the SAME program and settings as the cron's
#   paper trader (read from deploy/run.env + the arb bot's Chainstack links),
#   plus the live settings below, as ONE process: paper keeps trading inside
#   it for comparison and the live side copies its trades with real money.
#
#   Safety:
#     - Refuses unless run.env has SNIPER_ENABLED=0 (so the cron's paper bot
#       is off: one process, same node budget, no double trading).
#     - Refuses if any sniper paper/live process is already running.
#     - Started by its full path, so the cron (which only stops
#       "./sniper paper") never kills it by accident.
#     - No automatic restart: if it stops, it stays stopped.
#     - All live limits are enforced by the program itself (live.rs Gate):
#       per-trade cap (hard max $10), daily loss cap (hard max $20), one
#       position, stale-signal guard, halt on failures.
#   Node links are passed to the program, never printed.
#
#   Usage (from ~/sniper-bin):
#     bash deploy/live-start.sh <trade_usd> <day_loss_usd> [out_folder]
#     bash deploy/live-start.sh stop
#     bash deploy/live-start.sh status
# ============================================================================
set -u
cd "$(dirname "$0")/.." || exit 1
HERE="$(pwd)"
RUN=deploy/run.env
CONF="$HOME/.sniper-cron.conf"
PIDF="$HERE/live.pid"
KEY="$HOME/sniper-live.key"

kv() { grep -E "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'; }
alive() { [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; }

case "${1:-}" in
  stop)
    if alive; then kill "$(cat "$PIDF")"; sleep 2; echo "live: stopped (pid $(cat "$PIDF"))"; rm -f "$PIDF"; else echo "live: not running"; fi
    exit 0;;
  status)
    if alive; then echo "live: RUNNING pid $(cat "$PIDF")"; else echo "live: not running"; fi
    exit 0;;
esac

USD="${1:?usage: live-start.sh <trade_usd> <day_loss_usd> [out_folder]}"
LOSS="${2:?usage: live-start.sh <trade_usd> <day_loss_usd> [out_folder]}"
OUT="${3:-paper-out/live1}"

# --- refuse unless it is safe to start ---
[ "$(kv "$RUN" SNIPER_ENABLED)" = "0" ] || { echo "live: refuse: set SNIPER_ENABLED=0 in run.env first (cron paper bot must be off)"; exit 1; }
alive && { echo "live: refuse: already running (pid $(cat "$PIDF"))"; exit 1; }
if pgrep -f "sniper paper$" >/dev/null; then echo "live: refuse: a sniper paper process is still running"; exit 1; fi
[ -f "$KEY" ] || { echo "live: refuse: $KEY missing"; exit 1; }
[ "$(stat -c %a "$KEY")" = "600" ] || { echo "live: refuse: $KEY must be chmod 600"; exit 1; }

# --- same settings as the cron's paper trader ---
ARGS=()
while IFS= read -r line; do ARGS+=("$line"); done < <(grep -E '^SNIPER_[A-Z0-9_]+=' "$RUN" | grep -v -E '^SNIPER_(ENABLED|MODE|OUT|OUT_[A-Z0-9_]+|USE_CHAINSTACK|RHC_WSS|LIVE[A-Z0-9_]*|KEY_FILE)=')
if [ "$(kv "$RUN" SNIPER_USE_CHAINSTACK)" = "1" ]; then
  ARB_ENV="$(kv "$CONF" ARB_ENV)"
  CS_WSS="$( [ -n "$ARB_ENV" ] && kv "$ARB_ENV" CHAINSTACK_WSS_ROBINHOOD )"
  CS_RPC="$( [ -n "$ARB_ENV" ] && kv "$ARB_ENV" CHAINSTACK_RPC_ROBINHOOD )"
  if [ -n "$CS_WSS" ] && [ -n "$CS_RPC" ]; then
    ARGS+=("SNIPER_RHC_WSS=$CS_WSS" "SNIPER_RHC_HTTP=$CS_RPC")
  else
    echo "live: refuse: Chainstack links not found in the arb .env"; exit 1
  fi
fi

# --- live settings (the program re-checks every one of them) ---
mkdir -p "$OUT"
ARGS+=(
  "SNIPER_OUT=$OUT"
  "SNIPER_MODE=live"
  "SNIPER_LIVE=1"
  "SNIPER_LIVE_ACK=I approve real money trading"
  "SNIPER_KEY_FILE=$KEY"
  "SNIPER_LIVE_MAX_USD=$USD"
  "SNIPER_LIVE_DAY_LOSS_USD=$LOSS"
  "SNIPER_LIVE_LEDGER=$OUT/live-ledger.json"
)

# V4 pool keys catch-up, as the cron does before a paper start.
V4RPC="$(printf '%s\n' "${ARGS[@]}" | grep '^SNIPER_RHC_HTTP=' | tail -1 | cut -d= -f2-)"
if [ -f deploy/v4-history.py ] && [ -f paper-out/v4_history_progress.json ]; then
  SNIPER_RHC_HTTP="$V4RPC" timeout 600 python3 deploy/v4-history.py paper-out > /dev/null 2>> v4-catchup.log || true
fi

env "${ARGS[@]}" nohup "$HERE/sniper" paper >> live.log 2>&1 &
echo $! > "$PIDF"
sleep 5
if alive; then
  echo "live: STARTED pid $(cat "$PIDF") | \$$USD a trade, daily loss cap \$$LOSS | out $OUT | log live.log"
  grep -i "live" live.log | tail -5
else
  echo "live: FAILED to start; last log lines:"; tail -20 live.log; rm -f "$PIDF"; exit 1
fi
