#!/usr/bin/env bash
# ============================================================================
# ARBSIM PM2: starts / stops the fast-check sidecar ("arbsim" in pm2).
#
# Plain English:
#   The sidecar only runs when ALL of these are true:
#     - LOCAL_SIM in .env is "shadow" or "on"   (off / missing = not running)
#     - bin/arbsim exists, runs on this server, and was built from exactly
#       the sim/ code that is deployed right now (bin/arbsim.build_info)
#   Otherwise it is taken out of pm2. That is always safe: when the sidecar
#   is not there, the bot quietly uses the paid node for every check, just
#   like before the sidecar existed.
#
#   pm2 settings: name "arbsim", low priority (nice 5), restarted if it uses
#   more than 1300 MB, waits longer and longer between crash restarts (1 s up
#   to 15 s) so a broken sidecar can't hog the server, timestamps in the
#   logs. Log files are rotated by pm2-logrotate (already installed).
#
#   Why 800 MB (live dry run #19 on this server, Oct 22 2026): with 733 of
#   ~790 pools tick-walked the sidecar settled at ~393 MB RSS and stayed
#   flat for 16+ minutes (the test sizing of ~145 MB was too low: real pools
#   have more ticks). 800 MB is ~2x that: room for the remaining walks, load
#   bursts and allocator slack, while the server keeps > 1 GB free next to
#   the bot (~1.1 GB) on the 3.8 GB machine. The sidecar stops sending new
#   tick walks at 550 MB (ARBSIM_COPY2_WALK_MAX_RSS_MB), well before this
#   restart line. A restart is harmless anyway: the bot asks the node until
#   the copy is ready again (~1 min). (The old 150 / 400 MB lines were at or
#   below a fully walked copy: they would restart-loop.)
#   Raised to 1300 MB (Oct 25 2026, owner OK): the copy now follows ~1,480
#   pools (auto-follow, about 2x the 790 sized above) and sits flat at
#   ~800 MB, right ON the old line, so pm2 restarted it in normal running
#   (fire-first blind ~16% of an hour). 1300 MB = steady size + ~60% room;
#   the server has ~1.5 GB available next to the bot (~0.9-1.2 GB).
#   A changed limit applies when pm2 (re)creates the app: on the next
#   program update, or `bash deploy/arbsim-pm2.sh restart` after a stop.
#
#   Stopping (warm restart, copy2-n): pm2 sends a stop signal (SIGINT) and
#   kills the sidecar only after kill_timeout. On the signal the sidecar
#   saves its copy (data/arbsim-copy2-state.bin, ~40 MB, well under a
#   second) and exits by itself; the next start continues from that file
#   instead of loading every pool again. kill_timeout is 30 s (was 5 s) so
#   a busy server still lets the save finish. An app created with a shorter
#   kill_timeout is re-created once (like the memory limit below).
#
# Commands (run from anywhere; the bot folder is found automatically):
#   bash deploy/arbsim-pm2.sh ensure      match LOCAL_SIM + program (auto-deploy
#                                         runs this every 2 minutes; quiet when
#                                         nothing changes)
#   bash deploy/arbsim-pm2.sh start       start it now (after a manual stop)
#   bash deploy/arbsim-pm2.sh stop        stop it and KEEP it stopped (the
#                                         2-minute check leaves a stopped
#                                         sidecar alone until "start")
#   bash deploy/arbsim-pm2.sh restart     restart it
#   bash deploy/arbsim-pm2.sh status      plain-English health report
#
# Note: this never runs "pm2 save". After a server reboot the sidecar comes
# back within 2 minutes through the auto-deploy check (if LOCAL_SIM wants it).
# ============================================================================
set -uo pipefail
# shellcheck source=deploy/arbsim-lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/arbsim-lib.sh"

PM2_STATE_FILE="$BIN_DIR/.arbsim-pm2-state"
# pm2 restarts the sidecar above this much memory (MB); see the header.
ARBSIM_MEM_LIMIT_MB=1300
# pm2 waits this long (ms) after the stop signal before killing (final save).
ARBSIM_KILL_TIMEOUT_MS=30000
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [arbsim] $*"; }

# say_once KEY MESSAGE: log only when the situation changes (no spam).
say_once() {
  mkdir -p "$BIN_DIR"
  [ "$(cat "$PM2_STATE_FILE" 2>/dev/null || true)" = "$1" ] && return 0
  printf '%s\n' "$1" > "$PM2_STATE_FILE"
  log "$2"
}

# ready_reason -> empty when the installed program may run with the deployed
# code, otherwise a short plain-English reason why not.
ready_reason() {
  local deployed installed
  deployed="$(deployed_sim_tree)"
  installed="$(installed_sim_tree)"
  if [ ! -x "$ARBSIM_BIN" ]; then echo "no program installed yet (bin/arbsim)"; return; fi
  if [ -z "$deployed" ]; then echo "the deployed code has no sim/ folder"; return; fi
  # bin/ARBSIM_PINNED = the owner rolled back by hand and chose this exact
  # program on purpose (docs/FAST_CHECK_OPS.md section 4): the version match
  # is skipped, but it still has to run on this server.
  if [ "$installed" != "$deployed" ] && [ ! -f "$ARBSIM_PIN" ]; then
    echo "installed program was built for sim $(short "$installed"), deployed code is sim $(short "$deployed") (new build not ready yet)"
    return
  fi
  if ! smoke_test "$ARBSIM_BIN"; then echo "bin/arbsim doesn't run on this server"; return; fi
}

# remove_app WHY: take the sidecar out of pm2 (bot falls back to the node).
remove_app() {
  pm2 delete "$ARBSIM_APP" > /dev/null 2>&1 || true
  # A leftover socket would only make the bot try to connect; remove it.
  rm -f "${ARBSIM_SOCKET_PATH:-/tmp/arbsim.sock}"
  log "sidecar stopped: $1. The bot uses the node for checks meanwhile."
}

start_app() {
  pm2 start "$ARBSIM_SCRIPT_DIR/arbsim-run.sh" \
    --name "$ARBSIM_APP" \
    --interpreter bash \
    --cwd "$APP_DIR" \
    --max-memory-restart "${ARBSIM_MEM_LIMIT_MB}M" \
    --exp-backoff-restart-delay 1000 \
    --kill-timeout "$ARBSIM_KILL_TIMEOUT_MS" \
    --time > /dev/null 2>&1
}

# Socket path the runner will use (only for cleanup above; not secret).
ARBSIM_SOCKET_PATH="$(env_file_value "$APP_DIR/.env" ARBSIM_SOCKET)"

cmd="${1:-ensure}"
case "$cmd" in
  ensure)
    want_restart=0; [ "${2:-}" = "--restart" ] && want_restart=1
    mode="$(local_sim_mode)"
    status="$(pm2_app_status)"
    reason="$(ready_reason)"
    if [ "$mode" = off ]; then
      if [ "$status" != missing ]; then remove_app "LOCAL_SIM is off"; fi
      say_once "off" "LOCAL_SIM is off: sidecar not running (as wanted)"
      exit 0
    fi
    if [ -n "$reason" ]; then
      # Never run a program against code it wasn't built for. A sidecar the
      # owner stopped by hand is left stopped (it isn't running anything).
      case "$status" in
        missing|stopped) ;;
        *) remove_app "$reason" ;;
      esac
      say_once "notready $reason" "arbsim binary not ready for this version, keeping old one: $reason. Sidecar not running."
      exit 0
    fi
    case "$status" in
      missing)
        if start_app; then
          say_once "running" "sidecar started (LOCAL_SIM=$mode, sim $(short "$(installed_sim_tree)"))"
          printf '%s\n' "running" > "$PM2_STATE_FILE"
        else
          say_once "startfail" "PROBLEM: pm2 could not start the sidecar"; exit 1
        fi ;;
      stopped)
        # Stopped by hand (arbsim-pm2.sh stop / pm2 stop arbsim): respect it.
        say_once "manual-stop" "sidecar is stopped by hand; leaving it stopped (start: bash deploy/arbsim-pm2.sh start)" ;;
      *)
        # An app created with an older, LOWER memory limit (150 MB before
        # dry run #18) keeps it through "pm2 restart": re-create it once.
        # Only ever raised (never a loop if pm2 reports it differently).
        cur_mb="$(pm2_app_mem_limit_mb)"
        cur_kill="$(pm2_app_kill_timeout_ms)"
        if [ -n "$cur_mb" ] && [ "$cur_mb" -lt $((ARBSIM_MEM_LIMIT_MB * 9 / 10)) ]; then
          pm2 delete "$ARBSIM_APP" > /dev/null 2>&1 || true
          if start_app; then
            log "sidecar re-created with memory limit ${ARBSIM_MEM_LIMIT_MB} MB (was ${cur_mb} MB)"
          else
            log "PROBLEM: pm2 could not re-create the sidecar"; exit 1
          fi
        elif [ -n "$cur_kill" ] && [ "$cur_kill" -lt "$ARBSIM_KILL_TIMEOUT_MS" ]; then
          # Older app with a 5 s kill timeout: re-created once so a stop
          # leaves time for the final save (the deleted app gets the stop
          # signal and saves too; the new one starts from that file).
          pm2 delete "$ARBSIM_APP" > /dev/null 2>&1 || true
          if start_app; then
            log "sidecar re-created with stop wait ${ARBSIM_KILL_TIMEOUT_MS} ms (was ${cur_kill} ms) for the warm-restart save"
          else
            log "PROBLEM: pm2 could not re-create the sidecar"; exit 1
          fi
        elif [ "$want_restart" = 1 ]; then
          pm2 restart "$ARBSIM_APP" > /dev/null 2>&1 && log "sidecar restarted on the newly installed program" \
            || { log "PROBLEM: pm2 restart of the sidecar failed"; exit 1; }
        fi
        printf '%s\n' "running" > "$PM2_STATE_FILE" ;;
    esac
    ;;
  start|restart)
    [ "$(local_sim_mode)" = off ] && { echo "LOCAL_SIM is off in .env, so the sidecar is not started. Set LOCAL_SIM=shadow first."; exit 1; }
    reason="$(ready_reason)"
    [ -n "$reason" ] && { echo "Not starting: $reason. Try: bash deploy/arbsim-update.sh"; exit 1; }
    if [ "$(pm2_app_status)" = missing ]; then start_app; else pm2 restart "$ARBSIM_APP" > /dev/null 2>&1; fi \
      || { echo "pm2 could not start it (pm2 logs $ARBSIM_APP)"; exit 1; }
    printf '%s\n' "running" > "$PM2_STATE_FILE"
    echo "Sidecar started. Check it in a minute: bash deploy/arbsim-pm2.sh status"
    ;;
  stop)
    pm2 stop "$ARBSIM_APP" > /dev/null 2>&1 || true
    printf '%s\n' "manual-stop" > "$PM2_STATE_FILE"
    echo "Sidecar stopped and will stay stopped (start again: bash deploy/arbsim-pm2.sh start). The bot uses the node meanwhile."
    ;;
  status)
    exec node "$ARBSIM_SCRIPT_DIR/arbsim-status.js"
    ;;
  *)
    echo "usage: bash deploy/arbsim-pm2.sh ensure|start|stop|restart|status"; exit 2 ;;
esac
exit 0
