#!/usr/bin/env python3
# ============================================================================
# "BUY THE BOUNCE" TEST (read-only, past chain data)
#
# Plain English:
#   Question: when a coin that is at least 2 hours old suddenly DUMPS (its
#   price falls X% within about a second, on selling), does it bounce back
#   enough to make money if we buy right after?
#
#   How:
#     1. Read every Uniswap V3 swap on Robinhood Chain for the last N days
#        (log requests in 5,000-block chunks, the node's limit).
#     2. Track each coin's price swap by swap (from the pool's own price).
#     3. A DUMP = the coin's price falls at least X% below its high of the
#        last ~1 second (10 blocks), and the swap that did it was a sale.
#        At most one dump per pool per 5 minutes.
#     4. Simulated trade, same rules as the live sniper: buy 2 blocks AFTER
#        the dump (we are not first), at the price then. Sell at +5% net
#        (take profit), -5% net (stop) or after 60 seconds, whichever first.
#        Costs: the pool fee both ways + 0.6% for price impact at ~$50.
#     5. Pool age at the dump from paper-out/pool_births.json, looked up on
#        the chain (binary search) for pools not in it yet.
#
#   Output: per dump size (8/10/15/20%), per pool age band and per time of
#   day: dumps, wins, average net %, total $ at $50 a trade, and the total
#   WITHOUT the 3 best coins. Also how far coins bounced at best (60 s, 5 min).
#
#   Limits (honest): prices come from swap events, not live quotes; the
#   0.6% impact is an estimate; dumps caused by liquidity removal (rugs)
#   show no swap, so they are invisible here, but the 2-hour rule already
#   avoids the rug zone. Simulated dollars, for comparison only.
#
#   Read-only. Node: SNIPER_RHC_HTTP (never printed).
#   Usage: python3 bounce-test.py paper-out [days=3]
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
V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa"
BASES = {"0x0bd7d308f8e1639fab988df18a8011f41eacad73": "WETH", "0x5fc5360d0400a0fd4f2af552add042d716f1d168": "USDG"}
BLOCK_S = 0.105
STEP = 5000
DROP_WINDOW = 10            # blocks (~1 s): how fast the fall must be
LATE = 2                    # we buy 2 blocks after the dump block
HOLD = int(60 / BLOCK_S)    # 60 s in blocks
LOOK5 = int(300 / BLOCK_S)  # 5 min, for the "best bounce" stat
COOLDOWN = int(300 / BLOCK_S)
TP, SL = 0.05, 0.05
IMPACT = 0.006              # estimated round-trip price impact at ~$50
USD = 50.0
THRESHOLDS = [0.08, 0.10, 0.15, 0.20]
MIN_AGE_S = 7200
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
        return rpc("eth_getLogs", [{"fromBlock": hex(a), "toBlock": hex(b), "topics": [SWAP_V3]}])
    except (OSError, ValueError):
        if b - a < 100:
            raise
        m = (a + b) // 2
        return logs(a, m) + logs(m + 1, b)


def s256(h):
    v = int(h, 16)
    return v - (1 << 256) if v >= 1 << 255 else v


def pool_info(pool):
    """(token_is0, fee) for a Uniswap V3 pool with one side WETH/USDG, else None."""
    out = []
    for sel in ("0x0dfe1681", "0xd21220a7", "0xddca3f43", "0xc45a0155"):
        try:
            out.append(rpc("eth_call", [{"to": pool, "data": sel}, "latest"]))
        except Exception:  # noqa: BLE001
            return None
    if any(len(x) < 66 for x in out):
        return None
    t0, t1, fact = ("0x" + out[i][-40:] for i in (0, 1, 3))
    if fact != V3_FACTORY:
        return None
    if (t0 in BASES) == (t1 in BASES):
        return None  # need exactly one base side
    return (t1 in BASES, int(out[2], 16))  # token_is0, fee in ppm


def birth(pool, upper):
    """First block where the pool contract exists (binary search)."""
    def has(b):
        return len(rpc("eth_getCode", [pool, hex(b)])) > 2
    if not has(upper):
        return None
    lo, hi = 0, upper
    while lo < hi:
        mid = (lo + hi) // 2
        if has(mid):
            hi = mid
        else:
            lo = mid + 1
    return lo


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "paper-out"
    days = float(sys.argv[2]) if len(sys.argv) > 2 else 3
    head = int(rpc("eth_blockNumber", []), 16)
    now = time.time()
    start = head - int(days * 86400 / BLOCK_S)
    print(f"bounce-test: blocks {start}..{head} ({days} days)", file=sys.stderr)

    info = {}                                  # pool -> (token_is0, fee) or None
    recent = collections.defaultdict(collections.deque)  # pool -> (block, price)
    last_price = {}                            # pool -> latest token price
    last_dump = {}                             # pool -> block of last dump (cooldown)
    pending = collections.defaultdict(list)    # pool -> open simulated trades
    done = []                                  # finished trades

    def settle(tr, blk, price):
        """Feed a later price into an open simulated trade."""
        if tr["entry"] is None:
            if blk < tr["entry_block"]:
                return False
            tr["entry"] = tr["pre_entry_price"]  # state at our entry block
        g = price / tr["entry"] - 1
        tr["best60"] = max(tr["best60"], g) if blk - tr["entry_block"] <= HOLD else tr["best60"]
        tr["best5m"] = max(tr["best5m"], g)
        if tr["exit"] is None:
            net = g - tr["cost"]
            if net >= TP:
                tr["exit"] = ("tp", net)
            elif net <= -SL:
                tr["exit"] = ("sl", net)
            elif blk - tr["entry_block"] >= HOLD:
                tr["exit"] = ("time", net)
        return blk - tr["entry_block"] >= LOOK5

    a = start
    t0 = time.time()
    while a <= head:
        b = min(head, a + STEP - 1)
        batch = logs(a, b)
        new_pools = {l["address"].lower() for l in batch} - info.keys()
        with ThreadPoolExecutor(8) as ex:
            for p, i in zip(new_pools, ex.map(pool_info, new_pools)):
                info[p] = i
        for l in batch:
            pool = l["address"].lower()
            pi = info.get(pool)
            if not pi:
                continue
            token_is0, fee = pi
            blk = int(l["blockNumber"], 16)
            d = l["data"][2:]
            a0, a1, sp = s256(d[0:64]), s256(d[64:128]), int(d[128:192], 16)
            if sp == 0:
                continue
            p01 = (sp / 2 ** 96) ** 2               # token1 per token0
            price = p01 if token_is0 else 1 / p01    # base per token
            sold = (a0 if token_is0 else a1) > 0     # pool received the token
            # open trades on this pool see the new price
            keep = []
            for tr in pending[pool]:
                if tr["entry"] is None and blk >= tr["entry_block"]:
                    tr["pre_entry_price"] = last_price.get(pool, price)
                if settle(tr, blk, price):
                    done.append(tr)
                else:
                    keep.append(tr)
            pending[pool] = keep
            # dump detection
            dq = recent[pool]
            dq.append((blk, price))
            while dq and dq[0][0] < blk - DROP_WINDOW:
                dq.popleft()
            high = max(p for _, p in dq)
            drop = 1 - price / high if high > 0 else 0
            if sold and drop >= THRESHOLDS[0] and blk - last_dump.get(pool, -10**12) > COOLDOWN:
                last_dump[pool] = blk
                pending[pool].append({"pool": pool, "block": blk, "drop": drop, "entry_block": blk + LATE,
                                      "pre_entry_price": price, "entry": None, "exit": None,
                                      "best60": -1.0, "best5m": -1.0, "cost": 2 * fee / 1e6 + IMPACT,
                                      "ts": now - (head - blk) * BLOCK_S})
            last_price[pool] = price
        a = b + 1
        el = time.time() - t0
        pct = (a - start) / max(1, head - start)
        print(f"  {100 * pct:5.1f}% | pools {len(info)} | dumps {len(done) + sum(len(v) for v in pending.values())} | "
              f"requests {calls} | eta {el / max(pct, 1e-6) - el:6.0f}s", file=sys.stderr)
    for v in pending.values():
        done.extend(v)
    # Only finished trades count (a dump in the last minute of data has no exit yet).
    trades = [t for t in done if t["entry"] is not None and t["exit"] is not None]

    # pool age at the dump
    births_path = os.path.join(root, "pool_births.json")
    births = json.load(open(births_path)) if os.path.exists(births_path) else {}
    need = {t["pool"] for t in trades if not isinstance(births.get(t["pool"]), int)}
    print(f"  looking up {len(need)} pool births", file=sys.stderr)
    with ThreadPoolExecutor(8) as ex:
        for p, bb in zip(need, ex.map(lambda p: birth(p, head), need)):
            if bb is not None:
                births[p] = bb
    json.dump(births, open(births_path, "w"))
    for t in trades:
        bb = births.get(t["pool"])
        t["age_h"] = (t["block"] - bb) * BLOCK_S / 3600 if isinstance(bb, int) else None
        t["hour"] = (datetime.fromtimestamp(t["ts"], timezone.utc) - timedelta(hours=5)).hour

    def show(label, rows):
        n = len(rows)
        if not n:
            print(f"  {label:30} dumps    0")
            return
        nets = [r["exit"][1] for r in rows]
        usd = [x * USD for x in nets]
        by_pool = collections.Counter()
        for r, u in zip(rows, usd):
            by_pool[r["pool"]] += u
        top3 = sum(u for _, u in by_pool.most_common(3))
        wins = sum(1 for x in nets if x > 0)
        b60 = sorted(r["best60"] for r in rows)[n // 2]
        print(f"  {label:30} dumps {n:5d} | wins {100 * wins / n:3.0f}% | avg net {100 * sum(nets) / n:6.2f}% | "
              f"total ${sum(usd):8.2f} | w/o top 3 pools ${sum(usd) - top3:8.2f} | coins {len(by_pool):4d} | "
              f"median best bounce 60s {100 * b60:5.1f}%")

    old = [t for t in trades if t["age_h"] is not None and t["age_h"] * 3600 >= MIN_AGE_S]
    print(f"\nBUY THE BOUNCE: {len(trades)} dumps found ({len(old)} on pools >= 2 h old) | node requests {calls}\n")
    print("By dump size (pools >= 2 h old):")
    for th in THRESHOLDS:
        show(f"fell >= {int(th * 100)}% in ~1 s", [t for t in old if t["drop"] >= th])
    print("\nBy pool age (dumps >= 10%):")
    for lo, hi, name in [(0, 2, "< 2 h (rug zone, info only)"), (2, 6, "2-6 h"), (6, 24, "6-24 h"), (24, 1e9, "1 day +")]:
        show(name, [t for t in trades if t["drop"] >= 0.10 and t["age_h"] is not None and lo <= t["age_h"] < hi])
    print("\nBy time of day (pools >= 2 h, dumps >= 10%):")
    show("night 8 PM - 8 AM", [t for t in old if t["drop"] >= 0.10 and (t["hour"] >= 20 or t["hour"] < 8)])
    show("day 8 AM - 8 PM", [t for t in old if t["drop"] >= 0.10 and 8 <= t["hour"] < 20])
    print("\nExits (pools >= 2 h, dumps >= 10%):", dict(collections.Counter(t["exit"][0] for t in old if t["drop"] >= 0.10)))


if __name__ == "__main__":
    main()
