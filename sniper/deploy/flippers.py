#!/usr/bin/env python3
# ============================================================================
# FLIPPER STUDY: are daytime rushes fake volume?
#
# Plain English:
#   For a sample of paper trades (Uniswap V3), looks at the rush we bought
#   into and the minute after it:
#     - who bought in the rush (the wallet that sent each buy transaction)
#     - which of those same wallets SOLD the coin again within ~60 s
#       ("flippers": volume bots buy and sell in loops to fake activity)
#     - how often the same buyer wallets show up across many different
#       rushes (repeat bots)
#   Then compares day (8 AM-4 PM Toronto) with night (8 PM-8 AM), and
#   groups trades by how many of their rush buyers flipped, with P&L.
#   Read-only. Node: SNIPER_RHC_HTTP. ~15 requests per sampled trade.
#   Usage: python3 deploy/flippers.py paper-out/run5 paper-out/run6 ... [per_period=120]
# ============================================================================
import json
import os
import sys
import time
import urllib.request
from collections import Counter, defaultdict

RPC = os.environ.get("SNIPER_RHC_HTTP", "")
SWAP_V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
calls = 0


def rpc(method, params):
    global calls
    calls += 1
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        v = json.loads(r.read())
    if "error" in v:
        raise RuntimeError(str(v["error"])[:100])
    return v["result"]


def s256(h):
    v = int(h, 16)
    return v - (1 << 256) if v >= 1 << 255 else v


def period(ms):
    h = time.gmtime(ms / 1000 - 5 * 3600).tm_hour
    return "DAY" if 8 <= h < 16 else ("NIGHT" if (h >= 20 or h < 8) else "EVENING")


def main():
    dirs = [a for a in sys.argv[1:] if os.path.isdir(a)]
    per = int(next((a for a in sys.argv[1:] if a.isdigit()), "120"))
    trades = []
    for d in dirs:
        for l in open(os.path.join(d, "paper_trades.jsonl")):
            try:
                t = json.loads(l)
            except ValueError:
                continue
            if t.get("reason") and t.get("net_usd") is not None and t.get("open_block") and t.get("wall_ms") and t.get("venue", "v3") == "v3":
                t["period"] = period(t["wall_ms"])
                trades.append(t)
    by = defaultdict(list)
    for t in trades:
        by[t["period"]].append(t)
    token0 = {}
    sender = {}
    rows = []
    buyer_rushes = defaultdict(Counter)  # period -> wallet -> rushes it bought in
    for p, ts in by.items():
        step = max(1, len(ts) // per)
        for t in ts[::step][:per]:
            pool, ob = t["pool"].lower(), t["open_block"]
            try:
                if pool not in token0:
                    token0[pool] = "0x" + rpc("eth_call", [{"to": pool, "data": "0x0dfe1681"}, "latest"])[-40:].lower()
                logs = rpc("eth_getLogs", [{"address": pool, "topics": [SWAP_V3], "fromBlock": hex(ob - 10), "toBlock": hex(ob + 600)}])
            except Exception:
                continue
            tok_is0 = token0[pool] == t["token"].lower()
            buys, sells = [], []
            for l in logs:
                d = l["data"][2:]
                a0, a1 = s256(d[0:64]), s256(d[64:128])
                tok_amt = a0 if tok_is0 else a1  # pool's view: negative = coin left the pool = a buy
                b = int(l["blockNumber"], 16)
                h = l["transactionHash"]
                (buys if tok_amt < 0 else sells).append((b, h))
            rush_buys = [h for b, h in buys if b <= ob][:10]
            later_sells = [h for b, h in sells if b > ob][:25]
            def frm(h):
                if h not in sender:
                    try:
                        sender[h] = rpc("eth_getTransactionByHash", [h])["from"].lower()
                    except Exception:
                        sender[h] = None
                return sender[h]
            bw = {frm(h) for h in rush_buys} - {None}
            sw = {frm(h) for h in later_sells} - {None}
            if not bw:
                continue
            for w in bw:
                buyer_rushes[p][w] += 1
            flip = len(bw & sw) / len(bw)
            rows.append({"p": p, "flip": flip, "net": t["net_usd"], "buyers": len(bw), "sells_after": len(later_sells), "buys_after": len([1 for b, _ in buys if b > ob])})

    print("FLIPPERS: rush buyers who sold the same coin again within ~60 s\n")
    for p in ("DAY", "EVENING", "NIGHT"):
        r = [x for x in rows if x["p"] == p]
        if not r:
            continue
        avg_flip = sum(x["flip"] for x in r) / len(r)
        heavy = [x for x in r if x["flip"] >= 0.5]
        rep = buyer_rushes[p]
        repeat = sum(1 for w, n in rep.items() if n >= 5)
        top = sum(n for w, n in rep.most_common(10))
        tot = sum(rep.values()) or 1
        print(f"{p:8s} {len(r):3d} rushes | avg buyers flipping {100*avg_flip:4.1f}% | rushes with >=half flipping {100*len(heavy)/len(r):4.0f}%"
              f" | buys after us {sum(x['buys_after'] for x in r)/len(r):.1f} vs sells after us {sum(x['sells_after'] for x in r)/len(r):.1f}"
              f" | wallets in 5+ rushes {repeat} | top-10 wallets = {100*top/tot:.0f}% of rush buys")
    print("\nP&L BY HOW MANY RUSH BUYERS FLIPPED")
    for lo, hi, lab in ((0, 0.001, "nobody flipped"), (0.001, 0.5, "some flipped (<50%)"), (0.5, 1.01, "most flipped (>=50%)")):
        for p in ("DAY", "NIGHT"):
            r = [x for x in rows if x["p"] == p and lo <= x["flip"] < hi]
            if r:
                w = sum(1 for x in r if x["net"] > 0)
                print(f"  {lab:22s} {p:6s} {len(r):3d} trades | wins {100*w/len(r):3.0f}% | P&L ${sum(x['net'] for x in r):+7.2f} | per trade ${sum(x['net'] for x in r)/len(r):+.2f}")
    print(f"\n(node requests: {calls})")


if __name__ == "__main__":
    main()
