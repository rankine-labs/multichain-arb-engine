#!/usr/bin/env python3
# ============================================================================
# plan-projection.py: what would live have made, day by day, with the plan?
# Read-only. Uses recorded paper trades, scaled to live sizes.
#
# Plan modelled:
#   Main strategy  $10 a trade (paper traded $100, so x0.1), V3 10-min
#                  stop-loss cooldown on. Daily stop like live: no new buy once
#                  the day's loss + one trade would pass $20 (= stops at -$10).
#   Young V4       pools under 15 min old, V4 only, $3 a trade (paper $50, so
#                  x0.06). Own loss budget: stops once a new trade could pass
#                  -$9 for the day (= after about two rugs).
#   Rugs are counted at their full paper loss. Live's one-position limit is
#   NOT modelled (overlapping trades all count), so this is an upper bound
#   on trade count.
#
# Usage (from ~/sniper-bin):
#   python3 -I plan-projection.py
# ============================================================================
import collections
import datetime
import importlib.util
import os


def mod(name):
    """Load one of the sibling research scripts as a module."""
    p = os.path.expanduser(f"~/{name}.py")
    s = importlib.util.spec_from_file_location(name.replace("-", "_"), p)
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


ss = mod("stop-streak-test")
yp = mod("young-pool-research")


def day_of(block):
    ts = ss.REF_UNIX + (block - ss.REF_BLOCK) * ss.BLOCK_S + ss.TZ_OFF
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%m-%d %a")


def capped(trades, scale, size, cap):
    """Day by day, in order, apply the live-style daily stop. Returns
    {day: (taken, net, skipped_by_cap)}."""
    out = collections.defaultdict(lambda: [0, 0.0, 0])
    for t in trades:
        d = day_of(t["_blk"])
        a = out[d]
        if -min(a[1], 0.0) + size > cap:
            a[2] += 1
            continue
        a[0] += 1
        a[1] += t["net_usd"] * scale
    return out


def main():
    main_tr = ss.replay(ss.load(["paper-out/run14", "paper-out/live1"]))
    for t in main_tr:
        t["_blk"] = t["open_block"]
    young = [t for t in yp.load("paper-out")
             if t["_run"] in ("run14", "live1") and t.get("venue") == "v4" and (t.get("pool_age_s") or 9e9) < 900]
    # Rug rows have no open_block: place them at the block of the run's
    # previous young trade (good enough for day bucketing).
    last = 0
    for t in young:
        last = t.get("open_block") or last
        t["_blk"] = last
    young.sort(key=lambda t: t["_blk"])
    young = [t for t in young if t["_blk"]]

    M = capped(main_tr, 0.1, 10.0, 20.0)
    Y = capped(young, 0.06, 3.0, 9.0)
    days = sorted(set(M) | set(Y))
    print(f"{'day':10s} | {'main $10':>22s} | {'young V4 $3':>24s} | {'total':>8s}")
    tm = ty = 0.0
    for d in days:
        m, y = M.get(d, [0, 0.0, 0]), Y.get(d, [0, 0.0, 0])
        tm += m[1]
        ty += y[1]
        print(f"{d:10s} | {m[0]:4d} tr {m[1]:+7.2f} (cap skip {m[2]:3d}) | {y[0]:4d} tr {y[1]:+7.2f} (cap skip {y[2]:3d}) | {m[1]+y[1]:+8.2f}")
    print(f"{'TOTAL':10s} | {'':6s}{tm:+8.2f}{'':14s} | {'':6s}{ty:+8.2f}{'':16s} | {tm+ty:+8.2f}")
    rugs = sum(1 for t in young if t["_rug"])
    print(f"young V4 rugs in period: {rugs} (x $3 each)")


if __name__ == "__main__":
    main()
