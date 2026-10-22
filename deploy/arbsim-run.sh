#!/usr/bin/env bash
# ============================================================================
# ARBSIM RUNNER: the command pm2 runs for the "arbsim" app.
#
# Plain English:
#   1. Reads ONLY the lines it needs from the bot's .env:
#        CHAINSTACK_RPC_ROBINHOOD  -> paid node 1 for the sidecar
#        QUICKNODE_RPC_ROBINHOOD   -> paid node 2 (backup)
#        ARBSIM_*                  -> optional sidecar settings (see
#                                     docs/FAST_CHECK_OPS.md for the list)
#      Nothing else (wallet keys, Telegram, ...) is read or passed on.
#      The node links are secrets: they are never printed, and because they
#      are read here (not given to pm2), they never end up in pm2's saved
#      process list either.
#   2. Starts bin/arbsim at low priority (nice 5), so the bot always gets
#      the CPU first.
#
# Started by deploy/arbsim-pm2.sh; there is no need to run this by hand.
# ============================================================================
set -uo pipefail
# shellcheck source=deploy/arbsim-lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/arbsim-lib.sh"

ENV_FILE="$APP_DIR/.env"

# Optional sidecar settings: every ARBSIM_<NAME>=value line in .env is
# passed through as is (names checked to be plain ARBSIM_ names).
if [ -f "$ENV_FILE" ]; then
  while read -r key; do
    [[ "$key" =~ ^ARBSIM_[A-Z0-9_]+$ ]] || continue
    export "$key=$(env_file_value "$ENV_FILE" "$key")"
  done < <(grep -oE '^[[:space:]]*(export[[:space:]]+)?ARBSIM_[A-Z0-9_]+[[:space:]]*=' "$ENV_FILE" \
             | sed -E -e 's/^[[:space:]]*(export[[:space:]]+)?//' -e 's/[[:space:]]*=$//' | sort -u)
fi

# Paid nodes: an explicit ARBSIM_NODE_URL / ARBSIM_NODE_URL_2 line in .env
# wins; otherwise the bot's own saved Chainstack / QuickNode links are used.
if [ -z "${ARBSIM_NODE_URL:-}" ]; then
  ARBSIM_NODE_URL="$(env_file_value "$ENV_FILE" CHAINSTACK_RPC_ROBINHOOD)"
  export ARBSIM_NODE_URL
fi
if [ -z "${ARBSIM_NODE_URL_2:-}" ]; then
  ARBSIM_NODE_URL_2="$(env_file_value "$ENV_FILE" QUICKNODE_RPC_ROBINHOOD)"
  export ARBSIM_NODE_URL_2
fi

# Daily node-use counter lives in data/ (kept across restarts, never in git).
mkdir -p "$APP_DIR/data"
export ARBSIM_BUDGET_FILE="${ARBSIM_BUDGET_FILE:-$APP_DIR/data/arbsim-node-budget.json}"
# Warm restart (copy2-n): copy 2 saves itself here every minute and when
# pm2 stops it, and continues from it at the next start (instead of loading
# every pool from the node again). An ARBSIM_COPY2_STATE_FILE line in .env
# wins; "off" there = never saved / read.
export ARBSIM_COPY2_STATE_FILE="${ARBSIM_COPY2_STATE_FILE:-$APP_DIR/data/arbsim-copy2-state.bin}"
[ "$ARBSIM_COPY2_STATE_FILE" = "off" ] && export ARBSIM_COPY2_STATE_FILE=""

# Memory: at most 2 malloc "arenas" (glibc's default is 8 per CPU core).
# The sidecar runs ~20 threads (16 node workers parse big JSON answers);
# each extra arena keeps its own freed-but-not-returned memory, so with many
# arenas the process size (what pm2's memory limit sees) drifts far above
# what is really in use. 2 arenas cost nothing measurable in speed here.
# (MALLOC_ARENA_MAX already set in the environment wins.)
export MALLOC_ARENA_MAX="${MALLOC_ARENA_MAX:-2}"

# Same socket the bot uses (bot default /tmp/arbsim.sock, or ARBSIM_SOCKET).
SOCKET="${ARBSIM_SOCKET:-/tmp/arbsim.sock}"

# Say which nodes are set (yes/no only, never the links).
echo "[arbsim-run] starting $(info_value "$ARBSIM_INFO" source_commit | cut -c1-7) on $SOCKET;" \
     "node1 $([ -n "$ARBSIM_NODE_URL" ] && echo set || echo MISSING)," \
     "node2 $([ -n "$ARBSIM_NODE_URL_2" ] && echo set || echo 'not set')"

# exec: arbsim takes over this process, so pm2 watches arbsim itself
# (memory limit, restarts). nice 5 = lower priority than the bot.
exec nice -n 5 "$ARBSIM_BIN" serve "$SOCKET"
