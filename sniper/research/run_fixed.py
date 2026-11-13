"""Lock ONE rule (picked on last night's data) and check it on every quarter of tonight."""
import sys
sys.path.insert(0, "/home/claude/research")
from sweep import *
ETH = float(sys.argv[1]) if len(sys.argv) > 1 else 2500.0
rows = load_rich("/tmp/rhc_run2/swaps.jsonl")
bl = sorted(set(r["block"] for r in rows))
q = [bl[min(len(bl) - 1, int(len(bl) * k / 4))] for k in range(5)]
slices = {f"Q{k+1}": [r for r in rows if q[k] <= r["block"] < q[k + 1] or (k == 3 and r["block"] == q[4])] for k in range(4)}
slices["ALL"] = rows
RULES = [
    ("crowd", {"buys": 2, "win_s": 3.0, "rise": 2}, (0.20, 1.0, 30)),
    ("crowd", {"buys": 2, "win_s": 3.0, "rise": 2}, (0.10, 0.10, 30)),
    ("jump", {"jump_pct": 3}, (0.20, 1.0, 30)),
]
for kind, prm, (tp, sl, hs) in RULES:
    print(f"\nRULE {kind} {prm} TP {tp*100:.0f}% SL {sl*100:.0f}% {hs}s")
    for usd in [50, 150, 500]:
        for imp in [None, 1.0]:
            line = f"  ${usd:<3} depth<={str(imp):4}:"
            for name, rws in slices.items():
                pools = by_pool(rws); pths = rich_paths(pools)
                b = sorted(set(r["block"] for r in rws)); h = (b[-1] - b[0]) * BLOCK_MS / 3.6e6
                sig = make_signals(pools, kind, prm)
                p = one_at_a_time(sig, pths, 0, tp, sl, blocks_for(hs), usd, ETH, imp)
                if p:
                    line += f" {name} ${sum(p)/h:7.1f}/h ({len(p)}, win {100*sum(1 for x in p if x>0)/len(p):.0f}%, worst {min(p):.0f})"
            print(line)
