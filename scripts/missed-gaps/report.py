# ============================================================================
# MISSED GAPS - write results/missed-gaps/REPORT.md from classified.jsonl,
# summary.json and whatif.json (no network). Plain-language report for the owner.
#   python3 report.py <results dir>
# ============================================================================
import sys, json, os, datetime
from collections import defaultdict

D = sys.argv[1]
rows = [json.loads(l) for l in open(os.path.join(D, 'classified.jsonl'))]
summ = json.load(open(os.path.join(D, 'summary.json')))
wi = json.load(open(os.path.join(D, 'whatif.json')))
big = [r for r in rows if r['net'] > 0.25]
usd = lambda v: f"${v:,.2f}"
short = lambda a: a[:10]

# Plain names for each reason, and who can fix it.
NAMES = {
    'not-arbitrage': ('Not arbitrage: one-way sales, buy programs, router fee skims', 'nobody (not a chance for any arb bot)'),
    'hidden-leg': ('Route has a leg we cannot see (unknown exchange) or is an order split', 'not copyable as seen'),
    'route-unreadable': ('Route unreadable (V4 pool coins unknown)', 'unknown'),
    'thin-pool': ('A pool under the $10k depth bar (POOL_MIN_DEPTH_USD)', 'deliberate rule, can be tuned'),
    'pool-emptied-since': ('Pool emptied since (HMY meme pair; depth then unknown, all same-block races)', 'probably thin; speed race'),
    'v4-not-looked-up': ('Uniswap V4 pool at a fee setting the bot never looks up', 'FIXABLE (discovery gap)'),
    'route-4plus': ('Loop of 4+ pools (live loops max 3)', 'deliberate rule'),
    'passes-rules-race': ('Passes every rule we can check; winner landed within 2 blocks (speed race)', 'speed / runtime'),
    'passes-rules-slow': ('Passes every rule we can check; winner landed 3+ blocks later', 'runtime (see below)'),
    'taxed-coin': ('Coin the tax test blocked', 'deliberate rule'),
    'under-min': ('Under the $0.25 send minimum', 'deliberate rule'),
}
def examples(reason, n=3):
    xs = sorted([r for r in big if r['reason'] == reason], key=lambda r: -r['net'])[:n]
    out = []
    for r in xs:
        pair = ' + '.join(sorted(set(r['pairs'])))
        dexes = '/'.join(d.replace('uniswap-', 'uni-') for d in r['dexes'])
        out.append(f"{pair} ({dexes}) {usd(r['net'])}, bot {short(r['bot'])}, {r['dBlocks'] if r['dBlocks'] is not None else '?'} blk")
    return '; '.join(out) or '-'

L = []
P = L.append
P('# Why our bot took none of the arbitrage the 24 h measure found (missed gaps)')
P('')
P(f"Read-only analysis, {datetime.date.today().isoformat()}. Data: `results/profit-measure/` on branch `profit-measure-run` "
  "(window 2026-10-22 20:34 to 2026-10-23 20:34 UTC). Bot rules: code at origin/main 4fb29f1. Pool depths: public node, "
  f"block {summ['chainStateBlock']} (today; the node keeps only ~0.2 h of history, so the window's own pool states were gone).")
P('')
P('## The short answer')
P('')
P('1. **Most of the "slow" money is not arbitrage.** Of the $403/day of slow (>10 block) trades over $0.25, '
  f"**{usd(summ['over025']['not-arbitrage']['slowPerDay'])}/day are one-way trades** (a contract selling a meme coin into WETH/USDG, "
  "a fixed $34.66 USDG buy of PONS every few minutes, routers keeping a fee). The measure counted them because the coin they sold "
  "went into a Uniswap V4 pool or came straight from a user, so it looked like free WETH. No arbitrage bot can copy them. "
  "This covers all of 0x0005ea38 (the \"top earner\", median 66 blocks), almost all of 0x24a4d86c and all of 0xaa41e6c3.")
P(f"2. **Real, copyable loops on our exchanges are about {usd(wi['realLoopsOver025']['perDay'])}/day** (over $0.25, "
  f"{wi['realLoopsOver025']['count']} trades), not $823. **{usd(wi['realLoopsOver025']['racePerDay'])}/day of that is speed races** "
  f"(winner landed in the same block or 1-2 blocks later); only **{usd(wi['realLoopsOver025']['slowPerDay'])}/day landed 3 or more blocks later** "
  f"(over ~0.3 s; {usd(sum(r['perDay'] for r in big if r['roundTrip'] == 'loop' and r['slow']))}/day more than 10 blocks).")
P(f"3. Of the real loops, our rules leave **{usd(wi['today (rules as on origin/main)']['perDay'])}/day** that passes every rule "
  f"we can check ({usd(wi['today (rules as on origin/main)']['racePerDay'])} races + {usd(wi['today (rules as on origin/main)']['slowPerDay'])} slow). "
  "The rest is blocked by the $10k depth bar, by V4 pools the bot never discovers, and by the 3-pool loop limit.")
P('4. **The bot was probably not sending real trades for most or all of the window** (owner notes: real trading off from Oct 22 until the '
  'Rust fast check went live on Oct 23; the earliest live send on the status page is 23:26 UTC Oct 23, after the window ended at 20:34; '
  'the measure saw 0 successful trades by our contract). So even trades that pass every rule could not have been ours here.')
P('')
P('## Ranked table: every trusted "arbitrage" over $0.25 on our exchanges (USDG/WETH profit)')
P('')
P('First rule that stops it, in this order: real round trip? -> 4+ pools -> V4 pool not discoverable -> pool under $10k -> pool emptied -> taxed coin.')
P('')
P('| # | Reason | Trades | $/day | of which slow (>10 blk) | Who can fix | Examples (pair, exchanges, profit, winner, delay) |')
P('| --- | --- | --- | --- | --- | --- | --- |')
for i, (k, e) in enumerate(summ['over025'].items(), 1):
    name, who = NAMES.get(k, (k, ''))
    P(f"| {i} | {name} | {e['count']} | {usd(e['perDay'])} | {e['slowCount']} / {usd(e['slowPerDay'])} | {who} | {examples(k)} |")
tot = sum(e['perDay'] for e in summ['over025'].values())
P(f"| | **Total** | {sum(e['count'] for e in summ['over025'].values())} | **{usd(tot)}** | | | |")
P('')
P('All sizes (including under $0.25) are in `summary.json` (`all`). Every trade with its reason and every rule it fails: `classified.jsonl`.')
P('')

# Not-arbitrage by bot.
P('## The "not arbitrage" group, by contract')
P('')
P('| Contract | Trades | $/day | Median delay | What it does (biggest example) |')
P('| --- | --- | --- | --- | --- |')
by = defaultdict(list)
for r in big:
    if r['reason'] == 'not-arbitrage': by[r['bot']].append(r)
for b, xs in sorted(by.items(), key=lambda kv: -sum(r['perDay'] for r in kv[1]))[:10]:
    ds = sorted(r['dBlocks'] for r in xs if r['dBlocks'] is not None)
    x = max(xs, key=lambda r: r['net'])
    P(f"| {short(b)} | {len(xs)} | {usd(sum(r['perDay'] for r in xs))} | {ds[len(ds)//2] if ds else '?'} | {' + '.join(x['pairs'])}: {x['rtWhy']} |")
P('')
P('How we tell: we rebuild every coin\'s balance from the pools\' own in/out amounts. In a real loop every coin except the profit coin '
  'comes back to zero and the profit coin is also paid in. In these trades a coin (BOOMER, LYRO, HEDGE, CUCK, or USDG for the PONS buys) '
  'is paid in from outside and never comes back: it is a sale or a purchase, not a price gap.')
P('')

# What-if table.
P('## What each rule change would unlock (real loops over $0.25)')
P('')
P('| Change | Passes all rules | $/day | Races (<=2 blk) | 3+ blk | Extra vs today |')
P('| --- | --- | --- | --- | --- | --- |')
for k, v in wi.items():
    if k == 'realLoopsOver025': continue
    P(f"| {k} | {v['count']} | {usd(v['perDay'])} | {usd(v['racePerDay'])} | {usd(v['slowPerDay'])} | {usd(v['extraPerDay'])} |")
P(f"| (all real loops, for scale) | {wi['realLoopsOver025']['count']} | {usd(wi['realLoopsOver025']['perDay'])} | {usd(wi['realLoopsOver025']['racePerDay'])} | {usd(wi['realLoopsOver025']['slowPerDay'])} | |")
P('')
P('These are the money the WINNERS made. We would only get a share, and races need us to be first.')
P('')

# V4 settings.
v4 = json.load(open(os.path.join(D, 'v4-tiers.json')))
agg = defaultdict(lambda: [0, 0.0, set()])
for r in big:
    if r['roundTrip'] != 'loop': continue
    for p in r['pools']:
        if len(p) == 66 and not (v4.get(p) or {}).get('botFinds'):
            t = v4[p]; k = (t['fee'], t['tickSpacing']); agg[k][0] += 1; agg[k][1] += r['perDay']; agg[k][2].add('/'.join(sorted(set(r['pairs']))[:1]))
P('## V4 pools the bot never finds (fee settings not in src/config/v4Tiers.ts)')
P('')
P(f"Of {len(v4)} hook-free V4 pools on these pairs, the bot's 31 settings find {sum(1 for v in v4.values() if v['botFinds'])}; "
  f"{sum(1 for v in v4.values() if not v['botFinds'])} use other settings (almost all of the form fee = 100 x tick spacing, e.g. 0.78% / 78).")
P('')
P('| Fee (pips) / spacing | Real-loop trades over $0.25 | $/day | Pair |')
P('| --- | --- | --- | --- |')
for k, v in sorted(agg.items(), key=lambda kv: -kv[1][1]):
    P(f"| {k[0] if k[0] is not None else '?'} / {k[1] if k[1] is not None else '?'} | {v[0]} | {usd(v[1])} | {', '.join(sorted(v[2]))} |")
P('')
# ---- Narrative sections (owner-facing) ------------------------------------
w = lambda k: wi[k]
P('## Top 3 fixable reasons and what would capture them')
P('')
P(f"**1. V4 pools the bot cannot see ({usd(summ['over025']['v4-not-looked-up']['perDay'])}/day of real loops, {usd(summ['over025']['v4-not-looked-up']['slowPerDay'])} of it slow).** "
  "The pair watcher only asks V4 about 31 fixed fee settings. Pools made at other settings (USDG/microduck 0.78% / spacing 78 alone is "
  "$25/day, USDG/VRAX 5%, USDG/FRONG 2.1%) are never found, so neither the gap scan nor the loop trader knows they exist. "
  f"Fix: find V4 pools from the PoolManager's Initialize events (one log read per block range; the block reader already reads every block's logs) "
  f"instead of guessing settings; or as a stop-gap add the settings in the table above. Unlocks about {usd(w('all V4 fee settings looked up')['extraPerDay'])}/day "
  "(winners' money). Risk: low, it is read-only discovery and every trade is still checked; but these are mostly high-fee meme-coin pools, "
  "so expect thin, jumpy prices and the $300 auto-vetted coin cap to bite.")
P('')
P(f"**2. The $10k depth bar ({usd(summ['over025']['thin-pool']['perDay'])}/day blocked as thin, plus {usd(summ['over025']['pool-emptied-since']['perDay'])}/day on the HMY pair that has since been emptied).** "
  f"Lowering POOL_MIN_DEPTH_USD to $5k unlocks about {usd(w('depth bar $5k')['extraPerDay'])}/day, to $2k about {usd(w('depth bar $2k')['extraPerDay'])}/day. "
  f"But nearly all of it is speed races on meme pools (SEA/ABYSS on Abyss, microduck on UP CL, ANTHROPICx1L, EDEL): at $2k only "
  f"{usd(w('depth bar $2k')['slowPerDay'] - w('today (rules as on origin/main)')['slowPerDay'])}/day of the extra is slow. "
  "Risk: medium. The bar exists because thin V3 positions show fake gaps (the Oct 13 USDG/NVDA case); the real-balance cap now handles "
  "most of that, but more thin pools mean more practice checks against the 3-a-minute small-gap budget, more 30-minute mutes, and more "
  "reverted sends (gas) when a faster bot wins. Try $5k first and watch the scoreboard. Depths here are TODAY's, not the window's, so this is approximate.")
P('')
P(f"**3. Trades that pass every rule but were not taken ({usd(w('today (rules as on origin/main)')['perDay'])}/day: {usd(w('today (rules as on origin/main)')['slowPerDay'])} slow + {usd(w('today (rules as on origin/main)')['racePerDay'])} races).** "
  "Nothing in the code we can check stops these (examples: WETH/UP on Uniswap V3 vs UP CL $11.70 that sat for 154 blocks = 16 s; "
  "STONKBROKER loops $3.11 / 16 blocks; USDG/cbBTC $2.89 / 6 blocks). 5 of the 11 slow ones were on Oct 22 21:00-23:40 UTC and the rest on Oct 23 11:00-17:30 UTC; per the owner's notes "
  "real trading was off for at least part of that time. What can still stop them when live (only the server log can say which): "
  "(a) the scoreboard pauses the whole standing-gap path for 6 h once its last 12+ real sends lost money (status page today: "
  "\"7x scoreboard: gap paused\"); (b) only 3 small-gap checks a minute (GAP_TESTS_PER_MIN) and 2 fires per scan; (c) a pair is muted "
  "30 min after one check that said no, and blocked 6 h after one failed real check / live trade; (d) coins not on the safety allowlist "
  "(top-80 scan pairs + 22 auto-vetted) and the $300 cap for auto-vetted coins (the UP trade was $739). "
  "Fix: grep the server log for these pairs at these times ([gap] / [check-first] / [scoreboard] lines) before changing anything; "
  "then consider letting a fresh confirmed gap through even while the gap bucket is paused if its check is at the trigger block, and "
  "raising GAP_TESTS_PER_MIN now that the Rust fast check answers locally. Risk: more failed sends if the check is wrong.")
P('')
P('## Deliberate safety rules and what they cost (real loops over $0.25, winners\' money)')
P('')
P('| Rule | Where | $/day it blocks | Note |')
P('| --- | --- | --- | --- |')
ef = summ['everyRuleFailedOver025Loops']
P(f"| $10k depth near the price | POOL_MIN_DEPTH_USD, core/poolPrice.ts | {usd(ef.get('thin-pool', {}).get('perDay', 0))} (as any failing rule) | mostly same-block races on meme pools |")
P(f"| Live loops at most 3 pools | LOOP_LIVE_MAX_POOLS | {usd(ef.get('route-4plus', {}).get('perDay', 0))} | raising it alone unlocks only {usd(w('live loops up to 5 pools')['extraPerDay'])}: the 4-5 pool loops also use thin Abyss pools |")
P(f"| Coin tax test | core/coinTax.ts | {usd(ef.get('taxed-coin', {}).get('perDay', 0))} | |")
P('| No meme coins (live coin rule) | core/liveCoins.ts | $0 | OFF by default since Oct 18 (LIVE_COIN_RULE unset) |')
P('| Outlier guard (too-good profits) | core/outlierGuard.ts | $0 | no real loop here was over $50 or over 2% and $20 (largest $11.70) |')
P('| $0.25 send minimum | MIN_EXEC_NET_USD | ' + usd(summ['all'].get('under-min', {}).get('perDay', 0)) + ' (every trade under $0.25 that passes the other rules) | winners\' net; our share of these would be pennies |')
P('| $300 cap on auto-vetted coins, safety allowlist | shadowMain AUTO_VET_MAX_TRADE_USD, SafetyGate | unknown | the vetted list lives on the server |')
P('')
P('## What we could not check (and how sure we are)')
P('')
P('- **Watch list:** the real list (150 pairs, 129 pinned) is on the server. Pairs are added when the bot sees a trade on them, so a '
  'pair being actively traded is usually on it; `pairSecondUsd` in classified.jsonl shows each pair\'s 2nd-deepest pool (the scan pins pairs with $2k+ in 2+ pools).')
P('- **Depth:** measured today, ~6 h after the window. Pools change (HMY was emptied). Treat the thin/not-thin split as approximate.')
P('- **Safety allowlist / auto-vetted coins / approved flash lenders / wallet balance:** server-only. The wallet holds far less than '
  'the $2,000 own-money setting, so most trades need a flash loan from an approved pool that is not on the route.')
P('- **Runtime filters** (mutes, 6 h blocks, scoreboard pauses, check budget, what the practice check said): need the server log.')
P('- **The profit measure itself** counts one-way trades as arbitrage (see above). Its $932/day "ours" figure is about '
  f"{usd(sum(r['perDay'] for r in rows if r['roundTrip'] == 'loop'))}/day once only real loops are kept (all sizes). "
  'scripts/missed-gaps/load.py `round_trip()` is the check to add to scripts/profit-measure/report.mjs.')
P('')
P('## Files')
P('')
P('- `REPORT.md` this report; `summary.json` totals by reason (all sizes and over $0.25); `whatif.json` rule-change table;')
P('- `classified.jsonl` one line per trusted trade on our exchanges: reason, every failed rule, pool depths, pair depth, delay, winner;')
P('- `v4-tiers.json` fee setting of each V4 pool and whether the bot can find it; `chain-state.json` / `chainread.log` the pool reads;')
P('- scripts: `scripts/missed-gaps/` (load.py, build_input.py, chainread.mjs, v4tiers.mjs, classify.py, whatif.py, report.py).')
P('')
P('Re-run: `PM_DIR=<profit-measure dir> python3 scripts/missed-gaps/build_input.py results/missed-gaps/pools-in.json`, chain read on the '
  '`missed-gaps-run` branch (GitHub Actions), then `node scripts/missed-gaps/v4tiers.mjs`, `classify.py`, `whatif.py`, `report.py`.')
open(os.path.join(D, 'REPORT.md'), 'w').write('\n'.join(L) + '\n')
print('\n'.join(L))
