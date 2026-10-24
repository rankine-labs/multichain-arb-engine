# ============================================================================
# MISSED GAPS - shared loader. Re-creates the profit-measure report's pricing
# (scripts/profit-measure/report.mjs price()) in Python so every arbitrage gets
# the same net $, trust label and "ours" flags as REPORT.md.
#   from load import load_all  ->  list of dicts (one per arbitrage)
# Data dir: argv / env PM_DIR (files from origin/profit-measure-run).
# ============================================================================
import json, os

PM = os.environ.get('PM_DIR', 'results/profit-measure')
WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
ZERO = '0x0000000000000000000000000000000000000000'

def _lines(f):
    with open(os.path.join(PM, f)) as fh:
        for l in fh:
            l = l.strip()
            if l: yield json.loads(l)

def load_meta():
    return json.load(open(os.path.join(PM, 'meta.json')))

def load_all():
    meta = load_meta()
    timing = json.load(open(os.path.join(PM, 'timing.json')))
    prices = {p['hash']: p for p in _lines('arb-prices.jsonl')}
    tradeable = set(meta['tradeable'])
    cov = {1: meta['tier1']['read'] / max(1, meta['tier1']['total']), 2: meta['tier2']['read'] / max(1, meta['tier2']['total'])}
    H = meta['window']['hours']
    toks, pinfo = meta['tokens'], meta['poolInfo']
    dec = lambda t: 18 if t == ZERO else (toks.get(t) or {}).get('d')
    sym = lambda t: 'WETH' if t in (WETH, ZERO) else 'USDG' if t == USDG else ((toks.get(t) or {}).get('s') or t[:8])
    def dex_of(p):
        i = pinfo.get(p)
        return i['dex'] if i else ('uniswap-v4(?)' if len(p) == 66 else 'unknown')
    def pair_of(p):
        i = pinfo.get(p)
        if not i: return '?'
        if i.get('pair'): return i['pair']
        return '/'.join([sym(i['t0']), sym(i['t1'])])
    out = []
    for a in _lines('arbs.jsonl'):
        p = prices.get(a['hash'])
        def px_of(t):
            if t == USDG: return {'usd': 1, 'vol': float('inf')}
            if t in (WETH, ZERO): return {'usd': (p or {}).get('eth') or meta['ethMid'], 'vol': float('inf')}
            for tt, px in list((p or {}).get('net', [])) + list((p or {}).get('out', [])):
                if tt == t and px: return px
            return None
        gross, unpriced, thin = 0.0, False, False
        for t, raw in a['net']:
            px, d = px_of(t), dec(t)
            if not px or d is None: unpriced = True; continue
            if t not in (USDG, WETH) and (px.get('vol') or 0) < 1000: thin = True
            gross += int(raw) / 10 ** d * px['usd']
        size = None
        h0 = a['hops'][0] if a['hops'] else None
        if h0 and h0.get('tin') and h0.get('ain') and dec(h0['tin']) is not None:
            px0 = px_of(h0['tin']) or (p or {}).get('hop0')
            if px0: size = int(h0['ain']) / 10 ** dec(h0['tin']) * px0['usd']
        eth = (p or {}).get('eth') or meta['ethMid']
        gas = int(a['gasWei']) / 1e18 * eth
        g = None if unpriced else gross
        doubtful = thin or (g is not None and size and size > 0 and g > 0.05 * size) or (g is not None and size is None and g > 50) \
            or 'v4-native-leg-hidden' in a['uncertain'] or 'v4-pool-unknown' in a['uncertain']
        coins = [t for t, v in a['net'] if int(v) > 0]
        dexes = [dex_of(x) for x in a['pools']]
        base_coin = len(coins) >= 1 and all(t in (USDG, WETH) for t in coins)
        pairs = [pair_of(x) for x in a['pools']]
        tm = timing.get(a['hash'], {})
        out.append(dict(a=a, gross=g, gas=gas, net=None if g is None else g - gas, size=size,
            trust='unpriced' if g is None else 'doubtful' if doubtful else 'ok',
            coins=coins, profitCoin=sym(coins[0]) if len(coins) == 1 else ('mixed' if coins else '?'),
            dexes=dexes, pairs=pairs, allTradeable=all(d in tradeable for d in dexes), baseCoin=base_coin,
            twoSamePair=len(a['pools']) == 2 and pairs[0] == pairs[1] and pairs[0] != '?',
            bot=a['executor'], w=1 / max(1e-9, cov.get(a.get('tier'), 1)),
            dBlocks=tm.get('dBlocks'), trigTo=tm.get('trigTo'), trigBlock=tm.get('trigBlock'), arbBetween=tm.get('arbBetween')))
        out[-1]['oursAny'] = out[-1]['allTradeable'] and base_coin
    return out, meta, (lambda x: x * 24 / H), sym, dex_of, pair_of

# ----------------------------------------------------------------------------
# REAL ROUND TRIP CHECK (added for missed-gaps). The profit measure counts a
# transaction as arbitrage when the trader "ends with more of a coin and less
# of none" by its Transfer logs. Coins paid into a Uniswap V4 pool go to the
# PoolManager and some routers pull coins straight from the user, so a plain
# SALE (e.g. BOOMER -> USDG -> WETH) can look like free WETH. Here we rebuild
# each coin's balance from the pools' own in/out amounts:
#   real loop = every coin other than the profit coin comes back to ~zero
#   (within 0.5%), and the profit coin is also one of the coins paid in.
# Returns (verdict, detail): 'loop' | 'sale' (a coin came from outside) |
# 'hidden' (a leg went through an exchange we can't read) |
# 'unknown' (a hop's coins could not be read, e.g. unnamed V4 pool).
# ----------------------------------------------------------------------------
def round_trip(x):
    a = x['a']
    bal, flow = {}, {}
    for h in a['hops']:
        if not h.get('tin') or not h.get('tout') or h.get('ain') is None or h.get('aout') is None:
            return 'unknown', 'hop coins not readable'
        tin, tout = h['tin'], h['tout']
        if tin == ZERO: tin = WETH
        if tout == ZERO: tout = WETH
        bal[tin] = bal.get(tin, 0) - int(h['ain']); flow[tin] = flow.get(tin, 0) + int(h['ain'])
        bal[tout] = bal.get(tout, 0) + int(h['aout']); flow[tout] = flow.get(tout, 0) + int(h['aout'])
    profit = set(x['coins'])
    ins = {(h['tin'] if h['tin'] != ZERO else WETH) for h in a['hops']}
    if not (profit & ins):
        return 'sale', 'profit coin never paid in (one-way trade)'
    for c, b in bal.items():
        if c in profit: continue
        if b < 0 and -b > 0.005 * flow[c]:
            return 'sale', f'coin {c[:10]} paid in from outside'
    # A coin the seen pools paid out but no seen pool took back: one leg of the
    # route went through an exchange whose swaps we cannot read (not ours).
    for c, b in bal.items():
        if c in profit: continue
        if b > 0 and b > 0.005 * flow[c]:
            return 'hidden', f'coin {c[:10]} left through a leg we cannot see'
    return 'loop', ''
