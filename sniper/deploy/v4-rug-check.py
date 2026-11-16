#!/usr/bin/env python3
# ============================================================================
# V4 RUG CHECK: why couldn't we sell these V4 coins?
#
# Plain English:
#   For each V4 trade in a paper run that ended "exit_quote_failed" (we
#   could not get a sale quote), this reads the pool's own history from
#   the chain and answers:
#     1. How old was the pool when we bought? (from its Initialize event)
#     2. Does the pool have a hook (custom code that runs on every trade)?
#        Which hook permissions does it have?
#     3. Who added liquidity, and was it PULLED after we bought? By whom?
#        (ModifyLiquidity events; the wallet is the tx sender)
#     4. Did other people keep trading after we got stuck? If people could
#        still BUY but nobody could SELL, the pool refuses sells (a trap),
#        not a liquidity pull.
#   Plus the error the bot got and what our safety checklist logged.
#
#   Read-only. No transactions. Node: SNIPER_RHC_HTTP (paid node, needs
#   history). The node URL is never printed.
#   Usage: python3 v4-rug-check.py paper-out/run9 [days_back=3]
# ============================================================================
import json
import os
import sys
import urllib.request

RPC = os.environ.get("SNIPER_RHC_HTTP", "https://rpc.mainnet.chain.robinhood.com")
PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"  # V4 PoolManager
INIT = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438"
MODLIQ = "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec"
SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
BLOCK_S = 0.105
STEP = 5000  # the node refuses bigger log ranges

# V4 hook permission bits (lowest 14 bits of the hook address).
HOOK_BITS = [
    (13, "beforeInitialize"), (12, "afterInitialize"),
    (11, "beforeAddLiquidity"), (10, "afterAddLiquidity"),
    (9, "beforeRemoveLiquidity"), (8, "afterRemoveLiquidity"),
    (7, "beforeSwap"), (6, "afterSwap"),
    (5, "beforeDonate"), (4, "afterDonate"),
    (3, "beforeSwapReturnsDelta"), (2, "afterSwapReturnsDelta"),
    (1, "afterAddLiqReturnsDelta"), (0, "afterRemoveLiqReturnsDelta"),
]


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        v = json.loads(r.read())
    if "error" in v:
        raise ValueError(str(v["error"])[:150])
    return v["result"]


def logs(topics, a, b):
    """getLogs on the PoolManager over a..b, halving the range if refused."""
    try:
        return rpc("eth_getLogs", [{"address": PM, "topics": topics, "fromBlock": hex(a), "toBlock": hex(b)}])
    except ValueError:
        if b - a < 50:
            raise
        m = (a + b) // 2
        return logs(topics, a, m) + logs(topics, m + 1, b)


def chunked(topics, a, b):
    out = []
    for s in range(a, b + 1, STEP):
        out += logs(topics, s, min(b, s + STEP - 1))
    return out


def find_init(pid, entry, days):
    """Walk backwards from our entry until the pool's Initialize shows up."""
    lo_limit = max(0, entry - int(days * 86400 / BLOCK_S))
    b = entry
    while b > lo_limit:
        a = max(lo_limit, b - STEP * 20 + 1)
        got = chunked([INIT, pid], a, b)
        if got:
            return got[0]
        b = a - 1
    return None


def s256(word):
    v = int(word, 16)
    return v - (1 << 256) if v >= 1 << 255 else v


def words(data):
    d = data[2:]
    return [d[i:i + 64] for i in range(0, len(d), 64)]


def tx_from(txh, cache={}):
    if txh not in cache:
        cache[txh] = rpc("eth_getTransactionByHash", [txh])["from"]
    return cache[txh]


def jsonl(path):
    if not os.path.exists(path):
        return []
    out = []
    for line in open(path):
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def main():
    run = sys.argv[1] if len(sys.argv) > 1 else "paper-out/run9"
    days = float(sys.argv[2]) if len(sys.argv) > 2 else 3
    trades = [t for t in jsonl(os.path.join(run, "paper_trades.jsonl")) if t.get("reason") == "exit_quote_failed"]
    entries = {s["pool"]: s for s in jsonl(os.path.join(run, "signals.jsonl")) if s.get("taken")}
    head = int(rpc("eth_blockNumber", []), 16)
    print(f"failed exits in {run}: {len(trades)}")
    for t in trades:
        pid, token = t["pool"], (t.get("token") or "").lower()
        print("\n" + "=" * 70)
        print(f"coin {token}  venue {t.get('venue')}  lost ${t.get('usd_in')}")
        print(f"pool {pid}")
        print(f"bot error: {str(t.get('error'))[:300]}")
        s = entries.get(pid)
        if not s:
            print("  (no entry signal found; skipping)")
            continue
        entry = s["block"]
        print(f"our entry block {entry}; rug meta logged at entry: {json.dumps(s.get('rug'))[:600]}")
        if t.get("venue") != "v4":
            print("  not a V4 pool; use rug-forensics.py for V3")
            continue

        # 1 + 2: pool birth and hook
        init = find_init(pid, entry, days)
        if not init:
            print(f"  Initialize not found in the last {days} days: pool is older than that")
            born = None
        else:
            born = int(init["blockNumber"], 16)
            w = words(init["data"])  # fee, tickSpacing, hooks, sqrtPriceX96, tick
            hook = "0x" + w[2][-40:]
            c0, c1 = "0x" + init["topics"][2][-40:], "0x" + init["topics"][3][-40:]
            print(f"  pool born block {born}: {(entry - born) * BLOCK_S / 60:.1f} min before our buy")
            print(f"  creator (tx sender): {tx_from(init['transactionHash'])}")
            print(f"  pair: {c0} / {c1}  fee {int(w[0], 16)}")
            if int(hook, 16) == 0:
                print("  hook: NONE (plain pool)")
            else:
                flags = int(hook, 16) & 0x3FFF
                names = [n for bit, n in HOOK_BITS if flags >> bit & 1]
                code = rpc("eth_getCode", [hook, "latest"])
                print(f"  hook: {hook}  code {(len(code) - 2) // 2} bytes")
                print(f"  hook permissions: {', '.join(names) or 'none'}")

        # 3: liquidity adds and removals over the pool's life
        a = born if born else entry - 20000
        b = min(head, entry + 20000)  # ~35 min after our buy
        ml = chunked([MODLIQ, pid], a, b)
        print(f"  liquidity changes: {len(ml)}")
        for e in ml:
            blk = int(e["blockNumber"], 16)
            w = words(e["data"])  # tickLower, tickUpper, liquidityDelta, salt
            delta = s256(w[2])
            kind = "ADD   " if delta > 0 else "REMOVE"
            print(f"    {kind} at {(blk - entry) * BLOCK_S:+8.1f}s vs our buy  by {tx_from(e['transactionHash'])}  delta {delta:.3e}")

        # 4: trading around our buy. V4 Swap amounts are the swapper's
        # balance change: negative = the swapper paid that currency in.
        sw = chunked([SWAP, pid], max(a, entry - 6000), b)
        c0 = "0x" + init["topics"][2][-40:] if init else None
        coin_is_0 = c0 == token
        before = after_buys = after_sells = 0
        last = None
        for e in sw:
            blk = int(e["blockNumber"], 16)
            w = words(e["data"])  # amount0, amount1, sqrtPrice, liquidity, tick, fee
            coin_amt = s256(w[0]) if coin_is_0 else s256(w[1])
            if blk <= entry:
                before += 1
            elif coin_amt > 0:
                after_buys += 1
            else:
                after_sells += 1
            last = blk
        print(f"  swaps: {before} before our buy | after: {after_buys} buys, {after_sells} sells")
        if last:
            print(f"  last swap {(last - entry) * BLOCK_S:+.1f}s vs our buy")


if __name__ == "__main__":
    main()
