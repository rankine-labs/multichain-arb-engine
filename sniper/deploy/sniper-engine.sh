#!/usr/bin/env bash
# ============================================================================
# SNIPER ENGINE: start / stop / check the sniper's OWN copy of arbsim
# (speed step 2, sniper/src/engine.rs). Started automatically by
# deploy/sniper-cron.sh ONLY when deploy/run.env has SNIPER_ENGINE=1 (start
# if not running or its socket is dead; a healthy engine is left alone).
# Without that line nothing runs it; it can always be run by hand.
#
# Plain English:
#   The dex bot's arbsim program keeps a full in-memory copy of Robinhood
#   Chain and answers contract calls in about a millisecond. This script
#   runs a SECOND, completely separate copy of it just for the paper sniper:
#     - its own socket      /tmp/sniper-arbsim.sock (the dex bot uses
#                           /tmp/arbsim.sock; this script refuses that one)
#     - its own folder      ~/sniper-engine (binary copy, log, node budget)
#     - its own node budget ARBSIM_NODE_DAILY_CAP=3000 paid requests a day,
#                           2 a second; plain reads go to the FREE public node
#     - feed mode           ARBSIM_SOURCE=feed: the sniper's paper trader
#                           forwards the sequencer feed into it (SNIPER_ENGINE=1)
#     - no trading at all   started with a clean environment (env -i), so no
#                           wallet key, FASTLANE or sender setting can leak in;
#                           FASTLANE=off on top of that
#   The dex bot's own setup is not touched: no pm2, no edits to its .env, no
#   restart. From its .env ONE line is read: CHAINSTACK_RPC_ROBINHOOD (the
#   paid node link, never printed). The dex bot's TypeScript side
#   (LOCAL_SIM / nitroFeed.ts) is NOT pointed at this engine and stays off
#   for it; only the sniper talks to /tmp/sniper-arbsim.sock.
#
# Usage (on the main server):
#   bash deploy/sniper-engine.sh start    copy the binary, start the engine
#   bash deploy/sniper-engine.sh status   is it up, how far along, node use
#   bash deploy/sniper-engine.sh stop
#
# Then, to try it in paper (in deploy/run.env, on the sniper/** branch that
# builds the server, ONLY with the owner's go-ahead):
#   SNIPER_ENGINE=1
#   SNIPER_ENGINE_CHECK=1    first run: side-by-side, trades use the node
# and read the "engine quotes" section of `./sniper paper-report <dir>`.
#
# FEED WAKE-UP (speed step 3, src/feedwake.rs), side-by-side paper test.
# Needs this engine running (with SNIPER_ENGINE=1 the cron starts it). Add to deploy/run.env, on the
# sniper/** branch that builds the server, ONLY with the owner's go-ahead:
#   SNIPER_OUT=paper-out/run12          new folder: clean feed-vs-poll numbers
#   SNIPER_ENGINE=1
#   SNIPER_ENGINE_CHECK=1               trades keep using the node's quotes
#   SNIPER_FEED_WAKE=1
#   SNIPER_RHC_POLL_MS_WHEN_FEED=0      first run: node polled at today's pace
#                                       (1 s day / 0.4 s night), so "feed vs
#                                       poll" leads compare with what we have
#   SNIPER_FEED_STALE_SECS=5
#   SNIPER_YOUNG_TEST=1                 young-pool paper test group (src/paper.rs)
# SNIPER_RHC_FEED (already set) is the feed the forwarder reads; the
# wake-up uses that same one connection (no extra connection to the relay).
# Read: `./sniper paper-report paper-out/run12`, section "feed wake-up".
# Node requests: the first run (pace 0) is about the same as today (~300k a
# day), minus the V4 signer lookups the feed now answers. Once the numbers
# look right, SNIPER_RHC_POLL_MS_WHEN_FEED=2000 cuts the polling part (about
# 2 requests per poll) to ~86k a day while the feed is healthy; it goes back
# to normal pace by itself when the feed is stale. The engine reads each
# watched pool's price once from a node, then follows it from the feed
# (inside its own budget, ENGINE_DAILY_CAP). Estimates, not measured.
# Off again: remove SNIPER_FEED_WAKE (the trader then behaves exactly as
# before).
#
# Settings (optional, environment of this script):
#   ARB_DIR           dex bot folder (default: folder of ARB_ENV in
#                     ~/.sniper-cron.conf)
#   ARBSIM_SRC        arbsim binary to copy (default $ARB_DIR/bin/arbsim)
#   ENGINE_DIR        work folder (default ~/sniper-engine)
#   ENGINE_SOCKET     socket (default /tmp/sniper-arbsim.sock)
#   ENGINE_DAILY_CAP  paid node requests per day (default 3000)
# ============================================================================
set -uo pipefail

ENGINE_DIR="${ENGINE_DIR:-$HOME/sniper-engine}"
ENGINE_SOCKET="${ENGINE_SOCKET:-/tmp/sniper-arbsim.sock}"
ENGINE_DAILY_CAP="${ENGINE_DAILY_CAP:-3000}"
CONF="$HOME/.sniper-cron.conf"
PIDF="$ENGINE_DIR/engine.pid"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] sniper-engine: $*"; }
# KEY=VALUE from a file (last match wins, quotes stripped). Never sources it.
kv() { grep -E "^[[:space:]]*(export[[:space:]]+)?$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/[[:space:]]#.*$//' -e 's/^["'\'']//' -e 's/["'\'']$//'; }

running() { [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; }

if [ "$ENGINE_SOCKET" = "/tmp/arbsim.sock" ]; then
  log "refusing: /tmp/arbsim.sock is the dex bot's engine"; exit 1
fi

case "${1:-}" in
start)
  if running; then log "already running (pid $(cat "$PIDF"))"; exit 0; fi
  ARB_ENV="$(kv "$CONF" ARB_ENV)"
  ARB_DIR="${ARB_DIR:-$( [ -n "$ARB_ENV" ] && dirname "$ARB_ENV" )}"
  SRC="${ARBSIM_SRC:-$ARB_DIR/bin/arbsim}"
  [ -x "$SRC" ] || { log "no arbsim binary at $SRC (set ARBSIM_SRC)"; exit 1; }
  NODE="$( [ -n "$ARB_ENV" ] && kv "$ARB_ENV" CHAINSTACK_RPC_ROBINHOOD )"
  [ -n "$NODE" ] || { log "CHAINSTACK_RPC_ROBINHOOD not found in the dex bot's .env (ARB_ENV in $CONF)"; exit 1; }
  mkdir -p "$ENGINE_DIR"
  # Our own copy: the dex bot's updater can replace its binary at any time
  # without affecting us, and we never run from its folder.
  cp -f "$SRC" "$ENGINE_DIR/arbsim" && chmod +x "$ENGINE_DIR/arbsim"
  cd "$ENGINE_DIR" || exit 1
  # Clean environment: only what is listed here reaches the engine.
  #   HEADER_EVERY_S=2 + HISTORY=128: needed in feed mode on this ~10
  #   blocks/s chain (missing values are fetched at the node's newest block,
  #   which must still be among the blocks kept; the 300 s default breaks
  #   that after ~7 s, found by sniper/tests/engine_e2e.rs). Costs ~1 free
  #   public-node request a second.
  #   VERIFY every 20th block but at most every 5 min: ~288 paid traces/day.
  env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME" \
    ARBSIM_SOCKET="$ENGINE_SOCKET" \
    ARBSIM_SOURCE=feed \
    ARBSIM_NODE_URL="$NODE" \
    ARBSIM_NODE_DAILY_CAP="$ENGINE_DAILY_CAP" \
    ARBSIM_NODE_RPS=2 \
    ARBSIM_NODE_MIN_RPS=1 \
    ARBSIM_BUDGET_FILE="$ENGINE_DIR/node-budget.json" \
    ARBSIM_HEADER_EVERY_S=2 \
    ARBSIM_HISTORY=128 \
    ARBSIM_VERIFY_EVERY_N_BLOCKS=20 \
    ARBSIM_VERIFY_MIN_INTERVAL_S=300 \
    ARBSIM_WORKERS=2 \
    FASTLANE=off \
    nohup nice -n 10 ./arbsim serve >> "$ENGINE_DIR/engine.log" 2>&1 &
  echo $! > "$PIDF"
  sleep 1
  if running; then log "started (pid $(cat "$PIDF")), socket $ENGINE_SOCKET, log $ENGINE_DIR/engine.log"
  else log "did not start; last log lines:"; tail -5 "$ENGINE_DIR/engine.log"; exit 1; fi
  ;;
stop)
  if running; then kill "$(cat "$PIDF")"; sleep 1; log "stopped"; else log "not running"; fi
  rm -f "$PIDF"
  ;;
status)
  if running; then log "running (pid $(cat "$PIDF"))"; else log "NOT running"; fi
  # Ask the engine itself (same 4-byte length + JSON format the sniper uses).
  python3 - "$ENGINE_SOCKET" <<'PY'
import json, socket, struct, sys
try:
    s = socket.socket(socket.AF_UNIX); s.settimeout(3); s.connect(sys.argv[1])
    b = json.dumps({"id": 1, "type": "status"}).encode()
    s.sendall(struct.pack(">I", len(b)) + b)
    n = struct.unpack(">I", s.recv(4))[0]; d = b""
    while len(d) < n: d += s.recv(n - len(d))
    v = json.loads(d)
    node = v.get("node") or {}
    print(f"ready {v.get('ready')} | head block {(v.get('head') or {}).get('block')} | frames {v.get('frames')} "
          f"(dropped {v.get('frames_dropped')}) | checks {v.get('checks')} ok {v.get('checks_ok')} | "
          f"accounts {v.get('accounts')} values {v.get('slots')} | paid node today {node.get('usedToday')}/{node.get('cap')} | "
          f"restarts {v.get('restarts')} | memory {v.get('rssMb')} MB")
except Exception as e:
    print(f"engine not answering on {sys.argv[1]} ({e})")
PY
  ;;
*)
  echo "usage: $0 start|stop|status"; exit 2
  ;;
esac
