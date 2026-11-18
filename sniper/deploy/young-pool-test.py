#!/usr/bin/env python3
# ============================================================================
# YOUNG POOL TEST: what would the 2-hour rug rule have let us make if it
# were 1 hour (or shorter)?
#
# Plain English:
#   The paper trader skips every rush on a pool younger than 2 hours
#   ("pool too young" in signals.jsonl). This replays those skipped V3
#   rushes with REAL past prices from the archive node, exactly like the
#   paper trader would have traded them:
#     - buy $50 at the rush block (+ an optional delay in blocks)
#     - check the sale price every ~1 s (10 blocks)
#     - sell at +5% profit, -5% stop, or after 60 s
#     - one position per pool at a time (rushes during a trade are ignored)
#     - skip-first-rush rule applied (needs another rush on that pool in
#       the hour before), like the live settings
#   A RUG = the sale quote stops working until the end of the hold (pool
#   drained) or comes back at less than half: counted as the full loss.
#   Results grouped by pool age: <15 min, 15-30, 30-60, 60-120 min.
#
#   Not modelled (so real results would be a bit lower): the trap check
#   (taxed tokens), "already jumped", "no sell history", 3-position cap.
#   Read-only. No transactions. Node: SNIPER_RHC_HTTP. URL never printed.
#   Usage: python3 -I young-pool-test.py paper-out/run10 [delay_blocks=0] [max_per_band=250]
# ============================================================================
import json
import os
import re
import sys
import time
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

RPC = os.environ.get("SNIPER_RHC_HTTP", "")
QUOTER = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7"   # Uniswap QuoterV2
SEL = "c6a5026a"                                         # quoteExactInputSingle
WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"
USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
USD = 50.0
STEP, HOLD = 10, 571          # 1 s checks, 60 s hold (0.105 s blocks)
TP, SL = 0.05, 0.05
HOUR_BLOCKS = 34286           # 1 h in blocks
BANDS = [(0, 900, "<15 min"), (900, 1800, "15-30 min"), (1800, 3600, "30-60 min"), (3600, 7200, "60-120 min")]
calls = 0


def rpc(method, params):
    """One node request with a few retries."""
    global calls
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
    last = None
    for attempt in range(3):
        try:
            calls += 1
            with urllib.request.urlopen(req, timeout=60) as r:
                v = json.loads(r.read())
            if "error" in v:
                raise ValueError(str(v["error"])[:120])
            return v["result"]
        except OSError as e:
            last = e
            time.sleep(1 + attempt)
    raise last


def w(a):
    return a[2:].lower().rjust(64, "0")


def quote(tin, tout, fee, amount, block):
    """Real QuoterV2 answer at a past block; None if it can't be quoted."""
    data = "0x" + SEL + w(tin) + w(tout) + format(amount, "064x") + format(fee, "064x") + "0" * 64
    try:
        r = rpc("eth_call", [{"to": QUOTER, "data": data}, hex(block)])
        return int(r[2:66], 16) if r and len(r) >= 66 else None
    except (ValueError, OSError):
        return None


def pool_info(pool):
    """(base address, fee) for a V3 pool, or None if it isn't WETH/USDG based."""
    try:
        t0 = "0x" + rpc("eth_call", [{"to": pool, "data": "0x0dfe1681"}, "latest"])[-40:]
        t1 = "0x" + rpc("eth_call", [{"to": pool, "data": "0xd21220a7"}, "latest"])[-40:]
        fee = int(rpc("eth_call", [{"to": pool, "data": "0xddca3f43"}, "latest"]), 16)
    except (ValueError, OSError, TypeError):
        return None
    for base in (WETH, USDG):
        if base in (t0.lower(), t1.lower()):
            return base, fee
    return None


def replay(t, delay):
    """(net USD, exit reason) for one simulated trade, or None if no entry."""
    entry = t["block"] + delay
    toks = quote(t["base"], t["token"], t["fee"], t["base_in"], entry)
    if not toks:
        return None
    last, fails = None, 0
    for k in range(1, HOLD // STEP + 1):
        back = quote(t["token"], t["base"], t["fee"], toks, entry + k * STEP)
        if back is None:
            fails += 1
            continue
        fails = 0
        net = back / t["base_in"] - 1
        last = net
        if net >= TP:
            return net * USD, "take_profit"
        if net <= -0.5:
            return net * USD, "RUG"
        if net <= -SL:
            return net * USD, "stop_loss"
    if last is None or fails >= 5:
        return -USD, "RUG"
    return last * USD, "time"


def main():
    out = sys.argv[1]
    delay = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    cap = int(sys.argv[3]) if len(sys.argv) > 3 else 250
    if not RPC:
        sys.exit("set SNIPER_RHC_HTTP")
    sig = []
    for line in open(os.path.join(out, "signals.jsonl")):
        try:
            sig.append(json.loads(line))
        except ValueError:
            pass
    # Every rush per pool (any venue, traded or not), for the first-rush rule.
    rushes = defaultdict(list)
    for s in sig:
        if s.get("pool") and s.get("block"):
            rushes[s["pool"].lower()].append(s["block"])
    # Skipped young V3 rushes, in order; one open position per pool.
    cands, busy_until = [], {}
    for s in sig:
        if s.get("venue") != "v3":
            continue
        m = re.match(r"pool too young \((\d+)s old", s.get("why") or "")
        if not m:
            continue
        pool, b, age = s["pool"].lower(), s["block"], int(m.group(1))
        if busy_until.get(pool, 0) > b:
            continue
        if not any(b - HOUR_BLOCKS <= x < b for x in rushes[pool]):
            continue  # first rush in an hour: the live rules skip it
        busy_until[pool] = b + HOLD
        cands.append({"pool": pool, "token": s["token"].lower(), "block": b, "age": age})
    # Keep the newest `cap` per band (keeps node use bounded).
    per = defaultdict(list)
    for c in cands:
        for lo, hi, name in BANDS:
            if lo <= c["age"] < hi:
                per[name].append(c)
    picked = [c for name in per for c in per[name][-cap:]]
    print(f"young V3 rushes that pass skip-first-rush: {len(cands)} | replaying {len(picked)} (delay {delay} blocks)", flush=True)
    # Pool facts and WETH price (today's, for sizing).
    infos = {}
    with ThreadPoolExecutor(8) as ex:
        for p, i in zip(sorted({c["pool"] for c in picked}), ex.map(pool_info, sorted({c["pool"] for c in picked}))):
            infos[p] = i
    head = int(rpc("eth_blockNumber", []), 16)
    eth = (quote(WETH, USDG, 500, 10**18, head) or 0) / 1e6
    if eth <= 0:
        sys.exit("could not price ETH")
    todo = []
    for c in picked:
        i = infos.get(c["pool"])
        if not i:
            continue
        c["base"], c["fee"] = i
        c["base_in"] = int(USD / eth * 1e18) if c["base"] == WETH else int(USD * 1e6)
        todo.append(c)
    with ThreadPoolExecutor(8) as ex:
        res = list(ex.map(lambda t: replay(t, delay), todo))
    agg = defaultdict(lambda: [0, 0, 0.0, 0, 0.0])  # trades, wins, $, rugs, $ without rugs
    coins = defaultdict(lambda: defaultdict(float))
    for t, r in zip(todo, res):
        if r is None:
            continue
        net, why = r
        name = next(n for lo, hi, n in BANDS if lo <= t["age"] < hi)
        a = agg[name]
        a[0] += 1
        a[1] += net > 0
        a[2] += net
        if why == "RUG":
            a[3] += 1
        else:
            a[4] += net
        coins[name][t["token"][:10]] += net
    print(f"\nYOUNG POOL TEST | ${USD:.0f} trades | ETH ${eth:,.0f} | node requests {calls}")
    print(f"{'pool age':<11} {'trades':>6} {'wins':>5} {'total $':>9} {'rugs':>5} {'$ w/o rugs':>10}  top coins")
    for _, _, name in BANDS:
        a = agg.get(name)
        if not a or not a[0]:
            print(f"{name:<11} {0:>6}")
            continue
        top = sorted(coins[name].items(), key=lambda x: -abs(x[1]))[:3]
        tops = ", ".join(f"{k} {v:+.0f}" for k, v in top)
        print(f"{name:<11} {a[0]:>6} {100*a[1]/a[0]:>4.0f}% {a[2]:>+9.2f} {a[3]:>5} {a[4]:>+10.2f}  {tops}")


if __name__ == "__main__":
    main()
