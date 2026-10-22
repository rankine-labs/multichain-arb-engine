#!/usr/bin/env bash
# ============================================================================
# ARBSIM UPDATE: puts the right fast-check program (bin/arbsim) on the server.
#
# Plain English:
#   The server can't build the Rust program itself (no Rust, not enough
#   memory). GitHub builds it after every merge to main and stores it on a
#   separate branch, "arbsim-bin", together with:
#     arbsim.sha256   a checksum, to prove the download isn't damaged
#     BUILD_INFO      which code it was built from, including "sim_tree":
#                     git's fingerprint of the sim/ folder at that commit
#
#   This script compares fingerprints:
#     deployed code's sim/ folder   (git rev-parse HEAD:sim, on the server)
#     installed program             (bin/arbsim.build_info)
#     newest GitHub build           (BUILD_INFO on origin/arbsim-bin)
#   and then:
#     installed matches deployed  -> nothing to do
#     previous program matches    -> swap back to it (deploy was rolled back)
#     GitHub build matches        -> download (read-only), check the
#                                    checksum, check it runs, install it
#                                    (old one kept as bin/arbsim.prev)
#     nothing matches yet         -> "arbsim binary not ready for this
#                                    version, keeping old one". The file stays,
#                                    but it is NOT run against code it wasn't
#                                    built for: arbsim-pm2.sh stops the
#                                    sidecar and the bot quietly uses the node
#                                    instead until the build is ready (usually
#                                    5-15 minutes after a merge). The next run
#                                    picks it up by itself.
#   Last, it calls arbsim-pm2.sh ensure, which starts / stops / restarts the
#   sidecar to match LOCAL_SIM in .env (off = not running).
#
#   Owner rolled back by hand (bin/ARBSIM_PINNED exists): leaves the program
#   alone completely. See docs/FAST_CHECK_OPS.md.
#
# Runs from deploy/auto-deploy.sh (every 2 minutes, and after each
# successful deploy). Safe to run by hand any time:
#     bash deploy/arbsim-update.sh
#
# Exit codes (auto-deploy.sh uses these for Telegram):
#   0   nothing changed (or a problem that was already reported)
#   10  a new program was installed (and restarted if it was running)
#   1   a NEW problem (bad checksum, program won't run, download failed)
#
# Settings (optional): APP_DIR (bot folder), ARBSIM_BIN_BRANCH (arbsim-bin),
# ARBSIM_REMOTE (where to download from; default = the bot's git origin).
# ============================================================================
{
set -uo pipefail
# shellcheck source=deploy/arbsim-lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/arbsim-lib.sh"

BRANCH_BIN="${ARBSIM_BIN_BRANCH:-arbsim-bin}"
STATE_FILE="$BIN_DIR/.arbsim-update-state"   # what we last saw (stops log/alert spam)

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [arbsim] $*"; }

mkdir -p "$BIN_DIR"

# say_once KEY MESSAGE -> logs MESSAGE only if the situation (KEY) is new
# since the last run. Returns 0 if it was new, 1 if already said.
say_once() {
  if [ "$(cat "$STATE_FILE" 2>/dev/null || true)" = "$1" ]; then return 1; fi
  printf '%s\n' "$1" > "$STATE_FILE"
  log "$2"
  return 0
}

# Make the sidecar match LOCAL_SIM + the installed program. Never fails the
# update (the bot works without the sidecar).
ensure_pm2() {
  bash "$ARBSIM_SCRIPT_DIR/arbsim-pm2.sh" ensure "$@" || log "arbsim-pm2.sh ensure had a problem (see above)"
}

# --- 0. Owner pinned a version by hand: hands off ------------------------------
if [ -f "$ARBSIM_PIN" ]; then
  say_once "pinned" "bin/ARBSIM_PINNED is set (owner rolled back by hand): not updating the program. Remove that file to resume automatic updates." || true
  ensure_pm2
  exit 0
fi

DEPLOYED="$(deployed_sim_tree)"
if [ -z "$DEPLOYED" ]; then
  say_once "no-sim" "the deployed code has no sim/ folder: nothing to install" || true
  ensure_pm2
  exit 0
fi
INSTALLED="$(installed_sim_tree)"

# --- 1. Already the right program -------------------------------------------------
if [ "$INSTALLED" = "$DEPLOYED" ]; then
  say_once "ok $DEPLOYED" "program matches the deployed code (sim $(short "$DEPLOYED"))" || true
  ensure_pm2
  exit 0
fi

# install_from DIR -> moves DIR/arbsim + DIR/BUILD_INFO into place, keeping
# the current program as arbsim.prev. Every step is a rename within bin/,
# so the program pm2 runs is never half-written. (A running sidecar keeps
# using the old file until it is restarted.)
install_from() {
  local dir="$1"
  if [ -f "$ARBSIM_BIN" ]; then
    # Copy (not move) so bin/arbsim exists at every moment.
    cp -p "$ARBSIM_BIN" "$BIN_DIR/.arbsim.prev.tmp" && mv -f "$BIN_DIR/.arbsim.prev.tmp" "$ARBSIM_PREV" || return 1
    if [ -f "$ARBSIM_INFO" ]; then cp -p "$ARBSIM_INFO" "$ARBSIM_PREV_INFO"; else rm -f "$ARBSIM_PREV_INFO"; fi
  fi
  mv -f "$dir/arbsim" "$ARBSIM_BIN" || return 1
  mv -f "$dir/BUILD_INFO" "$ARBSIM_INFO" || return 1
  return 0
}

# --- 2. Deploy rolled back (or forward again)? The previous program may match ----
PREV_TREE="$(info_value "$ARBSIM_PREV_INFO" sim_tree)"
if [ -x "$ARBSIM_PREV" ] && [ "$PREV_TREE" = "$DEPLOYED" ] && smoke_test "$ARBSIM_PREV"; then
  SWAP="$BIN_DIR/.arbsim-swap.$$"
  rm -rf "$SWAP"; mkdir -p "$SWAP"
  cp -p "$ARBSIM_PREV" "$SWAP/arbsim" && cp -p "$ARBSIM_PREV_INFO" "$SWAP/BUILD_INFO" \
    && install_from "$SWAP"
  rc=$?
  rm -rf "$SWAP"
  if [ "$rc" = 0 ]; then
    printf '%s\n' "ok $DEPLOYED" > "$STATE_FILE"
    log "the previous program (bin/arbsim.prev) matches the deployed code (deploy rolled back?): switched to it (sim $(short "$DEPLOYED"))"
    ensure_pm2 --restart
    exit 10
  fi
  log "switching back to the previous program failed; trying a download instead"
fi

# --- 3. Look at the newest GitHub build (read-only) ---------------------------------
REMOTE="${ARBSIM_REMOTE:-$(git -C "$APP_DIR" remote get-url origin 2>/dev/null)}"
if [ -z "$REMOTE" ]; then
  say_once "no-remote" "can't find the bot's git origin; can't download the program" && { ensure_pm2; exit 1; }
  ensure_pm2; exit 0
fi

# One small request: which commit is the branch at? (no download yet)
REMOTE_COMMIT="$(timeout 60 git ls-remote "$REMOTE" "refs/heads/$BRANCH_BIN" 2>/dev/null | cut -f1)"
if [ -z "$REMOTE_COMMIT" ]; then
  say_once "nobranch $DEPLOYED" "arbsim binary not ready for this version, keeping old one (no $BRANCH_BIN branch on GitHub yet, or GitHub unreachable)" || true
  ensure_pm2
  exit 0
fi

# Same GitHub build we already looked at for this same deployed code: it
# didn't match (or was broken) last time, so don't download it again.
LAST="$(cat "$STATE_FILE" 2>/dev/null || true)"
case "$LAST" in
  "notready $DEPLOYED $REMOTE_COMMIT"|"bad $DEPLOYED $REMOTE_COMMIT")
    ensure_pm2
    exit 0 ;;
esac

# Download into a throw-away private copy (never into the bot's own repo,
# so the bot's git history stays small). Shallow = only the newest build.
WORK="$BIN_DIR/.arbsim-dl.$$"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
rm -rf "$WORK"; mkdir -p "$WORK"
if ! git init --quiet --bare "$WORK/repo.git" \
   || ! timeout 120 git -C "$WORK/repo.git" fetch --quiet --depth 1 --no-tags "$REMOTE" "refs/heads/$BRANCH_BIN" 2>/dev/null; then
  say_once "fetchfail $DEPLOYED $REMOTE_COMMIT" "download of the $BRANCH_BIN branch failed (network?); will retry next run" || true
  ensure_pm2
  exit 0
fi
GOT="$(git -C "$WORK/repo.git" rev-parse FETCH_HEAD)"

git -C "$WORK/repo.git" show "$GOT:BUILD_INFO" > "$WORK/BUILD_INFO" 2>/dev/null || : > "$WORK/BUILD_INFO"
BUILT_TREE="$(info_value "$WORK/BUILD_INFO" sim_tree)"
BUILT_FROM="$(info_value "$WORK/BUILD_INFO" source_commit)"

if [ "$BUILT_TREE" != "$DEPLOYED" ]; then
  # GitHub hasn't finished building this version yet (or built a newer one
  # the server hasn't deployed, e.g. while live and deploys are locked).
  say_once "notready $DEPLOYED $GOT" "arbsim binary not ready for this version, keeping old one (deployed sim $(short "$DEPLOYED"), newest build is sim $(short "$BUILT_TREE") from ${BUILT_FROM:0:7})" || true
  ensure_pm2
  exit 0
fi

# --- 4. It's the right build: check it before installing ---------------------------
if ! git -C "$WORK/repo.git" show "$GOT:arbsim" > "$WORK/arbsim" 2>/dev/null \
   || ! git -C "$WORK/repo.git" show "$GOT:arbsim.sha256" > "$WORK/arbsim.sha256" 2>/dev/null; then
  say_once "bad $DEPLOYED $GOT" "PROBLEM: the $BRANCH_BIN build ${GOT:0:7} is missing arbsim or arbsim.sha256; not installed" && { ensure_pm2; exit 1; }
  ensure_pm2; exit 0
fi

# Checksum: the first word of arbsim.sha256 must equal the download's.
WANT="$(awk '{print $1; exit}' "$WORK/arbsim.sha256")"
HAVE="$(sha256sum "$WORK/arbsim" | awk '{print $1}')"
if [ -z "$WANT" ] || [ "$WANT" != "$HAVE" ]; then
  say_once "bad $DEPLOYED $GOT" "PROBLEM: checksum mismatch on the downloaded program (build ${GOT:0:7}); NOT installed, the old one is untouched" && { ensure_pm2; exit 1; }
  ensure_pm2; exit 0
fi

# Does it actually run on this server (CPU, system libraries)?
chmod 755 "$WORK/arbsim"
if ! smoke_test "$WORK/arbsim"; then
  say_once "bad $DEPLOYED $GOT" "PROBLEM: the downloaded program doesn't run on this server (build ${GOT:0:7}, check BUILD_INFO glibc_max); NOT installed" && { ensure_pm2; exit 1; }
  ensure_pm2; exit 0
fi

# --- 5. Install (old one kept as bin/arbsim.prev) ----------------------------------
if ! install_from "$WORK"; then
  say_once "bad $DEPLOYED $GOT" "PROBLEM: couldn't move the new program into bin/ (disk full? permissions?)" && { ensure_pm2; exit 1; }
  ensure_pm2; exit 0
fi
printf '%s\n' "ok $DEPLOYED" > "$STATE_FILE"
log "installed new program: sim $(short "$DEPLOYED") built from ${BUILT_FROM:0:7} (checksum ok); previous kept as bin/arbsim.prev"
ensure_pm2 --restart
exit 10
}
