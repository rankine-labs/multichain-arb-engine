"""Do the profitable trades come from pools where nobody ever sells (honeypot sign)?"""
import sys, collections
sys.path.insert(0, "/home/claude/research")
from sweep import *
ETH = 2500.0
rows = load_rich("/tmp/rhc_run2/swaps.jsonl")
pools = by_pool(rows); pths = rich_paths(pools)
# Per pool: share of swaps that pushed the price DOWN (= someone sold the token).
down = {}
for pool, v in pools.items():
    d = sum(1 for a, b in zip(v, v[1:]) if b["price"] < a["price"])
    down[pool] = (d, len(v))
sig = make_signals(pools, "crowd", {"buys": 2, "win_s": 3.0, "rise": 2})
busy = -1; trades = []
for pool, block, rec in sorted(sig, key=lambda s: s[1]):
    if block <= busy: continue
    r = trade_exact(pths[pool], block, 0, 0.20, 1.0, blocks_for(30), 50, ETH)
    if r is None: continue
    trades.append((pool, r[0])); busy = r[2]
by = collections.defaultdict(lambda: [0, 0.0])
for pool, pnl in trades:
    d, n = down[pool]
    share = d / max(n - 1, 1)
    bucket = "no sells at all" if d == 0 else ("<10% sells" if share < 0.10 else ("10-30% sells" if share < 0.30 else ">=30% sells"))
    by[bucket][0] += 1; by[bucket][1] += pnl
tot = sum(p for _, p in trades)
print(f"{len(trades)} trades, total ${tot:.2f}")
for k, (n, s) in sorted(by.items()):
    print(f"  {k:16} {n:4} trades  ${s:8.2f}  ({100*s/tot:.0f}% of profit)")
# Top pools by profit
pp = collections.defaultdict(lambda: [0, 0.0])
for pool, pnl in trades: pp[pool][0] += 1; pp[pool][1] += pnl
print("top pools:")
for pool, (n, s) in sorted(pp.items(), key=lambda x: -x[1][1])[:8]:
    d, m = down[pool]
    print(f"  {pool[:14]} trades {n:3}  ${s:7.2f}  swaps {m:5} sells {d:5} ({100*d/max(m-1,1):.0f}%)")
