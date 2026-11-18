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
#   bash deploy/sniper-engine.sh guard    memory check (the cron runs it)
#   bash deploy/sniper-engine.sh trial [minutes] [keep]   live trial, see below
#
# RUN 12 ORDER: first `trial` (below). Only if it says WORKS, try it in
# paper (in deploy/run.env, on the sniper/** branch that builds the server,
# ONLY with the owner's go-ahead):
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
# MEMORY GUARD (run 12 prep, lesson from the dex bot: its engine normally
# runs 1,000-1,250 MB and pm2 kills it at 1,800 MB; this server has 7.7 GB
# and 2 CPUs and also runs the paper bot):
#   `guard` (run by the cron every 2 minutes whenever our engine is alive,
#   whatever run.env says) stops the engine when its memory (RSS) is over
#   ENGINE_MEM_LIMIT_MB (default 1500). One log line each time.
#   Restart backoff, like the dex bot's pm2 "wait longer between crash
#   restarts": the first memory stop may restart at once (next cron run);
#   if the engine is stopped again within ENGINE_MEM_STABLE_S (1 h) of its
#   start, the next start waits ENGINE_MEM_BACKOFF_S (120 s), then 240,
#   480 ... up to ENGINE_MEM_BACKOFF_MAX_S (1800 s). An engine that ran a
#   full hour before being stopped starts the count again. Meanwhile the
#   paper bot quietly uses the node (as it always does without the engine).
#   The engine also runs with:
#     - nice ENGINE_NICE (default 15): the paper bot always wins the CPU
#     - ARBSIM_ALLOC=mimalloc (sim/src/alloc.rs: same allocator the dex bot
#       uses, ~13% smaller than glibc's measured on the dex bot)
#     - ARBSIM_MAX_ACCOUNTS / ARBSIM_MAX_SLOTS (50,000 / 250,000, the
#       feed-mode copy's own size limits; it drops idle data above them).
#   The dex bot's seeing-ahead memory guard (ARBSIM_AHEAD_MEM_*,
#   sim/src/memguard.rs) only guards its predicted copy, which feed mode
#   does not run, so there is nothing to pass for it here.
#
# TRIAL (run 12 morning step 1): does this engine really work on the live
# chain inside its node budget? Lesson from the dex bot (sim/COPY2_PLAN.md):
# this exact "replay every chain transaction" mode needed ~2.1M node reads
# a day there. Our budget is 3,000 paid reads a day, so the engine may
# answer "unknown" most of the time. Earlier tests only used a fake node.
#   bash deploy/sniper-engine.sh trial [minutes=30] [keep]
# starts the engine ALONE (the paper bot is not touched or restarted) and
# runs `./sniper engine-trial` (src/enginetrial.rs), which forwards the
# sequencer feed relay (SNIPER_RHC_FEED from deploy/run.env) into it and,
# every minute, logs: paid node reads used vs cap, public node reads,
# ready / not ready, how many quotes for a sample of hot V3 pools (from the
# newest paper-out run's signals.jsonl) the engine answered vs "unknown",
# memory and CPU. At the end: a plain-English verdict with the numbers
# (works / falls back too often / too much memory or CPU), saved to
# ~/sniper-engine/trial-<time>.txt. The engine is then stopped, unless
# "keep" was given AND it stayed under the memory limit.
# Read-only: the trial itself never talks to a node; only the engine makes
# its own node reads, inside its own cap. Refused while the paper bot uses
# the engine (SNIPER_ENGINE=1 in run.env) or the engine already runs.
#
# Settings (optional, environment of this script):
#   ARB_DIR           dex bot folder (default: folder of ARB_ENV in
#                     ~/.sniper-cron.conf)
#   ARBSIM_SRC        arbsim binary to copy (default $ARB_DIR/bin/arbsim)
#   ENGINE_DIR        work folder (default ~/sniper-engine)
#   ENGINE_SOCKET     socket (default /tmp/sniper-arbsim.sock)
#   ENGINE_DAILY_CAP  paid node requests per day (default 3000)
#   ENGINE_MEM_LIMIT_MB       memory guard line (default 1500)
#   ENGINE_MEM_STABLE_S       run this long = backoff count starts again (3600)
#   ENGINE_MEM_BACKOFF_S      first backoff wait (120)
#   ENGINE_MEM_BACKOFF_MAX_S  longest backoff wait (1800)
#   ENGINE_NICE               CPU priority, 0-19, higher = lower (15)
#   SNIPER_BIN        sniper program for `trial` (default ./sniper next to
#                     the deploy folder)
# ============================================================================
set -uo pipefail

ENGINE_DIR="${ENGINE_DIR:-$HOME/sniper-engine}"
ENGINE_SOCKET="${ENGINE_SOCKET:-/tmp/sniper-arbsim.sock}"
ENGINE_DAILY_CAP="${ENGINE_DAILY_CAP:-3000}"
ENGINE_MEM_LIMIT_MB="${ENGINE_MEM_LIMIT_MB:-1500}"
ENGINE_MEM_STABLE_S="${ENGINE_MEM_STABLE_S:-3600}"
ENGINE_MEM_BACKOFF_S="${ENGINE_MEM_BACKOFF_S:-120}"
ENGINE_MEM_BACKOFF_MAX_S="${ENGINE_MEM_BACKOFF_MAX_S:-1800}"
ENGINE_NICE="${ENGINE_NICE:-15}"
CONF="$HOME/.sniper-cron.conf"
PIDF="$ENGINE_DIR/engine.pid"
# Memory guard memory: STREAK (stops in a row), NEXT_START_AT (unix time).
MEMF="$ENGINE_DIR/memguard.state"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # deploy/

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] sniper-engine: $*"; }
# KEY=VALUE from a file (last match wins, quotes stripped). Never sources it.
kv() { grep -E "^[[:space:]]*(export[[:space:]]+)?$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/[[:space:]]#.*$//' -e 's/^["'\'']//' -e 's/["'\'']$//'; }

running() { [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; }
# Engine memory in MB (RSS), empty if it is not running.
rss_mb() { local P; P="$(cat "$PIDF" 2>/dev/null)"; [ -n "$P" ] && ps -o rss= -p "$P" 2>/dev/null | awk '{printf "%d", $1/1024}'; }
# Stop: polite first (TERM), then KILL after 10 s.
stop_engine() {
  local P; P="$(cat "$PIDF" 2>/dev/null)"
  if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then
    kill "$P" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$P" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$P" 2>/dev/null && kill -9 "$P" 2>/dev/null
  fi
  rm -f "$PIDF"
}
# backoff_wait STREAK -> seconds to wait before the next start.
#   1st stop: 0 (restart at the next cron run), then BACKOFF, 2x, 4x ... MAX.
backoff_wait() {
  local n="$1" w="$ENGINE_MEM_BACKOFF_S" i=2
  [ "$n" -le 1 ] && { echo 0; return; }
  while [ "$i" -lt "$n" ] && [ "$w" -lt "$ENGINE_MEM_BACKOFF_MAX_S" ]; do w=$((w * 2)); i=$((i + 1)); done
  [ "$w" -gt "$ENGINE_MEM_BACKOFF_MAX_S" ] && w="$ENGINE_MEM_BACKOFF_MAX_S"
  echo "$w"
}

if [ "$ENGINE_SOCKET" = "/tmp/arbsim.sock" ]; then
  log "refusing: /tmp/arbsim.sock is the dex bot's engine"; exit 1
fi

case "${1:-}" in
start)
  if running; then log "already running (pid $(cat "$PIDF"))"; exit 0; fi
  # Memory backoff: after repeated memory stops, wait before starting again.
  NEXT="$(kv "$MEMF" NEXT_START_AT)"; NEXT="${NEXT:-0}"
  if [ "$(date +%s)" -lt "$NEXT" ]; then
    log "waiting: memory backoff, next start allowed in $((NEXT - $(date +%s))) s"; exit 3
  fi
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
  #   ALLOC / MAX_ACCOUNTS / MAX_SLOTS: memory (see the MEMORY GUARD notes).
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
    ARBSIM_ALLOC=mimalloc \
    ARBSIM_MAX_ACCOUNTS="${ENGINE_MAX_ACCOUNTS:-50000}" \
    ARBSIM_MAX_SLOTS="${ENGINE_MAX_SLOTS:-250000}" \
    FASTLANE=off \
    nohup nice -n "$ENGINE_NICE" ./arbsim serve >> "$ENGINE_DIR/engine.log" 2>&1 &
  echo $! > "$PIDF"
  sleep 1
  if running; then log "started (pid $(cat "$PIDF")), socket $ENGINE_SOCKET, log $ENGINE_DIR/engine.log, nice $ENGINE_NICE, memory limit ${ENGINE_MEM_LIMIT_MB} MB"
  else log "did not start; last log lines:"; tail -5 "$ENGINE_DIR/engine.log"; exit 1; fi
  ;;
stop)
  if running; then stop_engine; log "stopped"; else log "not running"; rm -f "$PIDF"; fi
  ;;
guard)
  # Quiet when all is well (the cron runs this every 2 minutes).
  running || exit 0
  MB="$(rss_mb)"; MB="${MB:-0}"
  [ "$MB" -gt "$ENGINE_MEM_LIMIT_MB" ] || exit 0
  NOW="$(date +%s)"
  STARTED_AT="$(stat -c %Y "$PIDF" 2>/dev/null || echo 0)"
  STREAK="$(kv "$MEMF" STREAK)"; STREAK="${STREAK:-0}"
  # Ran a full stable stretch before getting too big: count from 1 again.
  if [ $((NOW - STARTED_AT)) -ge "$ENGINE_MEM_STABLE_S" ]; then STREAK=1; else STREAK=$((STREAK + 1)); fi
  WAIT="$(backoff_wait "$STREAK")"
  stop_engine
  mkdir -p "$ENGINE_DIR"
  printf 'STREAK=%s\nNEXT_START_AT=%s\nLAST_STOP_AT=%s\nLAST_STOP_MB=%s\n' "$STREAK" "$((NOW + WAIT))" "$NOW" "$MB" > "$MEMF"
  log "memory guard: engine used ${MB} MB (limit ${ENGINE_MEM_LIMIT_MB} MB), stopped; memory stop ${STREAK} in a row, next start $( [ "$WAIT" = 0 ] && echo "allowed now" || echo "in ${WAIT} s"); paper bot uses the node meanwhile"
  exit 4
  ;;
trial)
  MIN="${2:-30}"
  case "$MIN" in ''|*[!0-9]*) echo "usage: $0 trial [minutes] [keep]"; exit 2;; esac
  KEEP=0; [ "${3:-}" = "keep" ] && KEEP=1
  RUN="$HERE/run.env"
  if [ "$(kv "$RUN" SNIPER_ENGINE)" = "1" ]; then
    log "trial refused: the paper bot uses the engine (SNIPER_ENGINE=1 in run.env); use 'status' instead"; exit 1
  fi
  if running; then
    log "trial refused: the engine is already running (pid $(cat "$PIDF")); 'stop' it first for a clean trial"; exit 1
  fi
  FEED="$(kv "$RUN" SNIPER_RHC_FEED)"
  # Never open our own connection to Robinhood's feed itself: repeated
  # rejected connections block the whole server for an hour (and the dex
  # bot's feed with it). Only our relay on the feed server.
  case "$FEED" in ''|*feed.mainnet.chain.robinhood.com*) log "trial refused: SNIPER_RHC_FEED in run.env must be our feed relay"; exit 1;; esac
  SNIPER_BIN="${SNIPER_BIN:-$HERE/../sniper}"
  [ -x "$SNIPER_BIN" ] || { log "no sniper program at $SNIPER_BIN (set SNIPER_BIN)"; exit 1; }
  # Hot V3 pools: the newest paper-out run that has a signals file.
  SIGS="${TRIAL_SIGNALS:-$(ls -t "$HERE"/../paper-out/*/signals.jsonl 2>/dev/null | head -1)}"
  bash "$0" start || exit 1
  mkdir -p "$ENGINE_DIR"
  OUTF="$ENGINE_DIR/trial-$(date '+%Y%m%d-%H%M').txt"
  log "trial: ${MIN} minutes, sample pools from ${SIGS:-<none found>}, results also in $OUTF"
  # Clean environment again: the trial gets no node link at all.
  env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME" \
    SNIPER_ENGINE_SOCKET="$ENGINE_SOCKET" \
    SNIPER_RHC_FEED="$FEED" \
    TRIAL_MINUTES="$MIN" \
    TRIAL_TICK_SECS="${TRIAL_TICK_SECS:-60}" \
    TRIAL_SIGNALS="$SIGS" \
    TRIAL_SAMPLE="${TRIAL_SAMPLE:-10}" \
    TRIAL_MIN_ANSWER_PCT="${TRIAL_MIN_ANSWER_PCT:-80}" \
    TRIAL_MAX_CPU_PCT="${TRIAL_MAX_CPU_PCT:-60}" \
    ENGINE_PID="$(cat "$PIDF")" \
    ENGINE_MEM_LIMIT_MB="$ENGINE_MEM_LIMIT_MB" \
    ENGINE_DAILY_CAP="$ENGINE_DAILY_CAP" \
    "$SNIPER_BIN" engine-trial 2>&1 | tee "$OUTF"
  RC="${PIPESTATUS[0]}"
  # RC 3 = the engine went over the memory limit: never kept.
  if [ "$KEEP" = 1 ] && [ "$RC" != 3 ]; then
    log "trial done; engine KEPT running (pid $(cat "$PIDF" 2>/dev/null)). Nobody feeds it until the paper bot runs with SNIPER_ENGINE=1."
  else
    stop_engine; log "trial done; engine stopped"
  fi
  exit "$RC"
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
          f"restarts {v.get('restarts')} | memory {v.get('rssMb')} MB | public node today {(node.get('public') or {}).get('usedToday')}")
except Exception as e:
    print(f"engine not answering on {sys.argv[1]} ({e})")
PY
  ;;
*)
  echo "usage: $0 start|stop|status|guard|trial [minutes] [keep]"; exit 2
  ;;
esac
