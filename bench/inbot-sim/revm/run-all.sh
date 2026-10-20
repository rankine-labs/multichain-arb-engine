#!/usr/bin/env bash
# ============================================================================
# run-all.sh — build, then for every fixture:
#   1) in-process benchmark  (revm alone)           -> results/<name>.bench.json
#   2) sidecar + Node client (full round trip)      -> results/<name>.socket.json
# and print one summary table.
#
# Usage:  ./run-all.sh [N]        (N = runs per test, default 5000)
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"
export PATH=/root/.cargo/bin:$PATH
N=${1:-5000}
FIX=../fixtures
SOCK=$(mktemp -u /tmp/revm-sidecar.XXXX.sock)

cargo build --release 2>&1 | tail -1
mkdir -p results chain-a

for f in "$FIX"/*.json; do
  name=$(basename "$f" .json)
  # tx A for the chained test: same route, 100 USDG, minProfit 1 wei -> really swaps.
  node tools/make-chain-a.js "$f" same 100000000 > "chain-a/$name.hex"

  # 1) in-process
  ./target/release/revm-bench bench "$f" --n "$N" --chain-a "chain-a/$name.hex" > "results/$name.bench.json"

  # 2) over the socket from Node
  ./target/release/revm-bench serve "$f" "$SOCK" 2>/dev/null &
  pid=$!
  for _ in $(seq 50); do [ -S "$SOCK" ] && break; sleep 0.05; done
  node client.js "$SOCK" "$f" --n "$N" --chain-a "chain-a/$name.hex" > "results/$name.socket.json"
  kill $pid; wait $pid 2>/dev/null || true
  rm -f "$SOCK"
done

node tools/summarize.js results
