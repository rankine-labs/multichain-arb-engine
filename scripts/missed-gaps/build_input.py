# ============================================================================
# MISSED GAPS - build the list of pools to read on chain (input of chainread.mjs).
# Pools: every pool on a real arbitrage loop (our exchanges, USDG/WETH profit,
# net > $0.10) plus every other known pool of the same coin pairs on an
# exchange we can price (to judge the pair's depth / chain-wide-scan rank).
# History reads: each loop pool at the block just before its arbitrage.
#   PM_DIR=<profit-measure dir> python3 build_input.py <out.json>
# ============================================================================
import sys, json
sys.path.insert(0, __import__('os').path.dirname(__file__))
from load import load_all, round_trip, WETH, ZERO

V2 = {'uniswap-v2', 'pancakeswap-v2', 'ramses-v2'}
V3 = {'uniswap-v3', 'pancakeswap-v3', 'ramses-v3', 'up-cl', 'giga-cl', 'abyss-cl', 'raphael-cl', 'sushiswap-v3', 'topaz-cl', 'swaphood-v3'}

def kind(pid, info):
    if len(pid) == 66: return 'v4'
    if info['dex'] in V2: return 'v2'
    if info['dex'] in V3: return 'v3'
    return None

def pair_key(info):
    a = WETH if info['t0'] == ZERO else info['t0']
    b = WETH if info['t1'] == ZERO else info['t1']
    return tuple(sorted([a, b]))

if __name__ == '__main__':
    P, meta, perDay, sym, dex_of, pair_of = load_all()
    pi = meta['poolInfo']
    L = [x for x in P if x['trust'] == 'ok' and x['oursAny'] and x['net'] > 0.10 and round_trip(x)[0] == 'loop']
    loop_pools = {p for x in L for p in x['a']['pools']}
    pairs = {pair_key(pi[p]) for p in loop_pools if pi.get(p)}
    pools = []
    for pid, info in pi.items():
        if not info: continue
        if pid in loop_pools or pair_key(info) in pairs:
            k = kind(pid, info)
            if k: pools.append({'id': pid, 'dex': info['dex'], 'kind': k, 't0': info['t0'], 't1': info['t1']})
    hist = [{'id': p, 'block': x['a']['block'] - 1} for x in L for p in x['a']['pools'] if pi.get(p) and kind(p, pi[p])]
    json.dump({'pools': pools, 'hist': hist}, open(sys.argv[1], 'w'))
    print(f'{len(pools)} pools, {len(hist)} history reads, {len(L)} loops')
