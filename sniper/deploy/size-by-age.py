#!/usr/bin/env python3
# ============================================================================
# size-by-age.py: should newer coins get less money? Read-only research.
#
# Plain English:
#   Reuses size-optimizer.py's 7 days of trades (each with its result at
#   $25/$50/$100). Adds each trade's POOL AGE at our buy:
#     - young test trades carry it directly,
#     - main trades: pool birth block from the cache (paper-out/pool_births.json,
#       filled by the earlier pool-age study and the bot's own lookups).
#   Then:
#     1. Per age band: trades, rugs, average return, and the Kelly fraction
#        (how much of the wallet each band "deserves").
#     2. Replays the week with:
#          A. flat 10% of wallet on every trade (my last recommendation)
#          B. age tiers: newer pools get a smaller % of the wallet
#        and reports profit, worst drawdown and the biggest single loss.
#   Same limits as before: paper overlaps trades, so dollars are optimistic;
#   compare rules, don't treat as a forecast.
#
# Usage (from ~/sniper-bin):
#   python3 -I size-by-age.py [start_bankroll_usd]
# ============================================================================
import collections
import importlib.util
import json
import os
import sys

p = os.path.expanduser("~/size-optimizer.py")
_s = importlib.util.spec_from_file_location("size_optimizer", p)
so = importlib.util.module_from_spec(_s)
_s.loader.exec_module(so)

BANDS = [(0, 120, "0-2 min"), (120, 300, "2-5 min"), (300, 900, "5-15 min"), (900, 3600, "15-60 min"),
         (3600, 7200, "1-2 h"), (7200, 21600, "2-6 h"), (21600, 86400, "6-24 h"), (86400, 1e12, "1 day+")]


def band(age):
    if age is None:
        return "unknown"
    for lo, hi, lab in BANDS:
        if lo <= age < hi:
            return lab
    return "unknown"


def load_with_age():
    """size-optimizer trades plus pool age. Re-reads the ladder rows to keep
    pool + age (size-optimizer drops them)."""
    births = {}
    bp = "paper-out/pool_births.json"
    if os.path.exists(bp):
        try:
            births = {k.lower(): v for k, v in json.load(open(bp)).items()}
        except ValueError:
            pass
    T = so.load()
    # Index ladder rows by (open_block, young) -> pool, age, so we can attach them.
    extra = {}
    import glob
    for d in sorted(glob.glob("paper-out/*")):
        if os.path.basename(d) not in so.RUNS:
            continue
        fp = os.path.join(d, "paper_trades.jsonl")
        if not os.path.exists(fp):
            continue
        last = 0
        for line in open(fp):
            if '"ladder_for"' not in line and '"open_block"' not in line:
                continue
            try:
                t = json.loads(line)
            except ValueError:
                continue
            if t.get("open_block"):
                last = t["open_block"]
            if "ladder_for" in t:
                blk = t.get("open_block") or last
                extra[(blk, t.get("group") == "young")] = (t["ladder_for"].lower(), t.get("pool_age_s"))
    for t in T:
        pool, age = extra.get((t["blk"], t["group"].startswith("young")), ("", None))
        if age is None and pool in births:
            b = births[pool]
            b = b.get("block") if isinstance(b, dict) else b
            if isinstance(b, (int, float)) and b > 0:
                age = (t["blk"] - b) * so.BLOCK_S
        t["age"] = age
        t["band"] = band(age)
    return T


def main():
    start = float(sys.argv[1]) if len(sys.argv) > 1 else 75.0
    T = load_with_age()
    print(f"{len(T)} trades, age known for {sum(t['age'] is not None for t in T)}\n")
    print("== By pool age at our buy (returns at $25, all venues) ==")
    by = collections.defaultdict(list)
    for t in T:
        by[t["band"]].append(t)
    K = {}
    for lab in [b[2] for b in BANDS] + ["unknown"]:
        ts = by.get(lab)
        if not ts:
            continue
        rets = [so.ret_at(t, 25.0) for t in ts]
        K[lab] = so.kelly(rets)
        rugs = sum(t["rug"] for t in ts)
        print(f"  {lab:10s} {len(ts):5d} trades | rugs {rugs:3d} ({100*rugs/len(ts):4.1f}%) | avg return {100*sum(rets)/len(rets):+5.2f}% "
              f"| worst trade {100*min(rets):+6.1f}% | Kelly {100*K[lab]:5.1f}% of wallet")

    def flat(pct, cap):
        return lambda g, b, t=None: min(pct * b, cap)

    def tiers(table, cap):
        return lambda g, b, t=None: min(table.get(t["band"], table["default"]) * b, cap)

    # replay() in size-optimizer passes (group, bankroll); wrap so rules see the trade.
    def run(rule, day_cap=0.15):
        b, peak, mdd, big = start, start, 0.0, 0.0
        day, ds, dp = None, start, 0.0
        n = rugs = 0
        for t in T:
            if t["day"] != day:
                day, ds, dp = t["day"], b, 0.0
            s = rule(t["group"], b, t)
            if s < 1 or s > b or -dp >= day_cap * ds:
                continue
            pnl = s * max(so.ret_at(t, s), -1.0)
            b += pnl
            dp += pnl
            n += 1
            rugs += t["rug"]
            big = min(big, pnl)
            peak = max(peak, b)
            mdd = max(mdd, (peak - b) / peak)
        return b - start, mdd, big, n, rugs

    print("\n== Sizing rules (start $%.0f, daily stop 15%%, max $25 a trade) ==" % start)
    rules = {
        "A. flat 10% of wallet": flat(0.10, 25),
        "B. tiers: <15m 4%, 15-60m 6%, 1h+ 10%": tiers({"0-2 min": 0.04, "2-5 min": 0.04, "5-15 min": 0.04,
                                                        "15-60 min": 0.06, "default": 0.10}, 25),
        "C. tiers: <2m 0%, 2-15m 4%, 15-60m 8%, 1h+ 12%": tiers({"0-2 min": 0.0, "2-5 min": 0.04, "5-15 min": 0.04,
                                                                 "15-60 min": 0.08, "default": 0.12}, 25),
        "D. tiers: <15m 3%, 15m-2h 8%, 2h+ 12%": tiers({"0-2 min": 0.03, "2-5 min": 0.03, "5-15 min": 0.03,
                                                       "15-60 min": 0.08, "1-2 h": 0.08, "default": 0.12}, 25),
        "E. tiers: <15m 5%, 15-60m 8%, 1h+ 10%": tiers({"0-2 min": 0.05, "2-5 min": 0.05, "5-15 min": 0.05,
                                                       "15-60 min": 0.08, "default": 0.10}, 25),
    }
    for name, rule in rules.items():
        pr, mdd, big, n, rugs = run(rule)
        print(f"  {name:48s} profit ${pr:+9.2f} | worst drawdown {100*mdd:4.1f}% | biggest single loss ${big:+7.2f} | {n} trades, {rugs} rugs")


if __name__ == "__main__":
    main()
