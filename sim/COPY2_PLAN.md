# Copy 2: our pools' copy kept current from pool events (build plan, Oct 21 2026)

Owner: Rudy (not a developer: comments in plain English, every file explains itself).
Goal: the fast check (arbsim engine, already proven 10,142/10,142 exact vs node) answers
from a copy of OUR pools that is kept current from those pools' own events, so the bot
checks a gap in ~1 ms instead of asking the node (160 to 250 ms). Trigger to signed
trade ~20 ms.

## Why (all measured, see project doc InBot_Profit_Reaction_2026-10-21)
- Copy 1 (replay every chain tx, sim/src/state/updater.rs + feed/) FAILED live:
  ~2.1M node reads/day. Keep its code; copy 2 is a NEW source of truth next to it.
- Offline proof (branch inbot-sim/bench, bench/event-copy-test/, results.md):
  event "fields" exact for V2 and Solidly (0 node reads); event "replay with the
  pool's own code" exact for V3, PancakeSwap V3, Algebra Integral (+plugin), V4
  hook-free (21,618 checks, 0 wrong in strict mode). Helpers.sol + lib.js +
  types/*.js + copycheck/ show exactly how each type was replayed. READ THEM.
- Pool reports (Chainstack WSS logs) arrive as fast as the sequencer feed
  (median 7 ms earlier). Live: ~10 tx/s touch our ~800 pools.

## Shape
- arbsim (Rust sidecar, Unix socket, 4-byte BE length + JSON) gets a new source:
  ARBSIM_SOURCE=pool-events (default stays the old feed mode until we switch).
- Bot (TypeScript) sends:
  - `track` {pools:[{address, v4Id?, kind, token0, token1, fee, tickSpacing}]}
    (the watched pools whose type copy 2 supports; re-sent on change / every 10 min)
  - `pool_logs` {block, timestamp, l1Block?, logs:[raw eth logs]} one message per
    block that has events on tracked pools (also coin Transfer logs to/from those
    pools), in block order. Blocks with no events: optional `block_tick` so the
    copy knows it is current.
- arbsim keeps, per tracked pool, the pool's storage + its two coins' balance slots
  for the pool (+ PoolManager slots for V4 ids, + Algebra plugin storage). First load:
  lazy fill from the node at the copy's block (state/fill.rs already handles
  "fetched at k, copy at B" carry-forward). Then each event is applied:
  fields (V2/Solidly) or replay (others). Publishes a Version per block into the
  existing mirror (state/mirror.rs, snap.rs) so `call` / `size_search` with
  at {"after":"head"} or {"block":N} read it.
- STRICT, ALWAYS: anything not exactly known is MISSING (never zero). A pool whose
  event can't be applied exactly -> UNSURE (checks touching it answer
  "unknown: unsure-pool"), reload it from the node in the background. Reorg
  (removed log) -> that block's pools UNSURE + reload. Never a guess.
- Status: per-pool state (loading / ready / unsure), events applied, unsure count,
  node reads used (daily allowance applies: node.rs budget classes).

## Workstreams (parallel; each its own branch off inbot-sim/main)
- A (Rust) `inbot-sim/copy2-a`: sim/src/copy2/intake.rs + wiring. `track` and
  `pool_logs` in proto/server; tracked pool set; per-block apply loop (ordered by
  block, tx index, log index); V2 + Solidly field application; coin Transfer ->
  pool coin balance slots (find the balance slot layout once via the node, like
  the bot's findBalanceSlot, cached); lazy fill + UNSURE + reload; publish
  Versions; status counters; ARBSIM_SOURCE switch. Calls B through
  `copy2::replay::apply_replay(...)`; until B lands, those kinds are UNSURE.
- B (Rust) `inbot-sim/copy2-b`: sim/src/copy2/replay.rs. `pub fn apply_replay(
  db: &mut <A's mutable overlay>, pool: &TrackedPool, log: &PoolLog, ctx: &BlockCtx)
  -> ApplyResult` for V3, PancakeV3, Algebra (+ plugin beforeSwap), V4 no-hook:
  re-run Swap / Mint / Burn / Collect / Flash / (V4 ModifyLiquidity, Donate) with the
  pool's own code inside revm on the copy, using a helper caller (port Helpers.sol
  logic; compiled bytecode embedded) that pays callbacks; then CHECK the result
  matches the event's own numbers (price, tick, liquidity, amounts) else Unsure.
  Agree the overlay type with A by reading A's branch / DESIGN; if A isn't there
  yet, write against a small trait in replay.rs that A implements.
- C (TypeScript) `inbot-sim/copy2-c`: bot side. Tap the block reader's pool logs
  (src/core/blockReader.ts, WSS) and forward per block as `pool_logs`; send
  `track` from the watch list (kind mapping: kindForPool / dex names); add copy-2
  readiness to localSimHost (per pool ready flag from status); route sitting-gap
  and loop checks to the fast check when every pool on the route is ready, else
  node as today. Switch LOCAL_SIM=on + LOCAL_SIM_CONFIRM=yes-fast-check already
  exists (auto step-back on disagreement already built). Rudy wants it LIVE
  directly (no long practice), so make "on" mode solid; keep off by default.
  Hourly Telegram line: copy ready pools, unsure, fast checks, node checks.
- D (TypeScript/JS) `inbot-sim/copy2-d`: checker. scripts/sim-compare/copy2-dryrun.js:
  runs a separate arbsim (test socket) in pool-events mode next to the bot,
  feeds it from its own Chainstack WSS log subscription, and every N blocks
  compares (1) each ready pool's key slots vs the node at that block and
  (2) fast vs node answers for real checks (bot's simulateRoundTrip on the node).
  Read only; reads only CHAINSTACK_* lines from .env, never prints them. Output a
  plain-English summary (match %, unsure %, node reads). Plus offline tests.

## Rules for every agent
- Never touch, print or ask for private keys. No transactions, no deploys.
- Work only on your branch; push it (git push origin <branch>). Do not merge to
  main, do not open PRs (the coordinator does). Do not run git checkout -- . or
  anything that throws away work.
- This sandbox cannot reach chain RPCs. Test offline: cargo test (sim/), the
  bench offline harness (anvil/forge in ~/.foundry/bin), npm test / tsc for TS.
- Every new file starts with a plain-English header; comment the why.
- Keep existing tests passing: `cd sim && cargo test`, `npx tsc --noEmit`,
  `npm test` (bot), sim-compare tests.
- Report back: what you built, tests run + results, what is NOT done, risks.

## Workstream A: what was built (for C / D / the coordinator)
- Files: copy2/overlay.rs (working copy B replays on), copy2/fields.rs (V2 +
  Solidly), copy2/coins.rs (coin balance places), copy2/intake.rs (thread,
  wire parsing, status), copy2/replay.rs = PLACEHOLDER: when merging B, take
  B's replay.rs whole (same signatures: apply_replay, finish_block, has_pending).
- Switch: ARBSIM_SOURCE=pool-events (default feed). Tunables:
  ARBSIM_COPY2_RELOAD_MS 2000, ARBSIM_COPY2_RELOAD_MAX_MS 600000,
  ARBSIM_COPY2_LAYOUT_RETRY_S 3600, ARBSIM_COPY2_LOAD_BATCH 25 (pools per
  job), ARBSIM_COPY2_LOADERS 4 (threads), ARBSIM_COPY2_KEEP_BLOCKS 2400
  (reports kept for carrying loads forward), ARBSIM_COPY2_MAX_ROUNDS 40,
  ARBSIM_COPY2_TIP_EVERY_S 30.
- Loading never holds up blocks (fix after the Oct 21 dry run): all node
  questions go to loader threads (copy2/loader.rs), PAID node first
  (call_batch_paid), ARBSIM_NODE_BATCH calls per HTTP request; values are
  fetched at block k and the pool's own reports for k+1..now are applied from
  the buffer before it turns ready. Load speed = paid calls / ARBSIM_NODE_RPS
  (default 8 calls/s!): about 9.5 calls per V2 pool, ~16 per Solidly pool,
  ~2 per V3/V4/Algebra pool up front + values fetched when its first events
  arrive. 800 pools ~ 6,000-8,000 calls: ~15 min at RPS 8, ~4-5 min at
  RPS 25-30 (set ARBSIM_NODE_RPS to what the Chainstack plan allows). The log
  prints "copy2: load round done: N pools in T s using X node requests".
- Socket (C): `track` {pools:[{address, v4Id?, kind: v2|solidly|v3|pancake-v3|
  algebra|v4, token0, token1, fee, tickSpacing}], coinSlots?: the bot's
  data/balance-slots.json entries} -> {ok, tracked, skipped}.
  `pool_logs` {block, timestamp, l1Block, baseFee?, prevBlock, logs} and
  `block_tick` {block, timestamp, l1Block, prevBlock}: no answer.
  PLEASE send a block_tick for EVERY block without events (checks at
  {"block":N} need a version for N, and head's time must be current) and
  always `prevBlock` (= block of your previous pool_logs/block_tick): a
  mismatch means a lost message and every pool is reloaded.
  Forward ALL coin Transfer logs to/from tracked pool addresses (incl. the V4
  PoolManager), also while pools are loading.
- Coin balance places the bot already knows (saves 2+ node requests per
  coin and avoids probing): send the content of data/balance-slots.json,
  either inside `track` as `coinSlots`, or on its own (any time, e.g. at
  start and whenever the file changes):
    {"id": 7, "type": "coin_slots", "coinSlots": {
       "robinhood:0x5fc5...": {"layout": "solidity", "slot": 1},
       "robinhood:0x0bd7...": {"layout": "solidity", "slot": 51},
       "0xabc...":            {"layout": "vyper",    "slot": 3} }}
    -> {"id": 7, "ok": true, "accepted": 3}
  Keys: "chain:0xtoken" (the file's own keys) or plain "0xtoken"; layout
  "solidity" = keccak(holder . slot), "vyper" = keccak(slot . holder).
  They replace a "not found", and pools waiting on that coin retry at once.
  arbsim still checks each coin ONCE (storage value == balanceOf(pool)).
- Node behind the websocket (dry run #3): loads / probes / fills are fetched
  at min(copy block, node's newest block) and carried forward; a node error
  object (unknown block, rate limit, timeout...) is never "not found", it is
  retried. Reports are kept while a load still needs them
  (ARBSIM_COPY2_MAX_KEEP_BLOCKS, 40000). A block re-sent with the same
  reports plus new ones after them applies just the new ones (no reorg).
  Each load round logs "copy2: load round done: ... outcomes: N ready, N
  coin balance place not found, N node errors (retried), N layout/balance
  mismatch, N other unsure" (and a progress line every 60 s while running).
- Dry run #4 fixes:
  - Late reports are judged PER POOL (the bot hears reports on ~18 separate
    subscriptions): a message for an already-applied block adds the reports
    we didn't have; each is applied to its pool if that pool has nothing
    applied after it (written into every kept version from that block on),
    else that pool alone goes unsure. Coin transfers likewise per (coin,
    pool): a transfer older than one already applied forgets that balance
    (fetched again) instead. Only `removed: true` reports are reorgs. Two
    messages for a block not yet applied are merged. prevBlock only flags a
    lost message when the block it names never arrived.
  - Coins without a general balance layout: per (coin, pool) the load runs
    debug_traceCall(balanceOf(pool), prestateTracer); the one coin slot equal
    to the balance is that pool's balance slot (2 calls per coin+pool, once;
    status counters coin_traces / coin_trace_found / coin_trace_not_found).
    The trace also loads the coin's code and the settings balanceOf reads.
  - READY now includes what a check needs: pool code + the slots its swap
    reads (V2: 0,6-10,12; Solidly: 2,10-23 + factory 0,1,2,customFee + clone
    implementation; V3: 0-4; PancakeV3: 0-5; V4: pools[id] 0-3), coin code.
  - Loader queues: values checks missed and catch-up fetches go BEFORE bulk
    first loads (before, fills waited behind minutes of loading).
  - Cost: ~14 paid calls per V2 pool, ~25 per Solidly, ~10 per V3/V4 (+2 per
    coin+pool without a known layout). 800 pools ~ 9,000-12,000 calls =
    6-8 min at ARBSIM_NODE_RPS=25. Sending coin_slots saves the probes.
- Dry run #5 fixes (loading speed):
  - 16 general loader threads (ARBSIM_COPY2_LOADERS) + 6 balance-trace
    threads (ARBSIM_COPY2_TRACE_LOADERS); lanes urgent > bulk, traces apart.
  - Bulk loads use node budget class "bulk": they only use speed-limit room
    (never push ARBSIM_NODE_RPS into debt), so urgent fetches never wait
    behind them. Expected: loading runs at ~ARBSIM_NODE_RPS calls/s.
  - Exact-block catch-up fetches answer "not there yet" at once (no thread
    sleeps); asked again after 300 ms, not counted as errors.
  - Pools that had events most recently load first.
  - A load answer is digested one pool at a time; new blocks go in between.
  - status copy2.loader: threads / busy, queued (urgent, bulk, trace),
    requestsPerSecLastMin, byKind {load, catchup, fill, trace, probe, tip}:
    jobsLastMin, avgMsLastMin, jobs, avgMs. Shown by deploy/arbsim-status.js.
  - A pool going unsure on a report logs kind, pool, block, tx, log index and
    the reason; replay reverts now include the revert reason (e.g. "LS").
- Dry run #6 stall (fixed): root cause = the node speed limiter (node.rs
  Budget). Urgent requests (fills of checks' misses, probes) were allowed to
  run the limit into debt and their waits were cut at 10 s, so a steady
  stream of them kept it in debt forever; the "bulk" class waited for a
  positive bucket and never got one -> 16 threads stuck in bulk loads, 0
  requests, probes ~30 s (3 x 10 s debt waits). Now: exact, fair limiter
  with two lanes (bulk / everything else): one busy lane gets the full rate,
  both busy get half each; no 10 s cut; a request facing > 30 s of queue is
  refused (tried on another node or later). One fill job at a time (100
  values). Test reproducing it: copy2_intake
  loading_keeps_flowing_under_the_speed_limit_with_checks_asking_too (before
  the fix: 0 of 120 pools ready after 40 s; after: all in ~13 s), plus
  node.rs speed_limit_is_fair_... .
  Watchdog: "[arbsim] copy2 WATCHDOG: no node answer for N s while M job(s)
  wait or run ..." with each busy loader thread's job and the speed-limit
  wait per lane (at most every 30 s). status: copy2.loader.busyThreads,
  secondsSinceLastAnswer; node.waitMs {main, bulk}.
- Dry run #7 retry storm (fixed by making copy 2 SELF-PACING):
  - Cause: copy 2 handed the node client far more than the rate allowed
    (16+6 threads, 325-call jobs); the limiter's 30 s refusals were counted
    as "allowance used up" (that was the 21,004 "refused" at 4.4 % used: not
    the class shares), as node requests and as node errors, retried after
    2-3 s, and fell back to the public node.
  - Now: copy 2's loader queue holds its own call budget,
    ARBSIM_COPY2_RATE_PCT (80) % of ARBSIM_NODE_RPS, at most 0.1 s worth let
    out at once; a job only leaves the queue when there is room for its
    calls. Urgent work (fills, catch-up) gets at most ARBSIM_COPY2_URGENT_PCT
    (25) % while loading waits. Bulk work in flight is capped at ~2 s of
    budget; load jobs ~2 s of calls each. Calls are counted only when really
    sent. Bulk/trace/probe work never goes to the public node.
  - node.rs speed limiter: one FIFO clock, strict spacing at 97 % of
    ARBSIM_NODE_RPS (no 1-s window over the plan rate); a refusal (> 30 s
    queue) is "speed limit", counted as throttledToday, NOT as allowance.
  - Every retry backs off: 1 s doubling to 30 s, +-25 % jitter (loads,
    traces, probes, catch-up fetches).
  - Coin places: probe once per coin; if it fails, ONE trace per coin; if
    that slot fits a standard layout (Solidity/Vyper slot 0-200, OpenZeppelin
    v5 namespaced ERC20, Solady) the layout is known for every pool of the
    coin; only coins with no standard layout get one trace per pool.
  - Soak test (copy2_intake soak_800_pools_...): 800 pools, node with 300 ms
    answers and a 25/s plan limit answering 429 when exceeded, checks missing
    values at 2x the limit; time runs 40x fast. Result: 800/800 ready after
    12.5 simulated minutes, 0 x 429, worst 1-s window 85 % of the limit.
  - Expected live at ARBSIM_NODE_RPS=25: copy 2 sends <= 20 calls/s; loading
    gets 15-20/s -> 800 pools (~13 calls each) in ~9-12 min. 5 min is not
    possible at 25/s: 800 x 13 calls need >= 7 min at the FULL rate.
- Dry run #8 (simpler loading with eth_getProof):
  - Every job (load, catch-up, fill) asks ONE eth_getProof per account with
    all its slots (balance, nonce, code hash + values come back together);
    eth_getCode once per code hash (cached). V2 pool ~2 requests instead of
    ~14; coins' balance slots for many pools come in one proof per coin. If
    the node doesn't know eth_getProof, one request per value as before.
  - Fills: one job at a time, <= ARBSIM_COPY2_FILL_RPS (10) requests/s,
    grouped per account; values of pools still loading are refused (the
    load brings them).
  - node.rs: a request that would queue more than ARBSIM_NODE_MAX_QUEUE_MS
    (2000) is refused (not sent, counted as throttled), so no batch lines up
    20 s of work.
  - First 5 node errors per job kind are logged ("copy2 node error #n (kind:
    method/item: message)") and shown in status copy2.loader.firstErrors /
    errorsByKind (and by deploy/arbsim-status.js).
  - Soak (40x time): 800/800 ready at 128 simulated s, 2,555 node calls in
    total incl. fills (947 eth_getProof), 0 x 429, worst second 86 % of the
    limit. Expected live at ARBSIM_NODE_RPS=100 (copy 2 at 80/s): ~1,700
    load requests -> roughly 30-60 s for 800 pools.
- Dry run #9 fixes:
  - This Nitro node gives eth_getProof only for very recent state
    ("historical state ... is not available"). Such accounts are read with
    eth_getStorageAt / eth_getBalance / eth_getTransactionCount / eth_getCode
    AT THE SAME BLOCK in the same job (exact, no retry loop); eth_getProof is
    still used whenever the node answers it.
  - Requests WAIT their turn in the node client (copy 2 paces itself); the
    queue cap is only a safety valve now (ARBSIM_NODE_MAX_QUEUE_MS 10000).
    A speed-limit refusal (nothing sent) is retried in ~0.3 s and is not a
    failure (no growing backoff).
- Dry run #10 -> SIMPLIFIED (replaces the pacing / lanes / refusals of #6-#9):
  - Bug: the node client charged one token PER VALUE inside a request (a
    25-value batch = 0.25 s of a 100/s budget) and re-routed refused proofs
    to the other paid node and the public node.
  - node.rs speed limit: one plain token bucket at ARBSIM_NODE_RPS counting
    HTTP requests (a batch or an eth_getProof = 1); waits, never refuses for
    speed. Daily allowance also counted in HTTP requests.
  - Copy 2: ARBSIM_COPY2_INFLIGHT (8) workers = at most 8 requests in
    flight, one queue: urgent (catch-up, the one fill job, tip) before bulk
    (loads most-recently-active first, probes, traces). Paid node only, no
    re-routing. Any error: 1-30 s backoff; first 5 errors per kind logged.
    Removed: ARBSIM_COPY2_LOADERS / TRACE_LOADERS / RATE_PCT / URGENT_PCT /
    FILL_RPS, ARBSIM_NODE_MAX_QUEUE_MS.
  - Status copy2.loader: requestsPerSecLastMin (HTTP), inFlight, threads,
    queued {urgent, bulk}, byKind answer times, firstErrors.
  - Soak (plan 100 HTTP req/s, RPS 80, 8 in flight, 300 ms answers, checks
    missing values at 2x, 40x time): 800/800 ready at 67 simulated s, 133
    HTTP requests in total, 0 x 429.
- Dry runs #11b/#12 fixes:
  - Every "unknown: miss" answer lists its items in `missing`
    ([{account, slot?}]); status copy2.missesByClass counts them by class.
  - Caller: in copy-2 mode a check's `from` that the copy doesn't know is
    run as if the request had the override {from: {balance 0, nonce 0, code
    empty}} (only if the request doesn't override `from`). Exactly the
    node's answer for the same call WITH that override; differs only if the
    called code reads the caller's own ETH balance / code / nonce.
  - Loads / probes / traces / fills read at the copy's head (or the node's
    tip if behind) AS OF WHEN THE JOB STARTS, not when queued. A catch-up
    more than 8 blocks old restarts that pool's load at the newest block.
- Node timing tools (read only):
  - `arbsim node-bench [--url-env NAME] [--n 50] [--parallel 16]
    [--probe-coin 0xCOIN] [--copy2-load pools.json]` (from the app folder;
    reads .env; never prints the URL). A-F: raw vs node client, sequential
    vs parallel. G: one real coin probe. H: copy 2's real loading of the
    pools in pools.json (same JSON as `track`: {"pools":[{address, kind,
    token0, token1, fee?, tickSpacing?, v4Id?}], "coinSlots"?}) fed with the
    node's newest block every 250 ms, progress every 5 s.
  - The first ARBSIM_HTTP_LOG (100) copy-2 HTTP requests are logged:
    "copy2 http #n: node1 [eth_getProof x5, eth_call x2] 7 calls, 31 keys,
    answer 220 KB, 140 ms total (60 ms reading the answer), 0 error item(s)".
  - eth_getProof only for accounts with <= 12 values; accounts with more
    (coins holding many pools' balances) use plain eth_getStorageAt batches.
- Status: `status` -> `copy2` {pools, loading, ready, unsure, lastBlock,
  unsureReasons, counters}; with {"pools": true} also `list` of {address,
  v4Id, kind, state, reason, events}. Checks touching a pool that isn't
  ready answer unknown "unsure_pool".
- Dry run #16 fixes (inbot-sim/copy2-f):
  - Request storm (from minute ~22: ~95 requests/s = our own cap while
    Chainstack answered -32005 "You've exceeded the RPS limit"; ready
    776 -> 650, loading 12 -> 139). Ready pools turn "loading" only when a
    replay needs a value the copy doesn't hold (start_partial_in_block, also
    Algebra end of block). The escalation: the catch-up fetch was refused,
    retried after 1-2 s, by then > 8 blocks old -> the pool's WHOLE load was
    restarted (every slot it ever held asked again), refused again, ... Fix:
    a "too fast" refusal only waits and asks again (1, 2, 4 s), never
    restarts the load; the old-block restart rule is 64 blocks
    (ARBSIM_COPY2_CATCHUP_MAX_BLOCKS) and is suspended while refused. Any
    refusal pauses new first loads and fills for 1-4 s.
  - node.rs adaptive speed limit: a provider refusal (-32005, HTTP 429,
    "rate limit") halves the allowed rate at once (at most once per second,
    floor ARBSIM_NODE_MIN_RPS 2) and drops saved-up burst; after 2 s without
    a refusal it grows back by 5 % of ARBSIM_NODE_RPS per second. Status:
    node usage rpsNow / providerRefusals / rateCuts; copy2.nodeRate; copy2
    counters node_refusals, need_refusal_retries.
  - eth_blockNumber: loads / fills / probes use the last known node tip
    (refreshed at most every ARBSIM_COPY2_TIP_MS 2000); exact catch-ups at
    most every ARBSIM_COPY2_TIP_EXACT_MS 500; a failed refresh never fails a
    job when a tip is known, and pauses refreshes 5 s.
  - Fills: values asked again after "pool traded after the read" wait 1 s
    (no tight loop); a slot of one ordinary pool ready since the read is
    used even if the pool traded since (its events' changes are carried).
  - Coin balance drift (41 of 627 probes, persistent offsets), two causes,
    each reproduced by a test first:
    1. The checker subscribes to Transfers FROM our pools and TO our pools
       separately, so a transfer between two followed pools came twice in
       one block message and was applied twice (copy2_intake
       the_same_report_twice_in_one_message_is_applied_once). Now repeated
       reports in a message are dropped (counter duplicate_logs).
    2. A late coin Transfer for a pool whose load was WAITING for node values
       past that place was lost: the buffer got it, but the load had already
       carried beyond it and the copy didn't hold the balance yet, so the
       pool became ready off by exactly that transfer (copy2_coins_anvil
       late_coin_transfer_while_a_load_waits_for_values_is_not_lost, real V3
       pool on anvil). Now added to the waiting load (counter
       late_transfers_to_loading).
    Safety net: a reload whose own coin balance disagrees with the one the
    copy followed makes that balance MISSING in every kept version and logs
    "copy2: coin ... the copy followed X but its reload says Y" (counter
    coin_balance_disagree).
  - Replay: "owner() on <factory> did not answer" now says how (reverted +
    reason / halted + why / answered N bytes + what the copy holds there).

- Dry run #17 fixes (inbot-sim/copy2-g): coverage (1/3 -> nearly all checks
  answered by the copy) and three accuracy holes.
  - Misses, proved (tests/copy2_coverage_anvil.rs big_checks_*, walks off =
    the #17 code): a ready pool held only V3 slots 0-4 / Pancake 0-5 / V4
    pools[id] 0-3 / Algebra nothing + what its replays had asked for. The
    2-pool round trip at 100 USD answered; 1k..150k USD missed on the
    pools' own tick-map words, ticks and price history ("ready pool slot":
    24..182 per run), exactly #17's class.
  - Tick walk (copy2/walk.rs + TickLens.sol): ONE debug_traceCall per pool
    with the prestateTracer of a lens contract (state override, never
    deployed) that asks the pool through ITS OWN getters for every
    tick-map word in +-ARBSIM_COPY2_WALK_TICKS (32768 ticks, at least 8
    words each side), every initialized tick in it (Algebra: the whole tick
    list + tick tree), the price history (up to 1024 entries) and settings,
    and runs two probe swaps (~2 % price move) cancelled in the callback.
    Only the pool's own storage is learned (V4: only this pool's entries in
    the PoolManager, computed from the id; owned plugin storage); taken in
    like fills (pool ready since <= k, same load), last_pos moved to k.
    Re-walked when the price moves half the window away. After walks: 12/12
    sizes answered and exact (success, output, gas) for V3 (spacing 1),
    PancakeV3, Algebra (+plugin), V4. A swap that uses up ALL liquidity
    walks to the price limit (beyond the window): may miss, never wrong.
    Settings: ARBSIM_COPY2_WALKS (2 at once, 0 = off), _WALK_TICKS,
    _WALK_MIN_WORDS, _WALK_MAX_TICKS (3000), _WALK_MAX_OBS, _WALK_PROBE_BPS,
    _WALK_GAS (40M), _WALK_MAX_SLOTS (150000 total, memory guard).
    Cost per pool (anvil, 18 positions): V3 spacing 1 446 slots / 121 KB
    answer / 1.7M gas; Pancake 161 / 84 KB; Algebra 204 / 121 KB; V4 133 /
    75 KB. Memory ~315 B per slot in the copy (imbl) + 52 B bookkeeping.
  - Accuracy 1, PancakeSwap farm (#17: 8 of 9 "LS" checks on Pancake
    0x18AB..2486; #16 log "replay did not reproduce: exactIn reverted
    (LS)"). Cause: the pool calls its farm (lmPool) on every swap /
    crossed tick; the farm's numbers also change by MasterChef stakes that
    emit NO pool event, so the copy's farm went stale and its swap failed
    with the farm's "LS" (reproduced: pancake_farm_* with the fix switched
    off gives exactly that log). Fix (replay.rs outside_ok): in V3 / Pancake
    swap / mint / burn / collect / flash replays every other contract the
    pool calls is a STOP stand-in (exact for the pool's storage: the real
    call didn't fail, and a call returning nothing can't change what the
    pool computes); that contract becomes VOLATILE: checks through a
    farmed Pancake pool answer unknown (never wrong). Status
    outsideContracts; missesByClass "outside contract (never kept)".
  - Accuracy 2, late reports (#17: 4 probes with wrong slot0 / coin
    balances). Cause: the checker (and the bot) send a block when its
    header + a grace time passed; reports come on ~18 separate
    subscriptions, so some arrive after the block went out. The copy's
    version of that block lacked them and ANSWERED (reproduced in
    late_coin_transfers_*: with the new gate switched off the probe answers
    ok with the old balances; slot0 right, balances wrong = 0x0c0c's
    pattern). Fix: "pending" pools (header logsBloom positive without such a
    report; swap / mint / collect without its coin Transfers; coin
    Transfers of a V3-style pool without its event): answers touching them
    at that block or later = unknown "pending_reports"; after
    ARBSIM_COPY2_PENDING_MS (1500) one eth_getLogs batch (pool addresses,
    Transfers from / to them, V4 ids) settles the blocks, missing reports
    are applied as late reports. Messages may now carry `logsBloom` (the
    checker sends the header's; the bot's feed has no header bloom: only
    the transfer / event rules apply there until it sends one).
  - Coin slots: the check's executor (code override) gets its coin balance
    slots fetched ahead for every coin with a known layout
    (warm_check_accounts). Status missesTop names the 20 accounts behind the
    misses. Coins WITHOUT a general layout forget every non-pool slot on
    each wallet transfer (unchanged, strict): suspected source of repeated
    "coin slot" misses + fill_retry; missesTop will show it.
  - Status: checks {total, answered, answeredPct}, poolCoverage
    {readyTickPools, fullTickData, partialTickData, walking, waiting,
    readyV2Like, fullPct, walkSlots}, pendingPools, outsideContracts,
    missesTop; counters walks*, pending_*; per pool tickData, pendingFrom.

- Bot feed = checker feed (inbot-sim/copy2-h, bot side only, no arbsim
  change): the live bot's copy-2 messages now carry the header logsBloom
  like the dry run's.
  - Block assembly moved UNCHANGED from scripts/sim-compare/copy2Lib.ts to
    src/execution/copy2Blocks.ts (copy2Lib re-exports it); the bot's
    Copy2Forwarder uses it: header + 30 ms (COPY2_GRACE_MS) or a block 2
    later; headerless 400 / 1500 ms then header read from the HTTP node
    (eth_getBlockByNumber, counted "copy 2 headers / fill-ins"); block_tick
    with bloom for EVERY block without our reports; late report = its own
    message, the block's time, no bloom. Removed reports go in the block
    message (as the checker). Coin Transfers only of the pool's own coins
    (classifyLog rule). Same report from from- and to- subscriptions is
    passed on once (arbsim also dedupes). Test parityTests: same inputs
    through both give the same messages.
  - Header source: newHeads on the bot's existing WebSocket, subscribed only
    while the copy-2 tap is on; tap live only when it is confirmed; refused
    = copy 2 off on that reader (like the transfer filters).
  - No header anywhere (WebSocket + node) or no readable bloom: the block is
    NOT sent and the copy reloads (arbsim marks pending from a bloom only, so
    a bloom-less block could miss a late report).
  - prevBlock fix: arbsim reloads on prevBlock >= its first block and not
    received; the bot's old "prevBlock 0 = reload" never triggered (0 is
    below the first block). Now prevBlock = block - 1 normally (every block
    goes out, a missing one is noticed) and = the block itself after a gap
    on the bot's side (dropped message, skipped block, outage not filled,
    fresh start) so the copy really reloads.
  - Cost: newHeads = 1 pushed message per block (~9/s at 0.11 s blocks, about
    780k a day): more than BLOCK_READER_WSS_DAILY's default 400k alone.
    COPY2_WSS_MAX_PCT (80): copy 2's subscriptions stop for the rest of the
    UTC day at 80 % of the cap (price feed keeps going, the node decides
    checks). Running copy 2 all day needs the cap (and plan) raised to
    ~1.2M. Outage fill-ins also read each missed header (<= 200).
  - Follow-up (same branch): newHeads is billed per push by Chainstack;
    the dry run measured ~9.8 blocks/s = ~845k RU/day = ~25M/month, more
    than the Growth plan (20M, extra usage off). So COPY2_HEADERS=off is
    the bot's default: no newHeads, no per-block header reads, no
    logsBloom. Headerless assembly (copy2Blocks.ts {headers:false}, also
    the checker's --no-headers): a block goes once a later block reports
    or COPY2_GRACE_MS (30) after its first report; time / parent-chain
    block from the sequencer feed (or logs' blockTimestamp), unknown after
    COPY2_TS_WAIT_MS (40) more = not sent, copy reloads; block_tick for the
    newest known block after COPY2_TICK_MS (250) with nothing held; late
    reports as before. prevBlock headerless = the previous block passed on
    (not every block goes out), the block itself after a gap. With
    COPY2_HEADERS=on everything above (bloom) is unchanged. The checker's
    --no-headers still takes block TIMES from its own newHeads (the bot
    uses its feed; same values) but ignores them for completeness and
    never sends a bloom.

- Dry run #18 memory (inbot-sim/copy2-i): 2 min after start 430 pools
  walked (151,642 values, the old cap 150k) and the process at 331 MB RSS,
  over pm2's 150 MB restart line. Measured with tests/copy2_memory.rs (real
  intake: track -> load -> tick walk -> blocks, history 64, a counting
  allocator for the heap + process RSS; fake node with N V3 pools x 375
  walk values, 40 V2 pools trading every block, 60 coins).
  - Cause (most of it): state/fill.rs reconcile learned the walked values
    into EVERY kept version from the walk's block k to now SEPARATELY, so
    each of those versions got its own copy of the pool's storage tree
    (~400 values) plus the account-map path; a walk is answered several
    versions after k (node tip cached up to 2 s, the answer's own time,
    queueing behind loads), and those copies lived until the versions aged
    out. Before the fix, 150k values, 16 walks at once, 150 ms answers:
    heap peak 157 MB (steady 60), RSS 177 MB and staying there (glibc keeps
    freed memory); 300k values: heap peak 204 MB, RSS 230 MB. Fix: a
    version whose account didn't change in its block takes the previous
    rebuilt version's account as is (one shared tree), a tick version (the
    very same snapshot) the previous rebuilt snapshot whole. Proven equal
    to the old per-version learning on 400 random version chains (ticks,
    changes, forgets outside the diff, one-version fills, restarts, basics
    with code): fill.rs shared_reconcile_equals_learning_into_every_version;
    walked_values_are_stored_once_across_unchanged_versions checks sharing.
    After: 150k values peak 62 MB, RSS 80 MB; 300k values (800 pools x
    375) peak 116 MB heap (44 MB of it the fake node), steady heap 124 MB of
    which copy 2 = 80 MB (~280 bytes per walked value, everything
    included), RSS 142-145 MB, flat over 1000 blocks after the buffers fill.
  - Not causes (measured): Snapshot clone in needs() (persistent maps: a
    pointer copy), per-version storage when pools change every block
    (~145-170 KB per kept version = ~10 MB for 64), code cache (one entry
    per factory), walk JSON (dropped after reading).
  - Other bounds: the report buffer is bounded in reports too
    (ARBSIM_COPY2_MAX_KEEP_LOGS 150000, ~190 bytes each) beyond the
    always-kept ARBSIM_COPY2_KEEP_BLOCKS, so a stuck load can't hold 40000
    blocks of reports; copy 2's eviction caps (ARBSIM_MAX_ACCOUNTS /
    _SLOTS) count only accounts it may drop (fully walked pools alone hold
    ~300k slots > 250k, which made every 60 s eviction drop ALL other
    accounts); `walked` lists have no spare capacity.
  - Defaults: ARBSIM_COPY2_WALK_MAX_SLOTS 600000 (~2x all pools), new walks
    pause while RSS >= ARBSIM_COPY2_WALK_MAX_RSS_MB 300 (status
    poolCoverage.walkPaused says why); pm2 restart line 400 MB (re-created
    once if the app still has the old lower limit); the runner sets
    MALLOC_ARENA_MAX=2 (fewer glibc arenas for ~20 threads: less retained
    memory; small effect in the bench, which has few busy threads).
  - Bench: `COPY2_MEM_POOLS=800 COPY2_MEM_KEEP=2400 COPY2_MEM_BLOCKS=1000
    COPY2_MEM_WALKS=16 COPY2_MEM_TRACE_MS=150 cargo test --release --test
    copy2_memory -- --nocapture --test-threads=1` (default size 200 pools
    runs in the normal suite and asserts no walk bulge, flat heap and
    <= 400 bytes per walked value).
- Live go-live failure Oct 22 07:36 UTC (inbot-sim/copy2-j): LOCAL_SIM=on,
  pool-events, headers off. arbsim logged "message(s) lost (bot's previous
  block N never arrived; now at N)" every 2-25 s, status 677 pools, 0
  ready, 0 loading, all unsure "lost message before block N", 0 events.
  Rolled back at 07:42. Causes (each proven by a test in
  src/test/copy2LiveFeed.test.ts, which drives the real WebSocket reader
  with renewals every 5-20 s, the real Copy2Link / forwarder / assembler,
  a feed whose times sometimes come after the reports, and a free node
  that lags 0-300 ms; on the old code: 19 and 29 forced reloads in 120 s
  and 118 / 127 reports silently missing; now 0 and 0):
  1. Bot: the logs' `blockTimestamp` (Chainstack puts it on every log) was
     dropped when the forwarder slimmed a log, so the assembler's fallback
     never worked: every block whose feed message came > 70 ms after its
     reports was skipped and the copy told to reload (the "time is not
     known" log line is throttled to once a minute, so 2 lines hid many
     more). Fixed: kept (proof/blockTimestamp). A block whose time neither
     the feed nor its reports give is read from the free node
     (eth_getBlockByNumber, at most COPY2_TIME_READS_PER_MIN=30 a minute,
     never a guess; past the budget: skipped + reload) (proof/time-read).
     Late reports also use their own blockTimestamp.
  2. Bot: the fill-in after a subscription renewal / reconnect read the
     free node (BLOCK_READER_RPC), which lags the WebSocket node. When it
     had not reached the first block heard live it gave up (reload); when
     its newest block was below the first missed block it treated the hole
     as empty (reports SILENTLY lost). Fixed: the fill-in must reach the
     sequencer feed's newest block at the moment the new subscription went
     live and the block before the first one heard live; it asks the node
     again every 150 ms for up to COPY2_FILL_WAIT_MS=3000, reading only up
     to what the node has, then merges and passes everything on in order
     (no reload). Only a node still behind after that (or an error, or >200
     blocks) reloads. A renewal during a fill-in restarts the fill-in from
     the same block instead of reloading (proof/fill-in).
  3. arbsim: every "reload every pool" counted as a strike against every
     pool and doubled its wait (2 s ... 10 min), and also restarted loads
     in flight, so a burst left the copy at 0 loading for minutes. Fixed:
     a lost-message reload is no strike (wait = ARBSIM_COPY2_RELOAD_MS,
     never shorter than a wait the pool had for its own trouble), and a
     pool already unsure from an earlier lost-message signal and not
     loading is left alone (its reload is already due). Test:
     copy2_intake gap_signal_burst_does_not_keep_the_copy_unsure.
  Observability: the bot sends `gapReason` with every reload message
  ("start", "block time unknown", "outage not filled in (HTTP node
  behind)", "message not handed over (socket busy)", ...); arbsim counts
  them in status `gapReasons` (+ "message lost on the way" when prevBlock
  differs without a reason). Bot: `[copy2] on / following N / reports live
  / forced reloads K (reason n, ...) / outages filled M` (logged when it
  changes) and one line per forced reload; hourly line adds `forced
  reloads K (...)` and, for checks asked about a copy-2 block, `copy 2 vs
  node: N checks, same a, different b, fast check unsure c (same answer
  x%)` (jsonl field `c2blk`).
- Live shadow hour Oct 22 08:26-09:31 UTC (inbot-sim/copy2-k): copy
  healthy (623/649 ready, 0 forced reloads, 574/576 tick pools walked) but
  the bot's REAL checks were answered 7 of 44 times (16 %; the checker's own
  probes ~67 %). missesTop: 503 "ready pool slot" at the V4 PoolManager;
  "coin slot" USDG 22 / WETH 12 / stock coins 4-8 each; 0xe10b6f6b.. 11;
  executor / 0x64 3 each. Causes, each reproduced on anvil
  (tests/copy2_coverage_anvil.rs bot_v4_*, the bot's shape: no PoolManager
  coin transfers in the reports, our contract's min / max price limit):
  1. PoolManager "ready pool slot" = tick-map words BEYOND the walked window.
     The bot's checks on thin pools (stock / USDG "gap" checks, node answer
     ZeroAmount or loss) run the price to its limit and read every word on
     the way (up to 64 missed per check, MAX_COLLECT). Fills then put such
     a word into the copy as a value of ALL our V4 pools (unsound for
     another pool's word). Reproduced: bot_v4_check_into_an_empty_side
     (old walk: misses with "not a base slot / walked value", 64+ per
     check). Fix: V4 tick walks read the WHOLE tick map when it has at most
     ARBSIM_COPY2_WALK_FULL_WORDS (8000 = every spacing; spacing 1 = 6932
     words; batched extsload(bytes32[]); measured on anvil: spacing 10
     2.7M gas + 168 KB answer, spacing 1 25.8M gas + 994 KB; walk_cost).
     Zero words outside the window are kept compactly (sorted list, 32
     bytes each: PoolEntry.far_zero, status poolCoverage.farZeroWords,
     counter walk_far_zero) and answered 0 by CHECKS only
     (copy2/checkview.rs), for versions from max(walk block, ready_since)
     while the pool stays ready (held values always win; replays never use
     them). PoolManager fills are now refused unless the slot is a base slot
     of one of our pools (fill_refused_pm_slot). After: 9/9 ZeroAmount
     checks answered, exact.
  2. "coin slot" USDG / WETH / stocks = the PoolManager's OWN coin balance
     (sync / settle / take in our contract's V4 swap). Nobody reports its
     transfers to us (the bot leaves the PoolManager out of the transfer
     subscription on purpose), yet the copy loaded that balance with each
     V4 pool and moved it only by transfers that also involved another
     followed pool: a STALE value. Reproduced: bot_v4_pool_manager_balance
     (old: 3 of 12 checks answered WRONG: copy "TransferFailed (underflow)",
     chain "InsufficientProfit"). Following it exactly would need a push for
     every V4 transfer of those coins on the whole chain (incl. hooked pools
     like Fables' WETH/USDG, the biggest volume): not cheap. Exact and free
     instead (ARBSIM_COPY2_PM_BOUND=1): the copy never holds a PoolManager
     coin / ETH balance (V4 pools are not coin "holders", loads don't fetch
     it, fills refused: fill_refused_pm_balance); a check that reads one runs
     at a proven LOWER BOUND P and again at P + 2^200 and answers only if
     both results are identical (success, output, gas), else unknown
     "pool_manager_balance" (counters pm_bound_checks / _same / _differ).
     P = sum over our ready V4 pools of what a swap draining that coin
     would pay out over the tick data held (TickMath / SqrtPriceMath,
     rounding down, minus 1 per price step): the PoolManager must be able
     to pay any swap out (solvency). Why two runs prove it: settle uses
     only the difference; take needs balance >= amount (passes at both ends
     => passes for R in between); a written balance is 0 at neither end
     (else the gas differs) so storage gas is the same; a coin with another
     rule in that range shows different results => unknown. Assumes the
     PoolManager holds < 2^200 base units and standard coin behaviour
     (balance check + store), no admin seizure from the PoolManager.
     After: 12/12 checks same as the chain at sizes up to 2M USD (6M:
     unknown, beyond the walk), 0 different. A check that pays a coin the
     PoolManager holds none of (R = 0: the gas really differs) answers
     unknown (bot_v4_check_into_an_empty_side, other way).
  3. Status: missesTopSlots = top 20 [class, account, slot, count, what]
     (named: PoolManager balance / our pool's balance / the check
     contract's balance / pool <id> slot0..liquidity / walked / far zero /
     protocolFeesAccrued / PoolManager setting / "not a base slot ..."),
     so the next live hour shows WHICH values miss (0xe10b6f6b.. could not
     be identified offline: not in our code or configs).
  Cost: 0 new WebSocket messages, 0 new node requests (the same one
  debug_traceCall per V4 pool, bigger answer); memory: far zero words ~32
  bytes each (~700 per spacing-10 pool, ~6900 per spacing-1 pool).
- Live shadow Oct 22 10:36 UTC, 89 min (inbot-sim/copy2-l): healthy (632/656
  ready, walks 100 %, 1 forced reload, 307 MB) and accurate (11/11 answers
  same as the node) but few answered: hourly 11 of 38, status 4 of 62
  (counted since arbsim started; one bot check can be several sidecar
  checks). missesTopSlots: WETH 17 + USDG 16 = the balances of ONE pool,
  0x52e65b17 (V3 WETH/USDG, the busiest); protocolFeesAccrued[0x2d42..]
  14 (+5 as "pool not ready"); first-time misses of coin settings (WETH
  0x35, 0x2d42.. ..d00/..d01, 2 each) and of 0xe10b6f6b.. (9).
  1. Pool balance MISSING over and over. Two causes, both reproduced in
     tests/copy2_intake.rs (they fail on the old code, pass now):
     a. A late coin Transfer (the bot hears it on another subscription
        after the block went out, or a settle finds it ~1.5 s later) for a
        balance that already had a LATER transfer applied made the balance
        forgotten (old rule "a transfer older than one already applied
        forgets that balance"). On a pool trading every few blocks that is
        nearly every late transfer
        (late_coin_transfer_after_a_later_one_is_added_not_forgotten,
        late_coin_transfer_already_in_the_node_value_changes_nothing).
     b. Once missing, a fill read at node block k was thrown away ("asked
        again in 1 s") whenever the pool had a transfer after k: for this
        pool, always (busy_pool_coin_balance_fill_is_carried_forward_exactly).
     Not causes: replays never write coin storage; WETH (OZ upgradeable
     ERC20, balances at 0x33) and USDG (mapping slot 1) move balances only
     with Transfer events.
     Fix (exact, no new node requests): every followed pool balance has a
     coin_base = the block of the node value it descends from (load fetch
     block / fill block; older versions forget it when a newer read is put
     in). A late Transfer at block n > base is ADDED to every kept version
     from n on (per version, all of a slot's late amounts summed first:
     order-free; below zero = that version's value was wrong -> forgotten
     there and after). n <= base: already inside the node value, nothing
     added (versions in [n, base) forget). Fills of a pool balance: node
     value at k plus/minus the kept Transfers of blocks k+1..j into every
     version j >= k (needs the copy at/past k and the report buffer
     reaching past k with no hole; else asked again). Counters
     late_coin_deltas, late_coin_included, fill_balance_carried.
  2. protocolFeesAccrued[coin] (PoolManager slot keccak(coin . 1)): the V4
     swap adds the protocol fee to it (unchecked +=) when the pool has a
     protocol fee on in that direction. Its value only matters as zero /
     not zero (SSTORE gas 20000 vs 2900; no revert possible), so the
     two-run trick works IF it is proven non-zero. It is not provable:
     collectProtocolFees (protocol fee controller) can empty it and leaves
     NO PoolManager event (only a coin Transfer from the PoolManager, which
     the bot does not subscribe to: every V4 take is one). Other pools'
     swaps also add to it. So: not followed, fills refused (as before),
     those checks stay unknown; status names it. Options (not built): the
     bot sends the PoolManager's outgoing Transfers of the protocol-fee
     coins (collections become visible; cost = every V4 payout of those
     coins), or the bot accepts a gas number that may be 17,100 low.
  3./4. Coin settings and other accounts: WETH slot 0x35 = totalSupply (OZ
     order balances 0x33, allowances 0x34, totalSupply 0x35): moves with
     every wrap / unwrap on the chain (our contract unwraps / wraps for
     native-ETH V4 pools); cannot be followed from our reports. 0x2d42..'s
     ..d00 / ..d01 are a namespaced (ERC-7201 style) struct the coin reads
     on every transfer (the coin HAS a general balance layout: the label
     "not a balance ..." is only given then); 0xe10b6f6b.. could not be
     identified offline (no chain access from here). These are "first
     read" misses (2 each = two checks at once before the fill landed):
     after the fill the copy HOLDS them, and nothing ever refreshed them
     (a changed pause flag / allow list would have been used stale).
     Now: every ARBSIM_COPY2_VERIFY_S (60) one bulk fetch re-reads up to
     ARBSIM_COPY2_VERIFY_MAX (400) held values nothing follows (all
     storage of accounts that are not a pool / pool-owned / PoolManager /
     outside contract; for coins every slot except our pools' balances);
     a value the chain changed is forgotten in every version, put in again
     from the re-read block (like a fill), counted (unfollowed_changed,
     status unfollowedChanged [account, slot, times]) and logged (first 3
     per value). WETH totalSupply will show up there every round (expected:
     its absolute value doesn't change a check's result as long as it is
     not near zero); anything else there = tell Claude. Cost: ~1 bulk
     eth_getProof per held account per minute (tens of requests a minute).
  5. Status: checks.unknownBy {reason: n} (miss, pending_reports,
     unsure_pool, pool_manager_balance, not_ready, stale, dirty, ...) and
     checks.blockedBy [label, checks missing it, checks missing ONLY it]
     (label = class + short account + what the slot is), so the next
     shadow hour shows whether every unknown check is a missed value and
     which value alone blocks how many. deploy/arbsim-status.js prints both.
     describe_slot names "probably totalSupply" and namespaced settings.
- Live shadow after the efa0a85 restart, Oct 22 13:34 UTC (inbot-sim/copy2-m):
  9 min after start 323 of 648 pools unsure "late report for a block no
  longer kept" (292); at 68 min 260 pools LOADING with 0 node jobs ("last
  load round ... still running after 24 min, 98 node requests"); checks
  102 asked, 24 sure; misses led by protocolFeesAccrued[0x2D42..] 28/27 and
  [0xB90A..] 15/14 (stock-coin V4 pools, the bot's most common checks).
  1. Restart burst. A late report for a block the copy can't place went
     to on_late's "no longer kept" branch: blocks before the copy's first
     block (the bot's first seconds after a restart), blocks older than the
     kept reports or before a lost-message reload (buffer cleared), and
     quiet blocks: the bot sends a message only for blocks with reports (a
     tick only for the newest quiet one), so a block whose every report
     came late had no message at all. That branch made every pool the
     report touched unsure WITH a strike (wait doubling 2 s ... 10 min,
     strikes reset only after 50 events while ready), cancelled loads in
     flight, and "touched" was by address: one V4 PoolManager report = ALL
     V4 pools at the PoolManager (~290). A trickle of such reports kept
     the V4 pools unsure (~9 strikes = waits of 10 min). Tests
     (tests/copy2_intake.rs; each fails on the old code):
     late_reports_from_before_the_copy_started_change_nothing / _do_not_
     cancel_loads, late_pool_manager_report_touches_only_its_own_pool,
     late_reports_for_a_block_without_a_message_are_placed_exactly,
     a_load_older_than_an_unplaceable_late_report_reads_again.
     Fix: every pool has base_block = the node block its values were read
     at (a load's fetch block); a late report for block n <= base_block is
     already in them: ignored (also in the normal late path; counter
     late_old_covered). A quiet block inside the kept range is placed like
     any late report, with the late message's own block time (inserted into
     the kept reports so loads carry through it; late_hole_blocks). Not
     placeable: a ready pool read before n goes unsure WITHOUT a strike; a
     loading / waiting pool gets need_base = n (a load whose node read is
     older reads again, on_load_one) and a working copy read before n starts
     over (late_old_reload); a followed coin balance read before n
     (coin_base) is forgotten from n; working copies get the transfer added.
     pools_touched (reorgs too) is per pool: a PoolManager report = that
     pool id; a coin Transfer = the pools whose balance of THAT coin we
     follow (never all V4 pools through the PoolManager's balance).
  2. Load stall. A retry left over from an EARLIER load of a pool (node
     "not at that block yet" 300 ms retry, error backoff, or a Need answer
     still in flight) did `partials.remove(pool)` before checking the
     generation: once the pool had gone unsure and started a NEW load, the
     old retry threw the new load's working copy away; the pool stayed
     "loading: fetching N more value(s)" with busy set and nothing working
     for it, forever (dispatch_loads skips busy pools). The restart burst
     (pools made unsure over and over while their catch-ups waited) made it
     common. Test an_old_loads_retry_never_takes_the_new_loads_working_copy
     (fake node "not at the block" for one value; old code: stuck). Fix:
     dispatch_delayed / on_need only take the working copy of their own
     generation; merge without a copy reschedules instead of dropping.
     Guard: a pool loading + busy with no node job, working copy, queued
     answer or retry for ARBSIM_COPY2_STALL_S (30) is rescheduled (counter
     stall_rescheduled, log "copy2 STALL ... (were: <reasons>)"); pools due
     30+ s but not sent are logged once a minute with why loads are held
     back (job cap, node refusing, probes, traces)
     (a_loading_pool_with_nothing_working_for_it_is_rescheduled).
  3. protocolFeesAccrued[coin] (V4 PoolManager slot keccak(coin . 1)). Its
     value never changes a swap (only `+= protocol fee`, unchecked); it
     only decides the store's gas: 0 -> non-zero 20,000, non-zero ->
     non-zero 2,900 (+2,100 cold either way): 17,100 apart. Checks now read
     it as 0 in one run and as 1 (placeholder for "not zero": R + fee and
     1 + fee are both non-zero, every SSTORE gas class identical) in a
     second run (each confirmed far above the PoolManager balance bound if
     it read one). Same success / output / everything but gas -> answered,
     each gasUsed field = the HIGHER of the two (the zero case); else
     unknown "protocol_fee". A value the copy holds (a replay of our own
     pool's swap fetches and moves it) is never used by checks (other
     pools' swaps / collections change it unseen). Only checks that read
     the counter (pools with a protocol fee on in that direction) pay the
     extra runs. Counters protocol_fee_checks / _same / _differ; status
     label "checks run with it 0 and not 0 ...". Anvil test
     bot_v4_protocol_fee_counter_answers_with_the_higher_gas (real
     PoolManager, protocol fee 0.1 % both ways): counter 0 on the chain ->
     exact (4/4); non-zero -> 6/6 answered, success / output exact, gas
     exactly 17,100 above the chain's.
     Bot impact: the sidecar's gasUsed feeds the gas calibration (median
     per route kind, core/gasModel.ts) and the gas-limit check
     (loopLive gasLimitOk); the profit decision itself uses gasModel's USD
     estimate. 17,100 gas at Robinhood's ~0.01 gwei L2 base fee = 1.7e-7
     ETH = ~$0.0007 at $4,000 ETH (x GAS_MARGIN 1.3 = ~$0.0009), far below
     GAS_MIN_USD ($0.01). Always on the high side: profit may look up to
     ~$0.001 smaller than real, never bigger.
  Expected: the restart burst no longer makes pools unsure / stuck (all
  ready within the first load round, as in the previous shadow hour);
  checks blocked only by the protocol fee counter (41 of the 102) answered;
  with the unsure_pool / not_ready ones gone, roughly 70-85 % of the bot's
  checks answered (the rest: other first-read misses, pending reports).
  Not addressed: "reports may be missing and the node's logs could not be
  read" (14; settle eth_getLogs failing > 60 s) - watch it next hour.

- Live shadow Oct 22 16:19-17:35 UTC, check speed (inbot-sim/copy2-p): the
  bot timed its fast check at p50 63 ms / p90 122 ms (max 237), slower than
  the node (61-147 ms); 257 of its questions hit LOCAL_SIM_TIMEOUT_MS (60)
  ("lu":"timeout"), so "copy 2 vs node: 90 checks ... fast check unsure 90".
  1. Measuring: every `call` / `size_search` answer now carries `t` =
     microseconds per step (queue for a worker, prep = reading the request,
     resolve = picking the version incl. a "dirty" wait, facts = copy 2's
     V4 facts, runs = each EVM run, post); `status` shows checkTiming
     (p50 / p90 / p99 / max of the last 1000, plus the time to write the
     answer), applyTiming (copy-2 block applies) and lockHold (the copy's
     thread holding a lock checks need for > 1 ms) (src/timing.rs;
     deploy/arbsim-status.js prints them). Bot side: data/local-sim-
     shadow.jsonl lines carry `lus` (arbsim's own time incl. queue, ms),
     `lrt` (socket round trip the bot measured) and `lt` (arbsim's split);
     the hourly log line adds "arbsim own time median / p90" and answers
     that came after the timeout (how late, arbsim's own time for them).
  2. Bench (tests/copy2_latency.rs, anvil, live shape: one V4 PoolManager
     with stock-coin / USDG pools, half with a protocol fee on, the same
     pairs as V3 pools with price histories, USDG / WETH on both, the
     bot's report shape; copy 2 on its own thread with loaders and walks,
     a block maker trading ~9 blocks/s, the bot's real 2-pool round trip
     over the real socket server, every 5th answer compared with the
     chain). Full size `COPY2_LAT_PAIRS=320` = 640 pools, 88k walked
     values, 2 workers. BEFORE: ~150 ms per check (warm-up avg 152 ms,
     max 287 ms): t = queue 0.01, prep 0.05, resolve 0, facts 0.8-1.3 ms,
     FIRST EVM run 118-157 ms, every later run 0.4 ms. Cause: the first
     run that reads a V4 PoolManager coin balance computes the proven lower
     bound (dry run "PoolManager balance" fix) = the sum over EVERY ready
     V4 pool holding that coin (USDG: all ~320) of a walk over that pool's
     whole tick map (tick spacing 60: ~60 words each way, spacing 1: ~3500),
     and every word not held was looked up in EVERY pool's far-zero list
     (320 binary searches per word). Scales with the number of V4 pools:
     48 pools gave 4 ms, 640 pools 150 ms (live ~290 V4 pools: ~60-130 ms,
     matching the bot's 63 / 122).
  3. Fixes (same answers; checkview.rs header):
     - The bound is first summed over the pools THIS check traded on (the
       run read their slot0 before the PoolManager settles / takes), plus
       other pools only while it is still 0 (the coin a check pays in on a
       one-sided pool). Any proven lower bound is sound; a too small one
       only makes the two runs differ, and then (only then) both runs are
       repeated with the full bound (every ready V4 pool), exactly the old
       way. Counters pm_bound_route_only / pm_bound_full_retry.
       ARBSIM_COPY2_BOUND_FULL=1 = always the full bound (old way, slower).
     - Far-zero lookups: one merged sorted list per account, cached across
       checks while the very same lists apply (the cache holds the lists,
       so "same" can't be a look-alike); the bound reads only its own
       pool's list.
     - Tick-map word slots per pool computed once (keccak) and kept;
       protocol-fee / balance / slot0 slot numbers remembered (each check
       built ~1,600 keccaks into its facts).
     Proof of "same answers": the full bench run with
     ARBSIM_COPY2_BOUND_FULL=1 and without gives the same answered /
     unknown counts (166 answered, 17 pool_manager_balance, 17 miss of
     200), every 5th answer equals the chain; checkview tests
     (remembered numbers == computed ones, route / full bound), anvil
     bot_v4_route_bound_falls_back_to_the_full_bound (a check that drains
     its pool needs the full bound: answered exactly via the retry; small
     checks never retry), and all earlier copy-2 tests.
  4. AFTER (640 pools, 200 checks, bot-side): p50 2.8 ms, p90 8.3 ms, p99
     21 ms (all checks); one EVM run p50 0.6 ms; facts p50 0.5 ms; queue
     ~0; block apply p50 1.0 ms, max 5 ms; no lock held > 1 ms. The tail is
     checks that needed the full bound (most then still "unknown":
     pool_manager_balance) and 4-run protocol-fee checks; size_search
     (on mode) p50 4.8 ms, p99 17 ms. Normal test (120 pairs = 240 pools)
     fails if the bot-side p50 of answered checks > 10 ms or p99 > 40 ms
     (COPY2_LAT_MAX_P50_MS / _P99_MS).
  Not changed: ARBSIM_WORKERS stays 2 (t3.medium = 2 vCPUs, shared with
  the bot; checks are now a few ms, the queue wait ~0); the release
  build already has lto=fat, codegen-units=1, panic=abort (no
  target-cpu: the binary must run on any x86-64); the bot's
  LOCAL_SIM_TIMEOUT_MS stays 60 (10x the expected p50; raising it would
  only hide a slow sidecar and delay the node fallback).
  Not answered here: "slowest block 807 ms" (status apply_us_max) did not
  show in the bench (max 5-7 ms); applyTiming now gives its p50 / p99 live.
  The likely one-off is the first block after start ("start" reload of
  every pool). Also to watch: a trigger check asks about the block of the
  trade's reports (copy2Route(minBlock = the trade's block)), which the
  bot's forwarder may pass on only up to COPY2_GRACE_MS (30) later; such
  a check gets "not_ready: seq N not received yet" at once and the node
  decides (`lu` "not_ready" in the jsonl). If that is common, the bot
  could wait for the forwarder to pass that block on (<= ~30 ms) before
  asking.

- Warm restart (inbot-sim/copy2-n; owner: "why do you need to start from the
  beginning each time"). Before: every deploy / restart of the bot or the
  sidecar threw the copy away and loaded ~650 pools again (loads, tick
  walks, coin layouts): ~13 min to fully ready, thousands of node requests,
  and the reload bursts caused bugs (#16, copy2-j, copy2-m).
  1. Save (copy2/persist.rs): every ARBSIM_COPY2_SAVE_S (60) and on SIGTERM /
     SIGINT (serve.rs catches them; pm2 kill_timeout 30 s, deploy/
     arbsim-pm2.sh re-creates an app with a shorter one), the READY pools'
     state goes to ARBSIM_COPY2_STATE_FILE (runner: data/arbsim-copy2-
     state.bin; "off" = never): the block it is exact at (+ its time /
     parent-chain block / base fee), every value the head holds (pool slots,
     walked tick data, coin balances, basics, code by hash; never-trusted
     accounts left out), the never-trust lists, per ready pool its
     bookkeeping (items, walked, walk, far-zero words, owned, accounts,
     base_block, ready_since, last report applied), coin layouts / traced
     slots / coin_ok, followed balances' coin_pos / coin_base, and the last
     ARBSIM_COPY2_RESUME_OVERLAP_BLOCKS (64) blocks' reports. Pools not ready
     (or pending from before the overlap) are left out WITH their values.
     Binary, FORMAT version 1 (other versions refused: bump it whenever what
     the copy holds or a field means changes), FNV-64 checksum, temp file +
     fsync + rename. The intake thread only clones (head snapshot = pointer
     copy, ready pools' entries); a saver thread writes; a save still
     running skips the round. A catch-up running = no save (the older file
     stays valid).
  2. Start (intake.rs restore): the file's copy becomes the copy at its block
     S (version with no block details: nothing answered AT S), its pools
     READY, blocks held. When the bot's first block B > S arrives (the bot
     always sends "gap: start" then), ONE loader job (loader.rs catch_up)
     reads every report of our pools (settle_filters: pool events, their
     coins' Transfers to / from them, V4 ids) in S-63..B-1: ranges of
     ARBSIM_COPY2_RESUME_RANGE (500) blocks, each range in ONE request with
     its last block's header (= proof this node has the whole range: a
     lagging node can't silently return fewer logs), free node first, paid
     node if that fails, ranges halved when "too big"; block time from the
     logs' blockTimestamp (else the header), parent-chain block by halving
     (it never decreases, so equal ends fill everything between: ~25 header
     reads per 5 min). Reports for blocks <= S the copy didn't have = late
     reports (on_late, exact as always); S+1..B-1 go through process() one
     block at a time (versions get no block details: "repaired", checks AT
     them answer not_ready; reports are complete: no "pending"). Then (only
     after a restart) every held value nothing follows is re-read EXACTLY at
     the new head (changed = replaced, unreadable = forgotten), then the
     held blocks go on. Gap > ARBSIM_COPY2_RESUME_MAX_BLOCKS (18000, ~30
     min), no node, missing / damaged / other-version file, or no complete
     answer within ARBSIM_COPY2_RESUME_TIMEOUT_S (120): the normal full load.
  3. Gaps while running (the bot restarted, an outage it couldn't fill, a
     lost message): process() starts the same catch-up from the copy's
     newest block (overlap re-read too: the old bot's late reports) instead
     of reload_all_after_gap; the message waits, then goes on. Only when
     that isn't possible / fails: the old reload. (Bot side unchanged apart
     from wording: it still sends prevBlock = the block itself after a gap.)
  4. Parking: the bot's first track after its restart lacks its loop-extra
     pools for ~3 min (core/loopExtraPools.ts start delay), and around a
     WebSocket renewal some pools wait to be listed. A READY pool leaving
     the list is parked: its values (own slots, walked, coin balances that
     descend from the same node read as its own values) and basics kept
     aside, taken out of the copy (no longer followed). Listed again within
     the catch-up limit: one log read for that pool from its overlap, its
     reports put into the kept reports (pinned while parked), and its kept
     values carried forward from where it was parked like a load (merge ->
     READY). A late report about it while parked, the kept reports no
     longer reaching back, a report <= its block the copy never had, or
     node trouble: normal load. Counters pools_parked / parked_resumed /
     parked_fallback / parked_expired.
  5. Fetch-round limit (ARBSIM_COPY2_MAX_ROUNDS) now counts rounds without
     progress (a catch-up carries a working copy across many blocks at
     once, one round per new tick a mint touches).
  Tests: tests/copy2_resume_anvil.rs (anvil: V3 0.01 %, V3 0.05 %, V4; random
  swaps / mints / burns with and without collect / collects / plain coin
  transfers): warm_restart_catches_up_exactly (save at S with one coin
  Transfer withheld = a late report never received; 25 blocks while down;
  restored copy catches up, finds the withheld Transfer in the overlap,
  loads 0 pools, 617 values exact vs chain AND equal to a never-restarted
  copy; again 10 blocks later), damaged_or_other_version_file_means_a_
  normal_load (flipped byte, other FORMAT, no file), too_big_a_gap_means_
  a_normal_load, bot_restart_gap_is_filled_from_logs_without_reloading
  (15 blocks missed, free node refuses getLogs -> paid; first track lists 1
  of 3 pools, the 2 others trade while parked and are resumed: 0 loads,
  exact), deploy_restarting_both_loads_nothing (restored + parked at the
  saved block + resumed later: 0 loads, exact); persist.rs unit tests
  (round trip, stripped values, every damaged byte refused, atomic write).
  Measured (tests/copy2_resume_bench.rs, release, made-up copy of 650
  pools / 259k values / 423 accounts, fake node 80 ms per request, ~1
  transaction with 3 reports per block, parent-chain block every 120
  blocks): file 37 MB; intake thread's part of a save median 2 ms, max 5 ms;
  writing 0.12 s (saver thread); reading back 0.15 s; block application
  p50 0.09 ms / p99 0.23-0.29 ms with and without saves every second (7
  saves during the run). Catch-up 5 min (3,000 blocks, 9,177 reports): 19
  HTTP requests (1 per 500-block range + header rounds; ~25 at Chainstack's
  25-calls-per-request batching), 195 headers, 1.8 s until answering;
  30 min (18,000 blocks, 54,363 reports): 52 requests (~93 at 25 per
  batch), 1,149 headers, 5.6 s, applying the blocks 0.75 s. (Before: a full
  load ~1,700+ requests + one heavy trace per tick pool, ~13 min.)
  Not covered / to watch: values nothing follows (coin settings) are
  re-read at the new head after a restart but were used unverified during
  the replays of the gap (same trust as between two verify rounds live); a
  pool whose replay needs a value in the gap fetches it at that old block
  (> 64 blocks old = reloads that pool at the newest block: a 30-min gap
  reloads pools with new-tick mints early in the gap); a fix to how copy 2
  follows pools needs FORMAT bumped (or the file deleted) or the old
  copy's mistakes survive the deploy.

- Live shadow after the copy2-p deploy, Oct 22 19:52 UTC, 29 min
  (inbot-sim/copy2-q): arbsim's own check time median 11.8 / p90 43.6 /
  p99 192.8 ms, of which "facts" ~14 ms (bench: 0.5 ms); 484 lock holds
  over 1 ms by the copy's thread, longest 197 ms; slowest block 421 ms.
  1. Causes. The facts step read copy 2's pool registry under its lock and
     went through ALL ~650 pools per check; checks also took the mirror's
     version lock (resolve, status). On a 2-vCPU server shared with the
     bot, the copy's thread holding either lock (and being descheduled
     while holding it) made checks wait. The socket thread also took the
     version lock for every block message, so a check sent after a block
     message on the same connection waited too.
  2. Fixes (no change to what copy 2 holds or follows; no state file
     format change):
     - mirror.rs PubLock: checks (resolve, head, status) read a copy of the
       published versions refreshed whenever a write lock is released;
       they never take the lock (a check then sees the versions as they
       were just before that write began). Block messages note "newest
       received" without the lock.
     - timing.rs GenLock: the registry's lock counts changes.
       copy2/checkcore.rs CheckCore = everything checks need from the
       registry (V4 bound pools, far zero words, protocol-fee counters,
       pending pools, not-ready pools, coin layouts), rebuilt only when
       the registry changed: by the copy's thread after each block / work
       round, else by a check. The facts sets are prebuilt once per core
       for every block from `stable_from` (newest "ready since" / walk
       block) to `pending_min` (first block with reports maybe missing) =
       every check at the newest blocks; other blocks get their own sets
       from the core (no lock). A core is used while the registry is
       unchanged, or by a check whose version came from the readers' copy
       that was current when the core was built (= a check that came at
       that moment). Only otherwise does a check read the registry (and
       may wait). Status counting (missesBy..., blockedBy) skips rather
       than waits.
     - lockHold in status now names the source lines (bySite: count over
       1 ms, total, longest), printed by deploy/arbsim-status.js.
  3. Bench (tests/copy2_latency.rs, 640 pools, + COPY2_LAT_HOG=2 threads
     burning CPU like the bot): facts p50 0.00 / p99 0.00 / max 3 ms (was
     0.5 / 3-6 ms in the bench, 14 ms live); answered checks bot-side p50
     2.2 ms, p90 6.5, p99 11.9; checks asked while a test thread holds the
     version lock or the registry lock for 300 ms: 1.2-10 ms (before: they
     waited the 300 ms). Same answered / unknown counts as before (245 /
     29 pool_manager_balance / 26 miss of 300; 48 compared with the chain).
     The latency test now also fails if such a check waits >= 100 ms.
  4. Disagreement re-check (bot, shadow and on): when copy 2 and the node
     give different verdicts for a check about a copy-2 block, the bot asks
     the node the same check pinned at the copy's block (c2blk) once, in
     the background (at most 30 an hour), and logs a jsonl line
     {"k":"recheck", c2blk, lv/lp, nv/np, nvAt/npAt, result}: "market
     moved" (the node at the copy's block agrees with the copy), "COPY
     WRONG" (it agrees with its own later answer; Telegram alert) or
     "unclear". Hourly line: "disagreements asked again at the copy's
     block: market moved a, COPY WRONG b, unclear c".
  The Oct 22 disagreement (VIRTUAL/WETH gap, copy profit 2.1e14 wei at
  block 0x5af41a4, node loss at "latest" 125 ms later = ~1 block later)
  can't be decided offline (no node here); see the report. The re-check
  decides the next one automatically.

- Live shadow Oct 22 21:22-22:25 UTC (inbot-sim/copy2-r): healthy, 10 of
  24 bot checks answered; 4 "MISMATCH at same moment", all RIVN/USDG gap:
  copy "fail" (gas 841,669, 4 EVM runs), node "loss", and the node pinned
  at the copy's block "loss" again. The shadow line had no copy reason.
  1. Logging (bot): shadow lines carry `lr` (the copy's reason for anything
     but profit / loss), `nr` (node's, 120 chars); re-check lines `lr`,
     `lg`, `nr`, `nrAt`, `ngAt`. arbsim's `t` adds `what` (each EVM run:
     b/h bound / high, 0/1 fee counter, f full bound, c coin read, p plain)
     and `far` (far zero words read).
  2. Cause, proved on the live chain (scripts/probe-rivn.ts via the "Live
     probe" workflow, only=rivn; the public node keeps ~4000+ blocks of
     state, not the mismatch blocks, but the gap is standing: every RIVN
     route is a loss at every size): eth_call with state overrides on the
     real state. USDG counts only the LOW 128 bits of its balance word:
     balanceOf(PoolManager) with raw 2^128 + 5 = 5, raw 2^255 + 5 = 5;
     USDG.transfer(1000) from the PoolManager reverts (0x356680b7) with raw
     999 AND with raw 2^200 + 999, works with 1000 and 2^200 + 1000. The
     bot's route V3 -> V4 (RIVN in, USDG out) with the PoolManager's USDG
     set to 2^200 reverts WrappedError(USDG, transfer, 0x356680b7); set to
     $1 it completes (IP 0): the V4 RIVN/USDG pool pays < $1 of USDG that
     way (a fake gap; the swap runs the price to its limit: the 841k gas).
     So the copy's two runs were "bound P" and "P + 2^200" = P again for
     USDG; the check takes all the USDG the pool can pay, slightly more
     than the pool's own bound (rounding margin, 1 per price step), so
     take() reverted in both runs identically -> "proven" revert, while the
     real PoolManager holds ~$37M USDG. (RIVN reads the whole word:
     2^200 reads back 2^200.) Not the protocol fee (all 4 fee / balance
     variants on the real state give the same loss), not stale RIVN
     settings (no RIVN events / pool events near the blocks), not tick data.
     Anvil reproduction (tests/copy2_coverage_anvil.rs bot_v4_coin_counting_
     part_of_its_balance_word_never_gives_a_false_revert; TestHelpers.sol
     Token128 = balance in the low 128 bits of the word): one-sided thin V4
     pool, a check draining its token0 side; old code: copy "WrappedError
     (coin, transfer, insufficient balance)", chain InsufficientProfit.
  3. Fix (server.rs coin_highs, checkview.rs): before the high run, per
     coin whose PoolManager balance the bound run read: the coin's
     balanceOf(PoolManager) must read back the bound P exactly (else the
     bound can't be put in: unknown), and the high value H is the largest
     of 2^200 / 2^160 / 2^126 / 2^112 / 2^96 that the coin reads back as P +
     H exactly; below 2^200 only if P + H > totalSupply x 2^16 (a held
     value, re-read every ARBSIM_COPY2_VERIFY_S; first time: "miss", filled).
     None: unknown "pool_manager_balance" (counter pm_high_refused; narrow
     values used: pm_high_narrow). The candidate that worked is remembered
     per coin (checked again every time). A revert / loss / profit is now
     reported only when it is the same with the coin really seeing a balance
     above any real one. Cost: 2-3 small balanceOf / totalSupply EVM runs
     per coin per check (latency bench unchanged within its limits).
     No change to what copy 2 holds / follows: no state FORMAT bump.
  Expected live: RIVN/USDG (and every stock/USDG V4 check paying USDG out
  of the PoolManager) answered "loss" exactly when the full bound covers
  the take, else unknown; no more fail-vs-loss mismatches of this shape.
