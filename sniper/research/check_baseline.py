"""(1) Same pools, RANDOM entry times vs signal entries. (2) Profit split V3 vs V4 pools."""
import sys, random, json, collections
sys.path.insert(0, "/home/claude/research")
from sweep import *
ETH = 2500.0
raw = {}
for line in open("/tmp/rhc_run2/swaps.jsonl"):
    s = json.loads(line); raw[s["pool"]] = s["v4"]
rows = load_rich("/tmp/rhc_run2/swaps.jsonl")
pools = by_pool(rows); pths = rich_paths(pools)
sig = make_signals(pools, "crowd", {"buys": 2, "win_s": 3.0, "rise": 2})

def run(signals):
    busy = -1; out = []
    for pool, block, rec in sorted(signals, key=lambda s: s[1]):
        if block <= busy: continue
        r = trade_exact(pths[pool], block, 0, 0.20, 1.0, blocks_for(30), 50, ETH)
        if r is None: continue
        out.append((pool, r[0])); busy = r[2]
    return out

real = run(sig)
print(f"SIGNAL: {len(real)} trades, ${sum(p for _,p in real):.2f}, win {100*sum(1 for _,p in real if p>0)/len(real):.0f}%")
# Random entries: same pools as the signals, random blocks within each pool's active span.
sig_pools = list({p for p, _, _ in sig})
random.seed(7)
for trial in range(5):
    rnd = []
    for pool, block, rec in sig:
        v = pools[pool]
        x = random.choice(v)
        rnd.append((pool, x["block"], x))
    rr = run(rnd)
    print(f"RANDOM entry, same pools #{trial}: {len(rr)} trades, ${sum(p for _,p in rr):.2f}, win {100*sum(1 for _,p in rr if p>0)/len(rr):.0f}%")
split = collections.defaultdict(lambda: [0, 0.0])
for pool, p in real:
    k = "V4" if raw.get(pool) else "V3"
    split[k][0] += 1; split[k][1] += p
print("by pool type:", {k: (n, round(s, 2)) for k, (n, s) in split.items()})
