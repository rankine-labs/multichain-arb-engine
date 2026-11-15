#!/usr/bin/env python3
# ============================================================================
# DAYTIME STUDY: why do busy daytime hours lose money?
#
# Plain English:
#   Compares day (8 AM-4 PM Toronto) with night (8 PM-8 AM) on the same
#   rules, using every paper trade from the run folders given, plus the
#   3-day chain replay if present:
#     1. how trades end (take profit / stop loss / time), average win and
#        loss, how fast losers fall
#     2. rushes per hour and how many we take
#     3. which coins: is daytime spread over different coins, or the same
#        coins behaving differently?
#     4. who sends the rush buys (the contract each buy transaction calls):
#        are daytime rushes driven by different players?
#     5. what happens after the rush: price move at exit, for wins vs losses
#   Read-only. Node (for step 4): SNIPER_RHC_HTTP.
#   Usage: python3 deploy/daytime.py paper-out/run5 paper-out/run6 [replay.json]
# ============================================================================
import json
import os
import sys
import time
import urllib.request
from collections import Counter, defaultdict

RPC = os.environ.get("SNIPER_RHC_HTTP", "")
SWAP_V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        v = json.loads(r.read())
    if "error" in v:
        raise RuntimeError(str(v["error"])[:120])
    return v["result"]


def lines(p):
    out = []
    try:
        for l in open(p):
            try:
                out.append(json.loads(l))
            except ValueError:
                pass
    except FileNotFoundError:
        pass
    return out


def hour_of(ms):
    return time.gmtime(ms / 1000 - 5 * 3600).tm_hour


def period(h):
    if 8 <= h < 16:
        return "DAY (8a-4p)"
    if 16 <= h < 20:
        return "EVENING (4p-8p)"
    return "NIGHT (8p-8a)"


def stats(ts, key="net_usd"):
    if not ts:
        return "no trades"
    n = len(ts)
    nets = [t[key] for t in ts]
    w = [x for x in nets if x > 0]
    l = [x for x in nets if x <= 0]
    ex = Counter(t.get("reason") or t.get("exit") for t in ts)
    tp = ex.get("take_profit", 0) * 100 / n
    sl = ex.get("stop_loss", 0) * 100 / n
    tm = ex.get("time", 0) * 100 / n
    return (f"{n:4d} trades | wins {100*len(w)/n:3.0f}% | avg win ${sum(w)/max(1,len(w)):+.2f} | avg loss ${sum(l)/max(1,len(l)):+.2f}"
            f" | total ${sum(nets):+8.2f} | exits TP {tp:.0f}% SL {sl:.0f}% time {tm:.0f}%")


def main():
    dirs = [a for a in sys.argv[1:] if os.path.isdir(a)]
    replay = next((a for a in sys.argv[1:] if a.endswith(".json")), None)
    trades, sigs = [], []
    for d in dirs:
        for r in lines(os.path.join(d, "paper_trades.jsonl")):
            if r.get("reason") and r.get("net_usd") is not None and r.get("wall_ms") and r["reason"] != "exit_quote_failed":
                trades.append(r)
        sigs += lines(os.path.join(d, "signals.jsonl"))
    for t in trades:
        t["period"] = period(hour_of(t["wall_ms"]))

    print("=" * 100)
    print("1. HOW TRADES END (paper runs, rugs left out)")
    by = defaultdict(list)
    for t in trades:
        by[t["period"]].append(t)
    for p in sorted(by):
        print(f"  {p:16s} {stats(by[p])}")
    for p in sorted(by):
        losers = [t for t in by[p] if t["net_usd"] <= 0 and t.get("held_s")]
        sls = [t["held_s"] for t in by[p] if t.get("reason") == "stop_loss" and t.get("held_s")]
        if sls:
            sls.sort()
            print(f"  {p:16s} stop losses hit after median {sls[len(sls)//2]:.1f}s (n={len(sls)})")

    if replay and os.path.exists(replay):
        print("\n   3-day chain replay, same split:")
        rt = json.load(open(replay))["trades"]
        rb = defaultdict(list)
        for t in rt:
            t["net_usd"] = t["net"]
            rb[period(time.gmtime(t["t"] - 5 * 3600).tm_hour)].append(t)
        for p in sorted(rb):
            print(f"  {p:16s} {stats(rb[p])}")

    print("\n2. RUSHES PER HOUR (signals) and how many we took")
    rush = defaultdict(lambda: [0, 0, set()])
    # signal lines have no wall time: borrow the block->time map from trades
    bt = sorted((t["open_block"], t["wall_ms"]) for t in trades if t.get("open_block"))
    def ms_of_block(b):
        if not bt:
            return None
        import bisect
        i = bisect.bisect_left(bt, (b, 0))
        i = min(max(i, 0), len(bt) - 1)
        b0, m0 = bt[i]
        return m0 + (b - b0) * 105
    hours_seen = defaultdict(set)
    for s in sigs:
        if "block" not in s:
            continue
        ms = ms_of_block(s["block"])
        if ms is None:
            continue
        p = period(hour_of(ms))
        rush[p][0] += 1
        rush[p][1] += bool(s.get("taken"))
        rush[p][2].add(s.get("token"))
        hours_seen[p].add(int(ms // 3_600_000))
    for p in sorted(rush):
        h = max(1, len(hours_seen[p]))
        print(f"  {p:16s} rushes {rush[p][0]:5d} ({rush[p][0]/h:.0f}/h) | taken {rush[p][1]} | different coins {len(rush[p][2])}")

    print("\n3. WHICH COINS (top 6 per period by trades, with their P&L)")
    for p in sorted(by):
        c = defaultdict(lambda: [0, 0.0])
        for t in by[p]:
            c[t["token"]][0] += 1
            c[t["token"]][1] += t["net_usd"]
        tot = len(by[p])
        top = sorted(c.items(), key=lambda kv: -kv[1][0])[:6]
        print(f"  {p}: {len(c)} coins; top 6 = {100*sum(v[0] for _, v in top)/tot:.0f}% of trades")
        for tok, (n, v) in top:
            # same coin in other periods
            other = {q: sum(t['net_usd'] for t in by[q] if t['token'] == tok) for q in by if q != p}
            o = ", ".join(f"{q.split()[0].lower()} ${v2:+.2f}" for q, v2 in other.items() if any(t['token'] == tok for t in by[q]))
            print(f"     {tok} {n:3d} trades ${v:+7.2f}" + (f"   (same coin {o})" if o else ""))

    print("\n4. WHO SENDS THE RUSH BUYS (contract each buy tx calls; V3 trades, up to 120 per period)")
    if not RPC:
        print("  (skipped: no SNIPER_RHC_HTTP)")
    else:
        for p in sorted(by):
            to_count, n_tx = Counter(), 0
            sample = [t for t in by[p] if t.get("open_block") and t.get("venue", "v3") == "v3"][:120]
            outcome = {"win": Counter(), "loss": Counter()}
            for t in sample:
                try:
                    logs = rpc("eth_getLogs", [{"address": t["pool"], "fromBlock": hex(t["open_block"] - 10), "toBlock": hex(t["open_block"]), "topics": [SWAP_V3]}])
                except Exception:
                    continue
                for h in list(dict.fromkeys(l["transactionHash"] for l in logs))[:8]:
                    try:
                        tx = rpc("eth_getTransactionByHash", [h])
                    except Exception:
                        continue
                    to = (tx.get("to") or "create").lower()
                    to_count[to] += 1
                    outcome["win" if t["net_usd"] > 0 else "loss"][to] += 1
                    n_tx += 1
            print(f"  {p}: {n_tx} rush buy txs from {len(sample)} trades")
            for to, n in to_count.most_common(6):
                w, l = outcome["win"][to], outcome["loss"][to]
                print(f"     {to} {100*n/max(1,n_tx):3.0f}% of buys | in winning trades {w}, losing {l}")

    print("\n5. AFTER THE RUSH: pool price move at exit (paper)")
    for p in sorted(by):
        mv_w = sorted(t["pool_move_pct"] for t in by[p] if t["net_usd"] > 0 and "pool_move_pct" in t)
        mv_l = sorted(t["pool_move_pct"] for t in by[p] if t["net_usd"] <= 0 and "pool_move_pct" in t)
        med = lambda xs: xs[len(xs) // 2] if xs else float("nan")
        print(f"  {p:16s} winners: median move {med(mv_w):+.1f}% | losers: median move {med(mv_l):+.1f}%")


if __name__ == "__main__":
    main()
