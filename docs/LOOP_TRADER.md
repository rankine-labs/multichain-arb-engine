# Loop trader v1 (practice only)

## What it does, in plain English

Today the bot trades one way only: the same coin pair on two pools (buy where
it's cheap, sell where it's dear). Rival bots also win with **loops**: start
with WETH, swap to DJT, DJT to PONS, PONS to USDG, USDG back to WETH. When the
prices along the way don't quite agree, they end with a bit more WETH than
they started with. In one day the rival report showed 117 loop wins
($488.45) that we couldn't take, almost all by one bot (0xd7572f).

The loop trader v1:

1. **Finds loops.** After every price update (the same moments the 2-pool gap
   scanner runs: every new block the block reader reads, every trade the feed
   predicts, plus every 5 s), it looks at the pools the bot keeps fresh and
   lists every loop of 3 to 5 pools that starts and ends in WETH or USDG.
2. **Prices them exactly.** Each loop is priced with the same pool maths the
   bot already uses (V2 copies, V3 copies, Algebra, Uniswap V4 including
   Fables). It finds the best trade size (up to $2,000, and never more than
   30% of the shallowest pool's money) and subtracts our gas (2-pool gas
   scaled by the number of pools).
3. **Counts each loop once.** A paying loop is counted once until it closes
   (same rule as the gap scanner: it counts again only after it disappeared,
   or if it at least doubled).
4. **Practice-checks paying loops** ($0.10+ after gas, the normal check bar)
   with the same free "pretend" test used for 2-pool trades (an eth_call with
   our contract's code dropped in; nothing deployed, nothing spent). Loop
   checks come last: only when the normal check line is idle, and at most 6 a
   minute.
5. **Reports** a "Loop trades" block in the hourly report.

**It never sends a trade.** The loop trader is never handed the sender or a
wallet; even with `EXECUTION_ENABLED=true`, loops are only practice-checked.

## The hourly block

Only shown when `LOOP_TRADER=1`:

```
Loop trades (3-5 pool loops, practice only, never sent)
Loop trades: found 12, best $0.84, checked 9, would make money 4 ($1.92), contract can't run 1
  1) WETH/DJT/PONS/USDG/WETH: 5x, best $0.84
  ...
Race vs rival loops: they won 40 (busiest: 0xd7572f 38); 31 longer than 5 pools or not fully seen; of the other 9, we found 3, usually 1.2 s before we read their trade
Finder speed: 9,800 updates, typical 3.1 ms, slowest 14 ms; 5000 loops watched
```

- **found**: paying loops (model, after gas), each counted once until it closes.
- **checked / would make money**: practice-check results (after gas).
- **contract can't run**: loops through an exchange the contract can't trade
  yet or that isn't approved for practice checks.
- **Race vs rival loops**: for each rival loop win of 3-5 pools, did our finder
  have the same pools paying shortly before? "before we read their trade" is
  measured against when our rival watch read their trade (a few seconds after
  it landed), so it is a rough lead, not an exact race result.

## Settings (.env)

| Setting | Default | What it does |
|---|---|---|
| `LOOP_TRADER` | off | `1` turns the loop trader on. Unset or `0` = off, exactly today's behaviour. |
| `LOOP_MAX_POOLS` | 5 | Longest loop searched (3 to 5). |
| `LOOP_MAX_CYCLES` | 5000 | Most loops kept in the list. Loops through pools that moved in the last 10 min are kept first. |
| `LOOP_MAX_TRADE_USD` | 2000 | Biggest loop trade size. |
| `LOOP_DEPTH_SHARE` | 0.3 | Trade at most this share of the shallowest pool's money. |
| `LOOP_MIN_NET_USD` | check bar ($0.10) | Smallest model profit after gas that counts and gets checked. Defaults to `SIM_MIN_GROSS_USD`, else `MIN_EXEC_NET_USD`, else $0.10. |
| `LOOP_CHECKS_PER_MIN` | 6 | Most loop practice checks a minute. `0` = find and report only. |
| `LOOP_MAX_POOL_AGE_MS` | 30000 | Pools whose price is older than this are left out. |

Pools also need `POOL_MIN_DEPTH_USD` ($10,000) of money, like the gap scanner.

## Can our contract run a loop?

**Yes.** `ArbExecutor.execute()` takes a list of hops of any length (2 or
more), each hop its own exchange type (V2, Solidly, V3/Algebra, V4, hooked
V4). It checks the route chains coin to coin and starts and ends in the same
coin, runs the hops in order, and at the end checks that no coin went down and
the start coin went up by at least the minimum profit. So a 3-5 pool loop
across mixed exchanges needs **no contract change** for practice checks.

## What's needed before going live

1. **Owner approval of the practice numbers**: a few days of the hourly block
   showing loop checks that make money after gas.
2. **A contract test with 3+ hops**: every contract test today uses 2 hops.
   Add a test (mixed V2 + V3 + V4) and a Robinhood fork test of a real loop
   (e.g. WETH/DJT/PONS/USDG) before any real money.
3. **Redeploy if needed**: the deployed contract lacks some fixes in this
   repo's version (Algebra callback, Oct 12 audit fixes). Loops through
   Algebra pools need the redeployed contract.
4. **A loop send path**: today's sender only builds 2-pool trades. A live loop
   needs its own builder (with the minimum-profit floor from the practice
   result), the same safety gate (vetted coins, size limits, daily loss cap)
   and a separate switch. Not in v1 on purpose.
5. **Own money in WETH/USDG** (rivals use their own money). Flash loans are
   possible too, but the lending pool must not be on the loop.
6. **Keep more pools fresh**: the finder only uses pools of "watched" pairs
   (pairs with 2+ pools), because only those get new prices every block.
   Pairs with a single pool (often the middle steps of rival loops, e.g.
   DJT/PONS) are not refreshed, so loops through them are not seen yet. The
   pair watcher / block reader would need to follow those pools too.
7. **Longer loops**: the rival averages 7.5 pools per trade. v1 stops at 5.

## Known limits

- V3-style pools are priced inside their current price band (same as the gap
  scanner). A big trade that crosses into the next band is only an estimate;
  the practice check (real pool code) catches it.
- Ramses V2 pairs are priced as x*y=k; the pair watcher only follows their
  "volatile" pairs (which use x*y=k), never "stable" ones.
- Rebuilding the loop list (when pools come or go, at most every 5 s, and once
  a minute) takes tens of milliseconds; normal updates take a few.
