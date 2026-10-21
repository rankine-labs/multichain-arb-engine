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
- Status: `status` -> `copy2` {pools, loading, ready, unsure, lastBlock,
  unsureReasons, counters}; with {"pools": true} also `list` of {address,
  v4Id, kind, state, reason, events}. Checks touching a pool that isn't
  ready answer unknown "unsure_pool".
