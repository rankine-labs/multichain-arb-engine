#!/usr/bin/env python3
# ============================================================================
# EXIT POLICY TEST on real paper trades (trailing take profit and friends)
#
# Plain English:
#   For every Uniswap V3 paper trade in the given runs, reads the pool's
#   swaps for 3 minutes after our entry from the chain and replays the
#   price path through each exit policy in replay.py (POLICIES): the fixed
#   +5% we use now, other take-profit levels, trailing take profits, and
#   tighter stops. Fees and our own price impact for each trade come from
#   the trade itself (chart move at exit minus the real net we got), so
#   each policy pays the same costs the real trade did.
#   Rug trades (exit failed) stay a total loss under every policy.
#   Read-only. Node: SNIPER_RHC_HTTP. One request per trade (+1 per pool).
#   Usage: python3 deploy/trail-test.py paper-out/run5 paper-out/run6 ...
# ============================================================================
import importlib.util
import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("replay", os.path.join(HERE, "replay.py"))
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)

RPC = os.environ.get("SNIPER_RHC_HTTP", "")
SWAP_V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
PATH = round(180 / replay.BLOCK_S)


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        v = json.loads(r.read())
    if "error" in v:
        raise RuntimeError(str(v["error"])[:100])
    return v["result"]


def main():
    trades, rugs = [], 0.0
    for d in sys.argv[1:]:
        for l in open(os.path.join(d, "paper_trades.jsonl")):
            try:
                t = json.loads(l)
            except ValueError:
                continue
            if t.get("reason") == "exit_quote_failed":
                rugs += t.get("net_usd") or 0
            elif t.get("reason") and t.get("net_usd") is not None and t.get("open_block") and t.get("venue", "v3") == "v3" and "pool_move_pct" in t:
                trades.append(t)
    token0, sims = {}, []
    for t in trades:
        pool, ob = t["pool"].lower(), t["open_block"]
        try:
            if pool not in token0:
                token0[pool] = "0x" + rpc("eth_call", [{"to": pool, "data": "0x0dfe1681"}, "latest"])[-40:].lower()
            logs = rpc("eth_getLogs", [{"address": pool, "topics": [SWAP_V3], "fromBlock": hex(ob - 60), "toBlock": hex(ob + PATH)}])
        except Exception:
            continue
        i0 = token0[pool] == t["token"].lower()
        pe, path = None, []
        for l in logs:
            b = int(l["blockNumber"], 16)
            sq = int(l["data"][2 + 128:2 + 192], 16)
            if sq == 0:
                continue
            px = (sq / 2**96) ** 2
            px = px if i0 else 1 / px
            if b <= ob:
                pe = px
            else:
                path.append((b - ob, px))
        if pe is None:
            continue
        usd = t.get("usd_in") or 50.0
        # this trade's real costs as a fraction: chart move at exit minus real net
        fric = t["pool_move_pct"] / 100 - t["net_usd"] / usd
        rets = [(off, px / pe - 1 - fric) for off, px in path]
        h = time.gmtime(t["wall_ms"] / 1000 - 5 * 3600).tm_hour if t.get("wall_ms") else 0
        sims.append((usd, rets, t["net_usd"], "DAY" if 8 <= h < 16 else "NIGHT/EVE", fric))
    print(f"EXIT POLICIES on {len(sims)} real paper trades (rugs ${rugs:+.2f} counted the same under every policy)")
    print(f"  actual result of these trades: ${sum(s[2] for s in sims):+.2f}")
    for name, pol in replay.POLICIES:
        tot = {"DAY": 0.0, "NIGHT/EVE": 0.0}
        wins, nw, nl, lsum = 0, 0, 0, 0.0
        for usd, rets, actual, per, fric in sims:
            r, why, off = replay.exit_on_path(rets, pol)
            if r is None:  # nobody traded after us: sell at the entry price, pay the costs
                r = -fric
            net = usd * r
            tot[per] += net
            if net > 0:
                wins += net
                nw += 1
            else:
                lsum += net
                nl += 1
        n = max(1, nw + nl)
        print(f"  {name:44s} ${tot['DAY'] + tot['NIGHT/EVE']:+8.2f} (day ${tot['DAY']:+7.2f}, night/eve ${tot['NIGHT/EVE']:+7.2f}) | wins {100*nw/n:3.0f}% | avg win ${wins/max(1,nw):+.2f} avg loss ${lsum/max(1,nl):+.2f}")


if __name__ == "__main__":
    main()
