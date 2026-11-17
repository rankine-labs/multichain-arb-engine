#!/usr/bin/env python3
# ============================================================================
# HOT-COIN + NIGHT-ONLY STUDY (read-only, uses files already on disk)
#
# Plain English:
#   Two strategy ideas, scored on every past paper trade that the live
#   2-hour age rule would still allow (pools at least 2 h old):
#
#   1. HOT COIN: was this coin already busy BEFORE we bought? "Busy" =
#      how many rushes (taken or skipped, any run) the same pool had in the
#      previous 60 minutes. Only information we had at the time is used.
#   2. NIGHT ONLY: trades between 8 PM and 8 AM Toronto vs daytime.
#
#   For each group: trades, win rate, net, $ per trade, how many separate
#   coins, and the net WITHOUT the 3 best coins (so one lucky coin can't
#   fake a result), plus how many runs were positive.
#
#   Needs paper-out/pool_births.json (made by pool-age-study.py).
#   Usage: python3 hot-night-study.py paper-out
# ============================================================================
import bisect
import collections
import glob
import json
import os
import sys
from datetime import datetime, timedelta, timezone

BLOCK_S = 0.105
MIN_AGE_S = 7200            # the live 2-hour rule
HOUR_BLOCKS = int(3600 / BLOCK_S)


def toronto_hour(ms):
    # Toronto is UTC-5 in November (no daylight saving).
    return (datetime.fromtimestamp(ms / 1000, timezone.utc) - timedelta(hours=5)).hour


def jsonl(path):
    out = []
    if os.path.exists(path):
        for line in open(path):
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def summary(label, rows):
    """rows: dicts with pnl, token, run."""
    n = len(rows)
    if not n:
        print(f"  {label:34} trades    0")
        return
    net = sum(r["pnl"] for r in rows)
    wins = sum(1 for r in rows if r["pnl"] > 0)
    by_coin = collections.Counter()
    by_run = collections.Counter()
    for r in rows:
        by_coin[r["token"]] += r["pnl"]
        by_run[r["run"]] += r["pnl"]
    top3 = sum(p for _, p in by_coin.most_common(3))
    pos_runs = sum(1 for v in by_run.values() if v > 0)
    print(f"  {label:34} trades {n:4d} | wins {100 * wins / n:3.0f}% | net {net:8.2f} | "
          f"$/trade {net / n:6.3f} | coins {len(by_coin):3d} | w/o top 3 coins {net - top3:8.2f} | "
          f"runs + {pos_runs}/{len(by_run)}")


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "paper-out"
    births = json.load(open(os.path.join(root, "pool_births.json")))

    # Every rush (taken or skipped) per pool, by block, across all runs.
    rush_blocks = collections.defaultdict(list)
    trades = []
    for d in sorted(glob.glob(os.path.join(root, "run*"))):
        run = os.path.basename(d)
        entries = {}
        for s in jsonl(os.path.join(d, "signals.jsonl")):
            if not s.get("block") or not s.get("pool"):
                continue
            rush_blocks[s["pool"].lower()].append(s["block"])
            if s.get("taken"):
                entries[s["pool"]] = s["block"]
        for t in jsonl(os.path.join(d, "paper_trades.jsonl")):
            if "wall_ms" not in t:
                continue  # rugs and side records (rugs are all < 1 h old anyway)
            blk = entries.get(t.get("pool"))
            b = births.get((t.get("pool") or "").lower())
            if blk is None or not isinstance(b, int):
                continue
            if (blk - b) * BLOCK_S < MIN_AGE_S:
                continue  # the live 2-hour rule would have skipped it
            trades.append({"pool": t["pool"].lower(), "token": t.get("token"), "run": run,
                           "pnl": t.get("net_usd", 0.0), "block": blk, "hour": toronto_hour(t["wall_ms"])})
    for v in rush_blocks.values():
        v.sort()

    for t in trades:
        bl = rush_blocks[t["pool"]]
        # rushes in the hour BEFORE this entry (not counting this one)
        lo = bisect.bisect_left(bl, t["block"] - HOUR_BLOCKS)
        hi = bisect.bisect_left(bl, t["block"])
        t["prior"] = hi - lo
        t["night"] = t["hour"] >= 20 or t["hour"] < 8

    print(f"trades allowed by the 2-hour rule: {len(trades)}\n")
    summary("ALL (2-hour rule)", trades)

    print("\n1. HOT COIN: rushes on this pool in the hour before we bought")
    for lo_, hi_, name in [(0, 0, "0 (first rush)"), (1, 2, "1-2"), (3, 5, "3-5"), (6, 10, "6-10"), (11, 25, "11-25"), (26, 10**9, "26+")]:
        summary(name, [t for t in trades if lo_ <= t["prior"] <= hi_])
    print("  what if we required at least N prior rushes:")
    for n in [1, 3, 6, 11]:
        summary(f"  >= {n}", [t for t in trades if t["prior"] >= n])

    print("\n2. TIME OF DAY (Toronto)")
    summary("night 8 PM - 8 AM", [t for t in trades if t["night"]])
    summary("day 8 AM - 8 PM", [t for t in trades if not t["night"]])
    for a, b in [(20, 24), (0, 4), (4, 8), (8, 12), (12, 16), (16, 20)]:
        summary(f"  {a:02d}:00-{b:02d}:00", [t for t in trades if a <= t["hour"] < b])

    print("\n3. COMBINED: night AND hot coin")
    for n in [1, 3, 6]:
        summary(f"night + >= {n} prior rushes", [t for t in trades if t["night"] and t["prior"] >= n])


if __name__ == "__main__":
    main()
