# Robinhood opportunity pipeline: every gate, in order

Phase 2, part A. Written Oct 8 2026 against `origin/main` at `c13d0b5`.

Line numbers are given as **branch / main**: the first is on branch
`phase2-research-lane` (which adds the research lane), the second is the same
line on `main` at `c13d0b5`. All gates are in `src/shadowMain.ts` inside
`main()`, in the `chainManager.onEvent(async (event) => ...)` trade handler,
unless another file is named.

## The hour that prompted this

Latest hourly report: **23,282 trades read, 145 after-fee candidates,
132 under $0.50, 13 not vetted, 0 sent to the checker.**

Read carefully, those numbers say more than they seem to:

- The handler counts `belowCheckBar` **before** `notVetted`
  (`shadowMain.ts:1338-1340 / 1270-1272`). So the 13 "not vetted" are
  candidates that **cleared** the $0.50 bar. Every single candidate that
  cleared the bar that hour was then dropped by the vetted-list gate.
  Two gates in a row, 100% loss.
- 145 of 23,282 (0.6%) survived the steps before sizing. The report shows the
  breakdown of the other 23,137 (no pool, too small, no partner, no USD
  price, smaller than fees); that breakdown was not in the summary I was
  given, so the ranking of those upstream steps below is from the code, not
  from the counts.

The Oct 8 rival audit adds two facts:

1. **All 15 verified 2-pool wins by rival bots had a gross under $0.50.**
   The $0.50 check bar sits above the entire winning distribution we have
   evidence for.
2. **Rivals use their own money (45 of 46 trades).** Our planner charges a
   9 bps flash-loan fee on every candidate, and the real-chain checker funds
   the test with a V3 flash loan whose fee is the lender pool's fee tier
   (5 bps at best, 30 to 100 bps on many pools).

## Where opportunities are lost, ranked

1. **The $0.50 check bar** (`SIM_MIN_GROSS_USD`). 132 of 145 candidates (91%)
   that hour. Rival wins are all below it. Its stated purpose is to save the
   checking node's quota, and that job is already done by the node budget
   (`core/nodeBudget.ts`, QuickNode 4 req/s and 14,000/day) and the one-at-a-time
   rule. **Not justified as a filter on what is worth learning about.**
2. **The vetted-list gate on simulation** (`simVetted`). 13 of 13 above-bar
   candidates. A simulation spends nothing and signs nothing, so vetting adds
   no safety at this step. The "vetted" list is also not a safety review: it is
   WETH, USDG and the coins in the top 80 pairs from the chain-wide scan
   (pairs with $2k+ in 2+ pools, `shadowMain.ts:1632, 1681 / 1555, 1604`), i.e.
   a liquidity list. **Justified for live trading, not for simulation.**
3. **The model's gross is understated before it meets the bar.** Two causes,
   both in files this phase does not own (`profitCalculator.ts`):
   - `findOptimalTradeSize` is called by `backrunPlanner.ts:planBackrun:66`
     with its defaults, `approxCostRateBps = 9` (flash fee) and
     `approxFixedGasUsd = 2` (`profitCalculator.ts:111-112`). The $2 is a
     constant and doesn't change which size wins, but the 9 bps does: on a
     $500 trade it is $0.45, the same size as the bar, so the sizer picks a
     smaller trade with a smaller gross. Rivals pay no flash fee.
   - `calculateLiquidityCeiling` (`profitCalculator.ts:46-95`) caps the largest
     size tried at 1% of the **thinner pool's one-side** depth when that is
     under $50k (2% under $250k, 3% under $1M, 5% above). A $50k pool has
     ~$25k per side, so the biggest trade tried is ~$250. With a 0.3% net gap
     that is a ~$0.75 ceiling on gross. Many real gaps can never reach $0.50
     in the model, whatever the market does.
4. **The $25k partner-depth bar** (`POOL_MIN_DEPTH_USD`, `noPartner`). Its own
   justification (`poolPrice.ts:115-119`) is "profit ~ depth x gap squared, so
   to make the **$20 minimum** a $25k pool needs ~12%". That derivation is tied
   to the $20 firing minimum. If real wins are under $1, the bar is
   calibrated to the wrong target. Count unknown from the summary; on a
   long-tail chain this is plausibly the biggest single upstream loss.
5. **The fast filter's 1% trade-size rule** (`tooSmall`). V2 pools only: a
   trade under 1% of the traded pool's tokenIn reserve is dropped. A 0.5%
   trade moves a V2 price about 1%, which beats a 0.30% + 0.05% fee pair.
   The rule is not tied to the actual fees of the pool pair. Also note
   `funnel.tooSmall` silently includes `NO_PEER_VENUE` (pair has no other
   pool at all) and `ZERO_AMOUNT`, so the "too small" count in the report is
   inflated by trades that have nothing to do with size.
6. **Standing gaps: $20 bar plus a $10 confirmation bar.** The gap scanner only
   reports gaps with model profit >= $20 (`GAP_MIN_USD`), and a confirmed gap
   must simulate at >= max($5, $20 / 2) = $10. On today's market that path
   effectively never fires. It also prices the flash fee at 5 bps while the
   trigger path uses 9 bps (inconsistent, minor).
7. **Checker-side gates** (`queueSimulation`): one check at a time, 5-minute
   mute after a loss, 6-hour bench for routes that never pay. They dropped
   nothing in the reported hour (nothing reached them), but the one-at-a-time
   rule will start dropping a lot as soon as gates 1 and 2 are relaxed.
8. **The $20 firing / counting bar** (`profit.qualifies`, `MIN_NET_PROFIT_USD`,
   15% safety margin, `MIN_COUNTED_USD`). Doesn't affect what gets simulated,
   only what is "fired" (dry run) and counted as would-have-earned. With rival
   wins under $0.50 the dry-run P&L will read zero by construction.

## Gate-by-gate trace

| # | Where (branch / main) | What it drops | Threshold now | Counter | Justified? |
|---|---|---|---|---|---|
| 0 | `core/decoder.ts:TransactionDecoder.decode`, handler `1105 / 1045` | feed txs that aren't a decodable swap on a known router | n/a | none (not counted) | Yes, but invisible: trades through unknown routers and rival contracts never count. |
| 1 | handler `1114-1203 / 1056-1143`: cache lookup, JIT resolve via `registerIfApproved` (`225-242 / 223-240`), 30-min `jitFailedUntil` memo (`1136 / 1076`) | swaps whose pool isn't cached and can't be resolved on an approved DEX | approved DEX list (`discoveryConfigs.robinhood`, `208-213 / 206-211`), non-zero liquidity | `noPool` (`1203 / 1143`) | Mostly. Unsupported DEXs and V4 pools not yet found by the watcher land here. |
| 2 | `core/fastFilter.ts:FastFilter.evaluate:38-70`, handler `1218-1219 / 1158-1159` | trade < 1% of the traded V2 pool's tokenIn reserve; also pairs with no other pool at all; also amountIn = 0 | `minTradeToPoolLiquidityRatio = 0.01` (V2 only; V3 always passes) | `tooSmall` | **Partly.** 1% is not tied to the pool pair's real fees; and the counter mixes three different reasons. |
| 3 | handler `1225-1235 / 1165-1167`, `core/poolPrice.ts:deepEnough:122` | trades whose every partner pool is under the depth bar | `POOL_MIN_DEPTH_USD = 25,000` (2 x smaller side, V3 = virtual reserves at today's price). Only partners are checked, never the traded pool. | `noPartner` | **No for research**, calibrated to the $20 minimum (`poolPrice.ts:115-119`). Stale comment at handler `1223 / 1163` and gap scanner `1538 / 1461` still says "$1,000+". |
| 4 | handler `1236-1240 / 1170-1172` (`pricesAtDecisionRobinhood`, `1048-1076 / 988-1016`) | nothing dropped; prices re-read if older than `FRESH_MS` (35 s), at most `MAX_DECISION_RPC_PER_SEC` (10) re-reads a second, else cached copy used | 35 s / 10 per s | `priceStats` | Yes. |
| 5 | handler `1279-1280 / 1211-1212` | tokenIn has no USD price | n/a | `noUsdPrice` | Yes (can't size without it). |
| 6 | handler `1284-1296 / 1216-1228`: `planBackrun` per partner (`core/backrunPlanner.ts:39-86`), sizing by `findOptimalTradeSize` (`profitCalculator.ts:101-151`) under `calculateLiquidityCeiling` (`profitCalculator.ts:46-95`) | both round-trip directions have gross <= 0 after DEX fees | gross > 0. Costs passed in: `gasPriceUsd = rhGasUsd(2)` (real gas, $2 fallback when unknown), `flashLoanFeeBps = 9`, `usingFlashLoan = true`, `safetyMarginPct = 0.15`. Sizer's own defaults: 9 bps, $2. Ceiling: 1/2/3/5% of thinner pool's one side | `smallerThanFees` | The gross > 0 rule is right. **The sizing is biased low** (9 bps flash fee rivals don't pay, tight ceiling), which feeds gate 7. |
| 7 | handler `1335, 1338 / 1267, 1270` | estimated gross under the check bar | `SIM_MIN_GROSS_USD = 0.50` | `belowCheckBar` (132) | **No.** All 15 verified rival wins were under it. |
| 8 | handler `1336, 1339 / 1268, 1271`, `execution/fastSender.ts:SafetyGate.isAllowed:74` | either coin not on the allowlist | WETH, USDG + coins of the top 80 scanned pairs | `notVetted` (13) | **No for simulation** (spends nothing). Yes for live trades. |
| 9 | `queueSimulation` `516-540 / 514-538` | another check running (`simBusy`), node paused, same pools lost in the last 5 min, route benched 6 h (`core/routeScore.ts`, 3 tests and no $0.10 win), unknown decimals, trade can't be built | one at a time; 5 min; 6 h | `funnel.skip` reasons, then `sentToCheck` | Mostly. One-at-a-time will become the bottleneck once 7 and 8 are relaxed. |
| 10 | `queueSimulation` result handling `598-641 / 596-639` | profit > 25% of amount put in = bad data | `MAX_PLAUSIBLE_PROFIT_SHARE = 0.25` | `failTally` 'implausible profit' | Yes. Note the test is funded by a flash loan from `pickLender` (`880-891 / 877-888`), so its "real profit" is after the lender pool's fee tier, not after the 9 bps the model assumed. |
| 11 | handler `1355-1388 / 1278-1311` | conservative net under $20 (after gas, 9 bps flash, 15% haircut) | `MIN_NET_PROFIT_USD = 20` (`core/types.ts:86`) | shadow log SKIPPED_BELOW_MIN_PROFIT | Fine for live trading. Means dry-run "would have earned" is $0 while wins are sub-$1. |
| 12 | handler `1389 / 1312` | low score | `shouldPreArm` | shadow log SKIPPED_LOW_SCORE | n/a here. |
| 13 | gap scanner `runGapScan` `1534-1591 / 1457-1514`, `core/gapScanner.ts:findStandingGaps:59-97` | standing gaps (no trigger) under $20 model profit; pools under $25k | `GAP_MIN_USD = 20`, `flashFee = 0.0005`, `maxTradeUsd = 5,000`, at most 2 tests per scan, 30 s per gap | `gapStats` | **No for research**: $20 is the firing bar, not a learning bar. |
| 14 | gap confirm `1564 / 1487` | simulated net under max($5, GAP_MIN_USD / 2) | $10 | `gapStats.fake` / `fail`, 30-min mute | No: a confirmed $3 gap is muted as "fake". |
| 15 | upstream of all of this: `core/pairWatcher.ts` (`maxPairs` 150, least-recently-traded evicted), `core/universeScan.ts:rankCandidates:372` (pairs with 2+ pools of $2k+, top 80 pinned) | pairs never watched have no partner pools in the cache, so they show up as gate 1 or 3 | 150 pairs, $2k per pool, top 80 | watch list size in report | Reasonable; worth re-checking after gates 3 and 7 move. |

## Thresholds in one place

| Setting | Value | Where | Used for |
|---|---|---|---|
| `minTradeToPoolLiquidityRatio` | 0.01 | `core/fastFilter.ts:25` | gate 2 |
| `POOL_MIN_DEPTH_USD` | 25,000 | `core/poolPrice.ts:120` | gates 3, 13 |
| sizer `approxCostRateBps` / `approxFixedGasUsd` | 9 / 2 | `core/profitCalculator.ts:111-112` | gate 6 sizing |
| liquidity ceiling | 1% / 2% / 3% / 5% of thinner one-side depth | `core/profitCalculator.ts:88-91` | gate 6 sizing |
| planner `flashLoanFeeBps` / `usingFlashLoan` / `safetyMarginPct` | 9 / true / 0.15 | `shadowMain.ts:1290-1292 / 1222-1224` | gate 6, 11 |
| `SIM_MIN_GROSS_USD` | 0.50 | `shadowMain.ts:1335 / 1267` | gate 7 |
| vetted list | WETH, USDG, top-80 scan coins | `shadowMain.ts:766, 1632, 1681 / 763, 1555, 1604` | gate 8 |
| `MAX_PLAUSIBLE_PROFIT_SHARE` | 0.25 | `shadowMain.ts:446 / 444` | gate 10 |
| `MIN_NET_PROFIT_USD` | 20 | `core/types.ts:86` | gate 11 |
| `GAP_MIN_USD` (also `MIN_COUNTED_USD`) | 20 | `shadowMain.ts:1520, 765 / 1443, 762` | gates 13, 14, dry-run P&L |
| gap scanner flash fee | 5 bps | `shadowMain.ts:1546 / 1469` | gate 13 |

## What I recommend (not done: the brief says never change live thresholds)

Turn the research lane on for a few days first, then decide with its numbers:

1. Decouple "worth simulating" from "worth firing". Feed the checker by a
   request budget, not a dollar bar; drop the vetted-list check for
   simulation only (keep it for live sends).
2. Size and judge candidates as own-capital trades (no 9 bps in the sizer)
   unless a flash loan is actually needed; compare both in the checker.
3. Re-derive `POOL_MIN_DEPTH_USD` and the liquidity ceiling against a $0.25
   to $1 target, not $20.
4. Split the `tooSmall` counter into its three real reasons, and tie the 1%
   rule to the pool pair's actual fees.
5. Fix the two stale "$1,000+" comments.

## The research lane built in this phase (part B)

`src/core/researchLane.ts`, wired with small edits in `shadowMain.ts`. Off by
default (`RESEARCH_LANE=1` to turn on). It receives exactly these rejections,
with the reason:

| Reason | Fed from (branch line) |
|---|---|
| `below_sim_bar` | gate 7, `shadowMain.ts:1341-1349` |
| `unvetted_token` | gate 8, same block (only when the gross cleared the bar) |
| `shallow_pool` | gate 3, `shadowMain.ts:1227-1235` (planned later against the thinner partners, $1k+ deep); and standing gaps that involve a pool under $25k |
| `gap_below_min` | gate 13: its own scan every 60 s over prices already in memory, deep pools, gaps from $0.25 to $20, own-capital costs |

It samples `RESEARCH_SAMPLE_PCT` (default 20%), tests each sample with
`simulateRoundTrip` (own money first, then the flash-loan version when a
lender is known and a request is spare), replays the trigger's block like the
main checker, and spends at most `RESEARCH_RPC_PER_MIN` (default 6) node
requests a minute, only while the main checker is idle and the checking node
has used under 60% of its daily allowance. It never sends, signs, vets,
counts toward dry-run P&L, or changes any setting.
