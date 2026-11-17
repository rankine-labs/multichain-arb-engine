#!/usr/bin/env python3
# ============================================================================
# DELAY TEST: how much profit do we lose for each block we land late?
#
# Plain English:
#   Takes every real Uniswap V3 paper trade of a run (the bot's actual
#   picks under the live rules) and replays it as if our buy had landed
#   0, 2, 5, 10 or 20 blocks after the rush (1 block = ~0.1 s).
#   For each delay:
#     - buy: a real QuoterV2 quote at that exact past block, same money in,
#     - sell: a real sale quote every ~1 s after that, using the live exit
#       rules: +5% net take profit, -5% net stop, or after 60 s.
#   Quotes are run on the archive node AT the past block, so they show the
#   prices that truly existed then (other bots' buys included).
#
#   Output: total and per-trade profit for each delay, so we can see whether
#   being faster is worth building.
#
#   Limits: a quote is not a fill (our own buy's effect on later sale quotes
#   is ignored, same as paper); gas is ignored (cents here); trades whose
#   pool can't be quoted at some block count as unfillable at that delay.
#   Simulated dollars, for comparison between delays.
#
#   Read-only. Node: SNIPER_RHC_HTTP (never printed).
#   Usage: python3 -I delay-test.py paper-out/run10 [max_trades=0 (all)]
# ============================================================================
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

RPC = os.environ.get("SNIPER_RHC_HTTP", "")
QUOTER = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7"   # Uniswap QuoterV2 on Robinhood Chain
SEL = "c6a5026a"                                         # quoteExactInputSingle((...))
BASES = {"WETH": "0x0bd7d308f8e1639fab988df18a8011f41eacad73", "USDG": "0x5fc5360d0400a0fd4f2af552add042d716f1d168"}
DELAYS = [0, 2, 5, 10, 20]
STEP = 10            # check the sale price every ~1 s (10 blocks)
HOLD = 600           # 60 s
TP, SL = 0.05, 0.05
calls = 0


def rpc(method, params):
    global calls
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
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


def quote(tin, tout, fee, amount, block):
    """Real QuoterV2 answer at a past block; None if the pool can't be quoted."""
    w = lambda a: a[2:].lower().rjust(64, "0")  # noqa: E731
    data = "0x" + SEL + w(tin) + w(tout) + format(amount, "064x") + format(fee, "064x") + "0" * 64
    try:
        r = rpc("eth_call", [{"to": QUOTER, "data": data}, hex(block)])
        return int(r[2:66], 16) if r and len(r) >= 66 else None
    except (ValueError, OSError):
        return None


def jsonl(path):
    out = []
    if os.path.exists(path):
        for line in open(path):
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def replay(t, delay):
    """Net USD of one trade if our buy landed `delay` blocks after the rush."""
    entry = t["rush_block"] + delay
    toks = quote(t["base_addr"], t["token"], t["fee"], t["base_in"], entry)
    if not toks:
        return None
    last = None
    for k in range(1, HOLD // STEP + 1):
        back = quote(t["token"], t["base_addr"], t["fee"], toks, entry + k * STEP)
        if back is None:
            continue
        net = back / t["base_in"] - 1
        last = net
        if net >= TP or net <= -SL:
            break
    return None if last is None else last * t["usd_in"]


def main():
    run = sys.argv[1] if len(sys.argv) > 1 else "paper-out/run10"
    cap = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    rush = {}
    for s in jsonl(os.path.join(run, "signals.jsonl")):
        if s.get("taken") and s.get("venue") == "v3" and s.get("block"):
            rush.setdefault(s["pool"], []).append(s["block"])
    trades = []
    for t in jsonl(os.path.join(run, "paper_trades.jsonl")):
        if t.get("venue") != "v3" or "wall_ms" not in t or t.get("base") not in BASES:
            continue
        ob = t.get("open_block")
        if not ob:
            continue
        trades.append({"pool": t["pool"], "token": t["token"], "base_addr": BASES[t["base"]], "rush_block": ob,
                       "base_in": int(t["base_in"]), "usd_in": t["usd_in"], "paper": t.get("net_usd", 0.0)})
    if cap:
        trades = trades[:cap]
    # V3 fee tier of each pool
    pools = {t["pool"] for t in trades}
    fees = {}
    for p in pools:
        try:
            fees[p] = int(rpc("eth_call", [{"to": p, "data": "0xddca3f43"}, "latest"]), 16)
        except (ValueError, OSError):
            fees[p] = None
    trades = [dict(t, fee=fees[t["pool"]]) for t in trades if fees.get(t["pool"])]
    print(f"delay-test: {len(trades)} V3 trades from {run}", file=sys.stderr)

    results = {d: [] for d in DELAYS}
    t0 = time.time()
    for d in DELAYS:
        with ThreadPoolExecutor(8) as ex:
            results[d] = list(ex.map(lambda t: replay(t, d), trades))
        print(f"  delay {d:2d} done | requests {calls} | {time.time() - t0:.0f}s", file=sys.stderr)

    paper = sum(t["paper"] for t in trades)
    print(f"\nDELAY TEST: {len(trades)} real V3 paper trades from {run} | node requests {calls}")
    print(f"paper's own result for these trades: ${paper:+.2f}\n")
    print(f"{'landed after rush':22} {'trades':>6} {'wins':>5} {'total $':>9} {'$/trade':>8} {'vs 0 blocks':>11}")
    base_total = None
    for d in DELAYS:
        r = [x for x in results[d] if x is not None]
        tot = sum(r)
        if base_total is None:
            base_total = tot
        wins = sum(1 for x in r if x > 0)
        keep = f"{100 * tot / base_total:5.0f}%" if base_total else "   n/a"
        print(f"{d:2d} blocks (~{d * 0.1:.1f} s)      {len(r):6d} {100 * wins / max(1, len(r)):4.0f}% {tot:9.2f} {tot / max(1, len(r)):8.3f} {keep:>11}")


if __name__ == "__main__":
    main()
