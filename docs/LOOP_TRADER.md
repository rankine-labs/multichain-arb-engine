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
   lists loops of 3 to `LOOP_MAX_POOLS` pools (default 5, up to 8) that start
   and end in WETH or USDG. See "Longer loops (6 to 8 pools)" below.
2. **Prices them exactly.** Each loop is priced with the same pool maths the
   bot already uses (V2 copies, V3 copies, Algebra, Uniswap V4 including
   Fables). It finds the best trade size (up to $2,000, and never more than
   30% of the shallowest pool's money) and subtracts our gas (2-pool gas
   scaled by the number of pools: a 3-pool loop pays 1.5x, an 8-pool loop
   4x. There is no measured per-pool gas figure for our contract yet, so
   this simple scaling is used for every length).
3. **Counts each loop once.** A paying loop is counted once until it closes
   (same rule as the gap scanner: it counts again only after it disappeared,
   or if it at least doubled).
4. **Practice-checks paying loops** ($0.10+ after gas, the normal check bar)
   with the same free "pretend" test used for 2-pool trades (an eth_call with
   our contract's code dropped in; nothing deployed, nothing spent). Loop
   checks come last: only when the normal check line is idle, and at most 6 a
   minute.
5. **Reports** a "Loop trades" block in the hourly report.
6. **Keeps single pools fresh** for loops (see "Extra single pools" below).

**It never sends a trade.** The loop trader is never handed the sender or a
wallet; even with `EXECUTION_ENABLED=true`, loops are only practice-checked.

## The hourly block

Only shown when `LOOP_TRADER=1`:

```
Loop trades (3-5 pool loops, practice only, never sent)
Loop trades: found 12, best $0.84, checked 9, would make money 4 ($1.92), contract can't run 1
  found by length: 3p 7, 4p 3, 5p 2, 6p -, 7p -, 8p -
  1) WETH/DJT/PONS/USDG/WETH: 5x, best $0.84
  ...
Race vs rival loops: they won 40 (busiest: 0xd7572f 38); 29 were longer than our max of 5 pools, 2 not fully seen; of the other 9, we found 3, usually 1.2 s before we read their trade
  extra single pools watched: 240 (231 with a fresh price now)
Finder speed: 9,800 updates, typical 3.1 ms, slowest 14 ms; 5000 loops watched (3p 1348, 4p 1826, 5p 1826, 6p -, 7p -, 8p -); last list rebuild 40 ms in slices of at most 6.0 ms
```

- **found**: paying loops (model, after gas), each counted once until it closes.
- **found by length**: the same, split by number of pools (3 to 8). A "-"
  means that length is longer than `LOOP_MAX_POOLS`, so it isn't searched.
- **checked / would make money**: practice-check results (after gas).
- **contract can't run**: loops through an exchange the contract can't trade
  yet or that isn't approved for practice checks.
- **extra single pools watched**: single-pool pairs kept fresh for loops (see
  below), and how many had a fresh price when the report was made.
- **Race vs rival loops**: for each rival loop win of 3 to `LOOP_MAX_POOLS`
  pools, did our finder have the same pools paying shortly before? "before we
  read their trade" is measured against when our rival watch read their trade
  (a few seconds after it landed), so it is a rough lead, not an exact race
  result. "longer than our max" counts rival loop wins with more pools than
  we search: if this number is big, raising `LOOP_MAX_POOLS` may help.
  "not fully seen" means we didn't see every pool of their route.
- **Finder speed**: how long each update took, how many loops are in the
  list per length, and how the last list rebuild went (start to finish, and
  the longest single slice the bot was held up for).

## Longer loops (6 to 8 pools)

The top rival bot averages 7.5 pools per trade, so most of its wins show as
"longer than our max" at the default of 5. Setting `LOOP_MAX_POOLS=6`, `7` or
`8` lets the finder search those longer loops too. **The default stays 5.**

**Why longer loops need care.** The number of possible paths grows very fast
with length: with ~1,000 pools there are a few thousand 3-pool loops but many
millions of 8-pool ones. Listing them all would take seconds and freeze the
bot. So the finder does four things:

1. **Shares the list out between lengths.** `LOOP_MAX_CYCLES` is split
   evenly between the lengths searched (3, 4, 5, ...). A length that doesn't
   need its share passes the rest on to the longer lengths. So thousands of
   long loops can never push the short ones out.
2. **Only lists long loops that could come close to paying.** Before going
   deeper, the finder works out the best any route of N more pools back to
   WETH/USDG could possibly do (prices after fees, for a tiny trade, which is
   the best a loop can ever do: bigger trades only get worse prices). If even
   that best case can't get within `LOOP_LONG_SLACK` (2%) of paying for the
   loop's gas, the path is dropped. This check can only be too hopeful, never
   too strict, so it never drops a loop that pays (a test checks this on
   thousands of loops). It applies to loops of 6+ pools only; 3-5 pool loops
   are all listed as before.
3. **Tries the most promising first.** Pools rival bots used in their loop
   trades (last 24 h) go first. Then, for long loops, the paths with the best
   "best case"; for short loops, pools that moved recently and deep pools. So
   when a length's share is full, the most useful loops are already listed.
4. **Never freezes the bot.** The list is built in small slices of about 5
   ms; in between, price updates, timers and node replies run as normal. The
   old list keeps being used until the new one is ready. Each price update
   also has a time budget (12 ms): loops not priced in time are priced on the
   next update.

**A big price move rebuilds the list sooner.** Long loops are listed based on
prices at the time of the rebuild. If a pool's price moves by more than half
of `LOOP_LONG_SLACK` (1%) since then, the list is rebuilt early (at most every
5 s), so a long loop that a big trade just opened gets listed quickly.

**Measured speed** (test benchmark, ~1,000 synthetic pools: 700 watched + 300
extra, 10 pools moving per update):

| Setting | Loops listed | Typical update | Slowest update | Rebuild (start to finish) | Longest slice |
|---|---|---|---|---|---|
| 5 pools, 5,000 loops | 5,000 | ~1.5-2.5 ms | ~6-12 ms | ~20-40 ms | ~5-10 ms |
| 8 pools, 5,000 loops | 5,000 (about 830 per length) | ~1.7-2.6 ms | ~9-13 ms | ~20-50 ms | ~5-12 ms |
| 8 pools, 20,000 loops | 20,000 (about 3,700 per length) | ~3.2-3.8 ms | ~9 ms | ~110-130 ms | ~10-15 ms |

At 8 pools with the default 5,000 loops, each length only gets about 830
loops. If the hourly block shows the list hitting its cap, raising
`LOOP_MAX_CYCLES` (e.g. 20,000) lists more long loops at a small cost.

**Before trying 8 pools live** (not just practice): gas for an 8-pool loop is
assumed to be 4x a 2-pool trade. That should be checked against a real
8-hop practice check's gas before trusting the "after gas" numbers.

## Extra single pools (loops through pairs that sit on one pool)

**The problem.** The bot only keeps prices fresh for coin pairs that sit on
2+ pools, because a 2-pool trade needs two pools. A pair on just one pool
(often the middle step of a rival loop, e.g. DJT/PONS) was remembered but
never updated, and the loop finder only uses fresh prices. So loops such as
WETH -> DJT -> PONS -> USDG -> WETH, the kind the rival bot 0xd7572f makes
about $464 a day on, were invisible.

**What the bot does now** (only when `LOOP_TRADER=1`):

1. **Picks up to 300 single pools.** A single pool is picked when it has at
   least $10,000 in it (`POOL_MIN_DEPTH_USD`, same bar as everywhere else)
   and both of its coins can be reached from WETH/USDG so the pool can sit on
   a loop of 3 to `LOOP_MAX_POOLS` pools. Pools that rival loop trades went through (last 24 h)
   come first, then pools on the coins those rivals used, then the deepest.
2. **Finds new ones from the chain-wide scan.** The scan knows every pool on
   the chain but not how much money is in it. Promising single pools (both
   coins already on our coin map, or a coin like PONS that joins two coins on
   the map) get one cheap balance read each, bundled hundreds to a request.
   The ones with money are then looked up properly (exact price, fee, coin
   decimals), about 40 per round. A pool with no money isn't looked at again
   for 6 hours.
3. **Keeps them fresh.** Picked pools are added to the block reader's list,
   so every trade on them updates the price straight from the block. This
   costs **no extra node requests**: the block reader already fetches every
   block's trade events and keeps the ones for our pools. On top of that, one
   bundled re-read of all picked pools every 20 s (1-2 requests, on the gentle
   scan lane) keeps quiet pools counted as fresh and corrects any drift. A
   re-read never overwrites a newer price from the block reader.
4. **Rebuilds the pick** every 10 minutes and right after each chain-wide scan.

**What it does NOT change.** Extra pools are never added to the pair
watcher's watch list. The 2-pool gap scanner and the back-run planner never
see them; only the loop finder does. A trade on an extra pool triggers a loop
scan only (not a gap scan). With `LOOP_TRADER` unset, none of this exists.

**Where to see it.** The 5-minute `[blockreader]` log line ends with
`loop extra pools: N fresh / M selected`; each rebuild logs a
`[loop] extra single pools ...` line; the hourly "Loop trades" block shows
`extra single pools watched: N`.

## Settings (.env)

| Setting | Default | What it does |
|---|---|---|
| `LOOP_TRADER` | off | `1` turns the loop trader on. Unset or `0` = off, exactly today's behaviour. |
| `LOOP_MAX_POOLS` | 5 | Longest loop searched (3 to 8). A value outside 3-8 is moved to the nearest end (9 becomes 8) and text that isn't a number means 5; both print a warning at start-up. |
| `LOOP_MAX_CYCLES` | 5000 | Most loops kept in the list, shared out evenly between the loop lengths searched. Loops through rival pools, then pools that moved in the last 10 min, are kept first. |
| `LOOP_LONG_SLACK` | 0.02 | Loops of 6+ pools are only listed if their best case is within this share (2%) of paying for gas. Bigger = more long loops listed, more work. 0 to 0.2. |
| `LOOP_MAX_TRADE_USD` | 2000 | Biggest loop trade size. |
| `LOOP_DEPTH_SHARE` | 0.3 | Trade at most this share of the shallowest pool's money. |
| `LOOP_MIN_NET_USD` | check bar ($0.10) | Smallest model profit after gas that counts and gets checked. Defaults to `SIM_MIN_GROSS_USD`, else `MIN_EXEC_NET_USD`, else $0.10. |
| `LOOP_CHECKS_PER_MIN` | 6 | Most loop practice checks a minute. `0` = find and report only. |
| `LOOP_MAX_POOL_AGE_MS` | 30000 | Pools whose price is older than this are left out. |
| `LOOP_EXTRA_POOLS` | on with `LOOP_TRADER=1` | Keep single-pool pairs fresh for loops. `0` = off. Never on without `LOOP_TRADER=1`. |
| `LOOP_EXTRA_POOLS_MAX` | 300 | Most single pools kept fresh (up to 2,000). |
| `LOOP_EXTRA_REFRESH_MS` | 20000 | Bundled re-read of the picked pools (2/3 of `LOOP_MAX_POOL_AGE_MS`, at most 20 s). `0` = only trades update them, so quiet pools drop out of the finder. |
| `LOOP_EXTRA_LOOKUPS` | 40 | New single pools from the scan looked up properly per 10-minute round. `0` = only use single pools the bot already knows. |

Pools also need `POOL_MIN_DEPTH_USD` ($10,000) of money, like the gap scanner.

## Can our contract run a loop?

**Yes.** `ArbExecutor.execute()` takes a list of hops of any length (2 or
more), each hop its own exchange type (V2, Solidly, V3/Algebra, V4, hooked
V4). It checks the route chains coin to coin and starts and ends in the same
coin, runs the hops in order, and at the end checks that no coin went down and
the start coin went up by at least the minimum profit. So a 3-8 pool loop
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
6. **Keep more pools fresh**: done (see "Extra single pools" above). Check
   the hourly "Race vs rival loops" line: "we found" should rise for rival
   loops through single-pool pairs.
7. **Longer loops**: done, up to 8 pools (`LOOP_MAX_POOLS`, default still
   5). See "Longer loops (6 to 8 pools)" above. Check the gas for 6-8 pool
   loops against real practice checks before going live.

## Known limits

- V3-style pools are priced inside their current price band (same as the gap
  scanner). A big trade that crosses into the next band is only an estimate;
  the practice check (real pool code) catches it.
- Ramses V2 pairs are priced as x*y=k; the pair watcher only follows their
  "volatile" pairs (which use x*y=k), never "stable" ones.
- Extra single pools add up to 300 pools to the loop finder. The loop list
  is still capped at `LOOP_MAX_CYCLES` (5,000, shared between lengths); rival,
  recently moved and deeper pools are kept first, so the cap can push some
  quieter loops out.
- Long loops (6+ pools) are listed from the prices at the last rebuild. A
  loop that was far from paying then and becomes paying through many small
  moves (each under 1%) is only picked up at the next rebuild (at most a
  minute later, usually sooner because the pool set changes often).
- An extra pool's price is exact after every trade (from the block). Between
  trades it is confirmed by the 20 s re-read; if the node is busy and a
  re-read fails, those pools briefly drop out of the finder (safe side).
- Rebuilding the loop list (when pools come or go, or a price moves a lot,
  at most every 5 s, and once a minute) takes tens of milliseconds in total
  but is done in slices of about 5 ms, so it never holds the bot up for
  long. The new list goes in on the next update after it is ready.
