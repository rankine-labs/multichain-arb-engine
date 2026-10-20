#!/usr/bin/env bash
# ============================================================================
# server-run.sh — run the revm speed test ON THE EC2 SERVER (read only).
#
# Plain English:
#   Uses the ready-built engine (bin/revm-bench, no Rust needed on the server)
#   on every test file in ../fixtures (the real trades grab-live.js saved).
#   For each trade: run it N times inside revm, then N times through the
#   socket from Node (what the bot would really do), and compare with the
#   chain's own answer. Nothing is sent, nothing touches the running bot.
#   Runs at low priority (nice) so the live bot always gets the CPU first.
#
# Usage:  ./server-run.sh [N=1000]
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")"
N=${1:-1000}
FIX=${FIX:-../fixtures}
BIN=./bin/revm-bench
SOCK=$(mktemp -u /tmp/revm-sidecar.XXXX.sock)
mkdir -p results-server chain-a-server

for f in "$FIX"/*.json; do
  name=$(basename "$f" .json)
  # Optional chained test (tx A then our trade); skipped if the trade can't be decoded.
  CHAIN=()
  if node tools/make-chain-a.js "$f" same > "chain-a-server/$name.hex" 2>/dev/null; then CHAIN=(--chain-a "chain-a-server/$name.hex"); fi

  nice -n 10 "$BIN" bench "$f" --n "$N" "${CHAIN[@]}" > "results-server/$name.bench.json" 2>/dev/null

  nice -n 10 "$BIN" serve "$f" "$SOCK" 2>/dev/null &
  pid=$!
  for _ in $(seq 50); do [ -S "$SOCK" ] && break; sleep 0.05; done
  nice -n 10 node client.js "$SOCK" "$f" --n "$N" "${CHAIN[@]}" > "results-server/$name.socket.json" 2>/dev/null
  kill $pid 2>/dev/null; wait $pid 2>/dev/null || true
  rm -f "$SOCK"
done

node tools/summarize.js results-server
