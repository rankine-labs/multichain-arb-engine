# Why our bot took none of the arbitrage the 24 h measure found (missed gaps)

Read-only analysis, 2026-10-23. Data: `results/profit-measure/` on branch `profit-measure-run` (window 2026-10-22 20:34 to 2026-10-23 20:34 UTC). Bot rules: code at origin/main 4fb29f1. Pool depths: public node, block 96428605 (today; the node keeps only ~0.2 h of history, so the window's own pool states were gone).

## The short answer

1. **Most of the "slow" money is not arbitrage.** Of the $403/day of slow (>10 block) trades over $0.25, **$342.88/day are one-way trades** (a contract selling a meme coin into WETH/USDG, a fixed $34.66 USDG buy of PONS every few minutes, routers keeping a fee). The measure counted them because the coin they sold went into a Uniswap V4 pool or came straight from a user, so it looked like free WETH. No arbitrage bot can copy them. This covers all of 0x0005ea38 (the "top earner", median 66 blocks), almost all of 0x24a4d86c and all of 0xaa41e6c3.
2. **Real, copyable loops on our exchanges are about $240.96/day** (over $0.25, 155 trades), not $823. **$194.39/day of that is speed races** (winner landed in the same block or 1-2 blocks later); only **$46.57/day landed 3 or more blocks later** (over ~0.3 s; $38.62/day more than 10 blocks).
3. Of the real loops, our rules leave **$48.97/day** that passes every rule we can check ($26.49 races + $22.48 slow). The rest is blocked by the $10k depth bar, by V4 pools the bot never discovers, and by the 3-pool loop limit.
4. **The bot was probably not sending real trades for most or all of the window** (owner notes: real trading off from Oct 22 until the Rust fast check went live on Oct 23; the earliest live send on the status page is 23:26 UTC Oct 23, after the window ended at 20:34; the measure saw 0 successful trades by our contract). So even trades that pass every rule could not have been ours here.

## Ranked table: every trusted "arbitrage" over $0.25 on our exchanges (USDG/WETH profit)

First rule that stops it, in this order: real round trip? -> 4+ pools -> V4 pool not discoverable -> pool under $10k -> pool emptied -> taxed coin.

| # | Reason | Trades | $/day | of which slow (>10 blk) | Who can fix | Examples (pair, exchanges, profit, winner, delay) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Not arbitrage: one-way sales, buy programs, router fee skims | 186 | $529.51 | 105 / $342.88 | nobody (not a chance for any arb bot) | BOOMER/USDG + WETH/USDG (uni-v4/uni-v4) $48.34, bot 0x0005ea38, 168 blk; ANTH/ANTHROPIC + WETH/ANTHROPIC (uni-v3/uni-v4) $47.77, bot 0x0005ea38, ? blk; VIRTUAL/LLL + WETH/LYRO + WETH/VIRTUAL (uni-v4/uni-v3/uni-v2) $46.93, bot 0x24a4d86c, 167 blk |
| 2 | A pool under the $10k depth bar (POOL_MIN_DEPTH_USD) | 56 | $81.33 | 6 / $6.10 | deliberate rule, can be tuned | USDG/EDEL (uni-v4/raphael-cl) $7.92, bot 0x87a98bdf, 1 blk; USDG/microduck (up-cl/ramses-v3) $6.76, bot 0x9c9f4ab6, 1 blk; NMD/SELECT + WETH/NMD + WETH/SELECT (uni-v3/uni-v3/uni-v3) $6.44, bot 0x62fc8082, 0 blk |
| 3 | Pool emptied since (HMY meme pair; depth then unknown, all same-block races) | 21 | $50.77 | 0 / $0.00 | probably thin; speed race | WETH/HMY (up-cl/uni-v3) $8.45, bot 0xb4c42a6e, 0 blk; WETH/HMY (up-cl/uni-v3) $8.37, bot 0x62fc8082, 0 blk; WETH/HMY (uni-v3/up-cl) $6.31, bot 0xb4c42a6e, 0 blk |
| 4 | Route has a leg we cannot see (unknown exchange) or is an order split | 51 | $45.46 | 23 / $20.92 | not copyable as seen | SLV/GLD + USDG/GLD (uni-v3/up-cl) $5.18, bot 0xfe2d8976, 2 blk; VIRTUAL/CLASH + WETH/USDG + WETH/VIRTUAL (up-cl/uni-v3/uni-v2) $2.77, bot 0x6e2a35a7, 16 blk; WETH/USDG (giga-cl/giga-cl/up-cl) $2.62, bot 0x6e2a35a7, 24 blk |
| 5 | Uniswap V4 pool at a fee setting the bot never looks up | 19 | $38.84 | 6 / $14.26 | FIXABLE (discovery gap) | USDG/VRAX (uni-v4/uni-v4) $8.47, bot 0x037fced7, 0 blk; USDG/microduck + WETH/USDG + WETH/microduck (uni-v4/uni-v3/uni-v3) $5.44, bot 0x9c9f4ab6, 0 blk; USDG/microduck (uni-v4/ramses-v3) $4.89, bot 0x9c9f4ab6, 79 blk |
| 6 | Passes every rule we can check; winner landed within 2 blocks (speed race) | 22 | $26.49 | 0 / $0.00 | speed / runtime | WETH/USDG (uni-v3/uni-v3) $7.70, bot 0xb0550000, 1 blk; USDG/STONKBROKER + WETH/STONKBROKER + WETH/USDG (up-cl/uni-v3/uni-v3) $2.34, bot 0x62fc8082, 0 blk; USDG/PFE (uni-v4/uni-v3) $2.26, bot 0x1d29b753, 0 blk |
| 7 | Passes every rule we can check; winner landed 3+ blocks later | 11 | $22.48 | 8 / $18.26 | runtime (see below) | WETH/UP (uni-v3/up-cl) $11.70, bot 0xbe40e23b, 154 blk; USDG/STONKBROKER + WETH/STONKBROKER + WETH/USDG (uni-v3/up-cl/uni-v3) $3.11, bot 0x183e5518, 16 blk; USDG/cbBTC (uni-v3/uni-v4) $2.89, bot 0x037fced7, 6 blk |
| 8 | Loop of 4+ pools (live loops max 3) | 26 | $21.05 | 0 / $0.00 | deliberate rule | ABYSS/SEA + USDG/SEA + WETH/ABYSS + WETH/USDG (uni-v3/abyss-cl/abyss-cl/abyss-cl) $3.11, bot 0x720756df, 2 blk; WETH/USDG (uni-v3/swaphood-v3/sushiswap-v3/topaz-cl) $2.04, bot 0xaceeb1b4, 0 blk; ABYSS/SEA + USDG/SEA + WETH/ABYSS + WETH/USDG (abyss-cl/abyss-cl/abyss-cl/uni-v3) $1.59, bot 0x17970d75, 3 blk |
| 9 | Route unreadable (V4 pool coins unknown) | 4 | $7.56 | 2 / $0.76 | unknown | USDG/NET + WETH/UP + WETH/USDG (up-cl/up-cl/up-cl) $5.60, bot 0xd2796475, 10 blk; WALLET/WETH + WETH/USDG (uni-v3/uni-v3) $1.02, bot 0x825c6c69, 8 blk; TSLA/USDG + USDG/SNDK + VEX/VIRTUAL + WALLET/WETH + WETH/USDG + WETH/VIRTUAL (uni-v3/uni-v3/uni-v4/uni-v4/uni-v4/uni-v2/uni-v2) $0.42, bot 0x381e1c38, 11 blk |
| | **Total** | 396 | **$823.49** | | | |

All sizes (including under $0.25) are in `summary.json` (`all`). Every trade with its reason and every rule it fails: `classified.jsonl`.

## The "not arbitrage" group, by contract

| Contract | Trades | $/day | Median delay | What it does (biggest example) |
| --- | --- | --- | --- | --- |
| 0x0005ea38 | 12 | $159.86 | 66 | BOOMER/USDG + WETH/USDG: profit coin never paid in (one-way trade) |
| 0x24a4d86c | 9 | $113.19 | 5 | WETH/LYRO + WETH/VIRTUAL + VIRTUAL/LLL: coin 0xf55e4e32 paid in from outside |
| 0xaa41e6c3 | 45 | $46.79 | 16 | WETH/USDG + WETH/PONS + WETH/PONS + WETH/PONS: coin 0x5fc5360d paid in from outside |
| 0x36dc95f1 | 2 | $39.04 | 284 | HEDGE/USDG + WETH/USDG: profit coin never paid in (one-way trade) |
| 0xb92fe925 | 4 | $37.76 | 584 | HOOD/CUCK + HOOD/USDG: profit coin never paid in (one-way trade) |
| 0x01eef8bb | 28 | $28.31 | 18 | WETH/USDG + WETH/PONS + WETH/PONS: coin 0x5fc5360d paid in from outside |
| 0x7ddbd395 | 15 | $23.07 | 3 | MRNA/USDG + MRNA/USDG: profit coin never paid in (one-way trade) |
| 0xe636a64d | 16 | $17.22 | 18 | WETH/USDG + WETH/PONS + WETH/PONS + WETH/PONS: coin 0x5fc5360d paid in from outside |
| 0x47aff0bd | 2 | $13.70 | 0 | WETH/USDG + WETH/USDG + WETH/USDG: profit coin never paid in (one-way trade) |
| 0x203bffa6 | 6 | $9.74 | 1 | WETH/SPCX + WETH/USDG: coin 0x4a0e65a3 paid in from outside |

How we tell: we rebuild every coin's balance from the pools' own in/out amounts. In a real loop every coin except the profit coin comes back to zero and the profit coin is also paid in. In these trades a coin (BOOMER, LYRO, HEDGE, CUCK, or USDG for the PONS buys) is paid in from outside and never comes back: it is a sale or a purchase, not a price gap.

## What each rule change would unlock (real loops over $0.25)

| Change | Passes all rules | $/day | Races (<=2 blk) | 3+ blk | Extra vs today |
| --- | --- | --- | --- | --- | --- |
| today (rules as on origin/main) | 33 | $48.97 | $26.49 | $22.48 | $0.00 |
| depth bar $5k | 44 | $76.65 | $54.18 | $22.48 | $27.68 |
| depth bar $2k | 74 | $112.33 | $84.65 | $27.68 | $63.36 |
| depth bar $1k | 81 | $124.65 | $96.63 | $28.02 | $75.68 |
| all V4 fee settings looked up | 44 | $75.52 | $44.44 | $31.08 | $26.55 |
| live loops up to 4 pools | 34 | $49.23 | $26.75 | $22.48 | $0.26 |
| live loops up to 5 pools | 34 | $49.23 | $26.75 | $22.48 | $0.26 |
| all three ($2k, all V4, 5 pools) | 109 | $165.12 | $125.00 | $40.12 | $116.15 |
| (all real loops, for scale) | 155 | $240.96 | $194.39 | $46.57 | |

These are the money the WINNERS made. We would only get a share, and races need us to be first.

## V4 pools the bot never finds (fee settings not in src/config/v4Tiers.ts)

Of 167 hook-free V4 pools on these pairs, the bot's 31 settings find 108; 59 use other settings (almost all of the form fee = 100 x tick spacing, e.g. 0.78% / 78).

| Fee (pips) / spacing | Real-loop trades over $0.25 | $/day | Pair |
| --- | --- | --- | --- |
| 7800 / 78 | 14 | $25.28 | USDG/microduck |
| 50000 / 500 | 1 | $8.47 | USDG/VRAX |
| 21000 / 210 | 3 | $5.10 | USDG/FRONG |
| ? / ? | 3 | $5.10 | USDG/FRONG |
| 20000 / 200 | 2 | $0.86 | USDG/GG |
| 9500 / 95 | 1 | $0.40 | NET/USDG |
| 50000 / 1000 | 1 | $0.31 | USDG/microduck |

## Top 3 fixable reasons and what would capture them

**1. V4 pools the bot cannot see ($38.84/day of real loops, $14.26 of it slow).** The pair watcher only asks V4 about 31 fixed fee settings. Pools made at other settings (USDG/microduck 0.78% / spacing 78 alone is $25/day, USDG/VRAX 5%, USDG/FRONG 2.1%) are never found, so neither the gap scan nor the loop trader knows they exist. Fix: find V4 pools from the PoolManager's Initialize events (one log read per block range; the block reader already reads every block's logs) instead of guessing settings; or as a stop-gap add the settings in the table above. Unlocks about $26.55/day (winners' money). Risk: low, it is read-only discovery and every trade is still checked; but these are mostly high-fee meme-coin pools, so expect thin, jumpy prices and the $300 auto-vetted coin cap to bite.

**2. The $10k depth bar ($81.33/day blocked as thin, plus $50.77/day on the HMY pair that has since been emptied).** Lowering POOL_MIN_DEPTH_USD to $5k unlocks about $27.68/day, to $2k about $63.36/day. But nearly all of it is speed races on meme pools (SEA/ABYSS on Abyss, microduck on UP CL, ANTHROPICx1L, EDEL): at $2k only $5.20/day of the extra is slow. Risk: medium. The bar exists because thin V3 positions show fake gaps (the Oct 13 USDG/NVDA case); the real-balance cap now handles most of that, but more thin pools mean more practice checks against the 3-a-minute small-gap budget, more 30-minute mutes, and more reverted sends (gas) when a faster bot wins. Try $5k first and watch the scoreboard. Depths here are TODAY's, not the window's, so this is approximate.

**3. Trades that pass every rule but were not taken ($48.97/day: $22.48 slow + $26.49 races).** Nothing in the code we can check stops these (examples: WETH/UP on Uniswap V3 vs UP CL $11.70 that sat for 154 blocks = 16 s; STONKBROKER loops $3.11 / 16 blocks; USDG/cbBTC $2.89 / 6 blocks). 5 of the 11 slow ones were on Oct 22 21:00-23:40 UTC and the rest on Oct 23 11:00-17:30 UTC; per the owner's notes real trading was off for at least part of that time. What can still stop them when live (only the server log can say which): (a) the scoreboard pauses the whole standing-gap path for 6 h once its last 12+ real sends lost money (status page today: "7x scoreboard: gap paused"); (b) only 3 small-gap checks a minute (GAP_TESTS_PER_MIN) and 2 fires per scan; (c) a pair is muted 30 min after one check that said no, and blocked 6 h after one failed real check / live trade; (d) coins not on the safety allowlist (top-80 scan pairs + 22 auto-vetted) and the $300 cap for auto-vetted coins (the UP trade was $739). Fix: grep the server log for these pairs at these times ([gap] / [check-first] / [scoreboard] lines) before changing anything; then consider letting a fresh confirmed gap through even while the gap bucket is paused if its check is at the trigger block, and raising GAP_TESTS_PER_MIN now that the Rust fast check answers locally. Risk: more failed sends if the check is wrong.

## Deliberate safety rules and what they cost (real loops over $0.25, winners' money)

| Rule | Where | $/day it blocks | Note |
| --- | --- | --- | --- |
| $10k depth near the price | POOL_MIN_DEPTH_USD, core/poolPrice.ts | $113.20 (as any failing rule) | mostly same-block races on meme pools |
| Live loops at most 3 pools | LOOP_LIVE_MAX_POOLS | $21.05 | raising it alone unlocks only $0.26: the 4-5 pool loops also use thin Abyss pools |
| Coin tax test | core/coinTax.ts | $0.40 | |
| No meme coins (live coin rule) | core/liveCoins.ts | $0 | OFF by default since Oct 18 (LIVE_COIN_RULE unset) |
| Outlier guard (too-good profits) | core/outlierGuard.ts | $0 | no real loop here was over $50 or over 2% and $20 (largest $11.70) |
| $0.25 send minimum | MIN_EXEC_NET_USD | $14.00 (every trade under $0.25 that passes the other rules) | winners' net; our share of these would be pennies |
| $300 cap on auto-vetted coins, safety allowlist | shadowMain AUTO_VET_MAX_TRADE_USD, SafetyGate | unknown | the vetted list lives on the server |

## What we could not check (and how sure we are)

- **Watch list:** the real list (150 pairs, 129 pinned) is on the server. Pairs are added when the bot sees a trade on them, so a pair being actively traded is usually on it; `pairSecondUsd` in classified.jsonl shows each pair's 2nd-deepest pool (the scan pins pairs with $2k+ in 2+ pools).
- **Depth:** measured today, ~6 h after the window. Pools change (HMY was emptied). Treat the thin/not-thin split as approximate.
- **Safety allowlist / auto-vetted coins / approved flash lenders / wallet balance:** server-only. The wallet holds far less than the $2,000 own-money setting, so most trades need a flash loan from an approved pool that is not on the route.
- **Runtime filters** (mutes, 6 h blocks, scoreboard pauses, check budget, what the practice check said): need the server log.
- **The profit measure itself** counts one-way trades as arbitrage (see above). Its $932/day "ours" figure is about $279.56/day once only real loops are kept (all sizes). scripts/missed-gaps/load.py `round_trip()` is the check to add to scripts/profit-measure/report.mjs.

## Files

- `REPORT.md` this report; `summary.json` totals by reason (all sizes and over $0.25); `whatif.json` rule-change table;
- `classified.jsonl` one line per trusted trade on our exchanges: reason, every failed rule, pool depths, pair depth, delay, winner;
- `v4-tiers.json` fee setting of each V4 pool and whether the bot can find it; `chain-state.json` / `chainread.log` the pool reads;
- scripts: `scripts/missed-gaps/` (load.py, build_input.py, chainread.mjs, v4tiers.mjs, classify.py, whatif.py, report.py).

Re-run: `PM_DIR=<profit-measure dir> python3 scripts/missed-gaps/build_input.py results/missed-gaps/pools-in.json`, chain read on the `missed-gaps-run` branch (GitHub Actions), then `node scripts/missed-gaps/v4tiers.mjs`, `classify.py`, `whatif.py`, `report.py`.
