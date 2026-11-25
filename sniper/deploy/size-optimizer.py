#!/usr/bin/env python3
# ============================================================================
# size-optimizer.py: what trade size makes the most money without letting a
# rug (or a bad streak) do serious damage? Read-only research.
#
# Plain English:
#   Every paper trade also records what the SAME trade would have netted at
#   $25, $50 and $100 (the "ladder" rows: real sell quotes, so bigger sizes
#   pay their extra price impact). Rugs count as a total loss at every size.
#   This script:
#     1. Loads 7 days of those ladder rows (main strategy + young V4 pools
#        under 15 min), in time order.
#     2. Works out each group's Kelly fraction: the share of the bankroll per
#        trade that grows money fastest given the real win/loss/rug mix.
#        We never bet full Kelly (too wild); we test fractions of it.
#     3. Replays the 7 days with a starting bankroll and many sizing rules
#        (fixed $ sizes, and % of current bankroll with caps), applying a
#        live-style daily loss stop, and reports: final bankroll, profit,
#        worst drawdown, worst day, biggest single loss.
#   Limits: paper can hold overlapping trades, live holds one, so trade
#   counts here are an upper bound. Use for COMPARING rules, not as a forecast.
#
# Usage (from ~/sniper-bin):
#   python3 -I size-optimizer.py [start_bankroll_usd]
# ============================================================================
import collections
import glob
import json
import math
import os
import sys

RUNS = ("run12", "run13", "run14", "live1")     # Nov 18 .. Nov 25 (about 7 days)
REF_BLOCK, REF_UNIX, BLOCK_S, TZ = 121975155, 1795496358, 0.11426, -5 * 3600
SIZES = (25.0, 50.0, 100.0)


def day_of(block):
    import datetime
    return datetime.datetime.fromtimestamp(REF_UNIX + (block - REF_BLOCK) * BLOCK_S + TZ,
                                           datetime.timezone.utc).strftime("%m-%d")


def load():
    """Ladder rows -> trades with a return curve over size. Groups:
    'main v3', 'main v4' (normal strategy) and 'young v4' (V4 pools < 15 min)."""
    out, seen = [], set()
    for d in sorted(glob.glob("paper-out/*")):
        if os.path.basename(d) not in RUNS:
            continue
        p = os.path.join(d, "paper_trades.jsonl")
        if not os.path.exists(p):
            continue
        last_block = 0
        for line in open(p):
            try:
                t = json.loads(line)
            except ValueError:
                continue
            if t.get("open_block"):
                last_block = t["open_block"]
            if "ladder_for" not in t:
                continue
            young = t.get("group") == "young"
            v = t.get("venue")
            if young and not (v == "v4" and (t.get("pool_age_s") or 9e9) < 900):
                continue
            if v not in ("v3", "v4"):
                continue
            blk = t.get("open_block") or last_block
            key = (t["ladder_for"], blk, young)
            if key in seen or not blk:
                continue
            seen.add(key)
            pts = {float(x["usd"]): x["net"] for x in t.get("ladder") or [] if isinstance(x.get("net"), (int, float))}
            if not all(s in pts for s in SIZES):
                continue
            ret = {s: pts[s] / s for s in SIZES}            # return as a fraction of stake
            rug = ret[25.0] <= -0.5
            out.append({"blk": blk, "day": day_of(blk), "group": ("young " if young else "main ") + v,
                        "ret": ret, "rug": rug})
    out.sort(key=lambda t: t["blk"])
    return out


def ret_at(t, size):
    """Return fraction at any size: flat below $25, straight lines between the
    ladder points, and the $50->$100 slope continued above $100 (pessimistic)."""
    r = t["ret"]
    if size <= 25:
        return r[25.0]
    if size <= 50:
        return r[25.0] + (r[50.0] - r[25.0]) * (size - 25) / 25
    if size <= 100:
        return r[50.0] + (r[100.0] - r[50.0]) * (size - 50) / 50
    return r[100.0] + (r[100.0] - r[50.0]) * (size - 100) / 50


def kelly(rets):
    """Fraction of bankroll per trade that maximises average log growth."""
    best, bf = -1e9, 0.0
    for i in range(1, 400):
        f = i / 400
        if any(1 + f * r <= 0 for r in rets):
            break
        g = sum(math.log(1 + f * r) for r in rets) / len(rets)
        if g > best:
            best, bf = g, f
    return bf


def replay(trades, start, rule, day_cap_frac=0.10):
    """rule(group, bankroll) -> $ size (0 = skip). Daily stop: no new trade
    once the day's realised loss + this size would pass day_cap_frac x the
    bankroll at the start of that day."""
    b, peak, mdd = start, start, 0.0
    day, day_start, day_pnl = None, start, 0.0
    worst_day, big_loss, n, rugs = 0.0, 0.0, 0, 0
    days = collections.defaultdict(float)
    for t in trades:
        if t["day"] != day:
            if day is not None:
                worst_day = min(worst_day, day_pnl)
            day, day_start, day_pnl = t["day"], b, 0.0
        s = rule(t["group"], b)
        if s <= 0 or s > b:
            continue
        if -min(day_pnl, 0.0) + s > day_cap_frac * day_start:
            continue
        pnl = s * max(ret_at(t, s), -1.0)
        b += pnl
        day_pnl += pnl
        days[day] += pnl
        n += 1
        rugs += t["rug"]
        big_loss = min(big_loss, pnl)
        peak = max(peak, b)
        mdd = max(mdd, (peak - b) / peak)
    worst_day = min(worst_day, day_pnl)
    return {"final": b, "profit": b - start, "mdd": mdd, "worst_day": worst_day,
            "big_loss": big_loss, "n": n, "rugs": rugs, "days": dict(days)}


def show(name, r, start):
    print(f"  {name:44s} profit ${r['profit']:+9.2f} ({100*r['profit']/start:+6.0f}%) | worst drawdown {100*r['mdd']:4.1f}% "
          f"| worst day ${r['worst_day']:+7.2f} | biggest loss ${r['big_loss']:+7.2f} | {r['n']} trades, {r['rugs']} rugs")


def main():
    start = float(sys.argv[1]) if len(sys.argv) > 1 else 75.0
    T = load()
    by = collections.defaultdict(list)
    for t in T:
        by[t["group"]].append(t)
    print(f"{len(T)} trades with size data, {T[0]['day']} .. {T[-1]['day']}, start bankroll ${start:.0f}\n")
    print("== Per group: average return by size, rug rate, Kelly fraction ==")
    K = {}
    for g, ts in sorted(by.items()):
        avg = {s: sum(ret_at(t, s) for t in ts) / len(ts) for s in SIZES}
        K[g] = kelly([ret_at(t, 25.0) for t in ts])
        print(f"  {g:9s} {len(ts):5d} trades | rugs {sum(t['rug'] for t in ts):3d} | avg return "
              + " ".join(f"${s:.0f}:{100*avg[s]:+.2f}%" for s in SIZES) + f" | Kelly {100*K[g]:.1f}% of bankroll")

    print("\n== Fixed sizes (daily stop at 10% of the day's starting bankroll) ==")
    for main_s, young_s in ((10, 0), (10, 3), (25, 0), (25, 5), (50, 0), (50, 10), (100, 0)):
        rule = lambda g, b, m=main_s, y=young_s: y if g.startswith("young") else m
        show(f"main ${main_s}, young V4 ${young_s}", replay(T, start, rule), start)

    print("\n== % of current bankroll (compounding), capped by size and liquidity ==")
    best = None
    for frac_k in (0.25, 0.5):
        for cap in (25, 50, 100):
            for day_cap in (0.10, 0.20):
                def rule(g, b, fk=frac_k, c=cap):
                    s = min(fk * K[g] * b, c)
                    return s if s >= 2 else 0
                r = replay(T, start, rule, day_cap)
                show(f"{frac_k:.2f}x Kelly, max ${cap}, day stop {int(day_cap*100)}%", r, start)
                # Best = most profit with worst drawdown <= 15% and no single loss > 10% of start
                if r["mdd"] <= 0.15 and -r["big_loss"] <= 0.10 * start and (best is None or r["profit"] > best[1]["profit"]):
                    best = (f"{frac_k:.2f}x Kelly, max ${cap}, day stop {int(day_cap*100)}%", r)
    if best:
        print(f"\nBEST within limits (drawdown <= 15%, no single loss > 10% of start): {best[0]}")
        show("  ->", best[1], start)
        print("  by day: " + " | ".join(f"{d} ${v:+.2f}" for d, v in sorted(best[1]["days"].items())))


if __name__ == "__main__":
    main()
