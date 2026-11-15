#!/usr/bin/env python3
# ============================================================================
# REPLAY TAX CHECK: re-score the chain replay with the REAL-SIZE trap check.
#
# Plain English:
#   The replay prices trades from pool prices, so it can't see a token that
#   takes a cut when you sell (run 5 blocked two such tokens with 3.5% and
#   4.3% sell taxes, which the small 0.1% test missed). This runs the paper
#   trader's real-size test today on every token the replay traded: move
#   about $50 worth of the token pool -> test wallet, then all of it back
#   (eth_simulateV1, nothing is sent). Refused or short by > 0.05% = taxed
#   or trapped. Then prints the replay totals without those tokens.
#
#   Usage: python3 replay-taxcheck.py out/replay.json   (env SNIPER_RHC_HTTP)
# ============================================================================
import json
import os
import sys
import urllib.request

RPC = os.environ.get("SNIPER_RHC_HTTP", "https://rpc.mainnet.chain.robinhood.com")
WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"
TEST = "0x5afe0000000000000000000000000000c0ffee01"


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        v = json.loads(r.read())
    if "error" in v:
        raise RuntimeError(str(v["error"])[:120])
    return v["result"]


def bal(token, who):
    return int(rpc("eth_call", [{"to": token, "data": "0x70a08231" + who[2:].rjust(64, "0")}, "latest"]), 16)


def verdict(token, pool, base, eth):
    """'ok', 'taxed N bps', 'blocked', or 'unknown (error)'."""
    try:
        held = bal(token, pool)
        base_held = bal(base, pool)
        usd_pool = base_held / 1e18 * eth if base == WETH else base_held / 1e6
        if held == 0 or usd_pool <= 0:
            return "unknown (empty pool)"
        amt = max(1, int(held * min(50.0 / usd_pool, 0.5)))  # ~$50 of tokens
        tr = lambda to, a: "0xa9059cbb" + to[2:].rjust(64, "0") + "%064x" % a
        bo = lambda w: "0x70a08231" + w[2:].rjust(64, "0")
        calls = [{"from": pool, "to": token, "data": tr(TEST, amt)}, {"to": token, "data": bo(TEST)}]
        r = rpc("eth_simulateV1", [{"blockStateCalls": [{"calls": calls}], "validation": False}, "latest"])[0]["calls"]
        if r[0]["status"] != "0x1":
            return "blocked"
        got = int(r[1]["returnData"], 16)
        calls += [{"from": TEST, "to": token, "data": tr(pool, got)}, {"to": token, "data": bo(pool)}]
        r = rpc("eth_simulateV1", [{"blockStateCalls": [{"calls": calls}], "validation": False}, "latest"])[0]["calls"]
        if r[2]["status"] != "0x1":
            return "blocked"
        after = int(r[3]["returnData"], 16)
        arrived = after - (held - amt)
        buy_bps = (amt - got) * 10000 // amt if got < amt else 0
        sell_bps = (got - arrived) * 10000 // got if arrived < got else 0
        if buy_bps > 5 or sell_bps > 5:
            return f"taxed buy {buy_bps} / sell {sell_bps} bps"
        return "ok"
    except Exception as e:
        return f"unknown ({type(e).__name__})"


def main():
    d = json.load(open(sys.argv[1]))
    trades = d["trades"]
    eth = float(os.environ.get("ETH_USD", "3000"))
    seen = {}
    for t in trades:
        if t["token"] not in seen:
            base = WETH if t["base"] == "WETH" else "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
            seen[t["token"]] = verdict(t["token"], t["pool"], base, eth)
    bad = {k for k, v in seen.items() if v != "ok" and not v.startswith("unknown")}
    unk = {k for k, v in seen.items() if v.startswith("unknown")}
    summ = lambda ts: f"{len(ts)} trades | wins {100*sum(t['net']>0 for t in ts)/max(1,len(ts)):.0f}% | total ${sum(t['net'] for t in ts):+.2f}"
    print(f"tokens traded {len(seen)} | taxed/blocked now {len(bad)} | could not test {len(unk)}")
    print("all trades:            " + summ(trades))
    clean = [t for t in trades if t["token"] not in bad]
    print("without taxed/blocked: " + summ(clean))
    cleaner = [t for t in clean if t["token"] not in unk]
    print("and without untested:  " + summ(cleaner))
    days = {}
    for t in clean:
        import time
        k = time.strftime("%a %b %d", time.gmtime(t["t"] - 5 * 3600))
        days.setdefault(k, []).append(t)
    for k in sorted(days, key=lambda k: min(t["t"] for t in days[k])):
        print(f"  {k}: " + summ(days[k]))
    for k, v in sorted(seen.items(), key=lambda kv: kv[1]):
        if v != "ok":
            n = sum(1 for t in trades if t["token"] == k)
            print(f"  {k}: {v} ({n} trades, ${sum(t['net'] for t in trades if t['token'] == k):+.2f})")
    json.dump(seen, open(os.path.join(os.path.dirname(sys.argv[1]), "taxcheck.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
