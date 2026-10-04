#!/usr/bin/env bash
# ============================================================================
# AUTO-DEPLOY (runs on the EC2 server every 2 minutes via cron)
#
# Plain English:
#   Checks GitHub for new code on `main`. If there is some, it:
#     1. Pulls it
#     2. Makes sure it compiles and all tests pass
#     3. Builds dist/ (pm2 runs dist/shadowMain.js) and restarts the bot (pm2)
#     4. Watches the bot for 30 seconds to make sure it stays up
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
# Settings (optional, override with environment variables):
#   APP_DIR   folder of the repo on the server (default: this script's repo)
#   PM2_NAME  pm2 process to restart        (default: dex-arb-shadow)
#   BRANCH    branch to deploy               (default: main)
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

# --- Only one deploy at a time ----------------------------------------------
# If a previous run is still going (slow npm install, etc.), skip this run.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  exit 0
fi

cd "$APP_DIR" || { log "ERROR: APP_DIR $APP_DIR not found"; exit 1; }

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
mark_failed() { echo "$1" > "$FAILED_SHA_FILE"; }

# --- 1. Anything new on GitHub? ---------------------------------------------
if ! git fetch --quiet origin "$BRANCH" 2>/dev/null; then
  log "git fetch failed (network blip or GitHub access problem); will retry next run"
  exit 0
fi

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  exit 0   # up to date, nothing to do
fi

if [ -f "$FAILED_SHA_FILE" ] && [ "$(cat "$FAILED_SHA_FILE")" = "$REMOTE_SHA" ]; then
  exit 0   # this exact commit already failed; waiting for a fix to be pushed
fi

SHORT="${REMOTE_SHA:0:7}"
SUBJECT="$(git log -1 --format=%s "$REMOTE_SHA")"
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
if ! git merge --ff-only --quiet "origin/$BRANCH"; then
  notify_not_deployed "Server history has diverged from GitHub (fast-forward impossible). Needs a manual look."
  mark_failed "$REMOTE_SHA"; exit 1
fi

PKG_CHANGED=0
if ! git diff --quiet "$PREV_SHA" "$REMOTE_SHA" -- package.json; then
  PKG_CHANGED=1
fi

rollback() {
  local reason="$1"
  log "Rolling back to ${PREV_SHA:0:7}: $reason"
  git reset --hard --quiet "$PREV_SHA"
  if [ "$PKG_CHANGED" = 1 ]; then npm install --no-audit --no-fund > /dev/null 2>&1; fi
  # Rebuild the old version too: pm2 runs the compiled dist/, not src/.
  npm run build > /dev/null 2>&1
  pm2 restart "$PM2_NAME" --update-env > /dev/null 2>&1
  notify "🔴 <b>DEPLOY FAILED</b> <code>${SHORT}</code>
$(html "$SUBJECT")
Reason: $(html "$reason")
↩️ Rolled back to <code>${PREV_SHA:0:7}</code>, bot running old version"
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

pm2 restart "$PM2_NAME" --update-env > /dev/null 2>&1 || rollback "pm2 restart failed"
sleep 5
read -r STATUS_A RESTARTS_A <<< "$(pm2_info)"
sleep "$HEALTH_WAIT_SECONDS"
read -r STATUS_B RESTARTS_B <<< "$(pm2_info)"

if [ "$STATUS_B" != "online" ]; then
  rollback "bot not running after restart (status: $STATUS_B)"
fi
if [ "$RESTARTS_B" != "$RESTARTS_A" ]; then
  rollback "bot crashed and restarted $((RESTARTS_B - RESTARTS_A))x in the first ${HEALTH_WAIT_SECONDS}s"
fi

rm -f "$FAILED_SHA_FILE"
notify "🚀 <b>DEPLOYED</b> <code>${SHORT}</code>
$(html "$SUBJECT")
✅ Bot up and stable"
exit 0
}
