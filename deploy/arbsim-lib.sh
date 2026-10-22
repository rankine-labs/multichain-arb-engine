#!/usr/bin/env bash
# ============================================================================
# ARBSIM HELPERS (shared by arbsim-update.sh and arbsim-pm2.sh)
#
# Plain English:
#   "arbsim" is the fast-check sidecar: a small Rust program that runs next
#   to the bot and answers "what would this trade do?" in about a
#   millisecond. This file only holds small helper functions; it does
#   nothing by itself. See docs/FAST_CHECK_OPS.md for the full picture.
#
# Where things live on the server (bin/ is never tracked by git):
#   bin/arbsim                 the program pm2 runs
#   bin/arbsim.build_info      which code it was built from (BUILD_INFO)
#   bin/arbsim.prev            the one before (for rolling back)
#   bin/arbsim.prev.build_info
#   bin/ARBSIM_PINNED          present = owner rolled back by hand; the
#                              automatic updater leaves the binary alone
#   bin/.arbsim-bin.git        small private download cache of the
#                              arbsim-bin branch (separate from the bot's repo)
# ============================================================================

# (Some names below are only used by the scripts that load this file.)
# shellcheck disable=SC2034

# Folder of these scripts, and the bot's folder (one up), unless given.
ARBSIM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "$ARBSIM_SCRIPT_DIR/.." && pwd)}"

ARBSIM_APP="${ARBSIM_APP:-arbsim}"                 # pm2 app name
BIN_DIR="$APP_DIR/bin"
ARBSIM_BIN="$BIN_DIR/arbsim"
ARBSIM_INFO="$BIN_DIR/arbsim.build_info"
ARBSIM_PREV="$BIN_DIR/arbsim.prev"
ARBSIM_PREV_INFO="$BIN_DIR/arbsim.prev.build_info"
ARBSIM_PIN="$BIN_DIR/ARBSIM_PINNED"

# env_file_value FILE KEY -> KEY's value from FILE (last line wins), quotes,
# spaces and a trailing " # comment" removed. Empty if missing.
# Same rules as env_file_value in auto-deploy.sh. Reads only that one line,
# so wallet keys and other secrets never enter these scripts.
env_file_value() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$file" 2>/dev/null | tail -n 1 \
    | sed -E -e 's/^[^=]*=//' -e 's/[[:space:]]+#.*$//' -e 's/^[[:space:]]+//' -e 's/[[:space:]]+$//' \
             -e 's/^["'\'']//' -e 's/["'\'']$//'
}

# local_sim_mode -> off | shadow | on, from LOCAL_SIM in the bot's .env.
# Same rule as the bot (src/execution/localSim.ts): anything else = off.
local_sim_mode() {
  local v
  v="$(env_file_value "$APP_DIR/.env" LOCAL_SIM)"
  v="${v,,}"
  case "$v" in shadow|on) echo "$v" ;; *) echo off ;; esac
}

# info_value FILE KEY -> one "key=value" line from a BUILD_INFO file.
info_value() {
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | tail -n 1
}

# deployed_sim_tree -> git's fingerprint of the sim/ folder in the code that
# is deployed right now (changes only when something in sim/ changes).
deployed_sim_tree() {
  git -C "$APP_DIR" rev-parse --verify --quiet "HEAD:sim" 2>/dev/null
}

# installed_sim_tree -> the same fingerprint for the installed binary
# (empty if there is no binary, or it came without build info).
installed_sim_tree() {
  [ -x "$ARBSIM_BIN" ] || return 0
  info_value "$ARBSIM_INFO" sim_tree
}

# pm2_app_status -> pm2 status of the arbsim app ("online", "stopped", ...),
# or "missing" when pm2 doesn't know it (or pm2 itself isn't reachable).
pm2_app_status() {
  pm2 jlist 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const p = JSON.parse(s).find(x => x.name === process.argv[1]);
        console.log(p ? p.pm2_env.status : "missing");
      } catch { console.log("missing"); }
    });' "$ARBSIM_APP"
}

# pm2_app_kill_timeout_ms -> how long pm2 waits after its stop signal
# before killing the arbsim app, in ms (empty when unknown / app missing).
pm2_app_kill_timeout_ms() {
  pm2 jlist 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const p = JSON.parse(s).find(x => x.name === process.argv[1]);
        const v = p && p.pm2_env ? Number(p.pm2_env.kill_timeout) : NaN;
        console.log(v > 0 ? Math.round(v) : "");
      } catch { console.log(""); }
    });' "$ARBSIM_APP"
}

# pm2_app_mem_limit_mb -> the memory restart limit pm2 has for the arbsim
# app, in MB (empty when unknown / not set / app missing).
pm2_app_mem_limit_mb() {
  pm2 jlist 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const p = JSON.parse(s).find(x => x.name === process.argv[1]);
        let v = p && p.pm2_env ? p.pm2_env.max_memory_restart : undefined;
        if (typeof v === "string") {
          const m = v.trim().match(/^([0-9.]+)\s*([KMG]?)B?$/i);
          const mul = { "": 1, K: 1024, M: 1048576, G: 1073741824 };
          v = m ? Number(m[1]) * mul[m[2].toUpperCase()] : NaN;
        }
        console.log(typeof v === "number" && v > 0 ? Math.round(v / 1048576) : "");
      } catch { console.log(""); }
    });' "$ARBSIM_APP"
}

# smoke_test FILE -> succeeds if FILE runs on this server (right CPU, new
# enough system libraries) and is really arbsim: run with no arguments it
# prints its usage line and exits with code 2. Touches nothing.
smoke_test() {
  local out code
  out="$(timeout 10 "$1" 2>&1)"; code=$?
  [ "$code" = 2 ] && printf '%s' "$out" | grep -q '^usage: arbsim serve'
}

# short TREE -> first 8 characters, for log lines.
short() { printf '%s' "${1:0:8}"; }
