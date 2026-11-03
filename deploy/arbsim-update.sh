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
#
# PREFETCH (Nov 3, "keep the old arbsim running until the new one is ready"):
#     bash deploy/arbsim-update.sh --prefetch <sim tree>
#   Used by auto-deploy.sh BEFORE it pulls a commit that changes sim/: gets
#   GitHub's build for that sim/ code ready in bin/.arbsim-staged/ (download,
#   checksum, "does it run here" check) WITHOUT touching bin/arbsim or the
#   running sidecar. When the deploy then happens, the normal update finds
#   the staged program and installs it with two renames and one quick pm2
#   restart: no 6-8 minute stop waiting for GitHub any more.
#   Exit codes:
#     0   ready (staged, or already installed / kept as the previous one)
#     20  GitHub has not built it yet (asks GitHub again at most once per
#         new arbsim-bin commit; cheap to call every 2 minutes)
#     21  no need to wait: LOCAL_SIM is off, or bin/ARBSIM_PINNED is set
#     1   a problem with the build (bad checksum, won't run, ...)
# ============================================================================
{
set -uo pipefail
# shellcheck source=deploy/arbsim-lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/arbsim-lib.sh"

BRANCH_BIN="${ARBSIM_BIN_BRANCH:-arbsim-bin}"
STATE_FILE="$BIN_DIR/.arbsim-update-state"   # what we last saw (stops log/alert spam)

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [arbsim] $*"; }

mkdir -p "$BIN_DIR"

# Where --prefetch keeps a checked program for code not deployed yet.
STAGE_DIR="$BIN_DIR/.arbsim-staged"
STAGE_LOOK="$BIN_DIR/.arbsim-staged.lastlook"

# --- PREFETCH mode (see the header) ---------------------------------------------
if [ "${1:-}" = "--prefetch" ]; then
  WANT="${2:-}"
  [ -n "$WANT" ] || { log "--prefetch needs the sim tree to get ready"; exit 1; }
  # Nothing runs the sidecar (LOCAL_SIM off) or the owner pinned a program
  # by hand: the deploy has nothing to wait for.
  [ "$(local_sim_mode)" = off ] && exit 21
  [ -f "$ARBSIM_PIN" ] && exit 21
  # Already here: staged, installed, or kept as the previous program.
  if [ -x "$STAGE_DIR/arbsim" ] && [ "$(info_value "$STAGE_DIR/BUILD_INFO" sim_tree)" = "$WANT" ]; then exit 0; fi
  [ "$(installed_sim_tree)" = "$WANT" ] && exit 0
  if [ -x "$ARBSIM_PREV" ] && [ "$(info_value "$ARBSIM_PREV_INFO" sim_tree)" = "$WANT" ]; then exit 0; fi
  REMOTE="${ARBSIM_REMOTE:-$(git -C "$APP_DIR" remote get-url origin 2>/dev/null)}"
  [ -n "$REMOTE" ] || exit 20
  REMOTE_COMMIT="$(timeout 60 git ls-remote "$REMOTE" "refs/heads/$BRANCH_BIN" 2>/dev/null | cut -f1)"
  [ -n "$REMOTE_COMMIT" ] || exit 20
  # This exact GitHub build was already looked at for this code: no new
  # download until GitHub publishes another build.
  [ "$(cat "$STAGE_LOOK" 2>/dev/null || true)" = "$WANT $REMOTE_COMMIT" ] && exit 20
  WORK="$BIN_DIR/.arbsim-pf.$$"
  trap 'rm -rf "$WORK"' EXIT
  rm -rf "$WORK"; mkdir -p "$WORK"
  if ! git init --quiet --bare "$WORK/repo.git" \
     || ! timeout 120 git -C "$WORK/repo.git" fetch --quiet --depth 1 --no-tags "$REMOTE" "refs/heads/$BRANCH_BIN" 2>/dev/null; then
    exit 20   # network trouble: try again next run
  fi
  GOT="$(git -C "$WORK/repo.git" rev-parse FETCH_HEAD)"
  git -C "$WORK/repo.git" show "$GOT:BUILD_INFO" > "$WORK/BUILD_INFO" 2>/dev/null || : > "$WORK/BUILD_INFO"
  if [ "$(info_value "$WORK/BUILD_INFO" sim_tree)" != "$WANT" ]; then
    printf '%s\n' "$WANT $REMOTE_COMMIT" > "$STAGE_LOOK"
    exit 20   # GitHub is still building this version
  fi
  if ! git -C "$WORK/repo.git" show "$GOT:arbsim" > "$WORK/arbsim" 2>/dev/null \
     || ! git -C "$WORK/repo.git" show "$GOT:arbsim.sha256" > "$WORK/arbsim.sha256" 2>/dev/null; then
    printf '%s\n' "$WANT $REMOTE_COMMIT" > "$STAGE_LOOK"
    log "PREFETCH PROBLEM: the $BRANCH_BIN build ${GOT:0:7} is missing arbsim or arbsim.sha256"
    exit 1
  fi
  PF_WANT="$(awk '{print $1; exit}' "$WORK/arbsim.sha256")"
  PF_HAVE="$(sha256sum "$WORK/arbsim" | awk '{print $1}')"
  if [ -z "$PF_WANT" ] || [ "$PF_WANT" != "$PF_HAVE" ]; then
    printf '%s\n' "$WANT $REMOTE_COMMIT" > "$STAGE_LOOK"
    log "PREFETCH PROBLEM: checksum mismatch on the downloaded program (build ${GOT:0:7})"
    exit 1
  fi
  chmod 755 "$WORK/arbsim"
  if ! smoke_test "$WORK/arbsim"; then
    printf '%s\n' "$WANT $REMOTE_COMMIT" > "$STAGE_LOOK"
    log "PREFETCH PROBLEM: the downloaded program doesn't run on this server (build ${GOT:0:7})"
    exit 1
  fi
  # Ready: replace any older staged program (renames inside bin/).
  rm -rf "$STAGE_DIR.new"; mkdir -p "$STAGE_DIR.new"
  mv -f "$WORK/arbsim" "$STAGE_DIR.new/arbsim" && mv -f "$WORK/BUILD_INFO" "$STAGE_DIR.new/BUILD_INFO" || exit 1
  rm -rf "$STAGE_DIR"; mv -f "$STAGE_DIR.new" "$STAGE_DIR" || exit 1
  rm -f "$STAGE_LOOK"
  log "prefetched the program for sim $(short "$WANT") (build ${GOT:0:7}, checksum ok, runs here) into bin/.arbsim-staged: the running sidecar is untouched until the deploy"
  exit 0
fi

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

# --- 2b. Prefetched for this code before the deploy (--prefetch)? Install it -------
# Two renames and one quick restart: no download now.
if [ -x "$STAGE_DIR/arbsim" ] && [ "$(info_value "$STAGE_DIR/BUILD_INFO" sim_tree)" = "$DEPLOYED" ] && smoke_test "$STAGE_DIR/arbsim"; then
  if install_from "$STAGE_DIR"; then
    rm -rf "$STAGE_DIR"
    printf '%s\n' "ok $DEPLOYED" > "$STATE_FILE"
    log "installed the prefetched program (bin/.arbsim-staged) for sim $(short "$DEPLOYED"); previous kept as bin/arbsim.prev"
    ensure_pm2 --restart
    exit 10
  fi
  log "installing the prefetched program failed; trying a download instead"
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
