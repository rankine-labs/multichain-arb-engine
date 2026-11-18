#!/usr/bin/env bash
# ============================================================================
# TEST: the sniper engine's memory guard (cron + deploy/sniper-engine.sh
# guard) and the engine `trial` command.
#
# Plain English:
#   Runs the REAL scripts against a pretend server in a temp folder: a fake
#   HOME, a fake build folder, a fake dex bot .env (with a fake node link,
#   checked never to reach any log), a fake `arbsim` (a small Python program
#   that opens the engine socket, speaks the engine's message format and
#   holds as much memory as the test tells it to), and a fake feed relay (a
#   tiny local WebSocket server sending empty frames). The trial uses the
#   REAL sniper program (SNIPER_BIN, passed in by tests/engine_guard.rs).
#   Nothing real is started, stopped or contacted.
#
#   Memory guard checks:
#     1. engine under the limit: left alone, nothing logged.
#     2. over the limit: stopped, one "memory guard" line, restarted at once
#        (first stop in a row = no wait).
#     3. over again soon after: stopped, restart WAITS (backoff 120 s),
#        said once, not every cron run; second wait doubles (240 s).
#     4. backoff over: started again.
#     5. an engine that ran a full stable hour starts the count again (no wait).
#     6. the guard also protects an engine kept after a trial when run.env
#        does not ask for the engine (stopped, NOT restarted).
#   Trial checks:
#     7. good engine: verdict WORKS (exit 0), engine stopped after, result
#        file written, a status line every tick.
#     8. engine answering "unknown": FALLS BACK TOO OFTEN (exit 2).
#     9. engine over the memory limit: TOO MUCH MEMORY (exit 3), stopped
#        early, and stopped even with "keep".
#    10. "keep": engine left running; a second trial is refused while it runs.
#    11. refused while run.env has SNIPER_ENGINE=1, and when SNIPER_RHC_FEED
#        is Robinhood's own feed (never our own connection to it).
#    12. the node link never appears in any output.
#
# Run:  SNIPER_BIN=target/debug/sniper bash sniper/tests/engine_guard_test.sh
#       (also run by `cargo test`, tests/engine_guard.rs). Needs bash, git,
#       python3, flock, pgrep, ps.
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"   # sniper/
if pgrep -f "^\./sniper " >/dev/null 2>&1; then
  echo "SKIP: a real sniper is running on this machine"; exit 0
fi
[ -x "${SNIPER_BIN:-}" ] || { echo "SNIPER_BIN must point at the sniper program"; exit 1; }

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
mkdir -p "$HOME" "$T/arb/bin"
SOCK="$T/engine.sock"
SECRET="https://fake-node.invalid/SECRETKEY123"
echo "CHAINSTACK_RPC_ROBINHOOD=$SECRET" > "$T/arb/.env"
echo "ARB_ENV=$T/arb/.env" > "$HOME/.sniper-cron.conf"

# Fake arbsim. Controlled by files in $HOME (its environment is wiped by
# the start script, HOME is kept):
#   fake-rss-mb   memory to hold (MB, touched so it really counts)
#   fake-mode     "good" (quotes answered) or "miss" (every quote unknown)
#   fake-reads    paid node reads added per status question (default 0)
cat > "$T/arb/bin/arbsim" <<'PY'
#!/usr/bin/env python3
import json, os, socket, struct, threading
home = os.environ["HOME"]
def rd(name, d):
    try: return open(os.path.join(home, name)).read().strip() or d
    except OSError: return d
hold = b"x" * (int(rd("fake-rss-mb", "0")) * 1024 * 1024)
p = os.environ["ARBSIM_SOCKET"]
try: os.unlink(p)
except FileNotFoundError: pass
s = socket.socket(socket.AF_UNIX); s.bind(p); s.listen(16)
used = [0]; frames = [0]
W = lambda x: "0x%064x" % x
WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"
TOKEN = "0x00000000000000000000000000000000000c0123"
def word_addr(a): return "0x" + "0" * 24 + a[2:]
def recv_exact(c, n):
    b = b""
    while len(b) < n:
        x = c.recv(n - len(b))
        if not x: return None
        b += x
    return b
def send(c, v):
    b = json.dumps(v).encode(); c.sendall(struct.pack(">I", len(b)) + b)
def serve(c):
    while True:
        h = recv_exact(c, 4)
        if h is None: return
        m = json.loads(recv_exact(c, struct.unpack(">I", h)[0]))
        t = m.get("type")
        if t == "feed":
            frames[0] += 1; continue
        if t == "status":
            used[0] += int(rd("fake-reads", "0"))
            send(c, {"id": m["id"], "ok": True, "ready": True, "head": {"block": 100 + frames[0]}, "frames": frames[0],
                     "rssMb": len(hold) / 1048576, "node": {"usedToday": used[0], "cap": 3000, "refusedToday": 0, "public": {"usedToday": 7 * frames[0]}}})
            continue
        if t == "call":
            outs = []
            for call in m["calls"]:
                sel = call["data"][:10]
                if sel == "0x0dfe1681": outs.append(word_addr(TOKEN))
                elif sel == "0xd21220a7": outs.append(word_addr(WETH))
                elif sel == "0xddca3f43": outs.append(W(3000))
                else:
                    if rd("fake-mode", "good") == "miss":
                        send(c, {"id": m["id"], "ok": False, "unknown": "miss"}); outs = None; break
                    outs.append(W(12345) + W(1)[2:] + W(0)[2:] + W(90000)[2:])
            if outs is not None:
                send(c, {"id": m["id"], "ok": True, "at": {"block": "0x64"}, "results": [{"success": True, "output": o} for o in outs]})
print("fake arbsim listening", flush=True)
while True:
    c, _ = s.accept()
    threading.Thread(target=serve, args=(c,), daemon=True).start()
PY
chmod +x "$T/arb/bin/arbsim"

# Fake feed relay: a minimal WebSocket server sending an empty frame every
# 100 ms to whoever connects. Prints its port.
cat > "$T/relay.py" <<'PY'
import base64, hashlib, socket, sys, threading, time
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", 0)); srv.listen(8)
print(srv.getsockname()[1], flush=True)
def client(c):
    req = b""
    while b"\r\n\r\n" not in req:
        x = c.recv(4096)
        if not x: return
        req += x
    key = [l.split(b":", 1)[1].strip() for l in req.split(b"\r\n") if l.lower().startswith(b"sec-websocket-key")][0]
    acc = base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
    c.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acc + b"\r\n\r\n")
    n = 0
    try:
        while True:
            n += 1
            msg = ('{"version":1,"messages":[{"sequenceNumber":%d}]}' % n).encode()
            c.sendall(bytes([0x81, len(msg)]) + msg)
            time.sleep(0.1)
    except OSError:
        return
while True:
    c, _ = srv.accept()
    threading.Thread(target=client, args=(c,), daemon=True).start()
PY
python3 "$T/relay.py" > "$T/relay.port" 2>/dev/null &
for _ in $(seq 1 50); do [ -s "$T/relay.port" ] && break; sleep 0.1; done
RELAY="ws://127.0.0.1:$(cat "$T/relay.port")"

# Fake build folder (what ~/sniper-bin is on the server), with a paper run
# that has rush lines on one V3 pool (the trial's sample).
B="$HOME/sniper-bin"
mkdir -p "$B/deploy" "$B/paper-out/run9"
cp "$HERE/deploy/sniper-cron.sh" "$HERE/deploy/sniper-engine.sh" "$B/deploy/"
printf '#!/usr/bin/env bash\nexit 0\n' > "$B/sniper"; chmod +x "$B/sniper"
POOL="0x00000000000000000000000000000000000f0011"
for i in 1 2 3; do echo "{\"pool\":\"$POOL\",\"venue\":\"v3\",\"block\":$i,\"taken\":false}" >> "$B/paper-out/run9/signals.jsonl"; done
base_env() { printf 'SNIPER_ENABLED=1\nSNIPER_MODE=paper\nSNIPER_OUT=paper-out/test\nSNIPER_ENGINE_SOCKET=%s\nSNIPER_RHC_FEED=%s\n' "$SOCK" "$RELAY"; }
base_env > "$B/deploy/run.env"
echo "SNIPER_ENGINE=1" >> "$B/deploy/run.env"
( cd "$B" && git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm build )

LOG="$T/cron.log"
MEMLIM=50
run_cron() { ENGINE_MEM_LIMIT_MB="$MEMLIM" ENGINE_SOCKET="$SOCK" ARBSIM_SRC="$T/arb/bin/arbsim" bash "$B/deploy/sniper-cron.sh" >> "$LOG" 2>&1; }
epid() { cat "$HOME/sniper-engine/engine.pid" 2>/dev/null; }
alive() { [ -n "$(epid)" ] && kill -0 "$(epid)" 2>/dev/null; }
n_guard() { grep -c "memory guard" "$LOG"; }
n_start() { grep -c "engine (re)started" "$LOG"; }
mstate() { grep "^$1=" "$HOME/sniper-engine/memguard.state" 2>/dev/null | cut -d= -f2; }
# Wait for the fake engine to really hold its memory (python startup).
settle() { for _ in $(seq 1 30); do [ -S "$SOCK" ] && break; sleep 0.1; done; sleep 0.3; }

# 1. Under the limit: left alone.
echo 10 > "$HOME/fake-rss-mb"
run_cron; settle
P1="$(epid)"
run_cron
if alive && [ "$(epid)" = "$P1" ] && [ "$(n_guard)" = 0 ]; then ok "under the limit: left alone, nothing logged"; else bad "under the limit"; cat "$LOG"; fi

# 2. Over the limit: stopped, logged, restarted at once (first stop).
echo 80 > "$HOME/fake-rss-mb"
kill "$P1"; sleep 0.3; run_cron; settle        # restart so it holds 80 MB
P2="$(epid)"
run_cron; settle
if [ "$(n_guard)" = 1 ] && grep -q "used [0-9]* MB (limit 50 MB), stopped; memory stop 1 in a row, next start allowed now" "$LOG" && alive && [ "$(epid)" != "$P2" ]; then
  ok "over the limit: stopped, logged, restarted at once"
else bad "over the limit: $(n_guard) guard lines"; tail -5 "$LOG"; fi

# 3. Over again soon after: backoff 120 s, said once.
run_cron; settle
if [ "$(n_guard)" = 2 ] && ! alive && [ "$(mstate STREAK)" = 2 ] && [ $(( $(mstate NEXT_START_AT) - $(mstate LAST_STOP_AT) )) = 120 ]; then
  ok "second stop in a row: restart waits 120 s"
else bad "second stop: streak $(mstate STREAK)"; tail -5 "$LOG"; cat "$HOME/sniper-engine/memguard.state"; fi
N_WAIT="$(grep -c "memory backoff" "$LOG")"
run_cron; run_cron
if ! alive && [ "$N_WAIT" = 1 ] && [ "$(grep -c "memory backoff" "$LOG")" = 1 ] && ! grep -q "engine start FAILED" "$LOG"; then
  ok "backoff said once, not a failure, not retried meanwhile"
else bad "backoff lines: $(grep -c "memory backoff" "$LOG")"; tail -5 "$LOG"; fi

# 4. Backoff over: started again; over again -> 240 s.
sed -i 's/^NEXT_START_AT=.*/NEXT_START_AT=0/' "$HOME/sniper-engine/memguard.state"
run_cron; settle
if alive; then ok "backoff over: started again"; else bad "not started after the backoff"; tail -5 "$LOG"; fi
run_cron
if [ "$(mstate STREAK)" = 3 ] && [ $(( $(mstate NEXT_START_AT) - $(mstate LAST_STOP_AT) )) = 240 ]; then ok "third stop in a row: wait doubles to 240 s"; else bad "third stop: $(cat "$HOME/sniper-engine/memguard.state")"; fi

# 5. Ran a full stable hour: the count starts again (no wait).
sed -i 's/^NEXT_START_AT=.*/NEXT_START_AT=0/' "$HOME/sniper-engine/memguard.state"
run_cron; settle
touch -d '2 hours ago' "$HOME/sniper-engine/engine.pid"
run_cron; settle
if [ "$(mstate STREAK)" = 1 ] && alive; then ok "after a stable hour: count starts again, restarted at once"; else bad "stable reset: $(cat "$HOME/sniper-engine/memguard.state")"; tail -3 "$LOG"; fi

# 6. Engine not wanted by run.env (e.g. kept after a trial): still guarded,
#    stopped, never restarted by the cron.
sed -i '/^SNIPER_ENGINE=1/d' "$B/deploy/run.env"
N="$(n_start)"
run_cron; settle
if ! alive && [ "$(n_start)" = "$N" ] && [ "$(mstate STREAK)" = 2 ]; then ok "unwanted engine over the limit: stopped, not restarted"; else bad "unwanted engine"; tail -3 "$LOG"; fi
rm -f "$HOME/sniper-engine/memguard.state"

# ---- trial ----
TOUT="$T/trial.out"
trial() { ( cd "$B" && SNIPER_BIN="$SNIPER_BIN" ENGINE_SOCKET="$SOCK" ARBSIM_SRC="$T/arb/bin/arbsim" TRIAL_TICK_SECS=1 ENGINE_MEM_LIMIT_MB="$MEMLIM" bash deploy/sniper-engine.sh trial "$@" ) > "$TOUT" 2>&1; }

# 7. Good engine: WORKS.
echo 10 > "$HOME/fake-rss-mb"; echo good > "$HOME/fake-mode"; echo 0 > "$HOME/fake-reads"
trial 4; RC=$?
if [ "$RC" = 0 ] && grep -q "ENGINE TRIAL VERDICT: WORKS" "$TOUT" && [ "$(grep -c '^minute ' "$TOUT")" = 4 ] && ! alive && ls "$HOME"/sniper-engine/trial-*.txt >/dev/null 2>&1; then
  ok "good engine: WORKS, 4 status lines, engine stopped, result file written"
else bad "good trial (rc $RC)"; cat "$TOUT"; fi
grep -q "quotes answered 1 unknown 0" "$TOUT" && ok "sample pool quoted on the engine every tick" || { bad "sample quotes"; cat "$TOUT"; }

# 8. Unknown answers: FALLS BACK TOO OFTEN.
echo miss > "$HOME/fake-mode"
trial 4; RC=$?
if [ "$RC" = 2 ] && grep -q "VERDICT: FALLS BACK TOO OFTEN" "$TOUT" && grep -q "miss" "$TOUT" && ! alive; then ok "unknown answers: FALLS BACK TOO OFTEN (exit 2)"; else bad "miss trial (rc $RC)"; cat "$TOUT"; fi
# Paid reads on course for over the cap: falls back too.
echo good > "$HOME/fake-mode"; echo 5 > "$HOME/fake-reads"
trial 4; RC=$?
if [ "$RC" = 2 ] && grep -q "over the 3000 cap" "$TOUT"; then ok "paid reads on course past the cap: FALLS BACK"; else bad "budget trial (rc $RC)"; cat "$TOUT"; fi
echo 0 > "$HOME/fake-reads"

# 9. Over the memory limit: stopped early, never kept.
echo 80 > "$HOME/fake-rss-mb"
trial 6 keep; RC=$?
if [ "$RC" = 3 ] && grep -q "TOO MUCH MEMORY OR CPU" "$TOUT" && grep -q "stopping early" "$TOUT" && ! alive; then ok "over memory: exit 3, stopped early, not kept"; else bad "memory trial (rc $RC)"; cat "$TOUT"; fi

# 10. keep: left running; a second trial is refused.
echo 10 > "$HOME/fake-rss-mb"
trial 3 keep; RC=$?
if [ "$RC" = 0 ] && alive && grep -q "KEPT running" "$TOUT"; then ok "keep: engine left running"; else bad "keep (rc $RC)"; cat "$TOUT"; fi
trial 3; RC=$?
if [ "$RC" = 1 ] && grep -q "already running" "$TOUT" && alive; then ok "second trial refused while the engine runs"; else bad "second trial (rc $RC)"; cat "$TOUT"; fi
( cd "$B" && ENGINE_SOCKET="$SOCK" bash deploy/sniper-engine.sh stop >/dev/null )

# 11. Refusals: paper bot uses the engine; Robinhood's own feed.
echo "SNIPER_ENGINE=1" >> "$B/deploy/run.env"
trial 2; RC=$?
if [ "$RC" = 1 ] && grep -q "paper bot uses the engine" "$TOUT" && ! alive; then ok "refused while SNIPER_ENGINE=1"; else bad "SNIPER_ENGINE refusal (rc $RC)"; cat "$TOUT"; fi
sed -i '/^SNIPER_ENGINE=1/d' "$B/deploy/run.env"
sed -i 's#^SNIPER_RHC_FEED=.*#SNIPER_RHC_FEED=wss://feed.mainnet.chain.robinhood.com#' "$B/deploy/run.env"
trial 2; RC=$?
if [ "$RC" = 1 ] && grep -q "must be our feed relay" "$TOUT" && ! alive; then ok "refused with Robinhood's own feed"; else bad "feed refusal (rc $RC)"; cat "$TOUT"; fi

# 12. The node link never shows up anywhere.
if grep -rq "SECRETKEY123\|fake-node.invalid" "$LOG" "$TOUT" "$HOME"/sniper-engine/trial-*.txt; then bad "node link printed"; else ok "node link never printed"; fi

echo "--- cron log ---"; cat "$LOG"
[ "$FAILS" = 0 ] && { echo "ALL PASSED"; exit 0; }
echo "$FAILS FAILED"; exit 1
