#!/usr/bin/env python3
# ============================================================================
# RUN ANALYSIS: who drove the rushes we traded, and what went wrong.
#
# Plain English:
#   For every closed paper trade in a run folder:
#     1. reads that pool's swaps in the ~1 s before our entry (1 request),
#     2. looks up each swap's transaction (who sent it, through which
#        contract): swaps sent through Uniswap's Universal Router (the
#        contract wallet apps and the Uniswap website use) count as PEOPLE;
#        anything else (custom contracts) counts as BOTS,
#     3. groups trades by the people share of their rush and prints P&L per
#        group.
#   Also lists every "exit_quote_failed" trade (counted as a total loss)
#   with the error, and tests whether the token can be sold NOW (a real
#   quoter sell of the pool's own amount), so we know if those were real
#   traps or quote glitches.
#
#   Read-only. Node: SNIPER_RHC_HTTP. Usage:
#     python3 deploy/run-analysis.py paper-out/run5
# ============================================================================
import json
import os
import sys
import urllib.request
from collections import defaultdict

RPC = os.environ.get("SNIPER_RHC_HTTP", "https://rpc.mainnet.chain.robinhood.com")
SWAP_V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
# Universal Router execute() selectors (with and without deadline)
UR_SELECTORS = {"0x3593564c", "0x24856bc3"}
WINDOW = 10  # blocks before entry (~1 s, the rush window)
calls = 0


def rpc(method, params):
    global calls
    calls += 1
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        v = json.loads(r.read())
    if "error" in v:
        raise RuntimeError(str(v["error"])[:150])
    return v["result"]


def lines(path):
    out = []
    try:
        for l in open(path):
            try:
                out.append(json.loads(l))
            except ValueError:
                pass
    except FileNotFoundError:
        pass
    return out


def summ(ts):
    if not ts:
        return "no trades"
    n = len(ts)
    tot = sum(t["net_usd"] for t in ts)
    w = sum(1 for t in ts if t["net_usd"] > 0)
    return f"{n:4d} trades | wins {100*w/n:3.0f}% | total ${tot:+8.2f} | per trade ${tot/n:+.2f}"


def main():
    d = sys.argv[1]
    trades = [r for r in lines(os.path.join(d, "paper_trades.jsonl")) if r.get("reason") and r.get("net_usd") is not None]
    closed = [t for t in trades if t["reason"] != "exit_quote_failed"]
    failed = [t for t in trades if t["reason"] == "exit_quote_failed"]
    print(f"run: {len(trades)} trades ({len(failed)} exit_quote_failed), total ${sum(t['net_usd'] for t in trades):+.2f}")

    # ---- 1. people vs bots ----
    tx_cache = {}
    groups = defaultdict(list)
    for t in closed:
        ob = t.get("open_block")
        if ob is None:
            continue
        try:
            logs = rpc("eth_getLogs", [{"address": t["pool"], "fromBlock": hex(ob - WINDOW), "toBlock": hex(ob), "topics": [SWAP_V3]}])
        except Exception:
            continue
        hashes = list(dict.fromkeys(l["transactionHash"] for l in logs))[:12]
        people = bots = 0
        for h in hashes:
            if h not in tx_cache:
                try:
                    tx = rpc("eth_getTransactionByHash", [h])
                    tx_cache[h] = (tx.get("input") or "0x")[:10].lower()
                except Exception:
                    tx_cache[h] = None
            sel = tx_cache[h]
            if sel is None:
                continue
            if sel in UR_SELECTORS:
                people += 1
            else:
                bots += 1
        if people + bots == 0:
            continue
        share = people / (people + bots)
        g = "no people (all bots)" if share == 0 else ("some people (<50%)" if share < 0.5 else "mostly people (>=50%)")
        t["people_share"] = share
        groups[g].append(t)
    print("\nWHO DROVE THE RUSH (swaps in the ~1 s before entry; Universal Router = people)")
    for g in ("no people (all bots)", "some people (<50%)", "mostly people (>=50%)"):
        print(f"  {g:24s} {summ(groups[g])}")

    # ---- 2. failed exits: real traps or glitches? ----
    print("\nFAILED EXITS (each counted as a total loss)")
    for t in failed:
        tok, pool = t["token"], t["pool"]
        try:
            bal = int(rpc("eth_call", [{"to": tok, "data": "0x70a08231" + pool[2:].rjust(64, "0")}, "latest"]), 16)
        except Exception as e:
            bal = None
        print(f"  {tok} pool {pool}: error: {str(t.get('error', ''))[:110]}")
        print(f"      token balance in pool now: {bal}")
    print(f"\n(node requests: {calls})")


if __name__ == "__main__":
    main()
