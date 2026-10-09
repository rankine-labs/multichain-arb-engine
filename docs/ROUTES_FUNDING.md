# Routes and funding (Phase 6): what is worth building

Branch `phase6-routes-funding`, based on main `c13d0b5`. Research and measurement only. Nothing here trades, signs or sends.

## Part 1: plain English

**The short answer**

1. **Keep 2-pool trades. Stop assuming a 9 bps flash loan on every trade.** Two-pool trades are 62% of rival wins by count and 95% of the money. The 9 bps loan fee our planner assumes is bigger than a typical win, so it throws away about 3 in 4 of the wins we could otherwise take (6 in 7 if our gas matched rivals').
2. **Pay with a small pot of our own money for small trades, and borrow from a V3 pool (1 to 5 bps, not 9) for big ones.** Rival trades are small: half are under $75, 9 in 10 are under about $700. About $1,000 of USDG plus a few hundred dollars of WETH covers 9 in 10 of the trades by count. The rare big trades (thousands of dollars) carry most of the money, and they can afford a 1 to 5 bps loan.
3. **Do not build 3/4-pool loops yet.** Loops are 38% of rival wins by count but under 5% of the money: about a cent each, and 3-pool loops made $6 in total across all rival bots in 20 minutes of sampled trading. Even if we won every single one, with our costs that is roughly $290 a day for the whole market, split between 70 to 90 bots. The `tri-routes` code works and the contract can already run loops, but the finder, sizer and the most common loop shapes (Uniswap V4 pools) are missing. Not worth it before the cheaper fixes below.
4. **Two things matter more than loops:**
   - **Gas.** The typical win is about 2.6 cents before gas. Rivals pay about 1.5 cents of gas. If our contract costs 50% more gas than theirs, the typical win leaves us about 0.3 cents, and one failed attempt wipes out about seven of those wins. Measure our real gas before going live.
   - **Unknown exchanges.** Half of the 2-pool wins use a pool on an exchange we do not read (8 unknown factories, full addresses below). Adding those exchanges opens more trades than loops would.
5. **The cheapest way to pay is the one rivals seem to use: "flash swaps".** Almost every rival trade (98%) has the pool send coins to the bot first and get paid at the end of the same trade, and most rival bot contracts hold no WETH or USDG at all. Done right, that needs no money of our own and no loan fee. Our contract cannot do this today (it pays each pool from its own balance), so it would mean a new contract version, testing and a new deploy. Worth planning, not doing now.

**Why the numbers look like this**

Robinhood Chain is full of bots (71 to 93 different rival contracts in each sample) fighting over many tiny price gaps. Most wins are a cent or two. A few times an hour a bigger gap appears (one trade made $85 on a $22,800 trade) and that is where most of the money goes. A flash-loan fee is charged on the trade size, so it hurts the many small trades badly and the few big ones only a little.

## Part 2: the data

### Where the numbers come from

| Source | What it gave |
| --- | --- |
| Probe `only=routes` on this branch (`scripts/probe-routes-funding.ts`), run 1: GitHub Actions run 37830228775 | 6 windows of 1,000 blocks spread over the last 24 h, 62,479 transactions, 10.3 min of chain time, 93 rival bots |
| Same probe, run 2 (adds per-window split, top wins, full factory addresses): run 37835060856 | 8 windows of 750 blocks over the last 24 h (Oct 7 22:44 UTC to Oct 8 19:50 UTC), 57,070 transactions, 10.2 min of chain time, 71 rival bots |
| Rival replay probe on `research-rival-replay` (run 37792273152, Oct 8 14:25 UTC) | The Oct 8 audit sample: 46 arbitrage trades, 20 verified wins (522 blocks) |
| Rival funding probe on `probe-rival-funding` (run 37674517457, Oct 7) | How much WETH/USDG each rival bot contract holds |
| `p2-research-lane` (`docs/PIPELINE_TRACE.md`) and `p3-sim-verify` (funding study) | Where the planner loses rival-style trades; the planner's fixed 9 bps and $2 gas |
| `contracts/src/ArbExecutor.sol`, `origin/tri-routes` | What the contract and the route builder can do |

Total: 14 windows, 12,000 blocks, about 119,500 transactions, **20.5 minutes of real chain time**, spread across a full day.

How a trade is counted:
- **Arbitrage trade**: swapped through 2 or more pools and left the bot (contract plus the wallet that sent it) with more of some coin and less of none.
- **Win**: an arbitrage trade whose gain is only in WETH and/or USDG (so it can be priced reliably) and is above the gas it paid. Trades that gained other coins are counted as arbitrage but not as wins, so wins are an undercount (about half of all arbitrage trades).
- **Junk**: a win impossible for its size (more than 5% of the trade size, or more than $5 with no known size). Usually a broken or brand-new pool. Left out of all sums and listed separately. Examples: $19,978 on an $18,293 trade, $1,020 with no size, three 3-pool V4 loops worth about $3,900 together.
- **Size**: the biggest USDG or WETH payment the bot made in the trade. If it paid out less than $1 of USDG/WETH, the real input was another coin and the size is "unknown".
- **Our gas**: 1.5 times what the rival paid (our contract checks every coin balance before and after, and opens the V4 pool manager once per V4 hop). This is an assumption; see "Open questions".

### Rival wins by route length (both runs added up)

| | 2 pools | 3 pools | 4+ pools |
| --- | --- | --- | --- |
| Arbitrage trades | 733 | 386 | 100 |
| Clean wins (junk left out) | 362 | 185 | 39 |
| Share of wins by count | 62% | 32% | 7% |
| Rival net, total (20.5 min) | $325.12 | $6.19 | $9.49 |
| Share of the money | 95% | 2% | 3% |
| Typical gross (median) | $0.025 to $0.026 | $0.026 to $0.029 | $0.041 to $0.051 |
| Typical rival net (median) | $0.009 to $0.010 | $0.010 to $0.011 | $0.017 to $0.027 |
| Top 10% of wins net at least | $0.07 to $0.14 | $0.04 to $0.05 | $0.16 to $0.63 |
| Rival gas (median) | $0.014 to $0.016 | $0.017 | $0.018 to $0.025 |
| Trade size median / 90th pct / max | $60-70 / $430-624 / $24,972 | $50 / $290-418 / $1,268 | $17-31 / $160-294 / $22,060 |
| Every pool tradable by our contract (known factory or V4) | 185 (51%) | 112 (61%) | 23 (59%) |
| Uses a pool on an unknown factory | 177 (49%) | 73 (39%) | 16 (41%) |
| Flash-loan event in the trade | 0 of 733 | 1 of 386 | 4 of 100 |
| "Pool paid first" | 714 of 733 | 380 of 386 | 98 of 100 |

Ranges are run 1 to run 2. Medians and percentiles are per run (they cannot be added up).

**The money is lumpy.** In run 2 the two biggest 2-pool wins made $84.90 (a $22,799 USDG trade between an unknown-factory WETH/USDG pool and Uniswap V3 WETH/USDG, at 01:45 UTC) and $11.16 (a $3,031 WETH trade between Uniswap V2 and V3 WETH/USDG, at 13:50 UTC). Together that is 88% of the run's 2-pool money. The other 159 wins made $13.07, about 8 cents each. Run 1 shows the same shape (90% of wins under $0.14, $216 in total). The per-window split in run 2 also shows trading is busiest in US market hours (10:49, 13:50 and 16:51 UTC windows: 113 of 161 2-pool wins) and nearly empty overnight (04:48 and 07:49 UTC: 10 wins, 9 cents).

Per day, market-wide (multiply 20.5 minutes by 70), very roughly:
- 2-pool everyday wins (leaving out the lumpy big ones): about $1,800 a day for all rival bots together in run 2 (run 1 did not split this out).
- 2-pool big wins: a few per hour at $10 to $85 each when they happen; too lumpy to project from 20 minutes.
- 3-pool loops: about $435 a day of rival net in total; about $290 a day with our costs if we won all of them.
- 4+ pool loops: about $670 a day, but most of it from a handful of trades (5 trades made $11.42 in run 1).

### What each way of paying would leave us

Same rival wins, re-priced as if we did them: we pay our gas (1.5 times theirs) and the loan fee on the trade size. Only wins with a known size (466 of 586).

| Route | Wins with known size | Own money, rival gas | Own money, our gas | V3 pool loan 1 bps | V3 pool loan 5 bps | Loan 9 bps (planner today) |
| --- | --- | --- | --- | --- | --- | --- |
| 2 pools | 296 | 296 wins, $324.52 | 184, $322.19 | 123, $310.90 | 59, $277.04 | 42, $246.81 |
| 3 pools | 142 | 142, $5.28 | 90, $4.18 | 45, $3.06 | 18, $1.80 | 9, $1.34 |
| 4+ pools | 28 | 28, $9.00 | 23, $8.53 | 19, $6.22 | 15, $2.59 | 12, $2.36 |

What this says:
- **By count, the loan fee is the killer.** Of the 184 2-pool wins still worth doing with our gas, a 9 bps loan leaves 42 (23%), a 1 bps loan leaves 123 (67%).
- **By money, the fee matters less**, because the money is in a few big trades that can afford it: a 9 bps loan still keeps 77% of the 2-pool dollars, 1 bps keeps 96%.
- **Gas matters as much as funding for small trades.** Going from rival gas to 1.5 times rival gas drops 2-pool wins from 296 to 184 with no loan at all.
- **Best mix:** own money for trades up to about $1,000 to $2,000 (where a fee would eat most of the gain) plus a V3 pool loan for anything bigger. That keeps nearly all of the 184 wins and nearly all of the $322.

### Own money needed

A trade gets its money back inside the same transaction, so the money needed is the biggest single trade we want to do, not the sum of trades.

| Starts in | Wins | Median size | 90% of wins are under | 99% under | Biggest |
| --- | --- | --- | --- | --- | --- |
| USDG | 316 | $61 to $75 | $385 to $716 | $1,000 to $18,631 | $24,972 |
| WETH | 150 | $43 to $56 | $228 to $291 | $624 to $3,031 | $3,031 |

Suggested pot: **about $1,000 of USDG and about $300 of WETH** covers 9 in 10 wins by count. Anything bigger borrows from a V3 pool. Going beyond that pot buys very little: the 99th percentile jumps around between runs ($1,000 vs $18,631) because it is a handful of trades.

## Part 3: the four options compared

Costs below are per typical win. DEX fees are already inside "gross" (the pools take them during the swaps).

### 1. Two-pool with flash loan (what the planner assumes today)

- **Opportunities:** 362 clean wins in 20.5 min; 184 still positive with our gas; only 42 survive a 9 bps fee, 59 survive 5 bps, 123 survive 1 bps.
- **Typical gross:** $0.026. **Costs:** pool fees (inside gross), loan fee = size x fee (a $70 trade: 0.7 cents at 1 bps, 6.3 cents at 9 bps), gas about $0.02 to $0.025 for us. **Typical net:** clearly negative at 9 bps (about -6 cents on a $70 trade); slightly negative even at 1 bps (about -0.4 cents). Only the larger wins survive a loan.
- **Real fee on Robinhood:** the lenders configured for Robinhood are V3 pools (`FLASH_LENDERS` in `docs/GO_LIVE.md`), and a V3 pool loan costs that pool's fee tier. The cheapest (Uniswap V3 WETH/USDG 0.01%, 0x52e65b17) is 1 bps, but a pool cannot lend while it is also a hop, and that pool is in many winning routes; then the next lender is usually a 0.05% pool (5 bps). The planner's flat 9 bps is the Aave rate and is wrong for this chain (the `p3-sim-verify` branch already makes the planner size with the fee it is given).
- **Capital:** none. **Inventory exposure:** none.
- **Failed trade cost:** gas only (about $0.02 to $0.03), the loan unwinds with the trade.
- **Operational risk:** lowest; the contract holds no money. Lender must hold 3x the loan (`LENDER_HEADROOM`), so big trades in thin coins can find no lender.

### 2. Two-pool with own money

- **Opportunities:** all 296 sized 2-pool wins at rival gas; 184 at our gas. About 1.5 times more trades than a 1 bps loan and 4.4 times more than 9 bps.
- **Typical gross:** $0.026. **Costs:** pool fees (inside gross), gas. No loan fee. **Typical net:** about $0.003 with 1.5x rival gas, $0.010 at rival gas.
- **Capital:** about $1,000 USDG and $300 WETH for 90% of wins by count (see table). Bigger trades: use a V3 pool loan.
- **Inventory exposure:** USDG: very low (it is a dollar coin, but it is still one issuer's coin). WETH: real. A 3% ETH move on $300 is $9, which is more than a day of typical WETH-start wins. Keep the WETH pot small or start routes in USDG where the route allows.
- **Failed trade cost:** gas only. The trade is all-or-nothing, so a failed trade never loses the pot.
- **Operational risk:** money sits in the contract. Only the owner can withdraw (`withdraw` is `onlyOwner`); the hot executor key can only call `execute`, and every trade must end with more of the start coin and less of nothing. Still: a contract bug or a stolen owner key loses the pot. Keep the pot small and top it up rather than growing it.

### 3. Three-pool loops (triangular)

- **Opportunities:** 185 clean wins in 20.5 min (32% of all wins), 90 positive at our gas with own money, 45 with a 1 bps loan, 9 with 9 bps.
- **Typical gross:** $0.026 to $0.029; rival gas higher than 2-pool ($0.017). **Typical net:** about 1 cent for rivals, near zero for us.
- **Total money:** $6.19 rival net, $4.18 for us with own money and our gas, in 20.5 minutes. About $290 a day market-wide if we won every one.
- **Capital:** smaller trades than 2-pool (median $50, max $1,268), so the same pot covers them.
- **What the loops look like** (most common first, run 1): `V4 > V4 > Uniswap V3 WETH/USDG` (22), `V4 > V4 > V4` (11), `Uniswap V3 WETH/USDG > V4 > V4` (6), `Uniswap V3 WETH/USDG > V4 > PancakeSwap V3 USDG/U` (6). That is: a coin traded against both USDG and ETH in V4 pools, closed through the deep WETH/USDG pool. Most of them use Uniswap V4 pools.
- **Failed trade cost:** more gas per attempt than 2-pool (3 hops).
- **Operational risk:** more moving parts: 3 prices must hold, sizing across 3 pools, 3 pool types to simulate.
- **Verdict:** not justified now. Low money, needs a new finder and sizer, and our loop watcher (`LoopMonitor`, PR #73) cannot see the most common shape because it only uses pools from the factory scan, not V4 pools.

### 4. Four-pool (and longer) loops

- **Opportunities:** 39 clean wins in 20.5 min. Higher median net ($0.017 to $0.027) but $9.49 in total, most of it from 5 trades in run 1 (a `V4 > V4 > V4 > V4` shape). 23 of 28 sized wins positive with our gas.
- **Costs:** highest gas (median $0.018 to $0.025 for rivals), 4 prices must hold.
- **Verdict:** not justified. Too few, too lumpy, and nearly all on V4.

### Not on the list but worth knowing: flash swaps (no money, no fee)

98% of rival arbitrage trades show the pool paying the bot before the bot pays anything, only 5 of 1,219 used a real flash loan, and 6 of the 8 rival bot contracts checked on Oct 7 held no WETH or USDG at all. The likely explanation is "flash swaps": swap on pool A, and inside A's "please pay me" callback swap on pool B, then pay A out of B's proceeds (V3 and V2 pools allow this; V4 settles all swaps at the end of one unlock). That needs **no money and no fee**, which beats options 1 and 2 on every trade. Caveat: our own contract's V3 hops would also look "pool paid first" in this probe, so this is strong evidence, not proof. Our contract pays each pool from its own balance and opens V4 once per hop, so this would be a new contract version (new tests, review, deploy). Recommended as a later build, not part of this phase.

## Part 4: the `tri-routes` branch

- **What it is:** one work-in-progress commit (`895d714`) adding `buildRouteCall` (46 lines) to `src/execution/executorCalldata.ts`. It builds the contract call for a loop of 2 or more pools: checks the legs chain coin to coin and end on the start coin, no pool is used twice, every pool is a type the contract can trade, and the lender is not a hop. It supports own money, Aave and V3 pool loans.
- **Is it up to date?** It is based on `bcc4307` (6 commits behind main) but `executorCalldata.ts` has not changed on main since, so it applies cleanly and type-checks. A throwaway check on this branch (not committed) confirmed a 3-leg USDG > X > WETH > USDG loop encodes to a call that decodes to 3 hops with the right amount and profit floor, and that broken chains, V4 pools without their details and lender-in-route are refused.
- **Tests:** none on the branch. Not wired to anything (no finder, no sizer, no simulation call, no use in `LoopMonitor`).
- **Can the contract run loops?** Yes, today, without changes. `execute` and `executeWithV3Flash` accept any number of hops (2 or more): `_validateRoute` checks start/end coin and that hops chain, `_runHops` runs them in order using what the previous hop produced, and the profit and no-loss checks cover every coin the route touches. Gap: every Solidity test uses 2 hops; there is no 3-hop contract test.
- **Decision:** left unmerged, not copied to this branch, because the data does not justify loops yet. If loops are revisited: add V4 legs to `LoopMonitor` first, re-measure, then bring in `buildRouteCall` with tests and a 3-hop Foundry test.

## Part 5: recommended order

1. **Price trades with the real funding** (own money 0 bps or the chosen V3 lender's fee, real gas) instead of a flat 9 bps and $2. The planner part is on `p3-sim-verify`.
2. **Measure our contract's gas** for 2-pool V3/V4 routes on a fork and compare with rivals' $0.014 to $0.016. If ours is much higher, slim the contract before anything else.
3. **Small own-money pot:** about $1,000 USDG and $300 WETH, with V3 pool loans for bigger trades. Requires the owner to fund the contract; nothing on this branch does that.
4. **Add the unknown exchanges** (Phase 4): half of the 2-pool wins touch them. Full factory addresses seen in run 2, by number of pool uses:
   - `0x16494a80e08bcb9285d87b67149d7b01774d82f8` (36)
   - `0xece6ecd61177336ea6fb9b17937ac439d85ee20b` (35)
   - `0x1ac9db4a2608ba45d6127b1737949b51bb54b7f3` (23)
   - `0xaa5865dc3a60b25d305226d66fd573021f0d8ffb` (10)
   - `0x0ec554f0bff0be6c99d1e95c8015bb0950f6a2c7` (10)
   - `0x9a8442cb89fe713ce7c2f22852e61fbffee97ecf` (9)
   - `0xe7fef2bc860b25bbdeb6f6ab96d88baaa77ddad7` (8)
   - `0x5481864ddd46a2d798df0925c23b7846e776e5e3` (7)
5. **Only go after wins worth a few failed attempts.** At about 2 cents of gas per failed try and 70 to 90 rival bots, a 1-cent win is not worth attempting. Aim at the top 10% (2-pool wins of $0.07 or more).
6. **Later:** a flash-swap version of the contract (no money, no fee). Then loops, if the V4-aware loop watcher shows real money.

## Open questions and limits

- **20.5 minutes of chain time** across 14 windows. Enough for shapes and medians, not for the lumpy big wins.
- **Our gas is assumed** to be 1.5 times rivals'. Not measured (Foundry is not installed in this sandbox).
- **Wins are an undercount:** trades that gained coins other than WETH/USDG are left out (about half of all arbitrage trades).
- **Size can be unknown** when a bot paid with another coin (120 of 586 wins). Those are left out of the loan-fee table.
- **Winning against rivals is not modelled.** These are trades rivals won. Our share depends on speed, which this study does not measure.
- **The loop watcher from PR #73** was merged on Oct 8 at 18:46 UTC; its first daily LOOP REPORT was not available to this study.

## How to re-run

GitHub, then Actions, then **Live probe**, then **Run workflow** on branch `phase6-routes-funding` with `only` = `routes`. Takes about 45 minutes. Results appear as annotations on the run ("Routes and funding 1", "Routes and funding 2"). Settings (environment, in the script header): `PROBE_WINDOWS`, `PROBE_WINDOW`, `PROBE_HOURS`, `PROBE_BATCH`, `PROBE_PACE_MS`, `PROBE_MAX_MINUTES`. The maths is in `src/core/routeFundingStudy.ts` and tested by `src/test/routeFundingStudy.test.ts`.
