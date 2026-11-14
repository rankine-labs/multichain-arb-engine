#!/usr/bin/env python3
# ============================================================================
# RUSH STUDY: how much does the sequencer-feed head start actually buy us?
#
# Plain English:
#   Reads feed-watch's matched.jsonl (every Uniswap V3 swap, with when the
#   FEED showed it and when the NODE showed it). For every "rush" (3+ buys of
#   one token within 1 second that lift its price 2%+, the paper trader's
#   rule) it compares two traders:
#     FAST: sees the 3rd buy in the feed, lands right after it (plus a small
#           reaction delay, during which other trades still go first).
#     SLOW: sees the 3rd buy from the node (~0.9 s later, like the paper bot),
#           lands after everything the sequencer ordered by then.
#   Both then sell on the same rule as the paper bot (+5% / -10% / 60 s),
#   using real pool prices in real order. Own price impact is ignored for
#   both (same $ size), so the DIFFERENCE between them is the speed edge.
#   It also lists which routers the rush buys came through.
#
#   Read-only. Uses the public node only to look up each pool's two tokens,
#   100 pools per request via Multicall3 (cached in pool-tokens.json).
#
# Usage: python3 deploy/rush-study.py feed-out/run1 [reaction_ms=50]
# ============================================================================
import json
import os
import statistics as S
import sys
import time
import urllib.request
from collections import defaultdict

RPC = os.environ.get("SNIPER_RHC_HTTP", "https://rpc.mainnet.chain.robinhood.com")
WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"
USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
BASES = {WETH, USDG}
RUSH_BUYS, RUSH_WINDOW_MS, RUSH_RISE = 3, 1000, 0.02
TP, SL, HOLD_MS = 0.05, 0.10, 60_000


def s256(h):
    v = int(h, 16)
    return v - (1 << 256) if v >= 1 << 255 else v


def call(to, data):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [{"to": to, "data": data}, "latest"]}).encode()
    # The free node throttles (HTTP 429) when the feed reader is busy: be
    # patient (up to ~2 minutes per request) and say what went wrong.
    for attempt in range(8):
        try:
            req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=15) as r:
                return json.loads(r.read()).get("result")
        except Exception as e:
            print(f"  node busy ({e}), retrying", file=sys.stderr)
            time.sleep(min(2 ** attempt, 30))
    return None


MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11"  # same address on most EVM chains


def _enc_aggregate3(calls):
    """ABI-encode Multicall3.aggregate3((address,bool,bytes)[]) for 4-byte calls."""
    n = len(calls)
    out = "82ad56cb" + "%064x" % 0x20 + "%064x" % n
    tuple_size = 32 * 5  # target, allowFailure, offset, length, 4 bytes padded
    out += "".join("%064x" % (32 * n + i * tuple_size) for i in range(n))
    for target, data in calls:
        d = data[2:] if data.startswith("0x") else data
        out += target[2:].lower().rjust(64, "0") + "%064x" % 1 + "%064x" % 0x60 + "%064x" % (len(d) // 2) + d.ljust(64, "0")
    return "0x" + out


def _dec_aggregate3(hexdata):
    """Decode (bool success, bytes returnData)[] into a list of hex strings or None."""
    b = bytes.fromhex(hexdata[2:])
    word = lambda o: int.from_bytes(b[o:o + 32], "big")
    base = word(0)
    n = word(base)
    start = base + 32
    res = []
    for i in range(n):
        t = start + word(start + 32 * i)
        ok = word(t)
        off = t + word(t + 32)
        ln = word(off)
        data = b[off + 32:off + 32 + ln]
        res.append("0x" + data.hex() if ok and ln >= 32 else None)
    return res


def pool_tokens(pools, cache_path):
    """token0/token1 of every pool, 100 pools per request (Multicall3), cached."""
    cache = json.load(open(cache_path)) if os.path.exists(cache_path) else {}
    todo = [p for p in pools if p not in cache]
    for i in range(0, len(todo), 100):
        chunk = todo[i:i + 100]
        calls = []
        for p in chunk:
            calls += [(p, "0x0dfe1681"), (p, "0xd21220a7")]
        r = call(MULTICALL3, _enc_aggregate3(calls))
        if not r:
            continue
        vals = _dec_aggregate3(r)
        for j, p in enumerate(chunk):
            t0, t1 = vals[2 * j], vals[2 * j + 1]
            cache[p] = ["0x" + t0[-40:] if t0 else None, "0x" + t1[-40:] if t1 else None]
        time.sleep(1)
    json.dump(cache, open(cache_path, "w"))
    return cache


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else "feed-out/run1"
    react = int(sys.argv[2]) if len(sys.argv) > 2 else 50
    rows = []
    for line in open(os.path.join(d, "matched.jsonl")):
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("v4") or not r.get("data") or r.get("lead_ms") is None:
            continue
        w = r["data"][2:]
        if len(w) < 320:
            continue
        a0, a1, sp = s256(w[0:64]), s256(w[64:128]), int(w[128:192], 16)
        r["a0"], r["a1"], r["sp"] = a0, a1, sp
        r["tf"] = r["t"] - r["lead_ms"]  # when the feed showed it
        rows.append(r)
    if not rows:
        print("no swap data yet")
        return
    pools = sorted({r["pool"] for r in rows})
    tok = pool_tokens(pools, os.path.join(d, "pool-tokens.json"))

    # Per pool: swaps in real (feed) order with price of TOKEN in BASE after each.
    by_pool = defaultdict(list)
    for r in rows:
        t0, t1 = tok.get(r["pool"], [None, None])
        if t0 in BASES and t1 not in BASES:
            token_is0 = False
        elif t1 in BASES and t0 not in BASES:
            token_is0 = True
        else:
            continue
        p10 = (r["sp"] / 2**96) ** 2  # token1 per token0
        if p10 <= 0:
            continue
        price = p10 if token_is0 else 1 / p10  # base per token (units cancel in % moves)
        base_in = (r["a1"] if token_is0 else r["a0"]) > 0  # pool received base = someone BOUGHT the token
        by_pool[r["pool"]].append({"tf": r["tf"], "tn": r["t"], "seq": r["seq"] or 0, "price": price, "buy": base_in,
                                   "to": r.get("to"), "sel": r.get("sel"), "lead": r["lead_ms"]})
    results, routers = [], defaultdict(int)
    hours = (max(r["t"] for r in rows) - min(r["t"] for r in rows)) / 3.6e6
    for pool, sw in by_pool.items():
        sw.sort(key=lambda x: (x["seq"], x["tf"]))
        busy_until = -1
        for i in range(1, len(sw)):
            s = sw[i]
            if not s["buy"] or s["tf"] <= busy_until:
                continue
            win = [x for x in sw[max(0, i - 20):i + 1] if s["tf"] - x["tf"] <= RUSH_WINDOW_MS]
            buys = [x for x in win if x["buy"]]
            if len(buys) < RUSH_BUYS:
                continue
            first = sw.index(buys[0])
            before = sw[first - 1]["price"] if first > 0 else None
            if not before or s["price"] / before - 1 < RUSH_RISE:
                continue
            # FAST lands after everything the feed showed up to tf+react; SLOW after tn+react.
            def entry(at):
                k = max(j for j in range(i, len(sw)) if j == i or sw[j]["tf"] <= at)
                return k, sw[k]["price"]

            def outcome(k, p_in, t_in):
                for x in sw[k + 1:]:
                    if x["tf"] - t_in > HOLD_MS:
                        break
                    g = x["price"] / p_in - 1
                    if g >= TP or g <= -SL:
                        return g, "tp" if g >= TP else "sl"
                later = [x for x in sw[k + 1:] if x["tf"] - t_in <= HOLD_MS]
                return (later[-1]["price"] / p_in - 1 if later else 0.0), "time"

            kf, pf = entry(s["tf"] + react)
            ks, ps = entry(s["tn"] + react)
            gf, ef = outcome(kf, pf, s["tf"] + react)
            gs, es = outcome(ks, ps, s["tn"] + react)
            results.append({"pool": pool, "edge": ps / pf - 1, "gf": gf, "gs": gs, "ef": ef, "es": es,
                            "lead": s["lead"], "skipped_between": ks - kf})
            for b in buys:
                routers[(b["to"], b["sel"])] += 1
            busy_until = s["tf"] + HOLD_MS
    if not results:
        print(f"{len(rows)} V3 swaps over {hours:.2f} h, no rushes yet")
        return
    n = len(results)
    usd = 50.0
    fee = 0.006  # ~0.3% pool fee in and out (typical; real fee tiers vary)
    pf_ = [usd * (r["gf"] - fee) for r in results]
    ps_ = [usd * (r["gs"] - fee) for r in results]
    print(f"RUSH STUDY: {n} rushes in {len(by_pool)} pools over {hours:.2f} h (reaction {react} ms)")
    print(f"  head start on the 3rd buy: median {S.median([r['lead'] for r in results]):.0f} ms")
    print(f"  slow bot pays more than fast: median {100*S.median([r['edge'] for r in results]):+.2f}%  (avg {100*S.mean([r['edge'] for r in results]):+.2f}%)")
    print(f"  trades that land between fast and slow entry: median {S.median([r['skipped_between'] for r in results]):.0f}")
    for name, v, key in (("FAST", pf_, "gf"), ("SLOW", ps_, "gs")):
        wins = sum(1 for x in v if x > 0)
        print(f"  {name}: win {100*wins/n:.0f}% | total ${sum(v):+.2f} (${sum(v)/hours:+.2f}/h) | per trade ${S.mean(v):+.2f}")
    print("  routers used by the rush buys (top 8):")
    tot = sum(routers.values())
    for (to, sel), c in sorted(routers.items(), key=lambda x: -x[1])[:8]:
        print(f"    {to} {sel}  {c} ({100*c/tot:.0f}%)")
    print("  NOTE: prices ignore our own impact and gas, same for both; the gap between FAST and SLOW is the speed edge.")


if __name__ == "__main__":
    main()
