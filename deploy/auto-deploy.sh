#!/usr/bin/env bash
# ============================================================================
# AUTO-DEPLOY (runs on the EC2 server every 2 minutes via cron)
#
# Plain English:
#   Checks GitHub for new code on `main`. If there is some, it:
#     1. Pulls it
#     2. Makes sure it compiles and all tests pass
#     3. Builds dist/ (pm2 runs dist/shadowMain.js) and restarts the bot (pm2)
#     4. Watches the whole startup (up to 7 min) for crashes, then 30 s more
#   If ANY step fails, it rolls back to the previous working version,
#   restarts that, and sends you a Telegram alert. Success also alerts.
#
# Safety rules built in:
#   - Never deploys over hand edits made directly on the server (alerts instead)
#   - Never force-overwrites history (fast-forward only)
#   - A commit that failed once is not retried every 2 minutes (no alert spam)
#   - Only one copy of this script can run at a time (lock file)
#   - The server PULLS from GitHub; nothing needs to SSH into the server
#
# DEPLOY LOCK (Oct 13): while the bot is LIVE (EXECUTION_ENABLED=true in
# .env, the bot's own live switch) a new commit is NOT deployed. It is only
# noted as "update waiting: <sha> <title>" in data/deploy-pending.txt (shown
# on the status page), logged, and sent to Telegram once. Nothing is pulled,
# so the server keeps running exactly the code it had.
#   To deploy while live anyway (the owner, deliberately), ONE of:
#     touch DEPLOY_ALLOW_LIVE              (in the bot folder; next run deploys,
#                                           then the file is deleted: one use)
#     bash deploy/auto-deploy.sh --force   (deploy right now, from the bot folder)
#     DEPLOY_WHILE_LIVE=1 bash deploy/auto-deploy.sh
#   Even then, the restart waits until no live trade is in flight (the bot
#   counts them in data/inflight.json). Still busy after 60 s: the new code
#   is put back to the old version (no restart) and the next run tries again.
#   Practice mode (not live): works exactly as before, no lock.
#
# Settings (optional, override with environment variables):
#   APP_DIR   folder of the repo on the server (default: this script's repo)
#   PM2_NAME  pm2 process to restart        (default: dex-arb-shadow)
#   BRANCH    branch to deploy               (default: main)
#   INFLIGHT_WAIT_SECONDS   how long to wait for trades to finish (default 60)
# ============================================================================

# The whole script is wrapped in { ... } so bash reads ALL of it before
# running anything. This script lives in the repo it deploys, so a deploy
# can replace this very file mid-run; without the wrapper bash could carry
# on reading the NEW file from the middle.
{
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
PM2_NAME="${PM2_NAME:-dex-arb-shadow}"
BRANCH="${BRANCH:-main}"

LOCK_FILE="$SCRIPT_DIR/auto-deploy.lock"
FAILED_SHA_FILE="$SCRIPT_DIR/.last-failed-sha"
HEALTH_WAIT_SECONDS=${HEALTH_WAIT_SECONDS:-30}

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# --force on the command line = owner deploying deliberately while live.
FORCE=0
if [ "${1:-}" = "--force" ]; then FORCE=1; fi

# --- Deploy lock helpers ------------------------------------------------------
# Small functions with no side effects, so the test (src/test/deployLock.test.ts)
# can run them against fake .env / state files.

# env_file_value FILE KEY  -> prints KEY's value from FILE (last line wins),
# with quotes, spaces and a trailing "# comment" removed. Empty if missing.
# Reads only that one line, so wallet keys never enter this script.
env_file_value() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$file" 2>/dev/null | tail -n 1 \
    | sed -E -e 's/^[^=]*=//' -e 's/[[:space:]]+#.*$//' -e 's/^[[:space:]]+//' -e 's/[[:space:]]+$//' \
             -e 's/^["'\'']//' -e 's/["'\'']$//'
}

# deploy_decision APP_DIR FORCE  -> prints one word:
#   practice  bot is not live: deploy exactly as always
#   override  bot is live, but the owner allowed this deploy
#   locked    bot is live: don't deploy, just note the waiting update
# "Live" = EXECUTION_ENABLED=true in .env (the bot's own live switch; any
# capitals count, to err on the side of locking).
deploy_decision() {
  local dir="$1" force="${2:-0}" live
  live="$(env_file_value "$dir/.env" EXECUTION_ENABLED)"
  if [ "${live,,}" != "true" ]; then echo practice; return 0; fi
  if [ "$force" = 1 ] || [ "${DEPLOY_WHILE_LIVE:-0}" = 1 ] || [ -f "$dir/DEPLOY_ALLOW_LIVE" ]; then
    echo override; return 0
  fi
  echo locked
}

# inflight_count FILE NOW_SECONDS  -> how many live trades the bot says are
# in flight (data/inflight.json). 0 when the file is missing, or untouched
# for INFLIGHT_STALE_SECONDS (a crashed bot can't block deploys forever; a
# trade gives up after 90 s). A file that can't be read counts as busy.
inflight_count() {
  local file="$1" now="$2" mtime n
  [ -f "$file" ] || { echo 0; return 0; }
  mtime="$(stat -c %Y "$file" 2>/dev/null || echo 0)"
  if [ $((now - mtime)) -gt "${INFLIGHT_STALE_SECONDS:-300}" ]; then echo 0; return 0; fi
  n="$(grep -o '"count"[[:space:]]*:[[:space:]]*[0-9]\+' "$file" 2>/dev/null | grep -o '[0-9]\+$' | head -n 1)"
  echo "${n:-1}"
}

# wait_for_no_inflight FILE  -> succeeds as soon as no trade is in flight,
# fails if trades are still in flight after INFLIGHT_WAIT_SECONDS.
wait_for_no_inflight() {
  local file="$1" waited=0 limit="${INFLIGHT_WAIT_SECONDS:-60}"
  while [ "$(inflight_count "$file" "$(date +%s)")" != 0 ]; do
    [ "$waited" -ge "$limit" ] && return 1
    sleep 2; waited=$((waited + 2))
  done
  return 0
}

# The test loads only the helpers above, then stops here.
if [ "${AUTO_DEPLOY_FUNCTIONS_ONLY:-0}" = 1 ]; then return 0 2>/dev/null || exit 0; fi

PENDING_FILE="$APP_DIR/data/deploy-pending.txt"
INFLIGHT_FILE="$APP_DIR/data/inflight.json"
ALLOW_FILE="$APP_DIR/DEPLOY_ALLOW_LIVE"
LIVE=0        # 1 = deploying while live (owner override)
RESTARTED=0   # 1 = the new version has been started

# --- Only one deploy at a time ----------------------------------------------
# If a previous run is still going (slow npm install, etc.), skip this run.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  [ "$FORCE" = 1 ] && echo "Another deploy run is in progress. Try again in a few minutes."
  exit 0
fi

cd "$APP_DIR" || { log "ERROR: APP_DIR $APP_DIR not found"; exit 1; }

# --- Log housekeeping (cheap, every run) ------------------------------------
# 1. pm2's own logs: set up pm2-logrotate ONCE (50 MB per file, keep 10,
#    compressed). Marker file so it isn't re-run every 2 minutes. Runs in the
#    background with the lock released so it can't delay a deploy.
LOGROTATE_MARK="$SCRIPT_DIR/.pm2-logrotate-set"
if [ ! -f "$LOGROTATE_MARK" ]; then
  ( exec 9>&-
    pm2 install pm2-logrotate > /dev/null 2>&1 \
      && pm2 set pm2-logrotate:max_size 50M > /dev/null 2>&1 \
      && pm2 set pm2-logrotate:retain 10 > /dev/null 2>&1 \
      && pm2 set pm2-logrotate:compress true > /dev/null 2>&1 \
      && touch "$LOGROTATE_MARK" ) &
fi
# 2. This script's own logs (deploy/*.log): past 5 MB, keep the last 2 MB.
for f in "$SCRIPT_DIR"/*.log; do
  [ -f "$f" ] || continue
  if [ "$(stat -c %s "$f" 2>/dev/null || echo 0)" -gt 5242880 ]; then
    tail -c 2097152 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  fi
done

# --- Status page (GitHub issue), throttled to every 15 min inside the script.
# Runs in the background with the lock released, so it can never delay or
# block a deploy. Does nothing until GH_STATUS_TOKEN is in .env.
( exec 9>&-; timeout 60 node "$SCRIPT_DIR/status-report.js" >> "$SCRIPT_DIR/status-report.log" 2>&1 ) &

# --- Telegram alerts --------------------------------------------------------
# Reads ONLY the two Telegram lines from the bot's .env (does not load the
# rest of the file, so wallet keys etc. never enter this script).
read_env_value() {
  local key="$1"
  [ -f "$APP_DIR/.env" ] || return 0
  grep -E "^${key}=" "$APP_DIR/.env" | tail -n 1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}
TG_TOKEN="$(read_env_value TELEGRAM_BOT_TOKEN)"
TG_CHATS="$(read_env_value TELEGRAM_CHAT_ID)"

# Escapes text for Telegram's HTML mode (commit subjects can contain < > &).
# (sed, not bash ${s//...}: newer bash treats '&' in the replacement as
# "the matched text", which mangles &lt; into <lt;.)
html() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# notify "<html message>"  -- sends to Telegram, logs a plain-text copy.
notify() {
  local text="$1"
  log "$(printf '%s' "$text" | sed -e 's/<[^>]*>//g' -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&amp;/\&/g' | tr '\n' ' ')"
  [ -n "$TG_TOKEN" ] && [ -n "$TG_CHATS" ] || return 0
  # Supports comma-separated chat IDs, same as the bot itself.
  IFS=',' read -ra CHATS <<< "$TG_CHATS"
  for chat in "${CHATS[@]}"; do
    chat="$(echo "$chat" | xargs)"
    [ -n "$chat" ] || continue
    curl -s -m 10 -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${chat}" \
      --data-urlencode "parse_mode=HTML" \
      --data-urlencode "disable_web_page_preview=true" \
      --data-urlencode "text=${text}" > /dev/null || true
  done
}

# Standard alert shapes (same style as the bot's own messages).
notify_not_deployed() {
  notify "⚠️ <b>NOT DEPLOYED</b> <code>${SHORT}</code>
$(html "$1")"
}

# Remember a commit that failed so we don't retry (and re-alert) every 2 min.
# A NEW commit on GitHub clears this automatically.
# Also uses up a live-deploy permission (DEPLOY_ALLOW_LIVE) and clears the
# "update waiting" note: a failed deploy must not leave the door open for
# the NEXT commit to restart the live bot without the owner asking again.
mark_failed() {
  echo "$1" > "$FAILED_SHA_FILE"
  rm -f "$ALLOW_FILE" "$PENDING_FILE"
}

# --- 1. Anything new on GitHub? ---------------------------------------------
if ! git fetch --quiet origin "$BRANCH" 2>/dev/null; then
  log "git fetch failed (network blip or GitHub access problem); will retry next run"
  exit 0
fi

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  rm -f "$PENDING_FILE"   # nothing waiting any more (e.g. deployed by hand)
  [ "$FORCE" = 1 ] && log "Already up to date ($(git log -1 --format='%h %s')). Nothing to deploy."
  exit 0   # up to date, nothing to do
fi

if [ -f "$FAILED_SHA_FILE" ] && [ "$(cat "$FAILED_SHA_FILE")" = "$REMOTE_SHA" ]; then
  [ "$FORCE" = 1 ] && log "Commit ${REMOTE_SHA:0:7} already failed to deploy (see deploy/auto-deploy.log). Push a fix."
  exit 0   # this exact commit already failed; waiting for a fix to be pushed
fi

SHORT="${REMOTE_SHA:0:7}"
SUBJECT="$(git log -1 --format=%s "$REMOTE_SHA")"

# --- 1b. Deploy lock: is the bot live? -----------------------------------------
case "$(deploy_decision "$APP_DIR" "$FORCE")" in
  locked)
    # Note the waiting update; log + Telegram only when it's a NEW commit,
    # not every 2 minutes. Nothing is pulled; the bot is not touched.
    WAITING="$SHORT $SUBJECT"
    if [ "$(cat "$PENDING_FILE" 2>/dev/null || true)" != "$WAITING" ]; then
      mkdir -p "$(dirname "$PENDING_FILE")" && printf '%s\n' "$WAITING" > "$PENDING_FILE"
      notify "🔒 <b>UPDATE WAITING</b> <code>${SHORT}</code>
$(html "$SUBJECT")
Bot is LIVE, so it was not deployed or restarted (update waiting: ${SHORT}).
To deploy it: <code>touch DEPLOY_ALLOW_LIVE</code> in the bot folder, or <code>bash deploy/auto-deploy.sh --force</code>"
    fi
    exit 0
    ;;
  override)
    LIVE=1
    WHY="DEPLOY_ALLOW_LIVE file"
    [ "${DEPLOY_WHILE_LIVE:-0}" = 1 ] && WHY="DEPLOY_WHILE_LIVE=1"
    [ "$FORCE" = 1 ] && WHY="--force"
    log "Bot is LIVE but the owner allowed this deploy ($WHY)"
    ;;
  *) ;;   # practice: deploy exactly as always
esac

log "New commit found: $SHORT $SUBJECT"

# --- 2. Refuse to overwrite hand edits on the server -------------------------
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
  notify_not_deployed "Server is on branch '$CURRENT_BRANCH', expected '$BRANCH'."
  mark_failed "$REMOTE_SHA"; exit 1
fi

if ! git diff --quiet HEAD --; then
  notify_not_deployed "The server has hand edits to tracked files. Commit or discard them (git status); it deploys with the next push."
  mark_failed "$REMOTE_SHA"; exit 1
fi

PREV_SHA="$LOCAL_SHA"

# --- 3. Pull the new code (fast-forward only, never force) --------------------
# npm writes its own package-lock.json on the server. If the repo starts
# tracking one, that untracked copy would block the pull ("would be
# overwritten") and look like diverged history. Remove it only when it's
# untracked here AND the incoming commit has one.
if [ -f package-lock.json ] && ! git ls-files --error-unmatch package-lock.json > /dev/null 2>&1 \
   && git cat-file -e "origin/$BRANCH:package-lock.json" 2>/dev/null; then
  log "Removing the server's untracked package-lock.json (the repo now has one)"
  rm -f package-lock.json
fi
if ! git merge --ff-only --quiet "origin/$BRANCH"; then
  notify_not_deployed "Server history has diverged from GitHub (fast-forward impossible). Needs a manual look."
  mark_failed "$REMOTE_SHA"; exit 1
fi

PKG_CHANGED=0
if ! git diff --quiet "$PREV_SHA" "$REMOTE_SHA" -- package.json package-lock.json; then
  PKG_CHANGED=1
fi

pm2_info() {
  # Prints "<status> <restart count>" for the bot, or "missing 0"
  pm2 jlist 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const p = JSON.parse(s).find(x => x.name === process.argv[1]);
        console.log(p ? `${p.pm2_env.status} ${p.pm2_env.restart_time}` : "missing 0");
      } catch { console.log("missing 0"); }
    });' "$PM2_NAME"
}

rollback() {
  local reason="$1"
  log "Rolling back to ${PREV_SHA:0:7}: $reason"
  # Every rollback step is checked: a failed rollback must say so, not
  # claim the old version is running.
  local rb_err=""
  git reset --hard --quiet "$PREV_SHA" || rb_err="git reset failed"
  if [ -z "$rb_err" ] && [ "$PKG_CHANGED" = 1 ]; then
    npm install --no-audit --no-fund > /dev/null 2>&1 || rb_err="npm install of the old version failed"
  fi
  # Rebuild the old version too: pm2 runs the compiled dist/, not src/.
  if [ -z "$rb_err" ]; then npm run build > /dev/null 2>&1 || rb_err="build of the old version failed (dist/ may be missing)"; fi
  # Live and the new version was never started: the bot is still running the
  # old version untouched, so DON'T restart it (no needless mid-trade restart).
  if [ "$LIVE" = 1 ] && [ "$RESTARTED" = 0 ]; then
    [ -z "$rb_err" ] && log "Live: the bot was never restarted and still runs the old version; leaving it alone"
  else
    if [ -z "$rb_err" ]; then pm2 restart "$PM2_NAME" --update-env > /dev/null 2>&1 || rb_err="pm2 restart of the old version failed"; fi
    if [ -z "$rb_err" ]; then
      sleep 20
      read -r RB_STATUS _ <<< "$(pm2_info)"
      [ "$RB_STATUS" = "online" ] || rb_err="old version not running after rollback (status: $RB_STATUS)"
    fi
  fi
  if [ -n "$rb_err" ]; then
    notify "🆘 <b>DEPLOY FAILED + ROLLBACK FAILED</b> <code>${SHORT}</code>
$(html "$SUBJECT")
Reason: $(html "$reason")
Rollback: $(html "$rb_err")
Bot may be DOWN. Needs a manual look (pm2 logs $PM2_NAME)."
  else
    notify "🔴 <b>DEPLOY FAILED</b> <code>${SHORT}</code>
$(html "$SUBJECT")
Reason: $(html "$reason")
↩️ Rolled back to <code>${PREV_SHA:0:7}</code>, bot running old version"
  fi
  mark_failed "$REMOTE_SHA"
  exit 1
}

if [ "$PKG_CHANGED" = 1 ]; then
  log "package.json changed, installing packages"
  npm install --no-audit --no-fund || rollback "npm install failed"
fi

# --- 4. Must compile and pass every test before restarting -------------------
npm run typecheck || rollback "code does not compile"
npm test          || rollback "tests failed"

# --- 4b. Compile src/ into dist/ (what pm2 actually runs) --------------------
# Without this step a restart just relaunches the previously built code.
npm run build     || rollback "build failed"

# --- 5. Restart and watch it stay up -----------------------------------------
# Where pm2 writes the bot's output, and how big it is before the restart,
# so we only look for the startup line in NEW output.
OUT_LOG="$(pm2 jlist 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    try { const p = JSON.parse(s).find(x => x.name === process.argv[1]); console.log(p ? p.pm2_env.pm_out_log_path : ""); }
    catch { console.log(""); }
  });' "$PM2_NAME")"
LOG_START=$(stat -c %s "$OUT_LOG" 2>/dev/null || echo 0)

# --- 4c. Live: never restart in the middle of a real trade -------------------
# Wait (up to INFLIGHT_WAIT_SECONDS) until the bot says no live trade is in
# flight. Still busy: put the old code back WITHOUT restarting (the bot keeps
# running the old version) and try again on the next run. The commit is not
# marked failed and DEPLOY_ALLOW_LIVE is kept, so the retry happens by itself.
if [ "$LIVE" = 1 ] && ! wait_for_no_inflight "$INFLIGHT_FILE"; then
  log "Live trade still in flight after ${INFLIGHT_WAIT_SECONDS:-60}s; not restarting. Putting the old code back; will retry next run."
  undo_err=""
  git reset --hard --quiet "$PREV_SHA" || undo_err="git reset failed"
  if [ -z "$undo_err" ] && [ "$PKG_CHANGED" = 1 ]; then
    npm install --no-audit --no-fund > /dev/null 2>&1 || undo_err="npm install of the old version failed"
  fi
  if [ -z "$undo_err" ]; then npm run build > /dev/null 2>&1 || undo_err="build of the old version failed (dist/ may be missing)"; fi
  if [ -n "$undo_err" ]; then
    notify "🆘 <b>DEPLOY SKIPPED, CLEANUP FAILED</b> <code>${SHORT}</code>
$(html "$SUBJECT")
A live trade was in flight so the bot was NOT restarted (still running the old version), but putting the old code back failed: $(html "$undo_err").
Needs a manual look before the bot restarts for any reason."
  fi
  exit 0
fi

pm2 restart "$PM2_NAME" --update-env > /dev/null 2>&1 || rollback "pm2 restart failed"
RESTARTED=1
# The live-deploy permission is used up the moment the restart happens.
[ "$LIVE" = 1 ] && rm -f "$ALLOW_FILE"
sleep 5
read -r STATUS_A RESTARTS_A <<< "$(pm2_info)"

# Startup takes minutes (pair discovery, scans), so watch the WHOLE startup:
# up to STARTUP_WAIT_SECONDS for "[startup] fully running", rolling back on
# any crash in that window, then HEALTH_WAIT_SECONDS more to be sure it stays
# up. (The old 35 s check passed builds that crashed later in startup.)
STARTUP_WAIT_SECONDS=${STARTUP_WAIT_SECONDS:-420}
STARTED=0
waited=0
while [ "$waited" -lt "$STARTUP_WAIT_SECONDS" ]; do
  sleep 10; waited=$((waited + 10))
  read -r STATUS_B RESTARTS_B <<< "$(pm2_info)"
  [ "$STATUS_B" = "online" ] || rollback "bot not running after restart (status: $STATUS_B)"
  [ "$RESTARTS_B" = "$RESTARTS_A" ] || rollback "bot crashed and restarted $((RESTARTS_B - RESTARTS_A))x during startup (${waited}s in)"
  if [ -n "$OUT_LOG" ] && [ -f "$OUT_LOG" ]; then
    size=$(stat -c %s "$OUT_LOG" 2>/dev/null || echo 0)
    [ "$size" -lt "$LOG_START" ] && LOG_START=0   # log was rotated meanwhile
    if tail -c +$((LOG_START + 1)) "$OUT_LOG" 2>/dev/null | grep -q '\[startup\] fully running'; then STARTED=1; break; fi
  fi
done

sleep "$HEALTH_WAIT_SECONDS"
read -r STATUS_C RESTARTS_C <<< "$(pm2_info)"
[ "$STATUS_C" = "online" ] || rollback "bot stopped right after startup (status: $STATUS_C)"
[ "$RESTARTS_C" = "$RESTARTS_A" ] || rollback "bot crashed and restarted $((RESTARTS_C - RESTARTS_A))x right after startup"

rm -f "$FAILED_SHA_FILE" "$PENDING_FILE"
if [ "$STARTED" = 1 ]; then
  notify "🚀 <b>DEPLOYED</b> <code>${SHORT}</code>
$(html "$SUBJECT")
✅ Bot fully started and stable"
else
  notify "🚀 <b>DEPLOYED</b> <code>${SHORT}</code>
$(html "$SUBJECT")
⚠️ Bot is up with no crashes, but the startup-finished line wasn't seen within $((STARTUP_WAIT_SECONDS / 60)) min. Worth a look."
fi
exit 0
}
