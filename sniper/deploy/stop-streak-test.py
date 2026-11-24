#!/usr/bin/env python3
# ============================================================================
# stop-streak-test.py: would a "too many stop-losses on one coin" rule have
# helped? Read-only backtest on recorded paper trades.
#
# Plain English:
#   Reads every main-group paper trade (young test excluded) from the run
#   folders given, de-duplicates, orders them by open block, then replays
#   them with a rule:
#       after K stop-losses on the same coin within W minutes,
#       skip that coin for B minutes.
#   Skipped trades simply don't happen (their profit/loss is removed).
#   Also replays the V3 10-minute cooldown we already shipped, so results
#   are comparable to what live would do now.
#   Prints totals per venue, per day, and the worst day, for each variant.
#
# Usage (from ~/sniper-bin):
#   python3 -I stop-streak-test.py paper-out/run14 paper-out/live1
# ============================================================================
import collections
import json
import os
import sys

BLOCK_S = 0.11426          # measured Robinhood Chain seconds per block
REF_BLOCK = 121975155      # block at 2026-11-24 04:59:18 UTC (from the wallet export)
REF_UNIX = 1795496358      # same moment as unix seconds
TZ_OFF = -5 * 3600         # Toronto


def load(dirs):
    """All closed main-group paper trades from the run folders, de-duplicated."""
    seen, out = set(), []
    for d in dirs:
        p = os.path.join(d, "paper_trades.jsonl")
        if not os.path.exists(p):
            continue
        for line in open(p):
            try:
                t = json.loads(line)
            except ValueError:
                continue
            if "net_usd" not in t or "open_block" not in t or t.get("group") == "young":
                continue
            key = (t["open_block"], (t.get("token") or "").lower())
            if key in seen:
                continue
            seen.add(key)
            t["_close"] = t.get("close_block") or t["open_block"]
            out.append(t)
    out.sort(key=lambda t: t["open_block"])
    return out


def day_of(block):
    """Local (Toronto) calendar day label for a block."""
    import datetime
    ts = REF_UNIX + (block - REF_BLOCK) * BLOCK_S + TZ_OFF
    return datetime.datetime.utcfromtimestamp(ts).strftime("%a %b %d")


def replay(trades, k=0, win_min=0, block_min=0, venues=("v3", "v4"), v3_cool_min=10):
    """Replay with the streak rule (k=0 = off) and the V3 cooldown.
    Returns the kept trades."""
    win_b = win_min * 60 / BLOCK_S
    blk_b = block_min * 60 / BLOCK_S
    cool_b = v3_cool_min * 60 / BLOCK_S
    stops = collections.defaultdict(list)   # coin -> close blocks of its stop-losses (kept trades only)
    banned_until = {}                       # coin -> block until which it is skipped
    last_stop = {}                          # coin -> close block of last stop (for V3 cooldown)
    kept = []
    for t in trades:
        coin = (t.get("token") or "").lower()
        b = t["open_block"]
        v = t.get("venue")
        if banned_until.get(coin, -1) > b:
            continue
        if v == "v3" and cool_b and coin in last_stop and b - last_stop[coin] < cool_b:
            continue
        kept.append(t)
        if t.get("reason") == "stop_loss":
            last_stop[coin] = t["_close"]
            if k and v in venues:
                s = [x for x in stops[coin] if t["_close"] - x < win_b] + [t["_close"]]
                stops[coin] = s
                if len(s) >= k:
                    banned_until[coin] = t["_close"] + blk_b
                    stops[coin] = []
    return kept


def summary(name, kept):
    by_v = collections.defaultdict(lambda: [0, 0.0])
    by_d = collections.defaultdict(float)
    for t in kept:
        a = by_v[t.get("venue")]
        a[0] += 1
        a[1] += t["net_usd"]
        by_d[day_of(t["open_block"])] += t["net_usd"]
    tot = sum(a[1] for a in by_v.values())
    days = [by_d[d] for d in sorted(by_d, key=lambda s: s[4:])]
    v3, v4 = by_v.get("v3", [0, 0.0]), by_v.get("v4", [0, 0.0])
    print(f"{name:34s} total {tot:+8.0f} | v3 {v3[0]:4d} {v3[1]:+7.0f} | v4 {v4[0]:4d} {v4[1]:+7.0f} | "
          f"worst day {min(days):+6.0f} | days " + " ".join(f"{x:+.0f}" for x in days))


def main():
    trades = load(sys.argv[1:] or ["paper-out/run14", "paper-out/live1"])
    print(f"{len(trades)} trades, blocks {trades[0]['open_block']}..{trades[-1]['open_block']}")
    summary("no rules (old)", replay(trades, v3_cool_min=0))
    summary("V3 cooldown only (now)", replay(trades))
    for venues in (("v3", "v4"), ("v4",)):
        for k in (2, 3, 4):
            for win in (30, 60):
                for blk in (30, 60, 120):
                    summary(f"+{k} stops/{win}m -> {blk}m off {'/'.join(venues)}",
                            replay(trades, k, win, blk, venues))


if __name__ == "__main__":
    main()
