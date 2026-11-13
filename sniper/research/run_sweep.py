"""
Run the rule search honestly:
  TRAIN = first half of last night's run (by block)
  TEST1 = second half of last night's run   (never used for picking)
  TEST2 = tonight's run so far              (never used for picking; has depth)
Ranks entry+exit combos on TRAIN by total % earned per hour (avg x signals/h,
so a rule must be both profitable AND frequent), keeps the top ones, and
prints how they do on TEST1 and TEST2. TEST2 also with our own price impact
at $50 / $150 / $500 per trade.
"""
import sys, json
sys.path.insert(0, "/home/claude/research")
from sweep import *

NIGHT = "/tmp/rhc12/swaps.jsonl"
TONIGHT = "/tmp/rhc_run2/swaps.jsonl"
ETH_USD = float(sys.argv[1]) if len(sys.argv) > 1 else 2500.0

night = load(NIGHT)
blocks = sorted(set(r["block"] for r in night))
# Use only the stretch before the PC slept (big gap) and split it in half.
gap_i = max(range(1, len(blocks)), key=lambda i: blocks[i] - blocks[i - 1])
awake = blocks[:gap_i]
mid = awake[len(awake) // 2]
train = [r for r in night if r["block"] <= mid]
test1 = [r for r in night if mid < r["block"] <= awake[-1]]
test2 = load(TONIGHT)


def hours(rows):
    b = [r["block"] for r in rows]
    return (max(b) - min(b)) * BLOCK_MS / 3.6e6


sets = {}
for name, rows in [("train", train), ("test1", test1), ("test2", test2)]:
    pools = by_pool(rows)
    sets[name] = (pools, paths(pools), hours(rows))
    print(f"{name}: {len(rows)} swaps, {hours(rows):.2f} h")

results = []
for kind, prm in rules():
    pools, pth, h = sets["train"]
    sig = make_signals(pools, kind, prm)
    if len(sig) < 30:
        continue
    for tp, sl, hs in EXITS:
        st = evaluate(pools, pth, sig, 0, tp, sl, blocks_for(hs))
        if st is None:
            continue
        per_hour = st["avg"] * len(sig) / h  # total % per hour if every signal taken at equal size
        results.append({"kind": kind, "prm": prm, "tp": tp, "sl": sl, "hs": hs, "train": st, "train_sig_h": len(sig) / h, "score": per_hour})

results.sort(key=lambda r: -r["score"])
print(f"\ncombos tried: {len(results)}")

def show(st):
    if st is None:
        return "n/a"
    return f"avg {st['avg']:+5.2f}% [{st['lo']:+5.2f}..{st['hi']:+5.2f}] med {st['med']:+5.2f}% win {st['win']:4.0f}% worst {st['worst']:+6.1f}% n {st['n']}"

top = []
seen = set()
for r in results:
    key = (r["kind"], json.dumps(r["prm"], sort_keys=True))
    if key in seen:
        continue  # best exit per entry rule only
    seen.add(key)
    top.append(r)
    if len(top) == 12:
        break

for r in top:
    label = f"{r['kind']} {r['prm']} | TP {r['tp']*100:.0f}% SL {r['sl']*100:.0f}% {r['hs']}s"
    print("\n" + label)
    print(f"  TRAIN  ({r['train_sig_h']:.0f}/h): " + show(r["train"]))
    for name in ["test1", "test2"]:
        pools, pth, h = sets[name]
        sig = make_signals(pools, r["kind"], r["prm"])
        st = evaluate(pools, pth, sig, 0, r["tp"], r["sl"], blocks_for(r["hs"]))
        print(f"  {name.upper()} ({len(sig)/h:.0f}/h): " + show(st))
        if name == "test2":
            for usd in [50, 150, 500]:
                st2 = evaluate(pools, pth, sig, 0, r["tp"], r["sl"], blocks_for(r["hs"]), usd, ETH_USD)
                late = evaluate(pools, pth, sig, round(300 / BLOCK_MS), r["tp"], r["sl"], blocks_for(r["hs"]), usd, ETH_USD)
                print(f"     ${usd:<4} first: {show(st2)}")
                print(f"     ${usd:<4} 0.3s late: {show(late)}")
