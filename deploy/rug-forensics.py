#!/usr/bin/env python3
# ============================================================================
# RUG FORENSICS: how did the coins we "couldn't sell" get rugged?
#
# Plain English:
#   For each failed exit in a paper run, reads the pool's and the token's
#   own history from the chain and prints a short timeline:
#     - when the pool got its first liquidity, and from which wallet
#     - who received the token's supply when it was created (the deployer)
#     - the first buyers: how many different wallets bought in the pool's
#       first few blocks and how much of the supply they took ("bundle")
#     - when we bought (from signals.jsonl)
#     - when the liquidity was pulled, and by which wallet
#   So we can see which pre-buy checks would have caught each one.
#
#   Read-only. Node: SNIPER_RHC_HTTP (needs history: the paid node).
#   Usage: python3 deploy/rug-forensics.py paper-out/run5 [days_back=4]
# ============================================================================
import json
import os
import sys
import urllib.request

RPC = os.environ.get("SNIPER_RHC_HTTP", "https://rpc.mainnet.chain.robinhood.com")
BLOCK_S = 0.105
MINT = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde"
BURN = "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c"
COLLECT = "0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0"
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
ZERO = "0x" + "0" * 40


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        v = json.loads(r.read())
    if "error" in v:
        raise ValueError(str(v["error"])[:150])
    return v["result"]


def logs(addr, topics, a, b):
    """getLogs over a..b, splitting the range if the node refuses it."""
    try:
        return rpc("eth_getLogs", [{"address": addr, "topics": topics, "fromBlock": hex(a), "toBlock": hex(b)}])
    except ValueError:
        if b - a < 1000:
            raise
        m = (a + b) // 2
        return logs(addr, topics, a, m) + logs(addr, topics, m + 1, b)


def chunked(addr, topics, a, b, step=200_000):
    out = []
    for s in range(a, b + 1, step):
        out += logs(addr, topics, s, min(b, s + step - 1))
    return out


def sender(txh, cache={}):
    if txh not in cache:
        try:
            cache[txh] = rpc("eth_getTransactionByHash", [txh])["from"].lower()
        except Exception:
            cache[txh] = "?"
    return cache[txh]


def a20(topic):
    return "0x" + topic[-40:].lower()


def main():
    d = sys.argv[1]
    days = float(sys.argv[2]) if len(sys.argv) > 2 else 4
    rows = [json.loads(l) for l in open(os.path.join(d, "paper_trades.jsonl")) if '"exit_quote_failed"' in l]
    sig = []
    for l in open(os.path.join(d, "signals.jsonl")):
        try:
            sig.append(json.loads(l))
        except ValueError:
            pass
    head = int(rpc("eth_blockNumber", []), 16)
    start = head - int(days * 86400 / BLOCK_S)
    secs = lambda n: n * BLOCK_S
    for r in rows:
        tok, pool = r["token"].lower(), r["pool"].lower()
        bought = max((s["block"] for s in sig if s.get("taken") and s.get("token", "").lower() == tok), default=None)
        print(f"\n=== {tok}  pool {pool}")
        try:
            pl = chunked(pool, [[MINT, BURN]], start, head)
            tl = chunked(tok, [TRANSFER], start, head)
        except Exception as e:
            print("  could not read history:", e)
            continue
        mints = [l for l in pl if l["topics"][0] == MINT]
        burns = [l for l in pl if l["topics"][0] == BURN and int(l["data"][2:66], 16) > 0]
        # deployer: who received tokens minted from address zero
        created = [l for l in tl if a20(l["topics"][1]) == ZERO]
        deployers = {a20(l["topics"][2]) for l in created}
        supply = sum(int(l["data"], 16) for l in created) or 1
        first_mint = int(mints[0]["blockNumber"], 16) if mints else None
        lp_from = {sender(m["transactionHash"]) for m in mints}
        print(f"  token created: {'yes, in window' if created else 'before window'} | supply receivers: {sorted(deployers)[:3]}")
        print(f"  liquidity added: {len(mints)} time(s), first at block {first_mint}, by {sorted(lp_from)[:3]}")
        if first_mint:
            # buyers in the first 20 blocks (~2 s) after liquidity: tokens leaving the pool
            early = [l for l in tl if a20(l["topics"][1]) == pool and first_mint <= int(l["blockNumber"], 16) <= first_mint + 20]
            buyers = {}
            for l in early:
                w = a20(l["topics"][2])
                buyers[w] = buyers.get(w, 0) + int(l["data"], 16)
            same_block = {a20(l["topics"][2]) for l in early if int(l["blockNumber"], 16) == first_mint}
            print(f"  first ~2 s after liquidity: {len(buyers)} buyer wallets took {100*sum(buyers.values())/supply:.1f}% of supply"
                  f" ({len(same_block)} in the SAME block as the liquidity)")
        if bought:
            print(f"  we bought at block {bought}: {secs(bought - first_mint)/60:.1f} min after liquidity" if first_mint else f"  we bought at block {bought}")
        for b in burns:
            bb = int(b["blockNumber"], 16)
            who = sender(b["transactionHash"])
            tag = "SAME wallet that added liquidity" if who in lp_from else ("the deployer" if who in deployers else "other wallet")
            after = f", {secs(bb - bought):.0f} s after our buy" if bought else ""
            print(f"  LIQUIDITY PULLED at block {bb} by {who} ({tag}){after}")
        if not burns:
            print("  no liquidity removal seen in window (drained another way: dump or tax?)")


if __name__ == "__main__":
    main()
