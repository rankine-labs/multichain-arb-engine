"""Last night (7.5 h, no depth -> % returns after pool fees, no own impact):
V3-only, signal vs random entries in the same pools, several rules."""
import sys, random, json, statistics
sys.path.insert(0, "/home/claude/research")
from sweep import *
v4 = {}
for line in open("/tmp/rhc12/swaps.jsonl"):
    s = json.loads(line); v4[s["pool"]] = s["v4"]
rows = [r for r in load("/tmp/rhc12/swaps.jsonl") if not v4[r["pool"]]]
bl = sorted(set(r["block"] for r in rows))
gap_i = max(range(1, len(bl)), key=lambda i: bl[i] - bl[i-1])
rows = [r for r in rows if r["block"] <= bl[gap_i - 1]]
pools = by_pool(rows); pth = paths(pools)
def run(signals, tp, sl, hs):
    busy = -1; out = []
    for pool, block, rec in sorted(signals, key=lambda s: s[1]):
        if block <= busy: continue
        r = simulate(pth[pool], block, 0, tp, sl, blocks_for(hs), rec["fee"])
        if r is None: continue
        out.append(r); busy = block + blocks_for(hs)
    return out
for kind, prm in [("crowd", {"buys": 3, "win_s": 1.0, "rise": 2}), ("crowd", {"buys": 3, "win_s": 1.0, "rise": 4}), ("crowd", {"buys": 5, "win_s": 1.0, "rise": 2}), ("crowd", {"buys": 2, "win_s": 3.0, "rise": 2}), ("jump", {"jump_pct": 3})]:
    sig = make_signals(pools, kind, prm)
    for tp, sl, hs in [(0.20, 1.0, 30), (0.05, 0.05, 10), (0.03, 0.03, 3)]:
        r = run(sig, tp, sl, hs)
        random.seed(3)
        rnd_avgs = []
        for t in range(10):
            rnd = [(p, random.choice(pools[p])["block"], rec) for p, b, rec in sig]
            rr = run(rnd, tp, sl, hs)
            if rr: rnd_avgs.append(100 * sum(rr) / len(rr))
        if len(r) > 5:
            st = stats(r)
            print(f"{kind} {str(prm):42} TP{tp*100:3.0f} SL{sl*100:3.0f} {hs:2}s: signal avg {st['avg']:+5.2f}% [{st['lo']:+5.2f}..{st['hi']:+5.2f}] n {st['n']:4} win {st['win']:3.0f}% | random avg {statistics.mean(rnd_avgs):+5.2f}%")
