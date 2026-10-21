# Event-only pool copy: does it give byte-identical ArbExecutor answers?

Date: 2026-10-21. Everything was run offline on anvil (cancun, chain id 4663). Every number below comes from `results/*.json`, produced by `runner.js`. Nothing is assumed.

## The question

Take a copy of a pool's storage: one full snapshot, then kept up to date ONLY from the pool's events (plus counted node re-reads on rare events). Does our ArbExecutor check, run on that copy, give exactly the same answer as on the real state? "Same answer" means the success flag plus the revert bytes, including the profit inside `InsufficientProfit(got, wanted)`.

## Short answer

The test compared two ways of keeping the copy:

- **"Fields"**: write into the copy only the numbers the event itself states (price, tick, liquidity, reserves).
- **"Replay"**: take each event's numbers and re-run that same action with the pool's own code on the copy. This is still events only: no state is read from the node.

| Pool type | Copy method | Profit number identical? | Gas identical? | Verdict |
|---|---|---|---|---|
| Uniswap V2 | fields (Sync + Transfer) | 1962/1962 | 1962/1962 | **EXACT** (no node reads at all) |
| Solidly / Velodrome V2 | fields (Sync + Fees + Transfer + Claim) | 1980/1980 | 1980/1980 | **EXACT** (no node reads at all) |
| Uniswap V3 | fields | 1980/1980 | 1520/1980 | **EXACT-EXCEPT-GAS** (+22 node re-reads per 100 ops) |
| Uniswap V3 | replay | 1980/1980 | 1980/1980 | **EXACT** (0 node reads) |
| PancakeSwap V3 | fields | 1980/1980 | 1510/1980 | **EXACT-EXCEPT-GAS** (+22 re-reads per 100 ops) |
| PancakeSwap V3 | replay | 1980/1980 | 1980/1980 | **EXACT** |
| Algebra Integral (+ base plugin) | fields | **1441/1944 (503 wrong)** | 0/1944 | **NOT EXACT**: the dynamic fee depends on plugin storage that no event describes |
| Algebra Integral | fields + replay of the plugin's beforeSwap hook | 1944/1944 | 1450/1944 | **EXACT-EXCEPT-GAS** |
| Algebra Integral | replay | 1944/1944 | 1944/1944 | **EXACT** |
| Uniswap V4 (hook-free) | fields | 1962/1962 | 1518/1962 | **EXACT-EXCEPT-GAS** (+16 re-reads per 100 ops) |
| Uniswap V4 (hook-free) | replay | 1962/1962 | 1962/1962 | **EXACT** |

Totals: 21,618 checks across 22 runs (6 pool types, 2 random seeds, about 330 operations each). Not one check gave a wrong answer where the copy claimed to know every slot it read (strict mode, see below: 0 WRONG). The only output mismatches are the Algebra "fields" runs, and those are explained below.

**So the assumption holds, with one important exception.** For Algebra it is **false** if the copy only writes event fields. The pool's fee comes from a plugin whose price history (its "timepoints") changes on every swap, and no event carries it. It becomes true once the plugin's hook is replayed, or once every event is replayed.

## How the test works (plain English)

- Two practice chains run side by side. **TRUTH** is the "real chain": random traders act here. **COPY** starts from one full snapshot of TRUTH and from then on only receives TRUTH's event logs, plus each block's number and time.
- **Workload, per run:** 330 operations in about 130 blocks. That includes swaps both ways from $1 to $3M (many cross dozens of ticks), exact-output swaps, swaps that stop at a price limit, liquidity adds and removes, fee collects, flash loans, coins sent straight to the pool ("donations"), and V3 price-history growth. There are 1-4 operations per block, and block times jump by 0 s, 1 s, 12 s, 1 min, 5 min or 1 h. A few operations revert on purpose (too big for the liquidity). That is normal and is counted.
- **Whole-state check after every block:** every storage slot of the pool (and coins, plugin, factory) is compared, TRUTH vs COPY. Any difference the copy method had not declared as "can't know" counts as **unsound**. **Result: 0 unsound slots in all 22 final runs.** The copy never silently got a slot wrong.
- **About every 5 operations, the bot's real check:** `execute()` with the live `ARB_EXECUTOR_RUNTIME_CODE` at the simulator address, executor slot 0 = sim caller, start coin given by a balance override, `minProfit = max`. Each check is a round trip through the pool under test and one of 4 never-traded Uniswap V3 reference pools, in both directions, at $100, $5k and $250k:
  - 2 references sit at ±2% of the test pool's price (realistic).
  - 2 are priced so far off that the round trip is **always** profitable. A loss shows up as profit 0, which would hide a difference; these make sure the profit number always depends on the test pool's exact output.
  - That gives 18 checks per checkpoint, each run with the **bot's own simulator engine** (`arbsim` library, revm 43.0.3) on three states:
    1. TRUE state (prestateTracer on TRUTH).
    2. COPY state, "lenient": stale slots keep their last value.
    3. COPY state, "strict": slots the copy can't vouch for are MISSING, not zero. If the check needs one, the engine stops with "needs node".
- **Sanity checks, all passed:**
  - The engine on TRUE state matched anvil's own answer on 21,618/21,618 checks, output and gas.
  - **Negative control:** at the end, one extra swap is made on TRUTH without telling the copy. The comparison flagged a different answer on 9-13 of the 18 checks in every run. The rest were profit-0 checks, which can't change. So the comparison is not blind.

## Per type: what events can and cannot reproduce

### 1. Uniswap V2 pair: EXACT, 0 node reads
- `Sync(r0, r1)` sets reserves plus `blockTimestampLast` (from the block time).
- `price0/1CumulativeLast` are **derivable exactly** (old reserves × seconds since last Sync, same integer math as the pair). They were verified slot-for-slot every block.
- LP `Transfer` / `Approval` cover LP balances, totalSupply (mint = from 0, burn = to 0) and allowances. Coin `Transfer` events cover the pair's coin balances.
- Donations (coins sent without a Sync) are covered by the coin's Transfer event. The contract measures `balanceOf(pair) − reserve`, so the coin balance slot matters, and it is kept exactly.
- `kLast` was not exercised (protocol fee off). With the fee on, it changes only on mint/burn and is computable from the post-Sync reserves.

### 6. Solidly / Velodrome V2 (real Velodrome Pool + PoolFactory source, solc 0.8.29 as they build it): EXACT, 0 node reads
- The check also reads the **factory** (`isPaused`, `volatileFee`, `customFee[pool]`) and the pool clone's implementation code. These are static unless the factory emits its own events.
- `Fees(amount0, amount1)` drives `index0/1 += amount·1e18/totalSupply`.
- LP `Transfer` replays the pool's own `_updateFor(from/to)` bookkeeping (supplyIndex, claimable).
- `Sync` covers reserves, cumulatives, and a new observation every >30 min.
- `Claim` zeroes claimable.
- The swap fee is moved out to `PoolFees` by a coin Transfer, which is also covered.

### 2/3. Uniswap V3 and PancakeSwap V3
**Fields method.** A `Swap` event sets price, tick and liquidity. The price-history entry written when the tick changes is **computable** (old tick, old liquidity, block time). PancakeSwap's `Swap` also carries that swap's protocol fees, so its `protocolFees` slot is derivable. Uniswap's is not.

**Events can NOT reproduce:**
- `feeGrowthGlobal0/1`
- every crossed tick's `feeGrowthOutside0/1`, `tickCumulativeOutside`, `secondsPerLiquidityOutside` and `secondsOutside`
- Uniswap's `protocolFees`

Measured effect, both seeds:
- **The profit number: none** (0 mismatches in 3,960 checks).
- **Gas: yes.** 23-24% of checks differ by +1,335 to +256,500 gas, almost all multiples of 17,100. That is the SSTORE cost difference between writing a slot the copy holds as 0 and the real non-zero value (or the reverse).

Mint, Burn, Collect, Flash and IncreaseObservationCardinalityNext need a node re-read:
- **about 22 re-read events / ~350 slots per 100 operations** in this workload, which is mint/burn-heavy at about 25% of operations;
- on a real pool, roughly (number of liquidity events) × 1 re-read.

**Replay method:** **0 re-reads and 0 failures** (595 replays for V3, 591 for PancakeSwap, both seeds). Gas was identical too.

A gotcha found by the test: **PancakeSwap's slot0 does not fit in one slot.** Its 32-bit `feeProtocol` pushes `feeProtocol|unlocked` into slot 1, and every later variable shifts by one: liquidity = slot 5, ticks = 6, bitmap = 7, positions = 8, observations from 9, lmPool = 65544. A copy that assumes the Uniswap layout gets PancakeSwap wrong. The first try did exactly that and produced 61 wrong profits.

### 4. Algebra Integral (core 1.2.10 + base plugin 1.2.4, dynamic fee, 10% community fee)
**Fields method: NOT EXACT.**
- On **every** swap, including the bot's check, the pool calls the plugin's `beforeSwap`. That writes a new timepoint and computes the fee from volatility over the stored timepoints.
- No event describes the plugin's storage. `SwapFee` reports only the fee that was used, not the history behind it.
- With stale timepoints the check used a different fee, and **503 of 1,944 profits were wrong**. Example: true profit 6,603,240 vs copy 6,595,327 on a $100 check (see `results/algebra-fields-s1.json`).
- In strict mode every one of these checks was correctly flagged "needs node: plugin timepoints". It never gave a wrong answer.

**Fields plus plugin hook replay:**
- The copy runs the plugin's own `beforeSwap` before writing each Swap's fields. That uses only the pool's tick and the block time, so it is still events-only.
- Result: **0 output mismatches**. What remains stale (`totalFeeGrowth0/1`, `outerFeeGrowth`, `communityFeePending|lastFeeTransferTimestamp`) affects gas only.
- Re-reads for Mint/Burn/Collect/Flash: 17.6 events per 100 operations. The slot count is higher here (~1,230 per 100 operations) because the tick linked-list neighbours are re-read broadly.

**Replay method:** EXACT, 0 re-reads, 589 replays, 0 failures.

Slot layout gotcha: `tickTreeRoot` (uint32) packs into slot 9 together with `nextTickGlobal|prevTickGlobal|liquidity|tickSpacing`. So `tickTreeSecondLayer` = 10, positions = 11, reserves = 12. The test caught a wrong first guess.

`reserve0/1` *are* derivable from events: +Swap and Mint amounts, −Collect, +ExcessTokens, −Transfers from the pool to the community vault. They were verified every block.

### 5. Uniswap V4 PoolManager (hook-free; 2 pools in one PoolManager, both traded)
**Fields method.** `Swap(id, …, sqrtPriceX96, liquidity, tick, fee)` gives that pool's slot0 and liquidity.

**Events can NOT reproduce:** `feeGrowthGlobal0/1` and the ticks' `feeGrowthOutside0/1`. If the protocol fee is on, `protocolFeesAccrued` can't be reproduced either: the event has no protocol-fee amount (it was off here). `Donate` changes only fee counters.

Effect:
- profit: 0 mismatches;
- gas: 23% of checks differ (−17,100 to +205,200);
- `ModifyLiquidity` re-reads: 16 events per 100 operations.

Who-owes-what bookkeeping inside a transaction lives in **transient** storage, so the copy never needs it.

**Replay method:** EXACT, 0 failures.

One edge case was found and handled: a swap through a range with **no liquidity** emits amounts 0/0 but moves the price. Its direction has to come from the price move, and it is replayed as a tiny swap up to the event's price. Before the fix, it caused 1 failed replay (which fell back to a node re-read; still exact).

## Re-reads per 100 operations (fields method)

| Type | Re-read events per 100 ops | Slots per 100 ops | Trigger |
|---|---|---|---|
| V2, Solidly | 0 | 0 | none |
| Uniswap V3 | 22.3 | 360 | Mint/Burn/Collect/Flash/grow-history (+ same-block history entry) |
| PancakeSwap V3 | 21.8 | 354 | same |
| Algebra | 17.6 | 1,233 | Mint/Burn/Collect/Flash |
| V4 | 16.2 | 269 | ModifyLiquidity |

The replay method needs **0** re-reads for every type (one V4 fallback happened before the zero-liquidity fix).

## What the strict mode says (would the copy ever lie?)
- When the copy marks unknown slots as MISSING, the engine either answers correctly or says "needs node". **Across all 22 runs: 0 wrong answers.**
- With fields-only V3/Pancake/V4, about 95% of checks touch a stale fee counter, so strict mode says "needs node" even though the profit would have been right. That is the price of being strict about gas-only slots.
- To use a fields-only copy without node calls, the bot must decide to treat fee-counter slots as **"gas-only, OK to be stale"** for V3/Pancake/V4. This test supports that decision: 0 profit differences in 5,922 checks. It must **never** be done for Algebra plugin storage.

## Robinhood-specific things to verify on the real chain
1. **Algebra version and plugin (Alandale, KittenSwap).**
   - Integral v1.3 changes the `SwapFee` event to `SwapFee(sender, fee, pluginAmountIn, pluginAmountOut)`.
   - The bot's `ALGEBRA_INTEGRAL_SWAP_TOPIC` assumes a 9-field Swap. Version 1.2.x emits a 7-field Swap plus a separate SwapFee, so check which one the live pools emit.
   - Read each pool's `plugin()` and its code: which plugin, whether it has a dynamic fee, a sliding fee, a farming hook, and what it stores.
   - If the plugin isn't the standard one, the "replay the hook" fix must be re-proved.
2. **PancakeSwap V3 copies (giga-cl, swaphood-v3).**
   - Confirm the 32-bit feeProtocol layout (observations from slot 9).
   - Check whether `lmPool` (slot 65544) is set. If it is, every swap and tick-cross calls the farm contract, and its storage becomes part of what the check reads.
3. **Slipstream / Velodrome-CL copies (up-cl, topaz-cl, raphael-cl)** were not tested here. They have gauge hooks and `stakedLiquidity`, and need their own run.
4. **Uniswap V3 forks with a protocol fee on:** `protocolFees` is not derivable from Uniswap's Swap event (only gas is affected here).
5. **V4 pools with a protocol fee on**, and Fables hooked pools: hooks have their own storage, and this test covered hook-free pools only.
6. **Fee-on-transfer or rebasing coins:** a coin balance changing without a Transfer event breaks the coin-balance part of the copy. All coins here emit Transfer for every change.
7. **Event ordering inside a transaction:** the copy applies pool events before that transaction's coin events, because replays must see pre-transaction balances. A real feed must keep logs grouped by transaction.

## Files
- `runner.js`: the test (one run = one type and variant and seed). `run-all.sh <seed>` runs everything. `summarize.js` prints the tables.
- `lib.js`: chains, the bot check (calldata, overrides), and the engine wrapper.
- `types/*.js`: per pool type: setup, random workload, the event→copy rules, and the slot names.
- `copycheck/`: a small Rust wrapper around the repo's `arbsim` library (the same engine as `arbsim check-fixture`) that adds the strict "unknown = missing" mode.
- `Helpers.sol`: test coin (emits Transfer on mint), traders, PancakeDeployer, Replayer, V4Trader.
- `velo-build/`: compiles the real Velodrome Pool and PoolFactory.
- `results/*.json`: all numbers. `logs/`: run logs and `summary.txt`.
- No repo files were changed and nothing was committed.
