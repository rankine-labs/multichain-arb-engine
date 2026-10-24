# ============================================================================
# MISSED GAPS - why didn't our bot take the arbitrage the profit measure saw?
#
# Plain English:
#   1. Every trusted "arbitrage" on our exchanges with USDG/WETH profit
#      (the $932/day group of results/profit-measure/REPORT.md) is first
#      checked to be a REAL round trip (load.round_trip). Many are one-way
#      sales or buy programs that only look like free money; those are not
#      chances for any arbitrage bot and are counted separately.
#   2. Each real loop is run through the bot's own rules from origin/main:
#        - route length: 2-pool gaps (gap scan / trigger path) or loops of
#          at most 3 pools (LOOP_LIVE_MAX_POOLS default 3); 4+ pools are
#          practice only
#        - can the pair watcher even find every pool? Uniswap V4 pools only
#          at the fee settings in src/config/v4Tiers.ts (v4-tiers.json)
#        - depth: every pool needs $10k+ near its price (core/poolPrice.ts
#          deepEnough / POOL_MIN_DEPTH_USD; V3 capped at its real coins),
#          measured on TODAY'S chain state (chain-state.json; the public node
#          had no history left for the window), so this one is approximate
#        - known taxed coins the loop trader refuses (status page list)
#      Everything a trade passes is listed; the FIRST failing rule (in the
#      order above) is its main reason.
#   3. Trades that pass every rule we can check are split by speed: landed
#      within 2 blocks (a speed race) or later (should have been ours: the
#      reason is something only the server log shows, e.g. not live in that
#      hour, the gap path paused by the scoreboard, a practice check that
#      said no, the 3-a-minute check budget).
#   Writes results/missed-gaps/classified.jsonl and summary.json.
#   PM_DIR=<profit-measure dir> python3 classify.py <chain-state.json> <v4-tiers.json> <out dir>
# ============================================================================
import sys, json, os, statistics
sys.path.insert(0, os.path.dirname(__file__))
from load import load_all, round_trip, WETH, USDG, ZERO

MIN_DEPTH = 10_000          # POOL_MIN_DEPTH_USD default (core/poolPrice.ts)
MIN_NET = 0.25              # MIN_EXEC_NET_USD default (core/types.ts)
LIVE_LOOP_MAX = 3           # LOOP_LIVE_MAX_POOLS default (execution/loopLive.ts)
SLOW = 10                   # "slow" = landed more than 10 blocks (~1 s) after the opener
# Coins the loop trader's coin tax test blocked (status page, Oct 24 02:28 UTC).
TAXED_SYMBOLS = {'VOLT', 'TORCH', 'NET', 'ROBINFUN', 'PRISM', 'fBOMB', 'ENDAI'}

def word(hexs, i=0):
    h = (hexs or '')[2:]
    if len(h) < 64 * (i + 1): return None
    return int(h[64 * i:64 * (i + 1)], 16)

def main():
    chain = json.load(open(sys.argv[1]))
    v4t = json.load(open(sys.argv[2]))
    outdir = sys.argv[3]
    P, meta, perDay, sym, dex_of, pair_of = load_all()
    pi, toks = meta['poolInfo'], meta['tokens']
    dec = lambda t: 18 if t in (ZERO, WETH) else (toks.get(t) or {}).get('d')
    eth = meta['ethMid']

    # ---- token prices: USDG $1, WETH = ETH, others from the measure's own
    # busy-pool prices (median over every arbitrage that priced the coin).
    seen = {}
    with open(os.path.join(os.environ.get('PM_DIR', 'results/profit-measure'), 'arb-prices.jsonl')) as fh:
        for l in fh:
            p = json.loads(l)
            for t, px in (p.get('net') or []) + (p.get('out') or []):
                if px and px.get('usd'): seen.setdefault(t, []).append(px['usd'])
    price = {t: statistics.median(v) for t, v in seen.items()}
    price[USDG] = 1.0; price[WETH] = eth; price[ZERO] = eth
    usd = lambda t: price.get(t)

    # ---- depth of a pool by the bot's rule, from today's state.
    def depth(pid):
        st = chain['latest'].get(pid); info = pi.get(pid)
        if not st or not info: return None
        t0, t1 = info['t0'], info['t1']
        d0, d1 = dec(t0), dec(t1)
        if d0 is None or d1 is None: return None
        if 'reserves' in st:
            r = (st['reserves'] or {}).get('r')
            if not r: return None
            a, b = word(r, 0) / 10 ** d0, word(r, 1) / 10 ** d1
        else:
            s0 = (st.get('slot0') or {}).get('r'); lq = (st.get('liquidity') or {}).get('r')
            sq, L = word(s0, 0), word(lq, 0)
            if not sq or not L: return 0.0
            sp = sq / 2 ** 96
            a, b = L / sp / 10 ** d0, L * sp / 10 ** d1
            if len(pid) == 42:   # V3 (not V4): cap each side at the coins really in the pool
                b0, b1 = word((st.get('bal0') or {}).get('r')), word((st.get('bal1') or {}).get('r'))
                if b0 is not None: a = min(a, b0 / 10 ** d0)
                if b1 is not None: b = min(b, b1 / 10 ** d1)
        ua, ub = usd(t0), usd(t1)
        av = a * ua if ua else None; bv = b * ub if ub else None
        if av is not None and bv is not None: return 2 * min(av, bv)
        if av is not None: return 2 * av
        if bv is not None: return 2 * bv
        return None

    def pair_key(pid):
        i = pi[pid]; a = WETH if i['t0'] == ZERO else i['t0']; b = WETH if i['t1'] == ZERO else i['t1']
        return tuple(sorted([a, b]))
    # Chain-wide scan view of a pair: depth of its 2nd-deepest pool (the scan
    # pins pairs with $2k+ in 2+ pools, ranked by the 2nd-deepest pool).
    pair_pools = {}
    for pid in chain['latest']:
        if pi.get(pid): pair_pools.setdefault(pair_key(pid), []).append(pid)
    def pair_second(k):
        ds = sorted([depth(p) or 0 for p in pair_pools.get(k, [])], reverse=True)
        return ds[1] if len(ds) > 1 else 0

    rows = []
    for x in P:
        if not (x['trust'] == 'ok' and x['oursAny']): continue
        a = x['a']
        rt, rt_why = round_trip(x)
        pools = a['pools']
        n = len(pools)
        slow = x['dBlocks'] is not None and x['dBlocks'] > SLOW
        r = dict(hash=a['hash'], block=a['block'], bot=x['bot'], net=round(x['net'], 4), perDay=perDay(x['net'] * x['w']),
                 w=x['w'], dBlocks=x['dBlocks'], slow=slow, pools=pools, dexes=x['dexes'], pairs=x['pairs'], n=n,
                 size=x['size'], roundTrip=rt, rtWhy=rt_why,
                 coins=sorted({str(sym(h[k])) for h in a['hops'] for k in ('tin', 'tout') if h.get(k)}))
        fails = []
        if rt == 'sale':
            fails.append('not-arbitrage')
        elif rt == 'unknown':
            fails.append('route-unreadable')
        elif rt == 'hidden':
            fails.append('hidden-leg')
        else:
            if n > LIVE_LOOP_MAX: fails.append('route-4plus')
            inv = [p for p in pools if len(p) == 66 and not (v4t.get(p) or {}).get('botFinds')]
            if inv: fails.append('v4-not-looked-up')
            ds = {p: depth(p) for p in pools}
            r['depths'] = {p: (None if v is None else round(v)) for p, v in ds.items()}
            thin = [p for p, v in ds.items() if v is not None and 0 < v < MIN_DEPTH]
            if thin: fails.append('thin-pool')
            # No money at all in it today: emptied since the window (meme pool
            # pulled), so its depth at the time is unknown (likely small).
            elif any(v == 0 for v in ds.values()): fails.append('pool-emptied-since')
            if any(v is None for v in ds.values()): r['depthUnknown'] = True
            r['pairSecondUsd'] = {'/'.join(sym(t) for t in pair_key(p)): round(pair_second(pair_key(p))) for p in pools if pi.get(p)}
            if any(c in TAXED_SYMBOLS for c in r['coins']): fails.append('taxed-coin')
            # Soft note (not a reason): a coin that is in no pair the chain-wide
            # scan would pin ($2k+ in 2+ pools) is probably not on the safety
            # allowlist unless auto-vetted (22 coins, list only on the server).
            coins = {t for h in a['hops'] for t in (h.get('tin'), h.get('tout')) if t and t not in (WETH, USDG, ZERO)}
            r['coinMaybeNotVetted'] = sorted(str(sym(t)) for t in coins if not any(pair_second(k) >= 2000 for k in pair_pools if t in k))
            if x['net'] < MIN_NET: fails.append('under-min')
            if not fails: fails.append('passes-rules-race' if (x['dBlocks'] is not None and x['dBlocks'] <= 2) else 'passes-rules-slow')
        r['fails'] = fails
        r['reason'] = fails[0]
        rows.append(r)

    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, 'classified.jsonl'), 'w') as fh:
        for r in rows: fh.write(json.dumps(r) + '\n')
    # Summaries: by main reason, for all, >$0.25, slow >$0.25.
    def summ(sel):
        out = {}
        for r in sel:
            e = out.setdefault(r['reason'], {'count': 0, 'perDay': 0.0, 'slowCount': 0, 'slowPerDay': 0.0})
            e['count'] += 1; e['perDay'] += r['perDay']
            if r['slow']: e['slowCount'] += 1; e['slowPerDay'] += r['perDay']
        return dict(sorted(out.items(), key=lambda kv: -kv[1]['perDay']))
    # Every rule a real loop fails (not only the first), >$0.25.
    allfails = {}
    for r in rows:
        if r['net'] > MIN_NET and r['roundTrip'] == 'loop':
            for f in r['fails']:
                e = allfails.setdefault(f, {'count': 0, 'perDay': 0.0}); e['count'] += 1; e['perDay'] += r['perDay']
    summary = {
        'all': summ(rows), 'over025': summ([r for r in rows if r['net'] > MIN_NET]),
        'everyRuleFailedOver025Loops': allfails,
        'totals': {'all': sum(r['perDay'] for r in rows), 'over025': sum(r['perDay'] for r in rows if r['net'] > MIN_NET)},
        'chainStateBlock': chain['headBlock'], 'oldestStateBlock': chain['oldestStateBlock'],
    }
    json.dump(summary, open(os.path.join(outdir, 'summary.json'), 'w'), indent=1)
    for k in ('all', 'over025'):
        print(k)
        for reason, e in summary[k].items(): print(f"  {reason:22s} {e['count']:5d} ${e['perDay']:8.2f}/day   slow {e['slowCount']:4d} ${e['slowPerDay']:7.2f}")
    print('every rule failed (>$0.25 real loops):', {k: (v['count'], round(v['perDay'], 1)) for k, v in allfails.items()})

if __name__ == '__main__':
    main()
