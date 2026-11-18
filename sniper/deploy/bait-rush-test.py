#!/usr/bin/env python3
# ============================================================================
# BAIT RUSH TEST: were the rushes that got us rugged faked by the creator?
#
# Plain English:
#   The rug warning test showed creators pull the money 0.6-4.5 s after we
#   buy, so the rush itself looks like bait. If the "buyers" in a bait rush
#   are the creator's own wallets, we can spot it BEFORE we buy.
#
#   For every young-pool trade (pool under 1 h old at our buy) in every run:
#     RUG   = we lost half or more / could not sell
#     CLEAN = everything else
#   it rebuilds the rush: wallets that sent a swap on that pool in the 2 s
#   before our buy. For each wallet:
#     - fresh?    sent fewer than 5 transactions ever (eth_getTransactionCount)
#     - funder    who sent it its FIRST ETH (binary search on the archive
#                 balance, then the funding transaction in that block)
#   and for the pool: the creator = sender of the first liquidity add.
#   Signals per trade:
#     creator-linked  a rush wallet IS the creator, or was funded by the
#                     creator, or shares the creator's funder
#     cluster         2+ rush wallets share one funder (sybil buyers)
#     fresh share     % of rush wallets that are fresh
#   Funders that fund wallets in many unrelated pools (bridges, exchanges)
#   are "hubs" and ignored, so they don't fake clusters.
#   Then: how well each signal separates RUG from CLEAN, and what a "skip if
#   flagged" rule would have done to the money.
#   Read-only. Node: SNIPER_RHC_HTTP (URL never printed).
#   Usage: python3 -I bait-rush-test.py paper-out [max_clean=80]
# ============================================================================
import glob
import json
import os
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor

RPC = os.environ.get("SNIPER_RHC_HTTP", "")
PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
SWAP_V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
SWAP_V2 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822"
SWAP_V4 = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
MINT_V3 = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde"
MINT_V2 = "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f"
MOD_V4 = "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec"
BLOCK_S = 0.105
RUSH_BLOCKS = 20       # 2 s before our buy
HOUR = 34286
calls = 0


def rpc(method, params):
    global calls
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
    last = None
    for attempt in range(4):
        try:
            calls += 1
            with urllib.request.urlopen(req, timeout=60) as r:
                v = json.loads(r.read())
            if "error" in v:
                raise ValueError(str(v["error"])[:160])
            return v["result"]
        except OSError as e:
            last = e
            time.sleep(1 + attempt)
    raise last


def is_v4(pool):
    return len(pool) == 66


def swap_senders(pool, a, b):
    """Distinct tx senders of swaps on the pool in blocks [a, b]."""
    if is_v4(pool):
        f = {"address": PM, "topics": [SWAP_V4, pool]}
    else:
        f = {"address": pool, "topics": [[SWAP_V3, SWAP_V2]]}
    f.update({"fromBlock": hex(a), "toBlock": hex(b)})
    txs = list(dict.fromkeys(l["transactionHash"] for l in rpc("eth_getLogs", [f])))
    out = []
    for h in txs:
        t = rpc("eth_getTransactionByHash", [h])
        if t and t.get("from"):
            out.append(t["from"].lower())
    return list(dict.fromkeys(out))


def creator(pool, birth):
    """Sender of the first liquidity add near the pool's birth block."""
    a, b = birth, birth + 3000
    if is_v4(pool):
        f = {"address": PM, "topics": [MOD_V4, pool]}
    else:
        f = {"address": pool, "topics": [[MINT_V3, MINT_V2]]}
    f.update({"fromBlock": hex(a), "toBlock": hex(b)})
    for l in rpc("eth_getLogs", [f]):
        if is_v4(pool) and int(l["data"][2:][128:192], 16) >= 1 << 255:
            continue  # a removal, not an add
        t = rpc("eth_getTransactionByHash", [l["transactionHash"]])
        if t and t.get("from"):
            return t["from"].lower()
    return None


_fund = {}


def funder(w, upto):
    """Who sent wallet w its first ETH: binary search for the first block
    with a balance, then find the transfer in that block. None if funded by
    a contract call (bridge/exchange) we can't see."""
    if w in _fund:
        return _fund[w]
    try:
        if int(rpc("eth_getBalance", [w, hex(upto)]), 16) == 0:
            _fund[w] = None
            return None
        lo, hi = 0, upto
        while lo < hi:
            mid = (lo + hi) // 2
            if int(rpc("eth_getBalance", [w, hex(mid)]), 16) > 0:
                hi = mid
            else:
                lo = mid + 1
        blk = rpc("eth_getBlockByNumber", [hex(lo), True]) or {}
        f = None
        for t in blk.get("transactions", []):
            if (t.get("to") or "").lower() == w and int(t.get("value", "0x0"), 16) > 0:
                f = t["from"].lower()
                break
        if f is None:
            f = "via-contract@" + str(lo)
    except (ValueError, OSError):
        f = None
    _fund[w] = f
    return f


def nonce(w, b):
    try:
        return int(rpc("eth_getTransactionCount", [w, hex(b)]), 16)
    except (ValueError, OSError):
        return None


def load(root):
    births = {}
    try:
        births = {k.lower(): v for k, v in json.load(open(os.path.join(root, "pool_births.json"))).items()}
    except (OSError, ValueError):
        pass
    rows = []
    for f in sorted(glob.glob(os.path.join(root, "run*", "paper_trades.jsonl"))):
        run = os.path.basename(os.path.dirname(f))
        lines = []
        for line in open(f):
            try:
                lines.append(json.loads(line))
            except ValueError:
                pass
        for i, r in enumerate(lines):
            if "reason" not in r or not r.get("pool"):
                continue
            ob = r.get("open_block")
            if ob is None:
                for x in lines[i + 1:i + 4] + lines[max(0, i - 3):i]:
                    if x.get("ladder_for") == r["pool"] and x.get("open_block"):
                        ob = x["open_block"]
                        break
            pool = r["pool"].lower()
            b = births.get(pool)
            if not ob or b is None:
                continue
            if isinstance(b, dict):
                b = b.get("block")
            if not isinstance(b, int) or ob - b >= HOUR:
                continue
            usd = r.get("usd_in") or 50.0
            net = r.get("net_usd") or 0.0
            rug = r["reason"] == "exit_quote_failed" or net <= -0.5 * usd
            rows.append({"run": run, "pool": pool, "open": ob, "birth": b, "net": net, "rug": rug})
    return rows


def study(t):
    try:
        t["buyers"] = swap_senders(t["pool"], t["open"] - RUSH_BLOCKS, t["open"])
        t["creator"] = creator(t["pool"], t["birth"])
        t["fresh"] = [w for w in t["buyers"] if (nonce(w, t["open"]) or 99) < 5]
        t["funders"] = {w: funder(w, t["open"]) for w in t["buyers"]}
        t["cfunder"] = funder(t["creator"], t["open"]) if t["creator"] else None
        t["ok"] = True
    except (ValueError, OSError) as e:
        t["ok"] = False
        t["err"] = str(e)[:80]
    return t


def main():
    if not RPC:
        sys.exit("set SNIPER_RHC_HTTP")
    root = sys.argv[1] if len(sys.argv) > 1 else "paper-out"
    cap = int(sys.argv[2]) if len(sys.argv) > 2 else 80
    rows = load(root)
    rugs = [r for r in rows if r["rug"]]
    clean = [r for r in rows if not r["rug"]][-cap:]
    print(f"young-pool trades with known pool age: {len(rows)} | rugs {len(rugs)} | clean (newest {cap}) {len(clean)}", flush=True)
    with ThreadPoolExecutor(6) as ex:
        done = [t for t in ex.map(study, rugs + clean) if t.get("ok")]
    # Hubs: funders seen across many different pools' buyers.
    pools_by_funder = defaultdict(set)
    for t in done:
        for f in t["funders"].values():
            if f and not f.startswith("via-contract"):
                pools_by_funder[f].add(t["pool"])
    hubs = {f for f, p in pools_by_funder.items() if len(p) >= 5}
    agg = {True: Counter(), False: Counter()}
    money = {True: defaultdict(float), False: defaultdict(float)}
    for t in done:
        fs = [f for f in t["funders"].values() if f and f not in hubs and not f.startswith("via-contract")]
        cl = max(Counter(fs).values()) if fs else 0
        c, cf = t["creator"], t["cfunder"]
        linked = bool(c) and any(w == c or t["funders"].get(w) in (c, cf) and t["funders"].get(w) not in hubs for w in t["buyers"])
        fresh = len(t["fresh"]) / len(t["buyers"]) if t["buyers"] else 0.0
        t["sig"] = {"linked": linked, "cluster": cl >= 2, "fresh60": fresh >= 0.6}
        t["sig"]["any"] = any(t["sig"].values())
        g = agg[t["rug"]]
        g["n"] += 1
        for k, v in t["sig"].items():
            if v:
                g[k] += 1
                money[t["rug"]][k] += t["net"]
        money[t["rug"]]["all"] += t["net"]
        print(f"  {'RUG  ' if t['rug'] else 'clean'} {t['run']:<6} {t['pool'][:12]} ${t['net']:+7.2f} | buyers {len(t['buyers'])} fresh {len(t['fresh'])} cluster {cl} creator-linked {linked}", flush=True)
    print(f"\nBAIT RUSH TEST | node requests {calls} | hub funders ignored {len(hubs)}")
    for k in ("linked", "cluster", "fresh60", "any"):
        r, c = agg[True], agg[False]
        rp = 100 * r[k] / max(r["n"], 1)
        cp = 100 * c[k] / max(c["n"], 1)
        saved = -money[True][k]
        lost = money[False][k]
        print(f"  {k:<8} flags {r[k]}/{r['n']} rugs ({rp:.0f}%) and {c[k]}/{c['n']} clean ({cp:.0f}%) | skip-if-flagged: avoids ${saved:.0f} of rug losses, gives up ${lost:+.0f} of clean trades")
    print(f"  totals: rugs ${money[True]['all']:+.0f} over {agg[True]['n']} | clean ${money[False]['all']:+.0f} over {agg[False]['n']}")


if __name__ == "__main__":
    main()
