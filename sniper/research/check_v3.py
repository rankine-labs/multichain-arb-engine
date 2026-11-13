import sys, random, json
sys.path.insert(0, "/home/claude/research")
from sweep import *
ETH = 2500.0
v4 = {}
for line in open("/tmp/rhc_run2/swaps.jsonl"):
    s = json.loads(line); v4[s["pool"]] = s["v4"]
rows = [r for r in load_rich("/tmp/rhc_run2/swaps.jsonl") if not v4[r["pool"]]]
pools = by_pool(rows); pths = rich_paths(pools)
def run(signals, usd, tp, sl, hs):
    busy = -1; out = []
    for pool, block, rec in sorted(signals, key=lambda s: s[1]):
        if block <= busy: continue
        r = trade_exact(pths[pool], block, 0, tp, sl, blocks_for(hs), usd, ETH)
        if r is None: continue
        out.append(r[0]); busy = r[2]
    return out
for kind, prm in [("crowd", {"buys": 2, "win_s": 3.0, "rise": 2}), ("crowd", {"buys": 3, "win_s": 1.0, "rise": 2}), ("jump", {"jump_pct": 3})]:
    sig = make_signals(pools, kind, prm)
    for tp, sl, hs in [(0.20, 1.0, 30), (0.05, 0.05, 10), (0.03, 0.03, 3)]:
        r = run(sig, 50, tp, sl, hs)
        random.seed(1)
        rs = []
        for t in range(5):
            rnd = [(p, random.choice(pools[p])["block"], rec) for p, b, rec in sig]
            rs.append(sum(run(rnd, 50, tp, sl, hs)))
        if r:
            print(f"V3 {kind} {prm} TP{tp*100:.0f} SL{sl*100:.0f} {hs}s: signal ${sum(r):7.2f} ({len(r)} trades, win {100*sum(1 for x in r if x>0)/len(r):.0f}%)  random avg ${sum(rs)/len(rs):7.2f}")
