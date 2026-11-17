#!/usr/bin/env python3
# ============================================================================
# COPY-THE-WINNERS TEST (read-only, past chain data, walk-forward)
#
# Plain English:
#   Question: are there wallets whose buys are worth copying 2 blocks later?
#
#   Fair test (no hindsight):
#     1. Read every Uniswap V3 swap (and pool creation) for the last N days.
#     2. Every BUY of a coin (token leaves the pool) worth at least ~$20, on a
#        pool at least 2 hours old (rug rule), is a possible "copy": we buy 2
#        blocks later at the pool price then, and sell with the live rules
#        (+5% net take profit, -5% net stop, 60 s max). Costs: pool fee both
#        ways + 0.6% price impact estimate.
#     3. The wallet = the swap's recipient, kept only if it is a plain wallet
#        (no contract code), so shared routers and aggregators are dropped.
#     4. PICK winners using the first 2/3 of the period only: wallets with at
#        least MIN_BUYS copies, positive in BOTH halves of that period.
#     5. TEST them on the last 1/3 (never used for picking). Baseline: copying
#        every active wallet (MIN_BUYS+ in the picking period) on the test
#        period. Only the first copy per coin per 60 s counts (we can't buy
#        the same coin twice at once).
#
#   Output: picking-period and test-period results for "winners" vs
#   baseline: copies, wins, avg net %, total $ at $50, without the top 3
#   wallets / coins, night vs day.
#
#   Read-only. Node: SNIPER_RHC_HTTP (never printed).
#   Usage: python3 copy-wallet-test.py [days=3]
# ============================================================================
import collections
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

RPC = os.environ.get("SNIPER_RHC_HTTP", "")
SWAP_V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
CREATED_V3 = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118"
V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa"
WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"
USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
BASES = {WETH, USDG}
ETH_USD = 1800.0             # rough, only to set the ~$20 minimum buy
MIN_BUY_USD = 20.0
BLOCK_S = 0.105
STEP = 5000
LATE = 2
HOLD = int(60 / BLOCK_S)
TP, SL = 0.05, 0.05
IMPACT = 0.006
USD = 50.0
MIN_AGE_BLOCKS = int(7200 / BLOCK_S)
MIN_BUYS = 10
calls = 0


def rpc(method, params):
    global calls
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
    for attempt in range(4):
        try:
            calls += 1
            with urllib.request.urlopen(req, timeout=90) as r:
                v = json.loads(r.read())
            if "error" in v:
                raise ValueError(str(v["error"])[:150])
            return v["result"]
        except (OSError, ValueError) as e:
            last = e
            time.sleep(2 * (attempt + 1))
    raise last


def logs(a, b):
    try:
        return rpc("eth_getLogs", [{"fromBlock": hex(a), "toBlock": hex(b), "topics": [[SWAP_V3, CREATED_V3]]}])
    except (OSError, ValueError):
        if b - a < 100:
            raise
        m = (a + b) // 2
        return logs(a, m) + logs(m + 1, b)


def s256(h):
    v = int(h, 16)
    return v - (1 << 256) if v >= 1 << 255 else v


def pool_info(pool):
    """(token_is0, fee, base) for a Uniswap V3 pool with exactly one WETH/USDG side."""
    out = []
    for sel in ("0x0dfe1681", "0xd21220a7", "0xddca3f43", "0xc45a0155"):
        try:
            out.append(rpc("eth_call", [{"to": pool, "data": sel}, "latest"]))
        except Exception:  # noqa: BLE001
            return None
    if any(len(x) < 66 for x in out):
        return None
    t0, t1, fact = ("0x" + out[i][-40:] for i in (0, 1, 3))
    return classify(t0, t1, int(out[2], 16), fact)


def classify(t0, t1, fee, factory):
    if factory != V3_FACTORY or (t0 in BASES) == (t1 in BASES):
        return None
    token_is0 = t1 in BASES
    return (token_is0, fee, t1 if token_is0 else t0)


def is_wallet(addr):
    try:
        return rpc("eth_getCode", [addr, "latest"]) in ("0x", "0x0")
    except Exception:  # noqa: BLE001
        return False


def main():
    days = float(sys.argv[1]) if len(sys.argv) > 1 else 3
    head = int(rpc("eth_blockNumber", []), 16)
    now = time.time()
    start = head - int(days * 86400 / BLOCK_S)
    split = start + int((head - start) * 2 / 3)   # pick before, test after
    mid = start + (split - start) // 2            # halves of the picking period
    print(f"copy-test: blocks {start}..{head}, pick < {split} <= test", file=sys.stderr)

    info = {}            # pool -> (token_is0, fee, base) or None
    born = {}            # pool -> creation block (if created inside the window)
    last_price = {}
    pending = collections.defaultdict(list)
    copies = []          # finished simulated copies

    def settle(tr, blk, price):
        if tr["entry"] is None:
            if blk < tr["entry_block"]:
                return False
            tr["entry"] = tr["pre"]
        if tr["exit"] is None:
            net = price / tr["entry"] - 1 - tr["cost"]
            if net >= TP:
                tr["exit"] = net
            elif net <= -SL:
                tr["exit"] = net
            elif blk - tr["entry_block"] >= HOLD:
                tr["exit"] = net
        return tr["exit"] is not None

    a = start
    t0 = time.time()
    while a <= head:
        b = min(head, a + STEP - 1)
        batch = logs(a, b)
        # pool creations in this chunk give token sides and exact birth for free
        for l in batch:
            if l["topics"][0] == CREATED_V3 and l["address"].lower() == V3_FACTORY:
                pool = "0x" + l["data"][-40:]
                t0_, t1_ = "0x" + l["topics"][1][-40:], "0x" + l["topics"][2][-40:]
                info[pool] = classify(t0_, t1_, int(l["topics"][3], 16), V3_FACTORY)
                born[pool] = int(l["blockNumber"], 16)
        new = {l["address"].lower() for l in batch if l["topics"][0] == SWAP_V3} - info.keys()
        with ThreadPoolExecutor(8) as ex:
            for p, i in zip(new, ex.map(pool_info, new)):
                info[p] = i
        for l in batch:
            if l["topics"][0] != SWAP_V3:
                continue
            pool = l["address"].lower()
            pi = info.get(pool)
            if not pi:
                continue
            token_is0, fee, base = pi
            blk = int(l["blockNumber"], 16)
            d = l["data"][2:]
            a0, a1, sp = s256(d[0:64]), s256(d[64:128]), int(d[128:192], 16)
            if sp == 0:
                continue
            p01 = (sp / 2 ** 96) ** 2
            price = p01 if token_is0 else 1 / p01
            keep = []
            for tr in pending[pool]:
                if tr["entry"] is None and blk >= tr["entry_block"]:
                    tr["pre"] = last_price.get(pool, price)
                if settle(tr, blk, price):
                    copies.append(tr)
                else:
                    keep.append(tr)
            pending[pool] = keep
            # A buy: the token left the pool (negative token amount).
            tok_amt, base_amt = (a0, a1) if token_is0 else (a1, a0)
            if tok_amt < 0 and base_amt > 0:
                usd = base_amt / 1e18 * (ETH_USD if base == WETH else 1.0)
                old_enough = pool not in born or blk - born[pool] >= MIN_AGE_BLOCKS
                if usd >= MIN_BUY_USD and old_enough:
                    pending[pool].append({
                        "wallet": "0x" + l["topics"][2][-40:], "pool": pool, "block": blk,
                        "entry_block": blk + LATE, "pre": price, "entry": None, "exit": None,
                        "cost": 2 * fee / 1e6 + IMPACT,
                        "hour": (datetime.fromtimestamp(now - (head - blk) * BLOCK_S, timezone.utc) - timedelta(hours=5)).hour,
                    })
            last_price[pool] = price
        a = b + 1
        el = time.time() - t0
        pct = (a - start) / max(1, head - start)
        print(f"  {100 * pct:5.1f}% | pools {len(info)} | copies {len(copies)} | requests {calls} | eta {el / max(pct, 1e-6) - el:6.0f}s", file=sys.stderr)

    # Keep only plain wallets (no code) with enough activity in the picking period.
    pick = [c for c in copies if c["block"] < split]
    per = collections.Counter(c["wallet"] for c in pick)
    active = [w for w, n in per.items() if n >= MIN_BUYS]
    print(f"  checking {len(active)} active recipients for contract code", file=sys.stderr)
    with ThreadPoolExecutor(8) as ex:
        wallets = {w for w, ok in zip(active, ex.map(is_wallet, active)) if ok}

    def score(rows):
        by = collections.defaultdict(list)
        for c in rows:
            by[c["wallet"]].append(c["exit"])
        return by

    first = score([c for c in pick if c["block"] < mid and c["wallet"] in wallets])
    second = score([c for c in pick if c["block"] >= mid and c["wallet"] in wallets])
    winners = {w for w in wallets
               if sum(first.get(w, [])) > 0 and sum(second.get(w, [])) > 0
               and len(first.get(w, [])) + len(second.get(w, [])) >= MIN_BUYS}

    def dedupe(rows):
        """One copy per coin per 60 s (we can't hold the same coin twice)."""
        rows = sorted(rows, key=lambda c: c["block"])
        last = {}
        out = []
        for c in rows:
            if c["block"] - last.get(c["pool"], -10**12) >= HOLD:
                last[c["pool"]] = c["block"]
                out.append(c)
        return out

    def show(label, rows):
        rows = dedupe(rows)
        n = len(rows)
        if not n:
            print(f"  {label:40} copies     0")
            return
        nets = [c["exit"] for c in rows]
        usd = [x * USD for x in nets]
        bw, bp = collections.Counter(), collections.Counter()
        for c, u in zip(rows, usd):
            bw[c["wallet"]] += u
            bp[c["pool"]] += u
        tw = sum(u for _, u in bw.most_common(3))
        tp = sum(u for _, u in bp.most_common(3))
        wins = sum(1 for x in nets if x > 0)
        print(f"  {label:40} copies {n:5d} | wins {100 * wins / n:3.0f}% | avg net {100 * sum(nets) / n:6.2f}% | "
              f"total ${sum(usd):8.2f} | w/o top 3 wallets ${sum(usd) - tw:8.2f} | w/o top 3 coins ${sum(usd) - tp:8.2f}")

    test = [c for c in copies if c["block"] >= split]
    print(f"\nCOPY-THE-WINNERS: {len(copies)} possible copies | {len(wallets)} active plain wallets | "
          f"{len(winners)} 'winners' picked | node requests {calls}\n")
    print("PICKING PERIOD (first 2/3, hindsight, for reference only):")
    show("winners", [c for c in pick if c["wallet"] in winners])
    show("all active wallets", [c for c in pick if c["wallet"] in wallets])
    print("\nTEST PERIOD (last 1/3, never used for picking):  <- the real answer")
    show("copy the winners", [c for c in test if c["wallet"] in winners])
    show("baseline: copy all active wallets", [c for c in test if c["wallet"] in wallets])
    show("winners, night 8 PM-8 AM", [c for c in test if c["wallet"] in winners and (c["hour"] >= 20 or c["hour"] < 8)])
    show("winners, day 8 AM-8 PM", [c for c in test if c["wallet"] in winners and 8 <= c["hour"] < 20])
    top = collections.Counter()
    for c in pick:
        if c["wallet"] in winners:
            top[c["wallet"]] += c["exit"] * USD
    print("\ntop picked wallets (picking period $):", [(w[:10], round(v, 2)) for w, v in top.most_common(5)])


if __name__ == "__main__":
    main()
