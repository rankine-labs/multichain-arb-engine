#!/usr/bin/env python3
# ============================================================================
# CHAIN REPLAY: what would the sniper have made over the last N days?
#
# Plain English:
#   Reads every Uniswap V3 swap on Robinhood Chain for the last N days
#   (default 3) straight from the node's history (eth_getLogs, a few
#   thousand blocks per request) and runs the paper trader's rules on them,
#   in order, as if the bot had been running the whole time:
#     rush     = 3+ DIFFERENT wallets buy within ~1 s and lift the price 2%+
#     filters  = 3+ sells already seen in that pool, price not already up
#                more than 8% since the rush began, pool deep enough that a
#                buy-then-sell at our size costs <= 1.5% (else "too thin")
#     entry    = we land 2 blocks AFTER the rush block (the race check: late)
#     exit     = +5% net take profit, -10% net stop loss, or 60 s
#     one position at a time, $50 per trade (smaller if the pool is thin)
#   Prices come from each swap's own sqrtPriceX96; our own price impact
#   comes from the pool's liquidity in the same event (exact within the
#   current tick), plus the pool fee both ways and ~$0.01 gas a side.
#
#   What it CAN'T know (so treat the result as an estimate, not a fact):
#     - no trap check at the time: afterwards it runs today's trap check on
#       every token it traded and reports the total with and without the
#       tokens that fail it now;
#     - no real quotes: impact is computed within the current tick only;
#     - nobody reacts to our trades.
#   To check it, it also replays run 5's own hours: compare with the paper
#   trader's real numbers for the same time.
#
#   Read-only. Node: SNIPER_RHC_HTTP (the paid node; the free one keeps no
#   history). About 1 request per 2,000 blocks: ~1,300 for 3 days.
#
# Usage: python3 deploy/replay.py [days=3] [out=replay-out]
# ============================================================================
import json
import os
import sys
import time
import urllib.request
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor

RPC = os.environ.get("SNIPER_RHC_HTTP", "https://rpc.mainnet.chain.robinhood.com")
WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"
USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa"
QUOTER = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7"
MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11"
SWAP_V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
BLOCK_S = 0.105  # Robinhood block time (paper.rs uses the same)

# Paper trader rules (deploy/run.env + paper.rs defaults)
RUSH_BUYS, WINDOW_BLOCKS, RUSH_RISE = 3, round(1.0 / BLOCK_S), 0.02
MIN_SELLS, MAX_RISE = 3, 0.08
TP, SL, HOLD_BLOCKS = 0.05, 0.10, round(60 / BLOCK_S)
# Price path kept after each rush (longer than the 60 s hold, so exit
# policies with longer holds can be tested): REPLAY_PATH_SECS.
PATH_BLOCKS = round(float(os.environ.get("REPLAY_PATH_SECS", "60")) / BLOCK_S)

# Exit policies to compare (REPLAY_POLICIES=1). Each: fixed take profit
# (tp), trailing take profit (start trailing once up `trail` net, sell when
# it falls `gap` below its best), stop loss (sl), most time held (hold_s).
POLICIES = [
    ("now: TP 5% / SL 10% / 60s", dict(tp=0.05, trail=None, gap=None, sl=0.10, hold_s=60)),
    ("TP 3%", dict(tp=0.03, trail=None, gap=None, sl=0.10, hold_s=60)),
    ("TP 8%", dict(tp=0.08, trail=None, gap=None, sl=0.10, hold_s=60)),
    ("trail from +3%, sell 2% off best, 60s", dict(tp=None, trail=0.03, gap=0.02, sl=0.10, hold_s=60)),
    ("trail from +3%, sell 2% off best, 180s", dict(tp=None, trail=0.03, gap=0.02, sl=0.10, hold_s=180)),
    ("trail from +5%, sell 3% off best, 60s", dict(tp=None, trail=0.05, gap=0.03, sl=0.10, hold_s=60)),
    ("trail from +5%, sell 3% off best, 180s", dict(tp=None, trail=0.05, gap=0.03, sl=0.10, hold_s=180)),
    ("trail from +5%, sell 2% off best, 180s", dict(tp=None, trail=0.05, gap=0.02, sl=0.10, hold_s=180)),
    ("TP 5% / SL 5% / 60s", dict(tp=0.05, trail=None, gap=None, sl=0.05, hold_s=60)),
    ("trail from +3%, sell 2% off, SL 5%, 180s", dict(tp=None, trail=0.03, gap=0.02, sl=0.05, hold_s=180)),
]


def exit_on_path(rets, pol):
    """rets: [(block offset from entry, net return)] after entry, in order.
    Returns (net return at exit, reason, block offset). Shared by the
    replay and deploy/trail-test.py."""
    hold = round(pol["hold_s"] / BLOCK_S)
    peak = None
    last = None
    for off, ret in rets:
        if off > hold:
            break
        last = (ret, off)
        peak = ret if peak is None else max(peak, ret)
        if ret <= -pol["sl"]:
            return ret, "stop_loss", off
        if pol["tp"] is not None and ret >= pol["tp"]:
            return ret, "take_profit", off
        if pol["trail"] is not None and peak >= pol["trail"] and ret <= peak - pol["gap"]:
            return ret, "trail", off
    if last is None:
        return None, "time", hold
    return last[0], "time", last[1]
LATE_BLOCKS = 2
USD, MAX_RT = 50.0, 0.015
GAS_USD = 0.01  # per side, run 5 paid $0.80 for 75 trades (both sides)

Q96 = 2 ** 96
calls_made = 0


def rpc(method, params, tries=8):
    """One JSON-RPC call, patient on errors. Never prints the node URL."""
    global calls_made
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    last = None
    for attempt in range(tries):
        try:
            calls_made += 1
            req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                v = json.loads(r.read())
            if "error" in v:
                last = str(v["error"])[:200]
                # a too-big range is the caller's job to split
                if any(w in last.lower() for w in ("range", "limit", "too many", "exceed", "size")):
                    raise ValueError(last)
            else:
                return v["result"]
        except ValueError:
            raise
        except Exception as e:  # network trouble: wait and retry
            last = type(e).__name__
        time.sleep(min(2 ** attempt, 30))
    raise RuntimeError(f"{method} failed: {last}")


def s256(h):
    v = int(h, 16)
    return v - (1 << 256) if v >= 1 << 255 else v


# ---------------------------------------------------------------- fetching --
def get_logs(a, b):
    """All V3 swaps in blocks a..b; splits the range if the node refuses it."""
    try:
        return rpc("eth_getLogs", [{"fromBlock": hex(a), "toBlock": hex(b), "topics": [SWAP_V3]}])
    except ValueError:
        if a == b:
            raise
        m = (a + b) // 2
        return get_logs(a, m) + get_logs(m + 1, b)


def block_time(n):
    return int(rpc("eth_getBlockByNumber", [hex(n), False])["timestamp"], 16)


# ------------------------------------------------------------ pool lookup --
def _enc_aggregate3(calls):
    n = len(calls)
    out = "82ad56cb" + "%064x" % 0x20 + "%064x" % n
    size = 32 * 5
    out += "".join("%064x" % (32 * n + i * size) for i in range(n))
    for target, data in calls:
        d = data[2:]
        out += target[2:].lower().rjust(64, "0") + "%064x" % 1 + "%064x" % 0x60 + "%064x" % (len(d) // 2) + d.ljust(64, "0")
    return "0x" + out


def _dec_aggregate3(hexdata):
    b = bytes.fromhex(hexdata[2:])
    word = lambda o: int.from_bytes(b[o:o + 32], "big")
    base = word(0)
    n = word(base)
    start = base + 32
    res = []
    for i in range(n):
        t = start + word(start + 32 * i)
        ok, off = word(t), t + word(t + 32)
        ln = word(off)
        res.append("0x" + b[off + 32:off + 32 + ln].hex() if ok and ln >= 32 else None)
    return res


def pool_facts(pools, cache):
    """token0, token1, fee, factory per pool (Multicall3, 50 pools a request)."""
    todo = [p for p in pools if p not in cache]
    for i in range(0, len(todo), 50):
        chunk = todo[i:i + 50]
        calls = []
        for p in chunk:
            calls += [(p, "0x0dfe1681"), (p, "0xd21220a7"), (p, "0xddca3f43"), (p, "0xc45a0155")]
        r = rpc("eth_call", [{"to": MULTICALL3, "data": _enc_aggregate3(calls)}, "latest"])
        vals = _dec_aggregate3(r)
        for j, p in enumerate(chunk):
            t0, t1, fee, fac = vals[4 * j:4 * j + 4]
            cache[p] = {
                "t0": "0x" + t0[-40:] if t0 else None,
                "t1": "0x" + t1[-40:] if t1 else None,
                "fee": int(fee, 16) if fee else None,
                "factory": "0x" + fac[-40:] if fac else None,
            }
    return cache


def eth_usd():
    """ETH price now, from the quoter (1 WETH -> USDG, 0.05% pool)."""
    for fee in (500, 3000, 100):
        d = "0xc6a5026a" + WETH[2:].rjust(64, "0") + USDG[2:].rjust(64, "0") + "%064x" % 10**18 + "%064x" % fee + "0" * 64
        try:
            r = rpc("eth_call", [{"to": QUOTER, "data": d}, "latest"], tries=2)
            if r and len(r) >= 66:
                return int(r[2:66], 16) / 1e6
        except Exception:
            pass
    return 3000.0


# --------------------------------------------------------------- the rules --
class PoolState:
    __slots__ = ("buys", "prices", "last", "cool", "sells")

    def __init__(self):
        self.buys = deque()  # (block, buyer, price_before)
        self.prices = deque()  # (block, last price in that block)
        self.last = None
        self.cool = 0
        self.sells = 0


def on_swap(st, block, buyer, price):
    """paper.rs Detector::on_swap, line for line. Returns (start, price) on a rush."""
    if st.last is not None:
        if price > st.last:
            st.buys.append((block, buyer, st.last))
        elif price < st.last:
            st.sells += 1
    st.last = price
    if st.prices and st.prices[-1][0] == block:
        st.prices[-1] = (block, price)
    else:
        st.prices.append((block, price))
    lo = block - (WINDOW_BLOCKS - 1)
    while st.buys and st.buys[0][0] < lo:
        st.buys.popleft()
    while len(st.prices) > 2 and st.prices[1][0] < lo:
        st.prices.popleft()
    if block < st.cool or len(st.buys) < RUSH_BUYS:
        return None
    if len({w for _, w, _ in st.buys}) < RUSH_BUYS:
        return None
    p0 = next((p for b, p in reversed(st.prices) if b < lo), None)
    if p0 is None or price / p0 - 1 < RUSH_RISE:
        return None
    st.cool = block + WINDOW_BLOCKS
    return (st.buys[0][2], price)


def impact_side(sqrt_q96, liq, base_is1, base_raw):
    """Our own price impact on ONE side (buy or sell) at this size, within the
    current tick (V3 maths), as a fraction of the spot price. Paper quotes
    buy and sell each on the pool as it is, so a round trip costs about
    2 x fee + 2 x this. (Crossing into thinner ticks is not modelled, so thin
    pools look a little better than they are; the round-trip limit filters
    most of them.)
      base is token1: impact = dy / (L * sqrtP)
      base is token0: impact = dx * sqrtP / L"""
    if liq <= 0:
        return 1.0
    s = sqrt_q96 / Q96
    return base_raw / (liq * s) if base_is1 else base_raw * s / liq


def main():
    days = float(sys.argv[1]) if len(sys.argv) > 1 else 3.0
    out = sys.argv[2] if len(sys.argv) > 2 else "replay-out"
    os.makedirs(out, exist_ok=True)
    head = int(rpc("eth_blockNumber", []), 16)
    t_head = block_time(head)
    start = head - int(days * 86400 / BLOCK_S)
    eth = eth_usd()
    print(f"replay: blocks {start}..{head} (~{days} days), ETH ${eth:.0f}", file=sys.stderr)

    # Pass 1: walk every swap in order. Keep, per pool, the rush detector in
    # BOTH directions (we don't know which side is the token until we look
    # the pool up), and record every candidate rush with the pool's swaps
    # for the next 60 s + late blocks.
    states = defaultdict(PoolState)  # key: pool or pool+"~" (mirror)
    rushes = []  # dicts, filled in as their windows complete
    open_watch = defaultdict(list)  # pool -> rushes still collecting prices
    chunk = 2000
    ranges = [(a, min(a + chunk - 1, head)) for a in range(start, head + 1, chunk)]
    stamps = {}
    n_swaps = 0
    t0 = time.time()
    with ThreadPoolExecutor(4) as ex:
        for i, logs in enumerate(ex.map(lambda r: get_logs(*r), ranges)):
            a, b = ranges[i]
            if i % 25 == 0:
                stamps[a] = block_time(a)
                el = time.time() - t0
                print(f"replay: {i}/{len(ranges)} chunks, {n_swaps} swaps, {len(rushes)} rushes, {el/60:.1f} min", file=sys.stderr)
            logs.sort(key=lambda l: (int(l["blockNumber"], 16), int(l["logIndex"], 16)))
            for l in logs:
                if l.get("removed"):
                    continue
                n_swaps += 1
                pool = l["address"].lower()
                block = int(l["blockNumber"], 16)
                d = l["data"][2:]
                if len(d) < 64 * 5:
                    continue
                sq = int(d[128:192], 16)
                liq = int(d[192:256], 16)
                if sq == 0:
                    continue
                p1 = (sq / Q96) ** 2  # token1 per token0
                buyer = "0x" + l["topics"][2][-40:] if len(l["topics"]) > 2 else l["transactionHash"]
                tick = (block, p1, sq, liq)
                # feed open windows first (the rush's own later swaps count)
                if pool in open_watch:
                    keep = []
                    for r in open_watch[pool]:
                        if block <= r["block"] + LATE_BLOCKS + max(HOLD_BLOCKS, PATH_BLOCKS):
                            r["path"].append(tick)
                            keep.append(r)
                    if keep:
                        open_watch[pool] = keep
                    else:
                        del open_watch[pool]
                # price of token0 in token1 rises = token0 bought; mirror = token1 bought
                for key, px, side in ((pool, p1, 0), (pool + "~", 1 / p1, 1)):
                    st = states[key]
                    hit = on_swap(st, block, buyer, px)
                    if hit:
                        r = {"pool": pool, "token_side": side, "block": block, "start": hit[0], "price": hit[1],
                             "sells": st.sells, "path": [tick]}
                        rushes.append(r)
                        open_watch[pool].append(r)
    print(f"replay: {n_swaps} swaps, {len(rushes)} candidate rushes, {calls_made} node requests", file=sys.stderr)

    # Which candidates are real (Uniswap V3 factory, token vs WETH/USDG in
    # the direction the rush was seen)?
    cache_path = os.path.join(out, "pools.json")
    cache = json.load(open(cache_path)) if os.path.exists(cache_path) else {}
    pool_facts(sorted({r["pool"] for r in rushes}), cache)
    json.dump(cache, open(cache_path, "w"))

    def blk_time(n):
        ks = sorted(stamps)
        lo = max((k for k in ks if k <= n), default=ks[0])
        return stamps[lo] + (n - lo) * BLOCK_S

    # Pass 2: trade them in time order, one position at a time.
    rushes.sort(key=lambda r: r["block"])

    def run_policy(pol):
        trades, skips = [], defaultdict(int)
        busy_until = -1
        for r in rushes:
            f = cache.get(r["pool"]) or {}
            if f.get("factory") != V3_FACTORY or not f.get("t0"):
                continue
            t0, t1 = f["t0"], f["t1"]
            token = t0 if r["token_side"] == 0 else t1
            base = t1 if r["token_side"] == 0 else t0
            if base not in (WETH, USDG) or token in (WETH, USDG):
                continue
            skips["rushes"] += 1
            if r["block"] <= busy_until:
                skips["busy"] += 1
                continue
            if r["sells"] < MIN_SELLS:
                skips["no sell history"] += 1
                continue
            if r["price"] / r["start"] - 1 > MAX_RISE:
                skips["already jumped"] += 1
                continue
            fee = (f["fee"] or 3000) / 1e6
            base_is1 = r["token_side"] == 0
            usd_per_base = eth if base == WETH else 1.0
            dec = 18 if base == WETH else 6
            # entry: last swap at or before rush block + late blocks
            entry_blk = r["block"] + LATE_BLOCKS
            path = r["path"]
            ent = None
            for k, tk in enumerate(path):
                if tk[0] <= entry_blk:
                    ent = (k, tk)
                else:
                    break
            k0, (eb, ep1, esq, eliq) = ent
            # size: largest of 50 / 25 within the round-trip limit (auto, capped $50)
            usd = None
            for s in (USD, 25.0):
                imp1 = impact_side(esq, eliq, base_is1, s / usd_per_base * 10**dec)
                if 2 * fee + 2 * imp1 <= MAX_RT:
                    usd, imp = s, imp1
                    break
            if usd is None:
                skips["too thin"] += 1
                continue
            tok_px = lambda p1: p1 if r["token_side"] == 0 else 1 / p1  # base per token
            entry = tok_px(ep1) * (1 + fee) * (1 + imp)
            rets = [(tk[0] - entry_blk, tok_px(tk[1]) * (1 - fee) * (1 - imp) / entry - 1) for tk in path[k0 + 1:]]
            ret, why, off = exit_on_path(rets, pol)
            if ret is None:  # nobody traded after us: sell at the entry price level
                ret = tok_px(ep1) * (1 - fee) * (1 - imp) / entry - 1
            xb = entry_blk + off
            net = usd * ret - 2 * GAS_USD
            busy_until = xb
            trades.append({"pool": r["pool"], "token": token, "base": "WETH" if base == WETH else "USDG", "block": r["block"],
                           "t": blk_time(r["block"]), "usd": usd, "net": round(net, 4), "exit": why})
        return trades, skips

    trades, skips = run_policy(POLICIES[0][1])
    if os.environ.get("REPLAY_POLICIES") == "1":
        excl = set()
        import glob
        for f in glob.glob(os.path.join(os.path.dirname(os.path.abspath(out)), "paper-out", "*", "blocked_tokens.json")) + glob.glob(os.environ.get("REPLAY_BLOCKED_GLOB", "/nonexistent")):
            try:
                excl |= {k.lower() for k in json.load(open(f))}
            except Exception:
                pass
        print(f"EXIT POLICIES ({len(excl)} known taxed/trap tokens left out of the second total)")
        for name, pol in POLICIES:
            ts, _ = run_policy(pol)
            c = [t for t in ts if t["token"] not in excl]
            w = sum(1 for t in c if t["net"] > 0)
            wins = [t["net"] for t in c if t["net"] > 0]
            loss = [t["net"] for t in c if t["net"] <= 0]
            print(f"  {name:44s} all ${sum(t['net'] for t in ts):+8.2f} | clean {len(c):4d} trades wins {100*w/max(1,len(c)):3.0f}% ${sum(t['net'] for t in c):+8.2f} | avg win ${sum(wins)/max(1,len(wins)):+.2f} avg loss ${sum(loss)/max(1,len(loss)):+.2f}")

    # Today's trap check on every token we traded (eth_simulateV1, like taxcheck.rs).
    trapped = set()
    for tok in sorted({t["token"] for t in trades}):
        pool = next(t["pool"] for t in trades if t["token"] == tok)
        if not trap_ok(tok, pool):
            trapped.add(tok)

    json.dump({"trades": trades, "skips": skips, "trapped": sorted(trapped)}, open(os.path.join(out, "replay.json"), "w"))
    print(report(trades, skips, trapped, days, t_head))
    print(f"(node requests: {calls_made})", file=sys.stderr)


TEST = "0x5afe0000000000000000000000000000c0ffee01"


def trap_ok(token, pool):
    """Same idea as taxcheck.rs: 0.1% of the pool's tokens pool->test wallet,
    then 90% back. Refused or short by > 0.05% = trap/tax. Errors count as ok
    (unknown), so the 'without trapped' total is never flattered."""
    try:
        bal = rpc("eth_call", [{"to": token, "data": "0x70a08231" + pool[2:].rjust(64, "0")}, "latest"], tries=3)
        held = int(bal, 16)
        amt = held // 1000
        if amt == 0:
            return True
        back = amt * 9 // 10
        tr = lambda to, a: "0xa9059cbb" + to[2:].rjust(64, "0") + "%064x" % a
        bo = lambda w: "0x70a08231" + w[2:].rjust(64, "0")
        calls = [{"from": pool, "to": token, "data": tr(TEST, amt)}, {"to": token, "data": bo(TEST)},
                 {"from": TEST, "to": token, "data": tr(pool, back)}, {"to": token, "data": bo(pool)}]
        r = rpc("eth_simulateV1", [{"blockStateCalls": [{"calls": calls}], "validation": False}, "latest"], tries=3)
        c = r[0]["calls"]
        if c[0]["status"] != "0x1" or c[2]["status"] != "0x1":
            return False
        got = int(c[1]["returnData"], 16)
        if got * 10000 < amt * 9995:
            return False
        after = int(c[3]["returnData"], 16)
        return (after - (held - amt)) * 10000 >= back * 9995
    except Exception:
        return True


def report(trades, skips, trapped, days, t_head):
    def summ(ts):
        if not ts:
            return "no trades"
        n = len(ts)
        tot = sum(t["net"] for t in ts)
        w = sum(1 for t in ts if t["net"] > 0)
        return f"{n} trades | wins {100*w/n:.0f}% | total ${tot:+.2f} | per trade ${tot/n:+.2f}"

    lines = [f"CHAIN REPLAY, last {days:g} days (estimate: rules of run 5, $50 max, land 2 blocks late)"]
    lines.append("all trades:              " + summ(trades))
    clean = [t for t in trades if t["token"] not in trapped]
    lines.append(f"without {len(trapped)} trap tokens:  " + summ(clean))
    lines.append("skips: " + " | ".join(f"{k} {v}" for k, v in skips.items()))
    ex = defaultdict(int)
    for t in trades:
        ex[t["exit"]] += 1
    lines.append("exits: " + json.dumps(ex))
    # per day and per 4-hour block (Toronto time = UTC-5)
    by_day, by_hour = defaultdict(list), defaultdict(list)
    for t in clean:
        lt = time.gmtime(t["t"] - 5 * 3600)
        by_day[time.strftime("%a %b %d", lt)].append(t)
        by_hour[lt.tm_hour // 4 * 4].append(t)
    lines.append("per day (Toronto, no trap tokens):")
    for d in sorted(by_day, key=lambda d: min(t["t"] for t in by_day[d])):
        lines.append(f"  {d}: " + summ(by_day[d]))
    lines.append("by time of day (Toronto):")
    for h in sorted(by_hour):
        lines.append(f"  {h:02d}:00-{h+4:02d}:00: " + summ(by_hour[h]))
    top = defaultdict(lambda: [0, 0.0])
    for t in clean:
        top[t["token"]][0] += 1
        top[t["token"]][1] += t["net"]
    lines.append("top tokens by profit:")
    for tok, (n, v) in sorted(top.items(), key=lambda kv: -kv[1][1])[:8]:
        lines.append(f"  {tok} {n} trades ${v:+.2f}")
    lines.append("worst tokens:")
    for tok, (n, v) in sorted(top.items(), key=lambda kv: kv[1][1])[:5]:
        lines.append(f"  {tok} {n} trades ${v:+.2f}")
    return "\n".join(lines)


if __name__ == "__main__":
    main()
