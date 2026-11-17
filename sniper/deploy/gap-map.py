#!/usr/bin/env python3
# ============================================================================
# PRICE GAP MAP (read-only, past chain data)
#
# Plain English:
#   When the same pair (say ETH/USDG) trades in several pools (Uniswap V3,
#   Uniswap V4, Aerodrome...), a big trade in a shallow pool pushes its price
#   away from the others. Buying in the cheap pool and selling in the dear
#   one at the same moment earns the gap, minus both pools' fees. No coin is
#   held, so no rug or dump risk.
#
#   This measures, over the last N hours:
#     - every time two pools of the same pair disagree by MORE than their two
#       fees combined (an "opening"),
#     - whether the gap is STILL there 2 blocks later (when we'd land; if other
#       bots close it within 1 block, it is not ours),
#     - roughly how many dollars a trade could have made at that moment, given
#       each pool's depth (concentrated-liquidity math), capped at a $5,000
#       and a $50,000 trade.
#
#   Pools: anything emitting the Uniswap-V3-style Swap event (Uniswap V3,
#   Aerodrome Slipstream and other forks) plus Uniswap V4 (via the shared
#   V4 key file). Plain V2 pools are not included (no price in their event).
#
#   Honest limits: prices come from swap events (state after each swap), the
#   depth math is an estimate, one capture per gap (we assume we close it),
#   and other bots compete for the same gaps. Simulated dollars.
#
#   Read-only. Node: SNIPER_RHC_HTTP (never printed).
#   Usage: python3 -I gap-map.py paper-out [hours=24]
# ============================================================================
import collections
import json
import math
import os
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

RPC = os.environ.get("SNIPER_RHC_HTTP", "")
SWAP_V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
SWAP_V4 = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"      # Uniswap V4 PoolManager
WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"
USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
ETH0 = "0x" + "0" * 40                                  # native ETH in V4 = WETH here
BLOCK_S = 0.105
STEP = 5000
LATE = 2                  # we land 2 blocks after the gap opens
GAS_USD = 0.05            # two swaps on this chain, generous
MAX_GAP = 0.20            # bigger "gaps" are broken/empty pools: ignored
MIN_SWAPS = 200           # pools with fewer swaps in the window are ignored
CAPS = (5_000.0, 50_000.0)
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
        return rpc("eth_getLogs", [{"fromBlock": hex(a), "toBlock": hex(b), "topics": [[SWAP_V3, SWAP_V4]]}])
    except (OSError, ValueError):
        if b - a < 100:
            raise
        m = (a + b) // 2
        return logs(a, m) + logs(m + 1, b)


def s256(h):
    v = int(h, 16)
    return v - (1 << 256) if v >= 1 << 255 else v


def norm(a):
    return WETH if a == ETH0 else a


def v3_info(pool):
    """(token0, token1, fee_fraction) of a V3-style pool, or None."""
    out = []
    for sel in ("0x0dfe1681", "0xd21220a7"):
        try:
            out.append(rpc("eth_call", [{"to": pool, "data": sel}, "latest"]))
        except Exception:  # noqa: BLE001
            return None
    if any(len(x) < 66 for x in out):
        return None
    try:
        fee = int(rpc("eth_call", [{"to": pool, "data": "0xddca3f43"}, "latest"]), 16) / 1e6
    except Exception:  # noqa: BLE001
        fee = 0.003
    return (norm("0x" + out[0][-40:]), norm("0x" + out[1][-40:]), fee)


def load_v4_keys(root):
    """pool id -> (c0, c1) from the shared V4 key file (+ run files), by regex
    so the 190 MB file never becomes a giant Python object."""
    keys = {}
    pat = re.compile(r'"(0x[0-9a-f]{64})": \{"c0": "(0x[0-9a-f]{40})", "c1": "(0x[0-9a-f]{40})"')
    paths = [os.path.join(root, "v4_pool_keys.json")]
    for d in sorted(os.listdir(root)):
        p = os.path.join(root, d, "v4_pool_keys.json")
        if os.path.exists(p):
            paths.append(p)
    for p in paths:
        try:
            text = open(p).read()
        except OSError:
            continue
        for m in pat.finditer(text):
            keys[m.group(1)] = (norm(m.group(2)), norm(m.group(3)))
        del text
    return keys


def symbol(tok):
    if tok == WETH:
        return "ETH"
    try:
        r = rpc("eth_call", [{"to": tok, "data": "0x95d89b41"}, "latest"])
        b = bytes.fromhex(r[2:])
        n = int.from_bytes(b[32:64], "big")
        return b[64:64 + n].decode(errors="ignore")[:12] or tok[:8]
    except Exception:  # noqa: BLE001
        return tok[:8]


def decimals(tok):
    if tok == WETH:
        return 18
    try:
        return int(rpc("eth_call", [{"to": tok, "data": "0x313ce567"}, "latest"]), 16)
    except Exception:  # noqa: BLE001
        return 18


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "paper-out"
    hours = float(sys.argv[2]) if len(sys.argv) > 2 else 24
    head = int(rpc("eth_blockNumber", []), 16)
    start = head - int(hours * 3600 / BLOCK_S)
    print(f"gap-map: {hours} h, blocks {start}..{head}; loading V4 keys", file=sys.stderr)
    v4keys = load_v4_keys(root)
    print(f"  {len(v4keys)} V4 keys", file=sys.stderr)
    usdg_dec = decimals(USDG)

    info = {}                     # pool -> (A, B, fee) with A < B (normalized), plus "flip"
    state = {}                    # pool -> [price B per A (raw), L, fee]
    swaps = collections.Counter()
    groups = collections.defaultdict(set)   # (A, B) -> pools
    open_gap = {}                 # (pa, pb) -> True while a counted gap is open
    pending = []                  # [check_block, pa, pb, open_block, gap]
    opps = []                     # finished: dict
    eth_usd = [None]

    def pool_meta(pool, kind, l):
        if pool in info:
            return info[pool]
        if kind == "v4":
            k = v4keys.get(pool)
            meta = None if not k else (k[0], k[1])
        else:
            m = v3_info(pool)
            meta = None if not m else (m[0], m[1])
            if m:
                info[pool + "#fee"] = m[2]
        if not meta or meta[0] == meta[1]:
            info[pool] = None
            return None
        a, b = sorted(meta)
        info[pool] = (a, b, meta[0] != a)   # flip: pool's token0 is our B
        groups[(a, b)].add(pool)
        return info[pool]

    def usd_of_b(a, b, amt_b_raw, price_b_per_a):
        """Dollar value of an amount of token B (raw units)."""
        if b == USDG:
            return amt_b_raw / 10 ** usdg_dec
        if b == WETH and eth_usd[0]:
            return amt_b_raw / 1e18 * eth_usd[0]
        if a == USDG and price_b_per_a > 0:
            return amt_b_raw / price_b_per_a / 10 ** usdg_dec
        if a == WETH and price_b_per_a > 0 and eth_usd[0]:
            return amt_b_raw / price_b_per_a / 1e18 * eth_usd[0]
        return None

    def evaluate(blk):
        """Run due checks: is each pending gap still open at landing time?"""
        keep = []
        for p in pending:
            if p[0] > blk:
                keep.append(p)
                continue
            _, pa, pb, ob, g0 = p
            sa, sb = state[pa], state[pb]
            hi, lo = (sa, sb) if sa[0] >= sb[0] else (sb, sa)
            gap = hi[0] / lo[0] - 1
            costs = sa[2] + sb[2]
            net = gap - costs
            rec = {"pa": pa, "pb": pb, "open": ob, "gap0": g0, "gap": gap, "costs": costs, "alive": net > 0}
            if net > 0 and gap <= MAX_GAP:
                d = net / 2
                # Token B moved to shift each pool's price by d: L * sqrt(P) * d / 2
                size_b = min(s[1] * math.sqrt(s[0]) * d / 2 for s in (sa, sb))
                a, b = info[pa][0], info[pa][1]
                usd_size = usd_of_b(a, b, size_b, lo[0])
                if usd_size:
                    for cap in CAPS:
                        sz = min(usd_size, cap)
                        rec[f"usd{int(cap)}"] = max(0.0, sz * d - GAS_USD)
                    rec["size"] = usd_size
            opps.append(rec)
        pending[:] = keep

    def check_group(gkey, blk):
        # Only the 8 busiest pools of a pair (keeps it fast; tiny pools can't
        # carry a real trade anyway).
        pools = sorted((p for p in groups[gkey] if p in state and swaps[p] >= 20), key=lambda p: -swaps[p])[:8]
        for i in range(len(pools)):
            for j in range(i + 1, len(pools)):
                pa, pb = sorted((pools[i], pools[j]))
                sa, sb = state[pa], state[pb]
                if sa[0] <= 0 or sb[0] <= 0:
                    continue
                gap = max(sa[0], sb[0]) / min(sa[0], sb[0]) - 1
                over = gap > sa[2] + sb[2]
                if over and not open_gap.get((pa, pb)):
                    open_gap[(pa, pb)] = True
                    pending.append([blk + LATE, pa, pb, blk, gap])
                elif not over:
                    open_gap[(pa, pb)] = False

    a = start
    t0 = time.time()
    last_blk = None
    touched = set()
    while a <= head:
        b = min(head, a + STEP - 1)
        batch = logs(a, b)
        new = {l["address"].lower() for l in batch if l["topics"][0] == SWAP_V3} - info.keys()
        with ThreadPoolExecutor(8) as ex:
            for p, m in zip(new, ex.map(v3_info, new)):
                if m and m[0] != m[1]:
                    x, y = sorted((m[0], m[1]))
                    info[p] = (x, y, m[0] != x)
                    info[p + "#fee"] = m[2]
                    groups[(x, y)].add(p)
                else:
                    info[p] = None
        for l in sorted(batch, key=lambda z: (int(z["blockNumber"], 16), int(z["logIndex"], 16))):
            blk = int(l["blockNumber"], 16)
            if last_blk is not None and blk != last_blk:
                for g in touched:
                    check_group(g, last_blk)
                touched.clear()
                evaluate(last_blk)
            last_blk = blk
            d = l["data"][2:]
            if l["topics"][0] == SWAP_V3:
                pool, kind = l["address"].lower(), "v3"
                sp, liq = int(d[128:192], 16), int(d[192:256], 16)
                fee = info.get(pool + "#fee", 0.003)
            else:
                if l["address"].lower() != PM:
                    continue
                pool, kind = l["topics"][1], "v4"
                sp, liq = int(d[128:192], 16), int(d[192:256], 16)
                fee = int(d[320:384], 16) / 1e6
            meta = pool_meta(pool, kind, l)
            if not meta or sp == 0 or liq == 0:
                continue
            p01 = (sp / 2 ** 96) ** 2              # token1 per token0 (raw)
            price = 1 / p01 if meta[2] else p01    # B per A (raw)
            # liquidity is the same number in either orientation
            state[pool] = [price, liq, fee]
            swaps[pool] += 1
            g = (meta[0], meta[1])
            touched.add(g)
            if g == tuple(sorted((WETH, USDG))):
                # USD per ETH from this pool (any ETH/USDG pool is fine)
                pr = price if meta[0] == WETH else 1 / price
                eth_usd[0] = pr * 1e18 / 10 ** usdg_dec
        a = b + 1
        el = time.time() - t0
        pct = (a - start) / max(1, head - start)
        print(f"  {100 * pct:5.1f}% | pools {sum(1 for k, v in info.items() if v and '#' not in k)} | "
              f"gaps {len(opps) + len(pending)} | ETH ${eth_usd[0] or 0:,.0f} | requests {calls} | "
              f"eta {el / max(pct, 1e-6) - el:6.0f}s", file=sys.stderr)

    # ---- report: only pools with real activity ---------------------------
    good = [o for o in opps if swaps[o["pa"]] >= MIN_SWAPS and swaps[o["pb"]] >= MIN_SWAPS]
    by_pair = collections.defaultdict(list)
    for o in good:
        by_pair[(info[o["pa"]][0], info[o["pa"]][1])].append(o)
    rows = []
    for (ta, tb), os_ in by_pair.items():
        alive = [o for o in os_ if o["alive"]]
        u5 = sum(o.get("usd5000", 0) for o in alive)
        u50 = sum(o.get("usd50000", 0) for o in alive)
        rows.append((u50, u5, ta, tb, len(os_), len(alive), os_))
    rows.sort(reverse=True)
    syms = {}
    print(f"\nPRICE GAP MAP: last {hours} h | gap openings (pools with {MIN_SWAPS}+ swaps): {len(good)} | "
          f"node requests {calls} | ETH ~${eth_usd[0] or 0:,.0f}\n")
    print(f"{'pair':22} {'pools':>5} {'openings':>8} {'alive@+2':>8} {'alive%':>6} {'med gap':>7} "
          f"{'$ if $5k cap':>12} {'$ if $50k cap':>13} {'med size $':>10}")
    for u50, u5, ta, tb, n, na, os_ in rows[:25]:
        for t in (ta, tb):
            if t not in syms:
                syms[t] = symbol(t)
        alive = [o for o in os_ if o["alive"]]
        mg = sorted(o["gap0"] for o in os_)[len(os_) // 2] if os_ else 0
        sizes = sorted(o.get("size", 0) for o in alive)
        ms = sizes[len(sizes) // 2] if sizes else 0
        npools = len([p for p in groups[(ta, tb)] if swaps[p] >= MIN_SWAPS])
        print(f"{syms[ta] + '/' + syms[tb]:22} {npools:5d} {n:8d} {na:8d} {100 * na / max(1, n):5.0f}% "
              f"{100 * mg:6.2f}% {u5:12.2f} {u50:13.2f} {ms:10.0f}")
    t5 = sum(r[1] for r in rows)
    t50 = sum(r[0] for r in rows)
    print(f"\nTOTAL (alive at +2 blocks, one capture per gap): ${t5:,.2f} with $5k cap | ${t50:,.2f} with $50k cap "
          f"over {hours} h")


if __name__ == "__main__":
    main()
