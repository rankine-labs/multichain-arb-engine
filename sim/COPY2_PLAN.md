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
- Status: `status` -> `copy2` {pools, loading, ready, unsure, lastBlock,
  unsureReasons, counters}; with {"pools": true} also `list` of {address,
  v4Id, kind, state, reason, events}. Checks touching a pool that isn't
  ready answer unknown "unsure_pool".
