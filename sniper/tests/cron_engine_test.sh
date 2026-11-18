#!/usr/bin/env bash
# ============================================================================
# TEST: deploy/sniper-cron.sh keeps the sniper's own engine running
# (SNIPER_ENGINE=1) and does nothing new without it.
#
# Plain English:
#   Runs the REAL cron script against a pretend server in a temp folder:
#   a fake HOME, a fake build folder (a local git repo with a fake `sniper`
#   that just exits), a fake dex bot .env (with a fake node link, so we can
#   check it never reaches the log) and a fake `arbsim` that only opens its
#   socket. Nothing real is started, stopped or contacted.
#
#   Checks:
#     1. SNIPER_ENGINE unset: no engine, no engine log line.
#     2. SNIPER_ENGINE=1: engine started once, one log line, socket answers.
#     3. next run, engine healthy: left alone.
#     4. new settings (paper bot restarts): healthy engine NOT restarted.
#     5. engine killed: restarted, one log line.
#     6. engine alive but socket dead: left alone inside the start-up grace
#        time, restarted after it.
#     7. kill switch (SNIPER_ENABLED=0) or a server that does not run the
#        paper bot (feed server): engine not started.
#     8. failed start: logged once, not retried until the retry wait is over.
#     9. the node link never appears in the cron log.
#
# Run:  bash sniper/tests/cron_engine_test.sh     (also run by `cargo test`,
#       tests/cron_engine.rs). Needs bash, git, python3, flock, pgrep.
# Refuses to run on a machine where a real sniper is running (the cron
# script manages processes named "./sniper ...").
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"   # sniper/
if pgrep -f "^\./sniper " >/dev/null 2>&1; then
  echo "SKIP: a real sniper is running on this machine"; exit 0
fi

T="$(mktemp -d)"
FAILS=0
ok()   { echo "ok   - $*"; }
bad()  { echo "FAIL - $*"; FAILS=$((FAILS + 1)); }
cleanup() {
  [ -f "$T/home/sniper-engine/engine.pid" ] && kill "$(cat "$T/home/sniper-engine/engine.pid")" 2>/dev/null
  pkill -f "$T/" 2>/dev/null
  rm -rf "$T"
}
trap cleanup EXIT

export HOME="$T/home"
mkdir -p "$HOME" "$T/arb/bin" "$T/bin"
SOCK="$T/engine.sock"
SECRET="https://fake-node.invalid/SECRETKEY123"

# Fake dex bot: its .env (one paid node link) and its arbsim binary. The
# fake arbsim opens ARBSIM_SOCKET and accepts connections forever.
echo "CHAINSTACK_RPC_ROBINHOOD=$SECRET" > "$T/arb/.env"
cat > "$T/arb/bin/arbsim" <<'PY'
#!/usr/bin/env python3
import os, socket
p = os.environ["ARBSIM_SOCKET"]
try: os.unlink(p)
except FileNotFoundError: pass
s = socket.socket(socket.AF_UNIX); s.bind(p); s.listen(8)
print("fake arbsim listening", flush=True)
while True:
    c, _ = s.accept(); c.close()
PY
chmod +x "$T/arb/bin/arbsim"
echo "ARB_ENV=$T/arb/.env" > "$HOME/.sniper-cron.conf"

# Fake build folder (what ~/sniper-bin is on the server).
B="$HOME/sniper-bin"
mkdir -p "$B/deploy"
cp "$HERE/deploy/sniper-cron.sh" "$HERE/deploy/sniper-engine.sh" "$B/deploy/"
printf '#!/usr/bin/env bash\nexit 0\n' > "$B/sniper"; chmod +x "$B/sniper"
base_env() { printf 'SNIPER_ENABLED=1\nSNIPER_MODE=paper\nSNIPER_OUT=paper-out/test\nSNIPER_ENGINE_SOCKET=%s\n' "$SOCK"; }
base_env > "$B/deploy/run.env"
( cd "$B" && git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm build )

LOG="$T/cron.log"
run_cron() { ENGINE_GRACE_S="${GRACE:-180}" ENGINE_RETRY_S="${RETRY:-600}" ARBSIM_SRC="${SRC:-$T/arb/bin/arbsim}" bash "$B/deploy/sniper-cron.sh" >> "$LOG" 2>&1; }
starts() { grep -c "engine (re)started" "$LOG"; }
epid() { cat "$HOME/sniper-engine/engine.pid" 2>/dev/null; }
sock_ok() { python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.settimeout(2); s.connect(sys.argv[1])' "$SOCK" 2>/dev/null; }

# 1. SNIPER_ENGINE unset: nothing new.
run_cron
if [ -z "$(epid)" ] && ! grep -q "engine" "$LOG"; then ok "unset: no engine, no engine log line"; else bad "unset: engine touched"; cat "$LOG"; fi

# 2. SNIPER_ENGINE=1: started once.
echo "SNIPER_ENGINE=1" >> "$B/deploy/run.env"
run_cron
sleep 0.5
P1="$(epid)"
if [ "$(starts)" = 1 ] && [ -n "$P1" ] && sock_ok; then ok "on: engine started (pid $P1), socket answers"; else bad "on: engine not started"; cat "$LOG"; fi
if grep -q "started sniper paper" "$LOG"; then ok "paper bot started too"; else bad "paper bot not started"; fi

# 3. healthy: left alone.
run_cron
if [ "$(starts)" = 1 ] && [ "$(epid)" = "$P1" ]; then ok "healthy engine left alone"; else bad "healthy engine restarted"; fi

# 4. new settings: the paper bot restarts, the healthy engine does not.
echo "SNIPER_TP_PCT=6" >> "$B/deploy/run.env"
N_PAPER="$(grep -c "started sniper paper" "$LOG")"
run_cron
if [ "$(grep -c "started sniper paper" "$LOG")" -gt "$N_PAPER" ] && [ "$(starts)" = 1 ] && [ "$(epid)" = "$P1" ]; then
  ok "new settings: paper restarted, engine kept (pid $P1)"
else bad "new settings: wrong restarts"; tail -5 "$LOG"; fi

# 5. engine killed: restarted.
kill "$P1"; sleep 0.5
run_cron
sleep 0.5
P2="$(epid)"
if [ "$(starts)" = 2 ] && [ -n "$P2" ] && [ "$P2" != "$P1" ] && grep -q "was not running" "$LOG"; then ok "dead engine restarted (pid $P2)"; else bad "dead engine not restarted"; tail -5 "$LOG"; fi

# 6. alive but socket dead: grace time first, then restart.
rm -f "$SOCK"
run_cron
if [ "$(starts)" = 2 ] && [ "$(epid)" = "$P2" ]; then ok "dead socket inside the start-up grace: left alone"; else bad "restarted inside grace"; fi
GRACE=0 run_cron
sleep 0.5
if [ "$(starts)" = 3 ] && [ "$(epid)" != "$P2" ] && sock_ok && grep -q "not answering" "$LOG"; then ok "dead socket after grace: restarted"; else bad "dead socket not restarted"; tail -5 "$LOG"; fi
P3="$(epid)"

# 7. kill switch, and a server without the paper bot: never started.
kill "$P3"; sleep 0.5
sed -i 's/^SNIPER_ENABLED=1/SNIPER_ENABLED=0/' "$B/deploy/run.env"
run_cron
if [ "$(starts)" = 3 ]; then ok "kill switch: engine not started"; else bad "kill switch: engine started"; fi
sed -i 's/^SNIPER_ENABLED=0/SNIPER_ENABLED=1/' "$B/deploy/run.env"
echo "MODES=feed-watch" >> "$HOME/.sniper-cron.conf"
run_cron
if [ "$(starts)" = 3 ]; then ok "feed server (no paper bot): engine not started"; else bad "feed server: engine started"; fi
sed -i '/^MODES=/d' "$HOME/.sniper-cron.conf"

# 8. failed start (no arbsim binary): one FAILED line, then it waits.
SRC="$T/missing/arbsim" run_cron
SRC="$T/missing/arbsim" run_cron
if [ "$(grep -c "engine start FAILED" "$LOG")" = 1 ]; then ok "failed start logged once, retry waits"; else bad "failed start: $(grep -c 'engine start FAILED' "$LOG") lines"; fi
RETRY=0 run_cron
sleep 0.5
if [ "$(starts)" = 4 ] && sock_ok; then ok "after the retry wait: started again"; else bad "not retried"; tail -5 "$LOG"; fi

# 9. the node link never reaches the log.
if grep -q "SECRETKEY123\|fake-node.invalid" "$LOG"; then bad "node link in the log"; else ok "node link never logged"; fi
# The dex bot's socket was never used.
if grep -q "/tmp/arbsim.sock" "$LOG"; then bad "dex bot socket mentioned"; else ok "dex bot socket untouched"; fi

echo "--- cron log ---"; cat "$LOG"
[ "$FAILS" = 0 ] && { echo "ALL PASSED"; exit 0; }
echo "$FAILS FAILED"; exit 1
