# Rust Predictive Sniper (Phase 1 and 2: read-only)

Read-only. It holds no keys and never sends a transaction. It is a separate
package from the arbitrage bot (`sim/`) and shares no build or runtime with it.

## What it answers

1. **Can we see Four.meme buys before they land, and how early?**
   It records the first time each pending tx hash shows up on our feed(s),
   then checks every confirmed Four.meme `TokenPurchase`/`TokenSale` event
   against that list.
2. **After a buying burst, does price keep rising long enough to profit?**
   It finds blocks where a token got 3+ buys from 3+ wallets, assumes we buy
   in the next block, and measures the best and worst price over the next
   3 / 10 / 30 blocks.

Matching works by tx hash on the contract's events, so it covers every buy
no matter which bot, router or wallet app sent it.

## Run it (on the server that will run the bot)

```bash
cd sniper
cargo build --release

# Pending feeds: comma list, "name=url". Use every feed you want to compare.
export SNIPER_PENDING_WS="node=ws://127.0.0.1:8546,paid=wss://provider.example/KEY"
# Heads + logs (defaults to the first pending feed). Use your fastest node.
export SNIPER_BLOCK_WS="ws://127.0.0.1:8546"
export SNIPER_DURATION_SECS=259200      # 72 h; 0 = until killed
export SNIPER_OUT=probe-out/run1

nohup ./target/release/sniper probe > probe.log 2>&1 &
tail -f probe.log                       # heartbeat once a minute
```

Then, at any point (also while it is still running):

```bash
./target/release/sniper report probe-out/run1
# options: --min-lead-ms 150  --burst-buys 3  --hurdle-pct 3  --warmup-secs 10  --json
```

The report is also saved as `probe-out/run1/summary.json`.

Other settings: `SNIPER_PENDING_TTL_SECS` (default 180, how long a pending
hash is remembered) and `SNIPER_HASH_ONLY=1` (hashes only, less bandwidth,
but no "pending direct call" records).

## Node requirements

- Websocket with `eth_subscribe` for `newPendingTransactions`, `newHeads`
  and `logs`. The probe asks for full pending txs and falls back to hashes
  automatically.
- Public RPC endpoints usually do **not** stream pending txs. A self-run BSC
  full node with good peering, or a paid mempool stream, is needed for a
  meaningful result.
- Disk: small. Only Four.meme trades, block headers and connection events
  are written (well under 1 GB for 72 h). Memory: pending hashes for 3 min.

## Reading the results

| Number | Meaning |
|---|---|
| `coverage` | % of confirmed buys we saw pending (count, and by volume) |
| `by buy size` | coverage per size bucket. Are the big buys visible, or only small retail? |
| `lead p50/p90` | ms between first sighting and the block arriving |
| `actionable` | % of **all** buys we saw early enough to act on (`--min-lead-ms`) |
| `late notices` | pending notices that arrived after the trade confirmed |
| `follow-through` | after a burst, % of cases where price later rose by the hurdle |

Lead time is measured to the moment **our** node received the block. The
real cut-off (the builder sealing the block) is earlier, so true usable
lead time is somewhat lower than reported.

Follow-through ignores our own price impact and is an upper bound.

**Proposed kill criteria for "buy before them" (Signal A):** buy coverage
under ~20% of volume, or actionable under ~150 ms at p50. If so, Signal A is
dropped and we focus on confirmed-burst entries plus pending-flow exits.

## Other commands (all read-only)

| Command | What it does |
|---|---|
| `sniper scan` | Live token scanner. Prints NEW tokens, BURST (N buys from N wallets in one block), DUMP (creator sold), GRAD (graduated). Env: `SNIPER_BLOCK_WS`, optional `SNIPER_BURST_BUYS`, `SNIPER_OUT`. Writes `signals.jsonl`. |
| `sniper curve-check <probe dir>` | Fits Four.meme's (unpublished) price curve from real trades the probe recorded and replays every trade with our own maths. Verdict PASS only if trades match within 0.01%. Writes `curve_fit.json`. |
| `sniper sell-check <token> <BNB>` | Simulates our wallet buying that much of a token and selling it all, on current chain state (`eth_simulateV1`). Reports buy tax, sell success and round-trip loss. Nothing is signed or spent. Env: `SNIPER_RPC` (https node URL), `SNIPER_WALLET` (address to simulate). |

Notes:
- Four.meme's contract source is not published, so the price formula is
  fitted and verified from real trades, never assumed. Local quotes are not
  used for sizing until `curve-check` passes.
- `sell-check` needs a node that supports `eth_simulateV1`. If the provider
  doesn't, the check cannot complete, which counts as a REJECT.
- A passing sell-check proves sellability on the current state only.

## Robinhood Chain speed test (read-only)

`sniper rhc-probe` records the public sequencer feed (the same feed the arb
bot's copy reads) and every Uniswap V3/V4 swap on token/WETH and token/USDG
pools, from any node (default: the free public RPC). No keys needed.
`sniper rhc-report <dir>` then reports:
1. how much earlier the feed shows each block than a normal node (the copy's
   head start over bots that wait for block data),
2. buying rushes on any token (>= 3 buys from 3 transactions, price +2% in
   one block),
3. simulated fast trades after each rush (take-profit / stop-loss / time
   limit, pool fee both ways), for "we're first" and "rivals beat us by a
   block", with a rough 95% range for the average.

Env: `SNIPER_RHC_FEED`, `SNIPER_RHC_HTTP`, `SNIPER_OUT`,
`SNIPER_DURATION_SECS`, `SNIPER_RHC_POLL_MS` (default 200).

## Paper trader (Robinhood Chain, no money)

`sniper paper` trades rushes on paper with real on-chain quotes (settings at
the top of `src/paper.rs`); `sniper paper-report <dir>` shows the results.

Safety filters (each skipped rush is logged in `signals.jsonl` with its
reason, and the report's last line counts them):

- **blocked token**: tokens that failed a trap check, or whose sale could
  not be priced (`exit_quote_failed`), go on a permanent blocklist saved to
  `<out>/blocked_tokens.json`. It is loaded at start, so restarts keep it.
  Delete an entry by hand to forgive a token.
- **no sell history**: buy only after the pool has shown at least
  `SNIPER_MIN_SELLS` (default 3) sells of the token since the trader started.
- **already jumped**: skip if the price already rose more than
  `SNIPER_MAX_RISE_PCT` (default 8) from just before the first rush buy.
- **unsafe**: the trap check (0.1% of the pool) failed, or the real-size
  check failed (our exact token amount out of the pool and all of it back).
- **too thin**: no size in `SNIPER_SIZES` survives an instant round trip
  with at most `SNIPER_AUTO_MAX_RT_PCT` (1.5) loss.

- **unsafe hook**: a Uniswap V4 pool whose hook can change swap amounts
  (beforeSwapReturnDelta / afterSwapReturnDelta flags). Hook-free pools and
  hooks without those flags are traded.
- **unknown v4 pool**: a rush in a V4 pool whose key (coins, fee, tick
  spacing, hook) we never saw, because the pool was created before the run
  and the node could not find its Initialize event in history.
- **few real buyers**: V4 swap logs only name the router, so a V4 rush's
  transactions are looked up and the signing wallets counted; fewer than
  `SNIPER_RUSH_BUYS` different wallets = skip.

Venues: `SNIPER_VENUES` (default `v3,v4,v2`) picks Uniswap V3 (QuoterV2),
Uniswap V4 (V4Quoter, keys from Initialize events saved to
`<out>/v4_pool_keys.json`, native-ETH pools included) and Uniswap V2
(reserves maths, 0.30% fee). All venues go through the same filters, sizes,
exits and race check; the V4 trap check moves tokens to/from the
PoolManager, which holds every V4 pool's coins. The report has a "by venue"
section (rushes, taken, trades, wins, P&L, late P&L). `SNIPER_V4_LOOKUP=off`
stops the background search for old V4 pools. Dry-fire (and any future
live sending) is Uniswap V3 only; it refuses V4 pool ids and V2 pairs.

Rush buyers are counted as different wallets receiving the tokens (the
swap's recipient), not different transactions. A router that receives the
tokens itself can hide the real wallet, so we may under-count buyers.

Size: each trade uses the auto size (largest size in `SNIPER_SIZES`,
default 25,50,100, that passed the round-trip test), capped at
`SNIPER_MAX_USD` (default 50). `SNIPER_PAPER_USD` is used only if
`SNIPER_SIZES` is empty. A trade that can't be sold counts as a loss of
its own size.

Race check: the normal quote assumes we get the price at the instant we
decide. Real transactions land at least a block later, after other traders.
So every buy and sell is quoted again once the chain is `SNIPER_LATE_BLOCKS`
blocks further on (default 2, about 0.2 s). Each trade gets an extra
`late_for` line in `paper_trades.jsonl`, and the report ends with a
"RACE CHECK" section: late total and $/hour, late win %, median entry and
exit slip (how much worse the late price was), and late quotes that failed.
If the late total is much worse than the normal total, the paper profit
depends on landing instantly, which we cannot do.

## Live trader safety notes (live stays OFF)

- Stale-signal guard (the dex bot's PR #249 lesson: never send a trade
  decided behind the chain tip): the live trader refuses a buy when the
  rush is more than `SNIPER_LIVE_MAX_BEHIND_BLOCKS` (default 5, about
  0.5 s) blocks behind the newest block we know at the moment the order
  would go out (the buy's `delay.behind_blocks`; `total_ms` is shown too).
  Written to `signals.jsonl` as a `live_skip` reason. Paper keeps trading
  those rushes, so we keep measuring them. `0` turns the guard off.
- KNOWN LIMIT, not built yet: a live buy and sell wait for their receipts
  INSIDE the paper trader's main loop (up to 20 s each, `RECEIPT_WAIT` in
  `src/livetrade.rs`). Nothing else is watched meanwhile. Acceptable for one
  $5 position; must be made non-blocking before more positions or bigger
  sizes.

## Engine quotes (speed step 2, off by default)

With `SNIPER_ENGINE=1` the paper trader prices swaps from its own copy of
the dex bot's `arbsim` engine (a full in-memory copy of Robinhood Chain,
answers in about a millisecond) instead of a node round trip. If the engine
is not ready, still loading a value, too slow (`SNIPER_ENGINE_TIMEOUT_MS`,
default 50) or not running, the node is asked as before. The trader also
forwards the sequencer feed (`SNIPER_RHC_FEED`) into the engine so its copy
stays current. Details and all settings: `src/engine.rs`.

- The engine is a SEPARATE process with its own socket
  (`/tmp/sniper-arbsim.sock`); the dex bot's `/tmp/arbsim.sock` is refused.
  Start it with `bash deploy/sniper-engine.sh start` (see that file).
- `SNIPER_ENGINE_CHECK=1`: every quote is asked of both, side by side, and
  written to `engine_check.jsonl`; trades use the NODE's answer. Different
  answers are re-asked of the node at the engine's exact block, to separate
  "engine was newer" from "engine was wrong". The report gets an
  "engine quotes" section: match rate, engine vs node time (p50 / p95),
  fallback rate and reasons.
- The status line every minute shows engine answers vs node fallbacks and
  the feed forwarder's sent / dropped frames.

## Feed wake-up (speed step 3, off by default)

With `SNIPER_FEED_WAKE=1` (needs `SNIPER_ENGINE=1` and the engine running)
the paper trader learns about swaps from the sequencer feed instead of
waiting for its next node poll. Details and settings: `src/feedwake.rs`.

How it works, in short:
- The pools the trader already follows (traded in the last 30 min) are on a
  watch list. Every feed transaction whose call data mentions a watched
  token or pool (any router, any byte position), or that calls a watched
  pool directly, is a candidate.
- For each candidate the engine is asked for the pool's price right before
  and right after that transaction (its exact replayed copy). No change = no
  swap, so failed / reverted transactions never count. A change = a swap:
  direction from the price move, buyer = the wallet that signed it.
- Confirmed swaps go through the SAME rush detector, filters and buy path as
  polled swaps. Node polling keeps running as a backup
  (`SNIPER_RHC_POLL_MS_WHEN_FEED`, default 2000 ms; 0 = normal pace). A swap
  seen both ways counts once (tx hash + pool). No feed frame for
  `SNIPER_FEED_STALE_SECS` (default 5), or the engine failing, = stale:
  normal polling, logged.
- `feedwake.jsonl` (run folder) records which source saw each rush first and
  by how many ms, stale / healthy switches and counters. `paper-report` adds
  a "feed wake-up" section: rushes first seen by feed vs poll, lead p50/p95,
  coverage, engine confirms, stale fallbacks, rush -> buy ready by source.
  Signals and delay records get `"src": "feed" | "poll"` (only when on).

Known gaps: a swap whose call data names neither the token nor the pool is
missed by the feed (polling still finds it later; it then counts as a late
buyer without moving the price). Several swaps of one transaction in one
pool are one net move. Blocks the engine could not replay itself are missed.
V3/V2 buyers are counted by signer on the feed path and by recipient on the
poll path (the same wallet in most trades, not always).

Side-by-side paper test on the server: see the "FEED WAKE-UP" notes at the
top of `deploy/sniper-engine.sh`.

## Engine safety and the live trial (run 12 morning step 1)

Lesson from the dex bot (`sim/COPY2_PLAN.md`): the engine mode the sniper
uses ("replay every chain transaction", `ARBSIM_SOURCE=feed`) needed ~2.1M
node reads a day on the live chain. The sniper's engine has 3,000 paid
reads a day, and every earlier test used a fake node. So before run 12:

    bash deploy/sniper-engine.sh trial          # 30 minutes; "trial 45 keep" = 45 min, keep it running

starts the engine alone (paper bot untouched), forwards the feed relay into
it, and every minute logs paid node reads used vs cap, public node reads,
ready / not ready, how many quotes for ~10 hot V3 pools (from the newest
paper run's `signals.jsonl`) it answered vs "unknown", memory and CPU. At
the end: `ENGINE TRIAL VERDICT: WORKS | FALLS BACK TOO OFTEN | TOO MUCH
MEMORY OR CPU`, with the numbers, also saved to
`~/sniper-engine/trial-<time>.txt`. The engine is then stopped unless
`keep`. The trial itself never talks to a node. Code: `src/enginetrial.rs`.

Memory guard (dex bot lesson: its engine runs 1,000-1,250 MB, pm2 kills at
1,800; this server has 7.7 GB and 2 CPUs): the cron stops our engine above
`ENGINE_MEM_LIMIT_MB` (default 1500), logged, and restarts it with a growing
wait (at once, then 120 s, 240 s ... 30 min; counted again after a stable
hour). It also runs at low CPU priority (nice 15), with mimalloc and the
copy's own size limits. Details: the top of `deploy/sniper-engine.sh`.

## Hot-pool WebSocket (off by default) and its free estimate (on)

The dex bot's proven way to hear about swaps early: subscribe on the paid
WebSocket node to the swap events of ONLY the pools that matter (Chainstack
pushes them about as fast as the sequencer feed, median 7 ms earlier; it
bills every pushed message). Details and settings: `src/wshot.rs`.

- Hot set: pools with a swap or rush in the last 30 min that pass the cheap
  filters (tradable, not blocked, safe V4 hook, old enough for the age rule
  or the young-test window). Rushed first, then most recent; capped at 200
  V3/V2 pools + 200 V4 ids (hard limit 1,000; lists sent in pieces of 400).
  V3/V2 filtered by address; V4 by pool id on the PoolManager.
- Renewed when the set changes, at most every 30 s, make-before-break on the
  same connection; every renewal and reconnect also fills in the gap from the
  HTTP node (`eth_getLogs`). Repeats dropped by tx hash + log index; the
  trader counts each swap once whichever source saw it first.
- Pushed swaps go through the same rush detector and buy path (`"src":"ws"`).
  Polling stays on as backup at the normal pace (rushes on pools that are
  not hot yet are only found by polling); `SNIPER_RHC_POLL_MS_WHEN_WS` can
  slow it while healthy. Quiet for 30 s = reconnect, normal polling meanwhile.
- `SNIPER_WS_HOT_ESTIMATE` (default ON, costs nothing): counts the polled logs
  the hot set's subscription WOULD push and projects messages per day,
  against the spare budget `SNIPER_WS_HOT_BUDGET_DAY` (300,000).
- Status line every minute, `wshot.jsonl` in the run folder, and a
  "hot-pool WebSocket" section in `paper-report`: estimate (FITS / does NOT
  fit), live messages per day, renewals, reconnects, fill-ins, rushes first
  seen by ws / poll / feed, ws lead p50/p95, fallbacks.
- Not used together with `SNIPER_PUSH=1` (that already pushes every swap).

## Young-pool test group (paper only, off by default)

`SNIPER_YOUNG_TEST=1` gives rushes on pools younger than
`SNIPER_MIN_POOL_AGE_SECS` a separate paper test instead of a plain skip.
Details: the top of `src/paper.rs`.

- The main results do not change: the rush is still written as "pool too
  young". It then goes through every OTHER filter and the same buy/exit
  logic as a "young" test trade, in its own slots
  (`SNIPER_YOUNG_MAX_POSITIONS`, default 2, each up to `SNIPER_YOUNG_USD`,
  default 50). It never uses or blocks a main slot or the main money cap.
  `SNIPER_YOUNG_MIN_AGE_SECS` (default 0) skips the very youngest pools.
- Its lines in `signals.jsonl` / `paper_trades.jsonl` carry
  `"group":"young"` and `"pool_age_s"`. `paper-report` keeps them out of
  every main number and adds a "YOUNG POOL TEST GROUP" section: trades,
  wins, $, rugs (exit failed, sale quote gone, or a loss of 50% or more),
  $ without rugs, by pool age (<15, 15-30, 30-60, 60+ min) and by venue.
- Never copied by the live trader (so never in the live daily loss
  ledger). A trap-check failure or rug on a young trade still blocks the
  token and its creator for everyone, and its result counts in the coin
  cooling-off history like any trade.
- Polled and feed wake-up rushes are routed the same way.

## Tests

```bash
cd sniper && cargo test
```

Unit tests cover event decoding (including the Four.meme event ids), the
matcher, the report maths, the curve maths, curve calibration (recovers a
known curve; fails a wrong one), the token registry and the sell-check
verdicts. `tests/probe_e2e.rs` runs the real probe
against two fake websocket nodes, including a dropped connection and a node
that refuses full pending txs.

`tests/sellcheck_anvil.rs` runs the real sell check against a local EVM
(anvil from Foundry) with test-only mock contracts (`tests/fixtures/`): a
normal token (PASS), a 5% tax token (REJECT) and an unsellable token
(REJECT). It needs `anvil` on PATH or `ANVIL_BIN=/path/to/anvil`, and
skips itself otherwise.

`src/engine.rs` tests use a fake engine socket (fallback on miss, slow,
missing, reverted and garbled answers; message formats; the report).
`tests/engine_e2e.rs` runs the sniper's forwarder and quoter against the
REAL arbsim binary (fake node + fake feed relay, all local). It needs the
binary, so plain `cargo test` skips it:

```bash
(cd sim && cargo build --release --bin arbsim)
(cd sniper && cargo test --test engine_e2e -- --ignored --nocapture)
```

Feed wake-up: `src/feedwake.rs` and `src/feedtx.rs` tests cover candidate
finding (ABI words, packed V3 paths, direct pool calls, V4 by token), price
reads, swap direction (failed tx = no change, V2 liquidity moves ignored),
signer recovery (real signatures and the EIP-155 example), dedupe, lead
times, health / stale, and the report section. Two end-to-end tests use the
real arbsim (same build step, `tests/common/` holds the fakes):

```bash
(cd sniper && cargo test --test feedwake_e2e --test feedwake_paper_e2e -- --ignored --nocapture)
```

Young-pool test group: unit tests in `src/paper.rs` (routing, separate
slots, never mirrored live, line tags, rugs and age bands, and a report
check that the main part is byte-for-byte the report without the test).
`tests/young_poll_e2e.rs` runs the real paper trader on the polled path
(plain `cargo test`); `tests/young_feed_e2e.rs` does the same rush through
feed wake-up (needs arbsim, `--ignored`).

Cron engine auto-start: `tests/cron_engine_test.sh` runs the real
`deploy/sniper-cron.sh` against fake binaries in a temp folder (fake HOME,
fake build, fake arbsim, fake node link) and checks start, keep, restart,
kill switch, feed server, failed-start back-off and that no link is logged.
`cargo test` runs it via `tests/cron_engine.rs`; or `bash tests/cron_engine_test.sh`.

Engine memory guard + trial: `tests/engine_guard_test.sh` (run by
`tests/engine_guard.rs`) runs the real cron and `sniper-engine.sh` against a
fake arbsim that holds as much memory as told and speaks the engine's
message format, a fake feed relay and the REAL `sniper engine-trial`: stop
over the limit, restart backoff (0, 120, 240 s; reset after a stable hour),
guard without `SNIPER_ENGINE`, verdicts WORKS / FALLS BACK / TOO MUCH
MEMORY, keep, refusals, no node link printed. Verdict maths: unit tests in
`src/enginetrial.rs`.

Hot-pool WebSocket: unit tests in `src/wshot.rs` (settings, cheap filters,
hot set order and caps, renewal rate limit, filter pieces, dedupe, fill-in
range, estimator, report). `tests/wshot_thread.rs` runs the WebSocket thread
against a fake WebSocket node (rate-limited make-before-break renewal,
renewal fill-in, refused renewal keeps the old subscription, repeats
dropped). `tests/wshot_e2e.rs` runs the real paper trader with a fake HTTP
node and a fake WebSocket node: the rush is found from the WebSocket, bought,
counted once, and after a dropped connection the fill-in recovers a swap
that was never pushed. Both run in plain `cargo test`.

Live stale-signal guard: unit test in `src/livetrade.rs`.

`feedwake_e2e` sends real signed transactions (3 buys + 1 failed) through a
fake feed into the engine and checks the confirmed swaps reach the rush
detector. `feedwake_paper_e2e` runs the real paper trader: a rush found in
the feed is bought (paper) tagged `src: feed`, the node's later copies are
counted once, a feed outage switches back to normal polling.

## Server auto-run (no terminal needed)

`sniper/deploy/` is published with every build to the `sniper-bin` branch.
One-time setup on the server:

    cd ~/sniper-bin && git fetch -q origin && git reset -q --hard origin/sniper-bin && bash deploy/install-sniper-cron.sh

After that, cron runs `deploy/sniper-cron.sh` every 2 minutes: it pulls new
builds, applies `deploy/run.env` (settings, `SNIPER_ENABLED=0` = kill switch),
keeps the paper sniper running (and, with `SNIPER_ENGINE=1`, the sniper's
own engine first: started if not running or its socket is dead, never
restarted while healthy, never the dex bot's), and every 15 minutes posts the scoreboard to
the GitHub issue "Sniper paper status". Paper only; never touches the arb bot
(it only reads `GH_STATUS_TOKEN` from the arb bot's `.env` to post the issue).

### Planned run 12 settings (not active yet)

Morning sequence (owner's go-ahead needed for every run.env change):

1. Engine trial on the server: `cd ~/sniper-bin && bash deploy/sniper-engine.sh trial`
   (30 min, paper bot untouched). Read the verdict.
2. Trial says WORKS: run 12 = the settings below (engine + feed wake-up +
   young-pool test).
3. Trial says anything else: do NOT turn the engine on. Run 12 = new folder +
   young-pool test, with the free WebSocket estimate (on by default) only;
   or, if the estimate in the first hours FITS the node budget,
   `SNIPER_WS_HOT=1` as well:

       SNIPER_OUT=paper-out/run12
       SNIPER_YOUNG_TEST=1
       # SNIPER_WS_HOT=1                 only if the estimate fits

Settings if the trial passes; they go in `deploy/run.env` on the `sniper/**`
branch that builds the server:

    SNIPER_OUT=paper-out/run12          new folder: clean numbers
    SNIPER_ENGINE=1                     cron starts/keeps the engine itself
    SNIPER_ENGINE_CHECK=1               trades keep using the node's quotes
    SNIPER_FEED_WAKE=1                  rushes from the sequencer feed
    SNIPER_RHC_POLL_MS_WHEN_FEED=0      node polled at today's pace (fair comparison)
    SNIPER_FEED_STALE_SECS=5
    SNIPER_YOUNG_TEST=1                 young-pool paper test group

With `SNIPER_ENGINE=1` no manual `sniper-engine.sh start` is needed: the
cron does it before starting the paper bot.
