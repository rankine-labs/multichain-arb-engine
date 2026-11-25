#!/usr/bin/env python3
# ============================================================================
# RUG RULES TEST: which pre-buy rule stops rugs while keeping the profit?
#
# Plain English:
#   For every trade in a paper run (wins, losses AND the rugs), works out
#   what we could have known at the moment we bought:
#     - pool age: when the pool was created (Uniswap V3 factory PoolCreated
#       event) vs our buy block
#     - creator: the wallet that received the token's supply when it was
#       minted, and how much of the supply that was
#     - liquidity provider: the wallet whose transaction first added
#       liquidity to the pool
#   Then scores candidate rules: for each, how many rugs it would have
#   blocked, how many good trades it would have blocked, and the profit
#   kept. A rule is only worth it if it saves more than it costs.
#
#   Read-only. Node: SNIPER_RHC_HTTP (needs history). Usage:
#     python3 deploy/rug-rules.py paper-out/run5 [days_back=4]
# ============================================================================
import json
import os
import sys
import urllib.request
from collections import defaultdict

RPC = os.environ.get("SNIPER_RHC_HTTP", "https://rpc.mainnet.chain.robinhood.com")
BLOCK_S = 0.105
V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa"
POOL_CREATED = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118"
MINT = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde"
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
ZERO_T = "0x" + "0" * 64
calls = 0


def rpc(method, params):
    global calls
    calls += 1
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        v = json.loads(r.read())
    if "error" in v:
        raise ValueError(str(v["error"])[:150])
    return v["result"]


def logs(flt, a, b):
    """getLogs a..b; halves the range when the node says it is too big."""
    try:
        return rpc("eth_getLogs", [dict(flt, fromBlock=hex(a), toBlock=hex(b))])
    except ValueError as e:
        if b - a < 100 or "range" not in str(e).lower() and "limit" not in str(e).lower():
            raise
        m = (a + b) // 2
        return logs(flt, a, m) + logs(flt, m + 1, b)


def lines(p):
    out = []
    for l in open(p):
        try:
            out.append(json.loads(l))
        except ValueError:
            pass
    return out


def main():
    d = sys.argv[1]
    days = float(sys.argv[2]) if len(sys.argv) > 2 else 4
    step = 5000
    trades = [r for r in lines(os.path.join(d, "paper_trades.jsonl")) if r.get("reason") and r.get("net_usd") is not None]
    sig = [s for s in lines(os.path.join(d, "signals.jsonl")) if s.get("taken")]
    for t in trades:  # failed exits have no open_block: take the buy signal's block
        if t.get("open_block") is None:
            t["open_block"] = max((s["block"] for s in sig if s.get("token", "").lower() == t["token"].lower()), default=None)
    trades = [t for t in trades if t.get("open_block")]
    pools = {t["pool"].lower() for t in trades}
    head = int(rpc("eth_blockNumber", []), 16)
    start = head - int(days * 86400 / BLOCK_S)

    # 1. Pool creation blocks: every V3 PoolCreated in the window.
    created = {}
    for a in range(start, head + 1, step):
        for l in logs({"address": V3_FACTORY, "topics": [POOL_CREATED]}, a, min(head, a + step - 1)):
            p = "0x" + l["data"][-40:].lower()
            if p in pools:
                created[p] = int(l["blockNumber"], 16)
    print(f"pools traded {len(pools)} | created inside the window {len(created)} (others are older)", file=sys.stderr)

    # 2. For young pools: first liquidity provider, token creator and their share.
    info = {}
    tok_of = {t["pool"].lower(): t["token"].lower() for t in trades}
    for p, cb in created.items():
        tok = tok_of[p]
        lp = None
        try:
            m = logs({"address": p, "topics": [MINT]}, cb, cb + step)
            if m:
                lp = rpc("eth_getTransactionByHash", [m[0]["transactionHash"]])["from"].lower()
        except Exception:
            pass
        creator, share = None, None
        # token mint (Transfer from zero): search back from the pool, up to ~3 h
        b = cb
        for _ in range(20):
            try:
                ml = logs({"address": tok, "topics": [TRANSFER, ZERO_T]}, max(0, b - step), b)
            except Exception:
                break
            if ml:
                amounts = defaultdict(int)
                for l in ml:
                    amounts["0x" + l["topics"][2][-40:].lower()] += int(l["data"], 16)
                total = sum(amounts.values()) or 1
                creator, top = max(amounts.items(), key=lambda kv: kv[1])
                share = top / total
                break
            b -= step + 1
        info[p] = {"lp": lp, "creator": creator, "share": share}

    # 3. Score each trade and candidate rules.
    rows = []
    for t in trades:
        p = t["pool"].lower()
        rug = t["reason"] == "exit_quote_failed"
        cb = created.get(p)
        age_s = (t["open_block"] - cb) * BLOCK_S if cb else 1e9  # older than the window
        i = info.get(p, {})
        self_lp = bool(i.get("lp") and i.get("lp") == i.get("creator"))
        rows.append({"net": t["net_usd"], "rug": rug, "age": age_s, "self_lp": self_lp, "share": i.get("share") or 0})

    def score(name, rule):
        hit = [r for r in rows if rule(r)]
        rugs = sum(r["rug"] for r in hit)
        good = [r for r in hit if not r["rug"]]
        saved = -sum(r["net"] for r in hit if r["rug"])
        lost = sum(r["net"] for r in good)
        print(f"  {name:52s} blocks {rugs}/{tot_rugs} rugs (+${saved:6.0f}) | blocks {len(good):3d} good trades (their P&L ${lost:+7.2f}) | NET EFFECT ${saved - lost:+7.2f}")

    tot_rugs = sum(r["rug"] for r in rows)
    print(f"\ntrades {len(rows)} | rugs {tot_rugs} | total ${sum(r['net'] for r in rows):+.2f}")
    print("\nBY POOL AGE AT OUR BUY")
    for lo, hi, lab in ((0, 60, "< 1 min"), (60, 600, "1-10 min"), (600, 3600, "10-60 min"), (3600, 86400, "1-24 h"), (86400, 1e10, "> 1 day / older")):
        b = [r for r in rows if lo <= r["age"] < hi]
        if b:
            print(f"  {lab:16s} {len(b):4d} trades | rugs {sum(r['rug'] for r in b)} | P&L ${sum(r['net'] for r in b):+8.2f} | without rugs ${sum(r['net'] for r in b if not r['rug']):+8.2f}")
    print("\nCANDIDATE RULES (what each would have done to this run)")
    for m in (1, 2, 5, 10, 30):
        score(f"skip pools younger than {m} min", lambda r, m=m: r["age"] < m * 60)
    score("skip if creator added the liquidity", lambda r: r["self_lp"])
    for m in (2, 5, 10):
        score(f"skip if creator added liquidity AND pool < {m} min", lambda r, m=m: r["self_lp"] and r["age"] < m * 60)
    score("skip if creator got >90% of supply AND pool < 5 min", lambda r: r["share"] > 0.9 and r["age"] < 300)
    print(f"\n(node requests: {calls})", file=sys.stderr)


if __name__ == "__main__":
    main()
