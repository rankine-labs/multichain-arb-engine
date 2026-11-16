#!/usr/bin/env python3
# ============================================================================
# POOL AGE STUDY: do older ("established") coins rug less, and still pay?
#
# Plain English:
#   For every pool the paper trader traded (all runs), finds the pool's REAL
#   creation block straight from the chain, then works out how old the pool
#   was when we bought. Then it groups every trade by that age and shows:
#   trades, win rate, profit, rugs (couldn't sell), profit without rugs.
#   And a "what if" table: if we only traded pools at least X old.
#
#   How the creation block is found (binary search over history, ~27 node
#   calls per pool):
#     V3 pool  = a contract: first block where it has code.
#     V4 pool  = a slot inside the PoolManager: first block where the pool's
#                state slot is non-zero (it is set by Initialize).
#
#   Read-only. No transactions. Node: SNIPER_RHC_HTTP (paid archive node).
#   The node URL is never printed. Results cached in pool_births.json.
#   Usage: python3 pool-age-study.py paper-out
# ============================================================================
import glob
import json
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

RPC = os.environ.get("SNIPER_RHC_HTTP", "https://rpc.mainnet.chain.robinhood.com")
PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"  # V4 PoolManager
BLOCK_S = 0.105

# ---- keccak256 in pure Python (the server has no crypto library) ----------
_RC = [0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
       0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
       0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
       0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
       0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
       0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]
_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
_M = (1 << 64) - 1


def _rol(x, n):
    return ((x << n) | (x >> (64 - n))) & _M if n else x


def _f(s):
    for rc in _RC:
        c = [s[x][0] ^ s[x][1] ^ s[x][2] ^ s[x][3] ^ s[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        s = [[s[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(s[x][y], _ROT[x][y])
        s = [[b[x][y] ^ (~b[(x + 1) % 5][y] & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        s[0][0] ^= rc
    return s


def keccak256(data: bytes) -> bytes:
    rate = 136
    p = bytearray(data) + b"\x01"
    while len(p) % rate:
        p += b"\x00"
    p[-1] |= 0x80
    s = [[0] * 5 for _ in range(5)]
    for off in range(0, len(p), rate):
        for i in range(rate // 8):
            s[i % 5][i // 5] ^= int.from_bytes(p[off + 8 * i:off + 8 * i + 8], "little")
        s = _f(s)
    out = b""
    for i in range(4):
        out += s[i % 5][i // 5].to_bytes(8, "little")
    return out


assert keccak256(b"").hex().startswith("c5d2460186f7233c"), "keccak self-test failed"
EXTSLOAD = "0x" + keccak256(b"extsload(bytes32)")[:4].hex()


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
    for _ in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                v = json.loads(r.read())
            if "error" in v:
                raise ValueError(str(v["error"])[:150])
            return v["result"]
        except (OSError, ValueError) as e:
            last = e
    raise last


def exists_v3(pool, blk):
    return len(rpc("eth_getCode", [pool, hex(blk)])) > 2


def exists_v4(slot, blk):
    r = rpc("eth_call", [{"to": PM, "data": EXTSLOAD + slot}, hex(blk)])
    return int(r, 16) != 0


def birth_block(pool, venue, upper):
    """First block where the pool exists (binary search over 0..upper)."""
    if venue == "v4":
        slot = keccak256(bytes.fromhex(pool[2:].rjust(64, "0")) + (6).to_bytes(32, "big")).hex()
        test = lambda b: exists_v4(slot, b)  # noqa: E731
    else:
        test = lambda b: exists_v3(pool, b)  # noqa: E731
    if not test(upper):
        return None
    lo, hi = 0, upper
    while lo < hi:
        mid = (lo + hi) // 2
        if test(mid):
            hi = mid
        else:
            lo = mid + 1
    return lo


def jsonl(path):
    out = []
    if os.path.exists(path):
        for line in open(path):
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "paper-out"
    trades = []  # (pool, venue, entry_block, pnl, rug)
    for d in sorted(glob.glob(os.path.join(root, "run*"))):
        entries = {}
        for s in jsonl(os.path.join(d, "signals.jsonl")):
            if s.get("taken") and s.get("block"):
                entries[s["pool"]] = s
        for t in jsonl(os.path.join(d, "paper_trades.jsonl")):
            rug = t.get("reason") == "exit_quote_failed"
            if "wall_ms" not in t and not rug:
                continue  # side records (race check etc.), not real trades
            s = entries.get(t.get("pool"))
            if not s:
                continue
            venue = t.get("venue") or s.get("venue") or "v3"
            trades.append((t["pool"].lower(), venue, s["block"], t.get("net_usd", 0.0), rug))
    print(f"trades with a known entry block: {len(trades)}")

    cache_path = os.path.join(root, "pool_births.json")
    births = json.load(open(cache_path)) if os.path.exists(cache_path) else {}
    todo = {}
    for pool, venue, blk, _, _ in trades:
        if pool not in births:
            todo[pool] = (venue, max(blk, todo.get(pool, (venue, 0))[1]))
    print(f"pools to look up: {len(todo)} (cached {len(births)})")

    def work(item):
        pool, (venue, blk) = item
        try:
            return pool, birth_block(pool, venue, blk)
        except Exception as e:  # noqa: BLE001
            return pool, "error: " + str(e)[:80]

    with ThreadPoolExecutor(8) as ex:
        for i, (pool, b) in enumerate(ex.map(work, todo.items()), 1):
            births[pool] = b
            if i % 50 == 0:
                print(f"  looked up {i}/{len(todo)}")
                json.dump(births, open(cache_path, "w"))
    json.dump(births, open(cache_path, "w"))

    bands = [(1800, "a  <30 min"), (3600, "b  30-60 min"), (7200, "c  1-2 h"), (21600, "d  2-6 h"),
             (86400, "e  6-24 h"), (259200, "f  1-3 days"), (float("inf"), "g  3+ days")]
    agg, ages = {}, []
    skipped = 0
    for pool, venue, blk, pnl, rug in trades:
        b = births.get(pool)
        if not isinstance(b, int):
            skipped += 1
            continue
        age = (blk - b) * BLOCK_S
        ages.append((age, pnl, rug))
        name = next(n for lim, n in bands if age < lim)
        a = agg.setdefault(name, [0, 0, 0.0, 0, 0.0])
        a[0] += 1
        a[1] += pnl > 0
        a[2] += pnl
        a[3] += rug
        a[4] += pnl if rug else 0.0
    print(f"(skipped {skipped} trades with no birth block found)\n")
    print("POOL AGE WHEN WE BOUGHT")
    print(f"{'age':14} {'trades':>6} {'wins':>5} {'net $':>9} {'rugs':>5} {'rug $':>8} {'no-rug $':>9}")
    for name in sorted(agg):
        a = agg[name]
        print(f"{name:14} {a[0]:6d} {100 * a[1] / a[0]:4.0f}% {a[2]:9.2f} {a[3]:5d} {a[4]:8.2f} {a[2] - a[4]:9.2f}")

    print("\nWHAT IF we only traded pools at least this old")
    print(f"{'min age':10} {'trades':>6} {'net $':>9} {'rugs':>5} {'no-rug $':>9} {'$ per trade':>11}")
    for lim, label in [(0, "any"), (600, "10 min"), (1800, "30 min"), (3600, "1 h"), (7200, "2 h"),
                       (21600, "6 h"), (86400, "24 h"), (259200, "3 days")]:
        sel = [x for x in ages if x[0] >= lim]
        n = len(sel)
        net = sum(x[1] for x in sel)
        rugs = sum(1 for x in sel if x[2])
        rugd = sum(x[1] for x in sel if x[2])
        print(f"{label:10} {n:6d} {net:9.2f} {rugs:5d} {net - rugd:9.2f} {net / max(1, n):11.3f}")


if __name__ == "__main__":
    main()
