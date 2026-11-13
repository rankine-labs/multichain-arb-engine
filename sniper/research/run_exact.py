"""
Honest dollars: tonight's data (has pool depth), our real trade size pushed
through each pool, ONE trade at a time, optional "pool must be deep enough"
filter. Entry rules = the top ones from run_sweep.py (picked on last night's
data, so tonight is out-of-sample). Also splits tonight in two halves to see
if results are stable.
"""
import sys
sys.path.insert(0, "/home/claude/research")
from sweep import *

ETH = float(sys.argv[1]) if len(sys.argv) > 1 else 2500.0
rows = load_rich("/tmp/rhc_run2/swaps.jsonl")
bl = sorted(set(r["block"] for r in rows))
hours_all = (bl[-1] - bl[0]) * BLOCK_MS / 3.6e6
mid = bl[len(bl) // 2]
halves = {"all": rows, "half1": [r for r in rows if r["block"] <= mid], "half2": [r for r in rows if r["block"] > mid]}
print(f"tonight: {len(rows)} swaps with depth, {hours_all:.2f} h, ETH=${ETH:.0f}")

CANDIDATES = [
    ("crowd", {"buys": 2, "win_s": 3.0, "rise": 2}),
    ("crowd", {"buys": 2, "win_s": 3.0, "rise": 4}),
    ("crowd", {"buys": 3, "win_s": 1.0, "rise": 2}),
    ("jump", {"jump_pct": 2}),
    ("jump", {"jump_pct": 3}),
    ("jump", {"jump_pct": 5}),
]
EXITS2 = [(0.20, 1.0, 30), (0.10, 0.10, 10), (0.05, 0.05, 10), (0.03, 0.03, 3), (0.10, 0.05, 30)]

for name, rws in halves.items():
    pools = by_pool(rws)
    pths = rich_paths(pools)
    b = sorted(set(r["block"] for r in rws))
    h = (b[-1] - b[0]) * BLOCK_MS / 3.6e6
    print(f"\n===== {name} ({h:.2f} h)")
    for kind, prm in CANDIDATES:
        sig = make_signals(pools, kind, prm)
        best = None
        for tp, sl, hs in EXITS2:
            for usd in [50, 150, 500]:
                for imp in [None, 0.5, 1.0]:
                    for delay_ms in [0, 300]:
                        p = one_at_a_time(sig, pths, round(delay_ms / BLOCK_MS), tp, sl, blocks_for(hs), usd, ETH, imp)
                        if len(p) < 10:
                            continue
                        tot = sum(p)
                        row = (tot / h, usd, imp, delay_ms, tp, sl, hs, len(p), 100 * sum(1 for x in p if x > 0) / len(p), min(p), tot)
                        if name == "all":
                            print(f"  {kind:5} {str(prm):40} ${usd:<3} depth<= {str(imp):4} late {delay_ms:3}ms TP{tp*100:3.0f} SL{sl*100:3.0f} {hs:2}s | trades {len(p):4} win {row[8]:3.0f}% worst ${min(p):7.2f} | ${tot:8.2f} total = ${tot/h:7.2f}/h")
                        if best is None or row[0] > best[0]:
                            best = row
        if best and name != "all":
            print(f"  best {kind} {prm}: ${best[0]:.2f}/h  (size ${best[1]}, depth filter {best[2]}, late {best[3]}ms, TP {best[4]*100:.0f}% SL {best[5]*100:.0f}% {best[6]}s, {best[7]} trades, win {best[8]:.0f}%)")
