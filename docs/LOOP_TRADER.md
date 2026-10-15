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
   30% of the shallowest pool's money) and subtracts our gas. Loop gas is a
   fixed part plus a part per pool, fitted to the PR #116 fork tests
   (contract call only: 3 hops 502k, 4 hops 646k, 5 hops 758k; a 4-hop V3
   flash loan 760k): about 123k + 128k per pool. It is scaled from the
   bot's normal 2-pool gas estimate, so a 3-pool loop pays 1.34x the 2-pool
   gas, 5 pools 2.01x and 8 pools 3.03x.
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

**Timing tests.** The test prints all the timings below but, because the
server runs the tests before every deploy and a busy machine can stretch a
single timing, it only fails on generous limits by default (longest slice
under 60 ms, typical update under 20 ms). Run `PERF_STRICT=1 npm test` to
check the real 15 ms slice target.

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

**Before trying 8 pools live** (not just practice): gas for 6-8 pool loops
comes from a straight line through the measured 3-5 hop fork tests (8 pools
about 1.15M gas, 3.03x a 2-pool trade). That should be checked against a
real 8-hop practice check's gas before trusting the "after gas" numbers.

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

## Loop fix phase 2 (Oct 14): real prices, trigger replay, cheap scans

**Why.** An audit found loops looked profitable in the model but almost never
passed the practice check. The loop maths and the contract encoding were
right. The causes were:

1. Loops were priced on **predicted** pool states (the trade feed guesses a
   pool's new price before the trade is in a block). Small guess errors add up
   over 3 to 5 pools, worst in thin meme and stock-coin pools.
2. **Real block updates were thrown away**: when the feed had written a pool
   in the last 400 ms (`BLOCK_READER_FEED_GRACE_MS`), the block reader skipped
   the exact block state and never came back to it.
3. Loop practice checks ran on plain "latest", not right after the trade that
   opened the loop (2-pool checks replay the trigger's block first).
4. The loss shown for a losing loop check was only a gas guess.
5. Loop scans were the biggest freeze cause when loops were on.

**What changed** (each part has its own switch, all ON when `LOOP_TRADER=1`;
`=0` brings back the old behaviour for that part; with `LOOP_TRADER` off
nothing here runs or uses memory):

- **A. Real prices** (`LOOP_REAL_PRICES`). The pool cache keeps a second,
  small "confirmed" view: the last state that came from real chain data (a
  block the block reader read, or an RPC re-read), never a feed prediction.
  Loops are priced from it, plus the predicted effect of every feed trade on
  that pool that no block has confirmed yet, in feed order ("pending"
  trades). A trade leaves the pending list as soon as a confirmed state is
  known to include it: the block reader says which transaction made the
  pool's last event, and the feed shows trades in the chain's order, so
  everything up to that transaction is in. An RPC read (block unknown)
  counts for trades seen more than 1 s before it was saved, and anything not
  confirmed within `LOOP_PENDING_MAX_MS` (4 s) is dropped. So a trade is
  never missed by a later scan and never counted twice. The view stores
  references to states the cache already has (no copies), is cleaned up with
  the pool, and an RPC read with no block number can't replace a block state
  less than 0.5 s old.
- **B. Keep block updates** (`LOOP_KEEP_BLOCK_UPDATES`). When the block reader
  skips the main write because the feed wrote the pool moments ago, the block
  state still goes into the confirmed view (an older block never overwrites a
  newer one). The main cache, and so every 2-pool trade, is not touched.
- **C. Trigger replay** (`LOOP_TRIGGER_REPLAY`). A loop found right after a
  feed trade remembers that trade's hash. Its practice check then works like
  the 2-pool one: find the trigger's block, replay it up to and including the
  trigger, then run our loop. Fallbacks: the end of the trigger's block, then
  latest ("tested late"). A loop check may wait for the normal check line to
  be idle; if the trigger's block is too old for the node it falls back
  cleanly. Loops found with no trigger (5 s safety net, block updates) are
  checked on latest as before. A loop check counts as a running check on the checking
  node, so the 2-pool check line sees the node as busy while it runs.
- **D. Model vs check** (`LOOP_MODEL_VS_CHECK`). Each check records the
  model's profit before gas and the check's, and which timing the check used.
  The hourly block gets a line like
  `model vs check (profit before gas, by timing): right after trigger 4: model said $1.20, check said $0.30, gap 75% (3 lost, ...)`.
  The contract only reports the final result, and for a loss not even how
  much, so a loss counts as $0 (the real gap on losses is at least what is
  shown). Each check also logs the model's amount out of EVERY pool next to
  the check's end result (`[loop] ... model vs check: model per pool ...`).
  Replays report the gas the loop really used; that now teaches the gas
  model's loop estimate (loop kinds only), and the check result uses the gas
  estimate as of the check.
- **E. Cheap scan** (`LOOP_CHEAP_SCAN`, `LOOP_SCAN_SLICE_MS`). A scan where no
  pool state changed (and the finder has nothing waiting) is skipped. The
  finder already only re-prices loops through changed pools; its per-update
  work (the pool list, change check, quick and exact checks) now runs in
  slices of at most 8 ms with breaks for feed messages, timed as `loop scan`
  by the stall finder. The sorted pool-set key is only built when a pool
  joined or left. Results are exactly the same as a one-go scan (tested).

## Settings (.env)

| Setting | Default | What it does |
|---|---|---|
| `LOOP_REAL_PRICES` | on with `LOOP_TRADER=1` | Price loops from block/RPC confirmed pool states (part A). `0` = main cache (feed predictions included). |
| `LOOP_KEEP_BLOCK_UPDATES` | on with `LOOP_TRADER=1` | Keep block states the main cache skipped, for loops only (part B). Needs `LOOP_REAL_PRICES`. |
| `LOOP_TRIGGER_REPLAY` | on with `LOOP_TRADER=1` | Practice-check loops right after their trigger trade (part C). `0` = latest. |
| `LOOP_MODEL_VS_CHECK` | on with `LOOP_TRADER=1` | Model vs check line and log, loop gas learned from checks (part D). |
| `LOOP_CHEAP_SCAN` | on with `LOOP_TRADER=1` | Skip unchanged loop scans and run scans in slices (part E). `0` = one go. |
| `LOOP_SCAN_SLICE_MS` | 8 | Longest single slice of a sliced loop scan. |
| `LOOP_PENDING_MAX_MS` | 4000 | A feed trade no block has confirmed by then stops being added to loop prices. |
| `LOOP_TRADER` | off | `1` turns the loop trader on. Unset or `0` = off, exactly today's behaviour. |
| `LOOP_MAX_POOLS` | 5 | Longest loop searched (3 to 8). A value outside 3-8 is moved to the nearest end (9 becomes 8) and text that isn't a number means 5; both print a warning at start-up. |
| `LOOP_MAX_CYCLES` | 5000 | Most loops kept in the list, shared out evenly between the loop lengths searched. Loops through rival pools, then pools that moved in the last 10 min, are kept first. |
| `LOOP_LONG_SLACK` | 0.02 | Loops of 6+ pools are only listed if their best case is within this share (2%) of paying for gas. Bigger = more long loops listed, more work. 0 to 0.2. |
| `LOOP_MAX_TRADE_USD` | 2000 | Biggest loop trade size. |
| `LOOP_DEPTH_SHARE` | 0.3 | Trade at most this share of the shallowest pool's money. |
| `LOOP_MIN_NET_USD` | check bar ($0.10) | Smallest model profit after gas that counts and gets checked. Defaults to `SIM_MIN_GROSS_USD`, else `MIN_EXEC_NET_USD`, else $0.10. |
| `LOOP_CHECKS_PER_MIN` | 6 | Most loop practice checks a minute. `0` = find and report only. |
| `LOOP_CHECK_NODE` | free | Which node loop practice checks use. `free` = the free public Robinhood node: loop checks no longer take a slot in the 2-pool check line and never touch the main checking node (Chainstack). The "no reason" second opinion is skipped for loops (the only other node would be Chainstack). `main` = old behaviour (main checking node, shares the 2-pool line). |
| `LOOP_CHECK_RPC` | none | With `free`: use this node URL for loop checks instead of the free public node. Never logged. Refused (free node used) if it is the main checking node. |
| `LOOP_CHECK_DAILY` | 3000 | Most loop checks a day on the loop node (Toronto day). `0` = no limit. When the loop node says "slow down" or can't be reached, loop checks pause 60 s, doubling up to 10 min; a clean check resets it. If the node has no replay method (`eth_simulateV1`), loops test at the end of the trigger's block and the hourly line says "replay not supported on loop node". |
| `LOOP_NODE_MAX_RPS` | 2 | With `free`: most loop requests a second on the loop node. A loop request also only goes out when the free node's shared allowance (used by price reads) has nobody queued, under half its speed limit used in the last second and a free slot, so loops never wait in that queue or delay price reads. If it stays busy for 2 s in one check, the check is skipped ("skipped node busy" in the hourly line; not a pause). Loop checks also poll for the trigger every 300 ms, at most 6 times. |
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
3. **Contract deploy**: no contract is deployed yet (see
   `contracts/README.md`). Friday's deploy uses current main, which already
   has the Algebra callback and the Oct 12 audit fixes.
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
