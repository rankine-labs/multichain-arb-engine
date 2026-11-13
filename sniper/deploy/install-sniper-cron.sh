#!/usr/bin/env bash
# ============================================================================
# ONE-TIME SETUP for the sniper auto-run. Run once on the EC2 server:
#
#     cd ~/sniper-bin && git fetch -q origin && git reset -q --hard origin/sniper-bin && bash deploy/install-sniper-cron.sh
#
# What it does:
#   1. Checks the tools it needs (git, python3, flock, pgrep).
#   2. Finds the arb bot's .env (from the arb bot's own auto-deploy cron line)
#      so the sniper can reuse its issues-only GitHub token, GH_STATUS_TOKEN.
#      It only records the file's path; it never copies or prints the token.
#   3. Adds a cron job: deploy/sniper-cron.sh every 2 minutes.
#   4. Runs it once now.
# Safe to run more than once. Never touches the arb bot.
# ============================================================================
set -uo pipefail

DIR="$HOME/sniper-bin"
CONF="$HOME/.sniper-cron.conf"
MARK="# sniper-auto-run"

ok()   { echo "  [ok]   $*"; }
fail() { echo "  [FAIL] $*"; exit 1; }

echo "Sniper auto-run setup"
for t in git python3 flock pgrep crontab; do
  command -v "$t" >/dev/null 2>&1 && ok "$t found" || fail "$t missing"
done
[ -x "$DIR/sniper" ] || chmod +x "$DIR/sniper" 2>/dev/null
[ -f "$DIR/deploy/sniper-cron.sh" ] || fail "$DIR/deploy/sniper-cron.sh not found (is ~/sniper-bin up to date?)"

# Find the arb bot folder from its auto-deploy cron line, then its .env.
ARB_ENV=""
LINE="$(crontab -l 2>/dev/null | grep 'auto-deploy.sh' | grep -v "$MARK" | head -1)"
if [ -n "$LINE" ]; then
  P="$(echo "$LINE" | grep -oE '/[^ ]*deploy/auto-deploy\.sh' | head -1)"
  [ -n "$P" ] && ARB_ENV="$(dirname "$(dirname "$P")")/.env"
fi
if [ -z "$ARB_ENV" ] || [ ! -f "$ARB_ENV" ]; then
  ARB_ENV="$(ls -1 "$HOME"/*/deploy/auto-deploy.sh 2>/dev/null | head -1 | sed 's#/deploy/auto-deploy.sh#/.env#')"
fi
if [ -n "$ARB_ENV" ] && [ -f "$ARB_ENV" ] && grep -q '^GH_STATUS_TOKEN=' "$ARB_ENV"; then
  ok "GitHub token found in $ARB_ENV (not copied)"
else
  echo "  [!!]   arb bot .env with GH_STATUS_TOKEN not found; the sniper will run but not report"
fi
touch "$CONF"
grep -v '^ARB_ENV=' "$CONF" > "$CONF.tmp" 2>/dev/null || true
echo "ARB_ENV=$ARB_ENV" >> "$CONF.tmp" && mv "$CONF.tmp" "$CONF"
chmod 600 "$CONF"

# Cron every 2 minutes (replace any older sniper line).
( crontab -l 2>/dev/null | grep -v "$MARK"; echo "*/2 * * * * bash $DIR/deploy/sniper-cron.sh >> $DIR/cron.log 2>&1 $MARK" ) | crontab -
ok "cron added (every 2 min)"

# Old hand-started copies are replaced by the cron-managed one.
pkill -f '^./sniper paper' 2>/dev/null && ok "stopped hand-started sniper" || true
rm -f "$HOME/.sniper-cron.state"
bash "$DIR/deploy/sniper-cron.sh" | tail -5
echo "Done. Results appear in the GitHub issue 'Sniper paper status' within a minute."
