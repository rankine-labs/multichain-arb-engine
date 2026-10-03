#!/usr/bin/env bash
# ============================================================================
# ONE-TIME SETUP for auto-deploy. Run this once on the EC2 server:
#
#     cd <the bot's folder>
#     bash deploy/install-auto-deploy.sh
#
# What it does:
#   1. Checks the tools it needs are installed (git, node, npm, pm2, curl, flock)
#   2. Checks this folder is the bot's git repo and the pm2 process exists
#   3. Sets up a read-only GitHub "deploy key" so the server can still pull
#      after the repo is made private (prints the key for you to add on GitHub)
#   4. Adds a cron job that runs deploy/auto-deploy.sh every 2 minutes
#
# Safe to run more than once. It never restarts the bot or changes code.
# ============================================================================

set -uo pipefail

REPO_SLUG="rankine-labs/multichain-arb-engine"
PM2_NAME="${PM2_NAME:-dex-arb-shadow}"
SSH_HOST_ALIAS="github-arb-engine"
KEY_PATH="$HOME/.ssh/arb_engine_deploy"
CRON_MARKER="# arb-engine-auto-deploy"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

ok()   { echo "  [ok]   $*"; }
warn() { echo "  [!!]   $*"; }
fail() { echo "  [FAIL] $*"; exit 1; }

echo "Auto-deploy setup for $APP_DIR"
echo

# --- 1. Required tools --------------------------------------------------------
echo "1. Checking tools"
for tool in git node npm pm2 curl flock; do
  command -v "$tool" > /dev/null 2>&1 && ok "$tool found" || fail "$tool is not installed or not on PATH"
done
echo

# --- 2. Right folder, right process -------------------------------------------
echo "2. Checking repo and bot"
git -C "$APP_DIR" rev-parse --git-dir > /dev/null 2>&1 || fail "$APP_DIR is not a git repo"
REMOTE_URL="$(git -C "$APP_DIR" remote get-url origin 2>/dev/null || true)"
echo "$REMOTE_URL" | grep -qi "multichain-arb-engine" || fail "origin is '$REMOTE_URL', expected $REPO_SLUG"
ok "repo origin: $REMOTE_URL"
ok "on branch: $(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD)"
if pm2 describe "$PM2_NAME" > /dev/null 2>&1; then
  ok "pm2 process '$PM2_NAME' exists"
else
  fail "pm2 process '$PM2_NAME' not found (check: pm2 status)"
fi
if ! git -C "$APP_DIR" diff --quiet HEAD --; then
  warn "server has hand edits to tracked files. Auto-deploy will refuse to run until"
  warn "they are committed or discarded. See: git -C $APP_DIR status"
fi
[ -f "$APP_DIR/.env" ] && grep -q "^TELEGRAM_BOT_TOKEN=" "$APP_DIR/.env" \
  && ok "Telegram settings found in .env (deploy alerts will be sent)" \
  || warn "no TELEGRAM_BOT_TOKEN in $APP_DIR/.env, deploys will run but won't alert"
echo

# --- 3. Deploy key (so pulls keep working once the repo is private) -----------
echo "3. GitHub access"
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
if [ ! -f "$KEY_PATH" ]; then
  ssh-keygen -t ed25519 -N "" -C "arb-engine-deploy@$(hostname)" -f "$KEY_PATH" > /dev/null
  ok "created deploy key $KEY_PATH"
fi
if ! grep -q "Host $SSH_HOST_ALIAS" "$HOME/.ssh/config" 2>/dev/null; then
  cat >> "$HOME/.ssh/config" <<EOF

Host $SSH_HOST_ALIAS
  HostName github.com
  User git
  IdentityFile $KEY_PATH
  IdentitiesOnly yes
EOF
  chmod 600 "$HOME/.ssh/config"
fi
ssh-keyscan -t ed25519 github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null
sort -u -o "$HOME/.ssh/known_hosts" "$HOME/.ssh/known_hosts"

SSH_URL="git@${SSH_HOST_ALIAS}:${REPO_SLUG}.git"
if git ls-remote "$SSH_URL" > /dev/null 2>&1; then
  git -C "$APP_DIR" remote set-url origin "$SSH_URL"
  ok "deploy key works; origin switched to $SSH_URL"
else
  warn "deploy key not added on GitHub yet. Pulls still work while the repo is"
  warn "public, but WILL STOP when you make it private. Add this key on GitHub:"
  warn "  repo > Settings > Deploy keys > Add deploy key (leave 'write access' OFF)"
  echo
  cat "$KEY_PATH.pub"
  echo
  warn "Then run this script again to switch over."
fi
echo

# --- 4. Cron job ---------------------------------------------------------------
echo "4. Scheduling"
# cron runs with a bare PATH, so bake in where node/npm/pm2 live on THIS server
# (handles nvm installs).
TOOL_PATH="$(dirname "$(command -v node)"):$(dirname "$(command -v pm2)"):/usr/local/bin:/usr/bin:/bin"
CRON_LINE="*/2 * * * * PATH=$TOOL_PATH PM2_NAME=$PM2_NAME /bin/bash $APP_DIR/deploy/auto-deploy.sh >> $APP_DIR/deploy/auto-deploy.log 2>&1 $CRON_MARKER"
( crontab -l 2>/dev/null | grep -v "$CRON_MARKER"; echo "$CRON_LINE" ) | crontab -
ok "cron job installed (every 2 minutes)"
echo

echo "Done. Merges to main will deploy within ~2 minutes, with a Telegram alert."
echo "Log file: $APP_DIR/deploy/auto-deploy.log"
echo "To turn it off: crontab -e  (delete the line ending in $CRON_MARKER)"
