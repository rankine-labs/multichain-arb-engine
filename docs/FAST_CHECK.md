# Fast check: what the switch does (bot side)

Plain English: the **fast check** is the small `arbsim` program running next to
the bot. It answers "would this trade make money?" in about a millisecond,
instead of ~100 ms from the paid node. How it gets installed and started is in
`docs/FAST_CHECK_OPS.md`. This page is about what the **bot** does with it.

## The switch (in `.env`)

| Setting | What happens |
|---|---|
| `LOCAL_SIM=off` or missing (default) | Nothing. The bot never even opens the connection. |
| `LOCAL_SIM=shadow` | **Practice.** The node decides every trade exactly as before. The fast check answers the same questions alongside, and both answers are written down to compare. |
| `LOCAL_SIM=on` **and** `LOCAL_SIM_CONFIRM=yes-fast-check` | The fast check decides when it is **sure**. When it isn't sure, the node decides, as before. |
| `LOCAL_SIM=on` without the confirm word | Stays in practice, and the log says why. |

Change it, then `pm2 restart dex-arb-shadow`.

## What it checks

- **Follow-a-trade checks** (practice and the live "check first, then send"):
  asked the moment the bot sees the trade it follows, "right after that trade".
  The fast check doesn't need to wait for the trade to land in a block, because
  it replays the live feed itself. In `on` mode a sure answer means the bot no
  longer waits ~0.2-1 s for the receipt and the node check.
- **Sitting gaps**: asked on the newest state.
- **Size**: in `on` mode it may pick a **smaller** size that makes more. Never
  bigger than the size the bot already chose (so every size limit and the
  wallet-fit rule still apply).

The bot passes every raw message from its one Robinhood live feed
(`wss://feed.mainnet.chain.robinhood.com`) to the fast check unchanged, and
every 10 minutes tells it which accounts to keep ready (our contract, watched
pools and their coins, the V4 PoolManager, approved loan pools, routers).

## What to watch

- Hourly Telegram line, e.g.
  `⚡ Fast check (practice): 120 checks, same answer 99%, unknown 8%, median 1 ms vs node 95 ms (trade seen to answer 3 ms)`
  - **same answer**: of the checks both could answer, how often they agree. Want 98%+.
  - **unknown**: how often the fast check wasn't sure (the node answered). Lower is better.
- Log lines starting `[local-sim]` (`pm2 logs dex-arb-shadow | grep local-sim`).
- The detail file `data/local-sim-shadow.jsonl` (one line per check, kept under
  2 MB, the older half in `.jsonl.1`). Fields: `lv`/`nv` fast/node verdict,
  `lp`/`np` profit, `lg`/`ng` gas, `lms`/`nms` time to answer, `lseen`/`nseen`
  time since the trade was seen, `lu` why it wasn't sure, `seen`/`sent`/`ans`
  timestamps. Lines with `"k":"signed"` give "trade seen -> trade signed" for
  live sends (`seenToSignedMs`), the number behind the 10-20 ms target.

## Automatic safety

In `on` mode, 1 in 10 fast decisions is checked again with the node in the
background. If more than 2% of the last 200 disagree, or the fast check reports
its copy of the chain drifted ("replay mismatch"), it **steps back to practice
for 6 hours by itself** and sends `⚠️ FAST CHECK stepped back to practice`.
After 6 hours it decides again (`⚡ FAST CHECK back ON`).

If the fast check program is stopped, crashed or slow, the bot just uses the
node (logged at most once a minute). It can never stop the bot.

## Copy 2: the fast check follows our pools from their own reports

When the fast check program runs in **pool-events mode** (`ARBSIM_SOURCE=pool-events`
on its side, see sim/COPY2_PLAN.md), the bot notices it by itself (status
check every 2 s) and then:

- asks the block reader's WebSocket (`BLOCK_READER_WSS`, required) for
  **every** event of our pools, every Uniswap V4 event of our V4 pool ids, and
  coin transfers into / out of our pools, and passes them on block by block
  (`pool_logs`, in order; `block_tick` for quiet blocks), put together by
  exactly the dry-run checker's rules (`src/execution/copy2Blocks.ts`,
  shared; the checker's `--no-headers` = the bot's default):
  - **Headers off (default, `COPY2_HEADERS=off`)**: a block goes out as soon
    as a report of a later block arrives, or 30 ms after its first report.
    Its time and parent-chain block come from the sequencer feed or the
    logs' own blockTimestamp (Chainstack puts it on every log); a block
    whose time is still unknown 40 ms later has it read from the HTTP node
    (`BLOCK_READER_RPC`, one eth_getBlockByNumber, at most
    `COPY2_TIME_READS_PER_MIN` a minute); only if that fails too is it not
    sent and the copy reloads (never a guessed time). No
    logsBloom: arbsim still marks a pool "pending" from its transfer /
    event pairing rules. `block_tick` for the feed's newest block once it is
    250 ms old with nothing held.
  - **Headers on (`COPY2_HEADERS=on`, needs a bigger provider plan)**: each
    message also carries the block header's **logsBloom** from a `newHeads`
    subscription (one billed WebSocket message per block, ~845k a day), so
    the copy also answers "unknown" for a pool whose reports for that block
    are still on their way (dry run #17). A block goes out 30 ms after its
    header, or once a block 2 later shows up; `block_tick` for every quiet
    block; a missing header is read from the HTTP node (counted as "copy 2
    headers / fill-ins"); no header at all = not sent, the copy reloads.
  A message that can't be handed over is dropped, counted, and the next one
  makes the copy reload (never a silent gap). A WebSocket renewal (the
  block reader renews its subscription when the watch list changes) or
  outage is filled in from the HTTP node (up to 200 blocks; with headers
  on, with their headers too): the fill-in waits up to `COPY2_FILL_WAIT_MS`
  (3 s) for that node to have every missed block (it is often a few blocks
  behind), then passes them on in order. That is NOT a lost message: no
  reload. Only a hole that can't be filled makes the copy reload.
- tells it which pools to follow (`track`): watched pools of a type the copy
  can follow exactly: Uniswap / PancakeSwap V2, Ramses V2 and GIGA Classic
  (Solidly), Uniswap V3 and copies, PancakeSwap V3 and copies, Algebra
  (Alandale, KittenSwap), Uniswap V4 **without** a hook. Not followed (the
  node keeps checking them): V4 with a hook (Fables...), Ramses V3,
  Slipstream copies, bins, order books, oracle pools.
- **routes** checks: a sitting gap, a live follow-a-trade check and a live
  loop check go to the fast check only when **every pool on the route (and
  the loan pool) is ready** in the copy, its readiness is fresh (under 10 s),
  and the reports are flowing without a gap. Then the fast check is asked
  about the newest block it has. Anything else: the node, exactly as before.
  Follow-a-trade: the trade's own pool reports say it is in a block (no node
  receipt polling); then the fast check answers for that block.
- In `on` mode the 1-in-10 node re-check runs on **the same block** the fast
  check used, so the automatic step back compares like with like.
- Hourly line adds e.g.
  `copy 2: 412 ready, 3 unsure, 5 loading of 420 pools; routed to fast check 120, to node 30 (pool unsure 20, readiness too old 10); pool reports live: 5321 blocks passed on`

Cost: the WebSocket pushes roughly 2-3 times more (billed) messages on the
same pools (each swap also moves two coins). With `COPY2_HEADERS=on` add
one header per block (~9.8 a second measured, ~845,000 a day = ~25M a
month, more than the whole Chainstack Growth plan of 20M): that is why it
is off by default. They count against `BLOCK_READER_WSS_DAILY` (400,000 a
day by default). Copy 2's subscriptions stop for the rest of the UTC day
once today's messages reach `COPY2_WSS_MAX_PCT` (80) % of that cap, so the
price feed always keeps its share; copy 2 then stops being ready and the
node decides.

Settings (all optional): `LOCAL_SIM_COPY2=off` (never use copy 2),
`COPY2_SKIP_DEXES` (exchange names never followed, comma separated),
`COPY2_HEADERS` (off), `COPY2_GRACE_MS` (30), `COPY2_TS_WAIT_MS` (40,
headers off: wait for a block's time from the feed), `COPY2_TICK_MS` (250,
headers off: quiet-block tick, 0 = none), `COPY2_HEADERLESS_MAX_MS` (1500,
headers on), `COPY2_WSS_MAX_PCT` (80, 0 = no copy-2 limit), `COPY2_STATUS_MS` (2000),
`COPY2_MAX_STATUS_AGE_MS` (10000), `COPY2_BACKFILL_MAX` (200),
`ARBSIM_L2_BLOCK_OFFSET` (0 on Robinhood).

Log lines start with `[copy2]`; the `[blockreader]` line shows
`copy 2 events live (N logs, M headers)` (M = 0 with headers off).

### Forced reloads (the Oct 22 go-live failure)

A "forced reload" = the bot tells the copy "I missed something, reload
every pool". Every one costs minutes of loading, so it must stay rare.
Where to see them:

- Bot log, when it changes:
  `[copy2] on / following 677 / reports live / forced reloads 0 / outages filled 12`
  and one line per forced reload:
  `[copy2] the copy was told to reload every pool (block time unknown); forced reloads so far: ...`
- Hourly line: `forced reloads K (reason n, ...)`.
- arbsim status (`bash deploy/arbsim-pm2.sh status`, line "forced reloads (every pool)"):
  `copy2.gapReasons` = the same reasons as the copy saw them, plus
  `message lost on the way` (a message lost between bot and arbsim).

Reasons: `start` (copy starts following: harmless, a fresh arbsim ignores
it), `block time unknown`, `late report, block time unknown`, `outage not
filled in (HTTP node behind | node error | no HTTP node | header
unreadable)`, `outage too long to fill in`, `message not handed over
(socket busy)`, `outage before the first block`. Healthy: 0-2 an hour.

Settings: `COPY2_FILL_WAIT_MS` (3000), `COPY2_TIME_READS_PER_MIN` (30, 0 =
never read a time: skip + reload instead).

## Validating copy 2 in practice BEFORE switching it on

`LOCAL_SIM=shadow` runs copy 2 with exactly the same live feed, WebSocket
subscriptions, renewals and fill-ins as `on`; only the decisions stay with
the node. So:

1. arbsim with `ARBSIM_SOURCE=pool-events`, bot `.env` `LOCAL_SIM=shadow`,
   `pm2 restart dex-arb-shadow`.
2. Wait for the load round (`copy2: load round done ...` in the arbsim log,
   ~5-15 min), then watch for 1-2 hours:
   - `pm2 logs dex-arb-shadow | grep copy2`: `forced reloads` stays at 0-2
     (`outages filled` going up is fine: renewals filled in).
   - arbsim status: `ready` close to `pools`, `gapReasons` small, `unsure`
     not stuck on `lost message before block N`.
   - Hourly Telegram line: `copy 2 vs node: N checks, same a, different b,
     fast check unsure c (same answer x%)`. These are the checks the fast
     check would have decided with copy 2; want same answer 98%+ with N in
     the tens or more. (In practice the node answers on the newest block a
     few ms later than the copy's block, so a few "different" can be the
     market moving; `data/local-sim-shadow.jsonl` lines with `c2blk` hold
     each one, with `lv`/`nv` and `lp`/`np` to look at.)
3. Only then `LOCAL_SIM=on` + `LOCAL_SIM_CONFIRM=yes-fast-check`.

## Turning it off

Set `LOCAL_SIM=off` in `.env` and `pm2 restart dex-arb-shadow`. That's all.
For an instant stop without restarting the bot: `bash deploy/arbsim-pm2.sh stop`
(the bot falls back to the node within a fraction of a second).

## Rarely needed settings

`ARBSIM_SOCKET` (default `/tmp/arbsim.sock`), `LOCAL_SIM_TIMEOUT_MS` (60, per
question), `LOCAL_SIM_DEADLINE_MS` (120, whole check), `LOCAL_SIM_SAMPLE_EVERY`
(10), `LOCAL_SIM_SIZE_SEARCH=0` (no size search), `LOCAL_SIM_LOG`,
`LOCAL_SIM_LOG_MAX_BYTES` (2000000).
