"""
Rule search for the Robinhood fast-trading idea (research only, read-only data).

Plain English:
  Loads the swaps the probe recorded, rebuilds each pool's price block by
  block, then tries many ENTRY rules ("what counts as a push worth buying")
  and EXIT rules (take-profit / stop-loss / time limit). Each combination is
  simulated on every signal: buy right after the signal block (as the copy
  allows), pay the pool fee both ways, and optionally our own price impact.

  To avoid fooling ourselves, rules are RANKED on a training slice and then
  CHECKED on slices they never saw. Only out-of-sample numbers matter.

Same maths as sniper/src/rhc_report.rs (price from sqrtPriceX96, last price
per block, simulate()).
"""
import json, math, sys, itertools, collections

Q96 = 2.0 ** 96


def token_price(sqrt_price, token_is0):
    x = float(sqrt_price) / Q96
    p = x * x
    if p <= 0 or not math.isfinite(p):
        return None
    return p if token_is0 else 1.0 / p


def size_for_1pct(sqrt_price, liq, token_is0, base):
    """Base coins (whole units) that lift the token price 1% (see rhc_report.rs)."""
    sp = float(sqrt_price) / Q96
    l = float(liq)
    if sp <= 0 or l <= 0:
        return None
    k = math.sqrt(1.01) - 1
    raw = l * sp * k if token_is0 else l * (1 / sp) * k
    return raw / (10 ** (6 if base == "USDG" else 18))


def load(path):
    """Swaps sorted by (block, log_index), de-duplicated."""
    rows, seen = [], set()
    for line in open(path):
        s = json.loads(line)
        key = (s["block"], s["log_index"])
        if key in seen:
            continue
        seen.add(key)
        p = token_price(s["sqrt_price"], s["token_is0"])
        if p is None:
            continue
        rows.append({
            "pool": s["pool"], "token": s["token"], "base": s["base"], "block": s["block"],
            "li": s["log_index"], "tx": s.get("tx") or "", "price": p,
            "fee": (s.get("fee_ppm") or 3000) / 1e6,
            "size1": size_for_1pct(s["sqrt_price"], s["liquidity"], s["token_is0"], s["base"]) if s.get("liquidity") else None,
        })
    rows.sort(key=lambda r: (r["block"], r["li"]))
    return rows


def by_pool(rows):
    d = collections.defaultdict(list)
    for r in rows:
        d[r["pool"]].append(r)
    return d


def paths(pools):
    """pool -> (sorted block list, {block: last price})"""
    out = {}
    for pool, v in pools.items():
        bp = {}
        for r in v:
            bp[r["block"]] = r["price"]
        out[pool] = (sorted(bp), bp)
    return out


# ---------------- entry rules ----------------

def sig_jump(pools, jump_pct, quiet):
    """One single buy lifts the price >= jump_pct (vs the swap before it)."""
    out = []
    for pool, v in pools.items():
        qu = 0
        for a, b in zip(v, v[1:]):
            if b["block"] < qu:
                continue
            if b["price"] / a["price"] - 1 >= jump_pct / 100:
                out.append((pool, b["block"], b))
                qu = b["block"] + quiet
    return out


def sig_crowd(pools, buys, window, rise_pct, quiet):
    """>= `buys` buys from >= `buys` txs within `window` blocks, price up rise_pct."""
    import bisect
    out = []
    for pool, v in pools.items():
        qu = 0
        recent = collections.deque()  # (block, tx) of buys inside the window
        last = None
        price_at = {}
        blocks = []
        i = 0
        while i < len(v):
            b = v[i]["block"]
            rec = None
            while i < len(v) and v[i]["block"] == b:
                p = v[i]["price"]
                if last is not None and p > last:
                    recent.append((b, v[i]["tx"]))
                last = p
                rec = v[i]
                i += 1
            price_at[b] = last
            blocks.append(b)
            lo = b - window + 1
            while recent and recent[0][0] < lo:
                recent.popleft()
            if b < qu or len(recent) < buys or len({t for _, t in recent}) < buys:
                continue
            j = bisect.bisect_left(blocks, lo) - 1
            if j < 0:
                continue
            p0 = price_at[blocks[j]]
            if price_at[b] / p0 - 1 >= rise_pct / 100:
                out.append((pool, b, rec))
                qu = b + quiet
    return out


# ---------------- exit simulation ----------------

def simulate(path, block, delay, tp, sl, horizon, fee, impact_pct=0.0):
    """Net return of one trade (0.01 = +1%), fees both ways and our impact."""
    blocks, bp = path
    import bisect
    j = bisect.bisect_right(blocks, block + delay) - 1
    if j < 0:
        return None
    entry = bp[blocks[j]]
    end = block + delay + horizon
    exitp = entry
    k = j + 1
    while k < len(blocks) and blocks[k] <= end:
        p = bp[blocks[k]]
        exitp = p
        g = p / entry - 1
        if g >= tp or g <= -sl:
            break
        k += 1
    keep = (1 - fee) ** 2
    return exitp / entry * keep - 1 - impact_pct / 100


def stats(res):
    n = len(res)
    if n < 2:
        return None
    m = sum(res) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in res) / (n - 1))
    srt = sorted(res)
    return {"n": n, "avg": 100 * m, "lo": 100 * (m - 1.96 * sd / math.sqrt(n)), "hi": 100 * (m + 1.96 * sd / math.sqrt(n)),
            "med": 100 * srt[n // 2], "win": 100 * sum(1 for x in res if x > 0) / n, "worst": 100 * srt[0]}


def evaluate(pools, pth, signals, delay, tp, sl, horizon, size_usd=None, eth_usd=None):
    res = []
    for pool, block, rec in signals:
        imp = 0.0
        if size_usd is not None:
            if rec["size1"] is None:
                continue
            base_usd = 1.0 if rec["base"] == "USDG" else eth_usd
            # round trip cost of our own impact ~ size / (size that moves 1%) percent
            imp = size_usd / (rec["size1"] * base_usd)
        r = simulate(pth[pool], block, delay, tp, sl, horizon, rec["fee"], imp)
        if r is not None:
            res.append(r)
    return stats(res)


BLOCK_MS = 105.0


def blocks_for(seconds):
    return max(1, round(seconds * 1000 / BLOCK_MS))


def rules():
    """Every entry rule to try."""
    out = []
    for j in [1, 2, 3, 5, 8, 12]:
        out.append(("jump", {"jump_pct": j}))
    for buys, win_s, rise in itertools.product([2, 3, 5], [0.3, 1.0, 3.0], [1, 2, 4, 8]):
        out.append(("crowd", {"buys": buys, "win_s": win_s, "rise": rise}))
    return out


EXITS = [(tp, sl, h) for tp in [0.02, 0.03, 0.05, 0.10, 0.20] for sl in [0.02, 0.05, 0.10, 1.0] for h in [1, 3, 10, 30]]


def make_signals(pools, kind, prm):
    quiet = blocks_for(1.0)
    if kind == "jump":
        return sig_jump(pools, prm["jump_pct"], quiet)
    return sig_crowd(pools, prm["buys"], blocks_for(prm["win_s"]), prm["rise"], quiet)


if __name__ == "__main__":
    print("usage: imported by run_sweep.py")


# ---------------- exact own-impact simulation (concentrated liquidity) ----------------
#
# Plain English: instead of a rough "% cost", actually push our buy through the
# pool at its real depth (active liquidity L at the current price) and later
# push our sell through at the exit price. Within one price band this is the
# exact Uniswap V3/V4 maths; it ignores liquidity changing across bands, which
# is fine for small trades. A trade can never lose more than what we put in.

def load_rich(path):
    """Like load() but keeps raw sqrt price and liquidity for exact impact."""
    rows, seen = [], set()
    for line in open(path):
        s = json.loads(line)
        key = (s["block"], s["log_index"])
        if key in seen or not s.get("liquidity"):
            continue
        seen.add(key)
        p = token_price(s["sqrt_price"], s["token_is0"])
        sp = float(s["sqrt_price"]) / Q96
        L = float(s["liquidity"])
        if p is None or sp <= 0 or L <= 0:
            continue
        rows.append({
            "pool": s["pool"], "token": s["token"], "base": s["base"], "block": s["block"], "li": s["log_index"],
            "tx": s.get("tx") or "", "price": p, "fee": (s.get("fee_ppm") or 3000) / 1e6,
            "sp": sp, "L": L, "t0": s["token_is0"],
            "size1": size_for_1pct(s["sqrt_price"], s["liquidity"], s["token_is0"], s["base"]),
        })
    rows.sort(key=lambda r: (r["block"], r["li"]))
    return rows


def rich_paths(pools):
    """pool -> (sorted blocks, {block: last swap record})"""
    out = {}
    for pool, v in pools.items():
        last = {}
        for r in v:
            last[r["block"]] = r
        out[pool] = (sorted(last), last)
    return out


def buy_tokens(rec, base_raw):
    """Tokens received for base_raw base units (after fee), and new state."""
    sp, L, fee = rec["sp"], rec["L"], rec["fee"]
    b = base_raw * (1 - fee)
    if rec["t0"]:      # token is token0, base is token1: base in raises sqrtP
        s1 = sp + b / L
        return L * (1 / sp - 1 / s1)
    else:              # token is token1, base is token0: base in lowers sqrtP
        s1 = 1 / (1 / sp + b / L)
        return L * (sp - s1)


def sell_tokens(rec, tok):
    """Base received for selling tok tokens into the pool state `rec` (after fee)."""
    sp, L, fee = rec["sp"], rec["L"], rec["fee"]
    x = tok * (1 - fee)
    if rec["t0"]:      # token0 in lowers sqrtP; base (token1) out
        s2 = 1 / (1 / sp + x / L)
        return L * (sp - s2)
    else:              # token1 in raises sqrtP; base (token0) out
        s2 = sp + x / L
        return L * (1 / sp - 1 / s2)


def trade_exact(path, block, delay, tp, sl, horizon, usd, eth_usd):
    """One trade with our real size. Returns (pnl_usd, entry_block, exit_block) or None."""
    import bisect
    blocks, last = path
    j = bisect.bisect_right(blocks, block + delay) - 1
    if j < 0:
        return None
    e = last[blocks[j]]
    base_usd = 1.0 if e["base"] == "USDG" else eth_usd
    dec = 6 if e["base"] == "USDG" else 18
    base_raw = usd / base_usd * 10 ** dec
    tok = buy_tokens(e, base_raw)
    if tok <= 0:
        return None
    entry_price = e["price"]
    end = block + delay + horizon
    x = e
    k = j + 1
    while k < len(blocks) and blocks[k] <= end:
        x = last[blocks[k]]
        g = x["price"] / entry_price - 1
        if g >= tp or g <= -sl:
            break
        k += 1
    out_raw = sell_tokens(x, tok)
    pnl = out_raw / 10 ** dec * base_usd - usd
    return max(pnl, -usd), blocks[j], x["block"]


def one_at_a_time(signals, pths, delay, tp, sl, horizon, usd, eth_usd, max_impact_pct=None):
    """Take signals in time order, only when no trade is open (risk rule).
    Optional depth filter: skip pools where our size would move price > max_impact_pct."""
    busy_until = -1
    pnls = []
    for pool, block, rec in sorted(signals, key=lambda s: s[1]):
        if block <= busy_until:
            continue
        if max_impact_pct is not None:
            if rec.get("size1") is None:
                continue
            base_usd = 1.0 if rec["base"] == "USDG" else eth_usd
            if usd / (rec["size1"] * base_usd) > max_impact_pct:
                continue
        r = trade_exact(pths[pool], block, delay, tp, sl, horizon, usd, eth_usd)
        if r is None:
            continue
        pnl, _, exit_block = r
        pnls.append(pnl)
        busy_until = max(exit_block, block + delay)
    return pnls
