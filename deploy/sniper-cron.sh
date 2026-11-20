#!/usr/bin/env bash
# ============================================================================
# SNIPER AUTO-RUN (runs on the EC2 server every 2 minutes via cron)
#
# Plain English:
#   Keeps the paper sniper up to date and running, and reports its results to
#   a GitHub issue, so nobody has to open a terminal:
#     1. Pulls the newest sniper build from the "sniper-bin" branch.
#     2. Reads deploy/run.env (the settings) from that build.
#     3. With SNIPER_ENGINE=1 in run.env: makes sure the sniper's own
#        engine (deploy/sniper-engine.sh) is running first (see step 2b).
#     4. (Re)starts the sniper if the build or settings changed, or if it
#        stopped. SNIPER_ENABLED=0 in run.env stops it (kill switch).
#     5. Every 15 minutes, posts the paper-trade scoreboard to the GitHub
#        issue "Sniper paper status".
#
# Safety:
#   - Paper only. The sniper holds no keys and cannot send transactions.
#   - Never touches the arb bot: no pm2, no restarts, no edits. From the arb
#     bot's .env it reads ONE line only, GH_STATUS_TOKEN (the existing
#     issues-only GitHub token), exactly like the arb bot's status page does.
#   - One copy at a time (lock file). Logs to ~/sniper-bin/cron.log.
#
# Config written once by install-sniper-cron.sh: ~/.sniper-cron.conf
#   ARB_ENV=/path/to/arb/.env     SNIPER_ISSUE=<number, filled in automatically>
# ============================================================================
{
set -uo pipefail

DIR="${SNIPER_DIR:-$HOME/sniper-bin}"
CONF="$HOME/.sniper-cron.conf"
STATE="$HOME/.sniper-cron.state"
REPO="rankine-labs/multichain-arb-engine"
REPORT_EVERY_MIN="${REPORT_EVERY_MIN:-15}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# Only one copy at a time.
exec 9>"$HOME/.sniper-cron.lock"
flock -n 9 || exit 0

cd "$DIR" || { log "no $DIR"; exit 1; }
touch "$CONF" "$STATE"

# Read KEY=VALUE from a file (last match wins, quotes stripped). Never sources it.
kv() { grep -E "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
set_kv() { # file key value
  grep -v -E "^$2=" "$1" > "$1.tmp" 2>/dev/null || true
  echo "$2=$3" >> "$1.tmp" && mv "$1.tmp" "$1"
}

# --- 1. Newest build ----------------------------------------------------------
git fetch -q origin sniper-bin 2>/dev/null || log "fetch failed (keeping current build)"
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/sniper-bin 2>/dev/null || git rev-parse HEAD)" ]; then
  # The branch is replaced on every build, so reset instead of pull.
  git reset -q --hard origin/sniper-bin && log "updated to $(git log -1 --format=%s)"
fi
chmod +x sniper 2>/dev/null || true

# --- 2. Settings --------------------------------------------------------------
RUN="deploy/run.env"
[ -f "$RUN" ] || { log "no $RUN in build"; exit 1; }
ENABLED="$(kv "$RUN" SNIPER_ENABLED)"
# SNIPER_MODE: one or more read-only programs, space separated.
MODES="$(kv "$RUN" SNIPER_MODE)"; MODES="${MODES:-paper}"
# A server can run its own set instead (MODES=... in ~/.sniper-cron.conf),
# e.g. the separate feed server runs only feed-watch.
HOST_MODES="$(kv "$CONF" MODES)"; [ -n "$HOST_MODES" ] && MODES="$HOST_MODES"
# MODES=none: this server runs no sniper program (e.g. the feed server only relays).
[ "$MODES" = "none" ] && MODES=""
ALLOWED=" paper feed-watch "
for M in $MODES; do
  case "$ALLOWED" in *" $M "*) ;; *) log "mode '$M' not allowed here (read-only/paper modes only)"; exit 1;; esac
done
# Output folder per mode: SNIPER_OUT_<MODE> (e.g. SNIPER_OUT_FEED_WATCH), else SNIPER_OUT.
out_for() { local K="SNIPER_OUT_$(echo "$1" | tr 'a-z-' 'A-Z_')"; local O="$(kv "$RUN" "$K")"; [ -n "$O" ] || O="$(kv "$RUN" SNIPER_OUT)"; echo "${O:-$1-out/run1}"; }
running_pid() { pgrep -f "^./sniper $1\$" | head -1 || true; }
stop_mode() { pkill -f "^./sniper $1\$" 2>/dev/null && sleep 1; true; }

# Old one-off probes that open their OWN sequencer-feed connection must never
# linger: Robinhood's feed blocks a server for an hour after repeated rejected
# connections, and that also cuts off the arb bot's feed on the same server.
for OLD in rhc-probe probe scan; do
  if pgrep -f "^./sniper $OLD" >/dev/null; then pkill -f "^./sniper $OLD"; log "stopped leftover sniper $OLD (shares the feed with the arb bot)"; fi
done

# Feed server only (FEED_RELAY=1 in conf): keep the compressed-feed relay
# running (deploy/feed-relay.py); feed-watch then reads ws://127.0.0.1:9642.
RELAY="$(kv "$CONF" FEED_RELAY)"
if [ "$RELAY" = "1" ] && ! pgrep -f "feed-relay.py" >/dev/null; then
  # FEED_RELAY_HOST=0.0.0.0 lets the main server read the relay over the
  # private network (the AWS firewall only lets the main server in).
  FEED_RELAY_HOST="$(kv "$CONF" FEED_RELAY_HOST)" nohup python3 deploy/feed-relay.py >> feed-relay.log 2>&1 9>&- &
  log "started feed relay (pid $!)"; sleep 2
fi

# What should be running: this build + these settings.
# (The program file itself, not the git commit: a change to scripts or
# studies under deploy/ must NOT restart the running bots.)
WANT="$(sha256sum sniper | cut -c1-16):$(sha256sum "$RUN" | cut -c1-16)"

# --- 2b. The sniper's own engine (speed step 2) -------------------------------
# SNIPER_ENGINE=1 in run.env: make sure the sniper's OWN arbsim copy
# (deploy/sniper-engine.sh) is up BEFORE the paper bot is started or kept.
#   - Only on a server that runs the paper bot, and only while enabled
#     (the feed server and the kill switch never start it).
#   - Started if it is not running, or if it runs but its socket has not
#     answered for ENGINE_GRACE_S (default 180 s) since it was started.
#   - Left alone when healthy: a new build or new settings restart only the
#     paper bot, never a healthy engine (it keeps its warm chain copy).
#   - After a failed start, waits ENGINE_RETRY_S (default 600 s) before
#     trying again, so a broken setup can't fill the log every 2 minutes.
#   - Never touches the dex bot's engine, socket (/tmp/arbsim.sock) or pm2.
#   - Logs one line per (re)start. Node links never reach the log.
#   - Memory guard first (see just below): an engine over its memory limit
#     is stopped, and its restart waits out a growing backoff.
# SNIPER_ENGINE unset (or not 1): nothing here runs at all.
ENGINE_DIR="${ENGINE_DIR:-$HOME/sniper-engine}"
ENGINE_GRACE_S="${ENGINE_GRACE_S:-180}"
ENGINE_RETRY_S="${ENGINE_RETRY_S:-600}"
# Never print a node link (they hold API keys): any "scheme://..." becomes <link>.
redact() { sed -E 's#[A-Za-z][A-Za-z0-9+.-]*://[^[:space:]"'\'']*#<link>#g'; }
# Is the engine process from our pid file alive and really an arbsim (not
# a finished "zombie", not some other program that got the same pid)?
engine_alive() {
  local P; P="$(cat "$ENGINE_DIR/engine.pid" 2>/dev/null)"
  [ -n "$P" ] && kill -0 "$P" 2>/dev/null && ps -p "$P" -o stat=,args= 2>/dev/null | grep -v '^ *Z' | grep -q arbsim
}
# Does the engine socket accept a connection (2 s max)?
engine_socket_ok() {
  [ -S "$1" ] && python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.settimeout(2); s.connect(sys.argv[1])' "$1" 2>/dev/null
}
case " $MODES " in *" paper "*) PAPER_HERE=1;; *) PAPER_HERE=0;; esac
# MEMORY GUARD (always, whatever run.env says, also for an engine kept
# after a trial): over ENGINE_MEM_LIMIT_MB (default 1500 MB) the engine is
# stopped and logged; restarts below then follow the backoff in
# deploy/sniper-engine.sh (first one at once, then 120 s, 240 s ... 30 min).
if engine_alive; then
  GOUT="$(ENGINE_DIR="$ENGINE_DIR" bash deploy/sniper-engine.sh guard 2>&1 9>&- | redact | tail -1 | sed -E 's/^\[[^]]*\] sniper-engine: //')"
  [ -n "$GOUT" ] && log "engine $GOUT"
fi
# Kill switch: SNIPER_ENABLED=0 also stops the sniper's own engine (never
# the dex bot's). It comes back by itself when the switch is turned back on.
if [ "$ENABLED" != "1" ] && engine_alive; then
  ENGINE_DIR="$ENGINE_DIR" bash deploy/sniper-engine.sh stop >/dev/null 2>&1 9>&-
  log "engine stopped (kill switch: SNIPER_ENABLED=$ENABLED)"
fi
if [ "$(kv "$RUN" SNIPER_ENGINE)" = "1" ] && [ "$ENABLED" = "1" ] && [ "$PAPER_HERE" = 1 ]; then
  # Same socket the paper bot will use (SNIPER_ENGINE_SOCKET, else its default).
  ESOCK="$(kv "$RUN" SNIPER_ENGINE_SOCKET)"; ESOCK="${ESOCK:-/tmp/sniper-arbsim.sock}"
  WHY=""
  if [ "$ESOCK" = "/tmp/arbsim.sock" ]; then
    log "engine: refusing SNIPER_ENGINE_SOCKET=/tmp/arbsim.sock (the dex bot's engine)"
  elif ! engine_alive; then
    WHY="was not running"
  elif ! engine_socket_ok "$ESOCK"; then
    # Still starting up? Give it ENGINE_GRACE_S from its start (pid file time).
    STARTED_AT="$(stat -c %Y "$ENGINE_DIR/engine.pid" 2>/dev/null || echo 0)"
    [ $(( $(date +%s) - STARTED_AT )) -ge "$ENGINE_GRACE_S" ] && WHY="socket $ESOCK not answering"
  fi
  if [ -n "$WHY" ]; then
    LAST_FAIL="$(kv "$STATE" ENGINE_FAILED_AT)"; LAST_FAIL="${LAST_FAIL:-0}"
    if [ $(( $(date +%s) - LAST_FAIL )) -ge "$ENGINE_RETRY_S" ]; then
      # 9>&- : the engine must not inherit our lock (same as the sniper below).
      if engine_alive; then
        ENGINE_SOCKET="$ESOCK" ENGINE_DIR="$ENGINE_DIR" bash deploy/sniper-engine.sh stop >/dev/null 2>&1 9>&-
      else
        # A stale pid file (engine gone) would make "start" think it still
        # runs, and "stop" could hit an unrelated program: just drop it.
        rm -f "$ENGINE_DIR/engine.pid"
      fi
      EOUT="$(ENGINE_SOCKET="$ESOCK" ENGINE_DIR="$ENGINE_DIR" bash deploy/sniper-engine.sh start 2>&1 9>&- | redact | tail -1 | sed -E 's/^\[[^]]*\] sniper-engine: //')"
      if engine_alive; then
        set_kv "$STATE" ENGINE_FAILED_AT ""
        set_kv "$STATE" ENGINE_BACKOFF_SAID ""
        log "engine (re)started [$WHY]: $EOUT"
      elif echo "$EOUT" | grep -q "memory backoff"; then
        # Waiting out the memory backoff on purpose: not a failure. Said
        # once per backoff period (not every 2 minutes).
        NEXT_AT="$(kv "$ENGINE_DIR/memguard.state" NEXT_START_AT)"
        if [ "$(kv "$STATE" ENGINE_BACKOFF_SAID)" != "$NEXT_AT" ]; then
          set_kv "$STATE" ENGINE_BACKOFF_SAID "$NEXT_AT"
          log "engine not started [$WHY]: $EOUT (paper bot uses the node meanwhile)"
        fi
      else
        set_kv "$STATE" ENGINE_FAILED_AT "$(date +%s)"
        log "engine start FAILED [$WHY]: $EOUT (next try in ${ENGINE_RETRY_S}s; paper bot falls back to the node)"
      fi
    fi
  fi
fi

# --- 3. Start / restart / stop ------------------------------------------------
for M in $(echo "$ALLOWED"); do
  KEY="RUNNING_$(echo "$M" | tr 'a-z-' 'A-Z_')"
  HAVE="$(kv "$STATE" "$KEY")"
  PID="$(running_pid "$M")"
  case " $MODES " in *" $M "*) WANTED=1;; *) WANTED=0;; esac
  if [ "$ENABLED" != "1" ] || [ "$WANTED" = 0 ]; then
    if [ -n "$PID" ]; then stop_mode "$M"; log "stopped $M (enabled=$ENABLED, in SNIPER_MODE=$WANTED)"; fi
    set_kv "$STATE" "$KEY" ""
  elif [ -z "$PID" ] || [ "$WANT" != "$HAVE" ]; then
    [ -n "$PID" ] && stop_mode "$M"
    OUT="$(out_for "$M")"
    # Pass only SNIPER_* settings (no per-mode outs, no switches), then this mode's folder.
    ARGS=()
    while IFS= read -r line; do ARGS+=("$line"); done < <(grep -E '^SNIPER_[A-Z0-9_]+=' "$RUN" | grep -v -E '^SNIPER_(ENABLED|MODE|OUT|OUT_[A-Z0-9_]+|USE_CHAINSTACK|RHC_WSS)=')
    ARGS+=("SNIPER_OUT=$OUT")
    [ "$RELAY" = "1" ] && ARGS+=("SNIPER_RHC_FEED=ws://127.0.0.1:9642")
    # SNIPER_USE_CHAINSTACK=1: give the PAPER trader the paid Chainstack node
    # (pushed swaps over websocket + quotes over https), read from the arb
    # bot's .env. Only while the arb bot is paused, so they never share the
    # budget. The links hold API keys: passed to the program, never logged.
    if { [ "$M" = paper ] || [ "$M" = feed-watch ]; } && [ "$(kv "$RUN" SNIPER_USE_CHAINSTACK)" = "1" ]; then
      ARB_ENV="$(kv "$CONF" ARB_ENV)"
      CS_WSS="$( [ -n "$ARB_ENV" ] && kv "$ARB_ENV" CHAINSTACK_WSS_ROBINHOOD )"
      CS_RPC="$( [ -n "$ARB_ENV" ] && kv "$ARB_ENV" CHAINSTACK_RPC_ROBINHOOD )"
      if [ -n "$CS_WSS" ] && [ -n "$CS_RPC" ]; then
        ARGS+=("SNIPER_RHC_WSS=$CS_WSS" "SNIPER_RHC_HTTP=$CS_RPC")
        log "$M uses Chainstack (push + quotes)"
      else
        log "SNIPER_USE_CHAINSTACK=1 but Chainstack links not found in arb .env; using the free node"
      fi
    fi
    LOGF="$M.log"; [ "$M" = paper ] && LOGF="paper.log"
    # V4 KEY CATCH-UP (same idea as the dex bot's V4 discovery "follow" step,
    # src/core/v4EventDiscovery.ts): the shared V4 key file was read once
    # from history; while the sniper runs it sees new pools live, but pools
    # created between the last read and this start were never seen ("unknown
    # v4 pool" skips). v4-history.py resumes from its saved progress, so this
    # only reads the gap (a few dozen requests per day missed), then the
    # sniper loads the refreshed file. Paper/read-only. Capped at 10 minutes;
    # a failure just means the old file is used, as before.
    if [ "$M" = paper ] && [ -f deploy/v4-history.py ] && [ -f paper-out/v4_history_progress.json ]; then
      V4RPC="$(printf '%s\n' "${ARGS[@]}" | grep '^SNIPER_RHC_HTTP=' | tail -1 | cut -d= -f2-)"
      if [ -n "$V4RPC" ]; then
        SNIPER_RHC_HTTP="$V4RPC" timeout 600 python3 deploy/v4-history.py paper-out > /dev/null 2>> v4-catchup.log \
          && log "V4 keys caught up: $(tail -1 v4-catchup.log 2>/dev/null | cut -c1-120)" \
          || log "V4 key catch-up failed or timed out (using the existing file)"
      fi
    fi
    # 9>&- : the sniper must not inherit our lock, or the next run would think we're still busy.
    env "${ARGS[@]}" nohup ./sniper "$M" >> "$LOGF" 2>&1 9>&- &
    set_kv "$STATE" "$KEY" "$WANT"
    log "started sniper $M -> $OUT (pid $!) [$( [ -z "$PID" ] && echo 'was not running' || echo 'new build or settings')]"
  fi
done

# --- 4. Reports ---------------------------------------------------------------
# build_report: scoreboards + last log lines for this server's programs.
build_report() {
  REPORT=""; TAIL=""; RUNNING_NOW=""
  for M in $MODES; do
    OUT="$(out_for "$M")"; LOGF="$M.log"; [ "$M" = paper ] && LOGF="paper.log"
    case "$M" in paper) R="$(./sniper paper-report "$OUT" 2>&1 | tail -40)";; *) R="$(./sniper "${M%-watch}-report" "$OUT" 2>&1 | tail -40)";; esac
    REPORT="$REPORT$R"$'\n\n'
    TAIL="$TAIL--- $M"$'\n'"$(tail -4 "$LOGF" 2>/dev/null)"$'\n'
    RUNNING_NOW="$RUNNING_NOW $M: $( [ -n "$(running_pid "$M")" ] && echo running || echo NOT-RUNNING )"
  done
  [ "$ENABLED" = "1" ] || RUNNING_NOW=" stopped by kill switch"
}

# 4a. Feed server: publish the report as a plain text page on the PRIVATE
#     network (PUBLISH_PORT=8080 in conf). The AWS firewall only lets the main
#     server read it. No secrets live on the feed server.
PORT="$(kv "$CONF" PUBLISH_PORT)"
if [ -n "$PORT" ]; then
  build_report
  mkdir -p "$HOME/report-public"
  { echo "feed server:$RUNNING_NOW ($(date -u '+%H:%M') UTC)"; echo "$REPORT"; echo "$TAIL"; } > "$HOME/report-public/status.tmp" && mv "$HOME/report-public/status.tmp" "$HOME/report-public/status.txt"
  if ! pgrep -f "http.server $PORT" >/dev/null; then
    nohup python3 -m http.server "$PORT" --directory "$HOME/report-public" >/dev/null 2>&1 9>&- &
    log "report page started on port $PORT"
  fi
fi

# 4b. Main server: post to the GitHub issue every 15 min (adds the feed
#     server's page when REMOTE_REPORT=http://<private ip>:8080/status.txt).
NOW=$(date +%s)
LAST=$(kv "$STATE" LAST_REPORT); LAST=${LAST:-0}
ARB_ENV="$(kv "$CONF" ARB_ENV)"
TOKEN="$( [ -n "$ARB_ENV" ] && kv "$ARB_ENV" GH_STATUS_TOKEN )"
if [ -n "$TOKEN" ] && [ $((NOW - LAST)) -ge $((REPORT_EVERY_MIN * 60)) ]; then
    build_report
    REMOTE="$(kv "$CONF" REMOTE_REPORT)"; [ -n "$REMOTE" ] || REMOTE="$(kv "$RUN" SNIPER_REMOTE_REPORT)"
    if [ -n "$REMOTE" ]; then
      RR="$(curl -s -m 5 "$REMOTE" 2>/dev/null | head -60)"
      REPORT="$REPORT=== FEED SERVER ==="$'\n'"${RR:-feed server page not reachable}"$'\n'
    fi
    ISSUE="$(kv "$CONF" SNIPER_ISSUE)"
    NEW_ISSUE="$(
      TOKEN="$TOKEN" REPO="$REPO" GH_API="${GH_API:-https://api.github.com}" ISSUE="$ISSUE" REPORT="$REPORT" TAIL="$TAIL" \
      RUNNING_NOW="$RUNNING_NOW" RUNFILE="$(grep -E '^SNIPER_' "$RUN")" BUILD="$(cat BUILD_INFO 2>/dev/null)" \
      python3 - <<'PY'
# Posts (or creates) the "Sniper paper status" issue. Prints the issue number.
import json, os, sys, time, urllib.request
tok, repo = os.environ["TOKEN"], os.environ["REPO"]
def api(method, path, body=None):
    base = os.environ.get("GH_API", "https://api.github.com")  # overridable for tests
    req = urllib.request.Request("%s/repos/%s%s" % (base, repo, path), method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + tok, "Accept": "application/vnd.github+json",
                 "User-Agent": "sniper-cron"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read() or b"null")
title = "\U0001F3AF Sniper paper status (auto-updated every 15 min)"
body = ("## Sniper:%s\n_Updated %s UTC. Paper only: no keys, no transactions._\n\n"
        "### Scoreboard\n```\n%s\n```\n### Last log lines\n```\n%s\n```\n"
        "### Settings (deploy/run.env)\n```\n%s\n```\n### Build\n```\n%s\n```\n") % (
    os.environ["RUNNING_NOW"],
    time.strftime("%Y-%m-%d %H:%M", time.gmtime()), os.environ["REPORT"], os.environ["TAIL"],
    os.environ["RUNFILE"], os.environ["BUILD"])
num = os.environ.get("ISSUE") or ""
if not num:  # reuse an open issue with our title, else create one
    for i in api("GET", "/issues?state=open&per_page=100") or []:
        if i.get("title") == title and "pull_request" not in i:
            num = str(i["number"]); break
if num:
    api("PATCH", "/issues/" + num, {"body": body})
else:
    num = str(api("POST", "/issues", {"title": title, "body": body})["number"])
print(num)
PY
    )"
    if [ -n "$NEW_ISSUE" ] && [ "$NEW_ISSUE" -eq "$NEW_ISSUE" ] 2>/dev/null; then
      [ "$NEW_ISSUE" != "$ISSUE" ] && set_kv "$CONF" SNIPER_ISSUE "$NEW_ISSUE"
      set_kv "$STATE" LAST_REPORT "$NOW"
      log "report posted to issue #$NEW_ISSUE"
    else
      log "report failed: $NEW_ISSUE"
    fi
fi
exit 0
}
