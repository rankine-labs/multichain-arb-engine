#!/usr/bin/env bash
# ============================================================================
# SNIPER AUTO-RUN (runs on the EC2 server every 2 minutes via cron)
#
# Plain English:
#   Keeps the paper sniper up to date and running, and reports its results to
#   a GitHub issue, so nobody has to open a terminal:
#     1. Pulls the newest sniper build from the "sniper-bin" branch.
#     2. Reads deploy/run.env (the settings) from that build.
#     3. (Re)starts the sniper if the build or settings changed, or if it
#        stopped. SNIPER_ENABLED=0 in run.env stops it (kill switch).
#     4. Every 15 minutes, posts the paper-trade scoreboard to the GitHub
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

# What should be running: this build + these settings.
WANT="$(git rev-parse HEAD):$(sha256sum "$RUN" | cut -c1-16)"

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
    while IFS= read -r line; do ARGS+=("$line"); done < <(grep -E '^SNIPER_[A-Z0-9_]+=' "$RUN" | grep -v -E '^SNIPER_(ENABLED|MODE|OUT|OUT_[A-Z0-9_]+)=')
    ARGS+=("SNIPER_OUT=$OUT")
    LOGF="$M.log"; [ "$M" = paper ] && LOGF="paper.log"
    # 9>&- : the sniper must not inherit our lock, or the next run would think we're still busy.
    env "${ARGS[@]}" nohup ./sniper "$M" >> "$LOGF" 2>&1 9>&- &
    set_kv "$STATE" "$KEY" "$WANT"
    log "started sniper $M -> $OUT (pid $!) [$( [ -z "$PID" ] && echo 'was not running' || echo 'new build or settings')]"
  fi
done

# --- 4. Report to GitHub every 15 min ------------------------------------------
NOW=$(date +%s)
LAST=$(kv "$STATE" LAST_REPORT); LAST=${LAST:-0}
if [ $((NOW - LAST)) -ge $((REPORT_EVERY_MIN * 60)) ]; then
  ARB_ENV="$(kv "$CONF" ARB_ENV)"
  TOKEN="$( [ -n "$ARB_ENV" ] && kv "$ARB_ENV" GH_STATUS_TOKEN )"
  if [ -z "$TOKEN" ]; then
    log "no GH_STATUS_TOKEN found (ARB_ENV=$ARB_ENV), skipping report"
  else
    REPORT=""; TAIL=""; RUNNING_NOW=""
    for M in $MODES; do
      OUT="$(out_for "$M")"; LOGF="$M.log"; [ "$M" = paper ] && LOGF="paper.log"
      R="$(./sniper "${M%-watch}-report" "$OUT" 2>&1 | tail -40)"
      [ "$M" = paper ] && R="$(./sniper paper-report "$OUT" 2>&1 | tail -40)"
      REPORT="$REPORT$R"$'\n\n'
      TAIL="$TAIL--- $M"$'\n'"$(tail -4 "$LOGF" 2>/dev/null)"$'\n'
      RUNNING_NOW="$RUNNING_NOW $M: $( [ -n "$(running_pid "$M")" ] && echo running || echo NOT-RUNNING )"
    done
    [ "$ENABLED" = "1" ] || RUNNING_NOW=" stopped by kill switch"
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
fi
exit 0
}
