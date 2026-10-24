# ============================================================================
# MISSED GAPS - what would each rule change unlock? (reads classified.jsonl)
#
# Plain English: take the REAL loops over $0.25 (sales, part-hidden routes and
# unreadable ones are left out: no bot could copy them) and ask, one change
# at a time, how many more of them would pass every rule we can check:
#   - depth bar lowered from $10k to $5k / $2k / $1k (POOL_MIN_DEPTH_USD)
#   - every hook-free V4 fee setting looked up (src/config/v4Tiers.ts)
#   - live loops up to 4 / 5 pools (LOOP_LIVE_MAX_POOLS)
#   - all three together
# Each result is split into "race" (winner landed within 2 blocks of the
# trade that opened the gap: we must be fast to get it) and "slow".
#   python3 whatif.py <classified.jsonl> <out.json>
# ============================================================================
import sys, json

rows = [json.loads(l) for l in open(sys.argv[1])]
real = [r for r in rows if r['roundTrip'] == 'loop' and r['net'] > 0.25]

def passes(r, depth=10_000, all_v4=False, max_pools=3):
    f = set(r['fails']) - {'passes-rules-race', 'passes-rules-slow'}
    if r['n'] > max_pools: return False
    if 'v4-not-looked-up' in f and not all_v4: return False
    ds = [v for v in (r.get('depths') or {}).values() if v is not None]
    if any(0 < v < depth for v in ds): return False
    if any(v == 0 for v in ds): return False      # emptied since: unknown, not counted
    if 'taxed-coin' in f: return False
    return True

def tally(sel):
    race = [r for r in sel if r['dBlocks'] is not None and r['dBlocks'] <= 2]
    slow = [r for r in sel if not (r['dBlocks'] is not None and r['dBlocks'] <= 2)]
    return {'count': len(sel), 'perDay': round(sum(r['perDay'] for r in sel), 2),
            'raceCount': len(race), 'racePerDay': round(sum(r['perDay'] for r in race), 2),
            'slowCount': len(slow), 'slowPerDay': round(sum(r['perDay'] for r in slow), 2)}

base = [r for r in real if passes(r)]
cases = {
    'today (rules as on origin/main)': dict(),
    'depth bar $5k': dict(depth=5_000), 'depth bar $2k': dict(depth=2_000), 'depth bar $1k': dict(depth=1_000),
    'all V4 fee settings looked up': dict(all_v4=True),
    'live loops up to 4 pools': dict(max_pools=4), 'live loops up to 5 pools': dict(max_pools=5),
    'all three ($2k, all V4, 5 pools)': dict(depth=2_000, all_v4=True, max_pools=5),
}
out = {'realLoopsOver025': tally(real)}
for name, kw in cases.items():
    sel = [r for r in real if passes(r, **kw)]
    out[name] = tally(sel)
    out[name]['extraPerDay'] = round(out[name]['perDay'] - sum(r['perDay'] for r in base), 2)
json.dump(out, open(sys.argv[2], 'w'), indent=1)
for k, v in out.items(): print(f'{k:36s} {v}')
