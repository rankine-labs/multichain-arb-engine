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
  timestamps, and (since copy2-p) `lus` = the fast check's OWN time for our
  contract call (ms, its queue included), `lrt` = the socket round trip the
  bot measured (ms), `lt` = the fast check's split in microseconds (queue /
  prep / resolve / facts / runs / post; since copy2-r also `what` = what
  each EVM run was: `b`/`h` PoolManager balance at the bound / far above it,
  `0`/`1` protocol fee counter, `f` full bound, `c` a coin read to pick the
  high value, `p` plain; `far` = far zero tick words read). Since copy2-r
  `lr` / `nr` = the fast check's / node's reason when it is not profit or
  loss (decoded revert, e.g. "ZeroAmount(): pool gave back nothing").
  `lms` far above `lrt` = the bot
  itself was busy; `lrt` far above `lus` = the answer was read late. Lines with `"k":"signed"` give "trade seen -> trade signed" for
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
`ARBSIM_L2_BLOCK_OFFSET` (0 on Robinhood), `COPY2_DROP_GRACE_S` (1800: a
pool that leaves the watch list stays followed, and in the WebSocket
subscription, this long, so it is still ready when it comes back; 0 = drop
at once; falls back to `ARBSIM_COPY2_DROP_GRACE_S`), `COPY2_DROP_GRACE_MAX`
(300 such pools at most), `COPY2_WANTED_S` (60: route pools a check found
"loading" are sent with the status poll for this long, and the fast check
loads them first; 0 = never).

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

## Speed (copy2-p)

Each check should take a few ms inside the fast check (bench with 640
pools: median ~3 ms, p99 ~20 ms). Where to look if it is slow:

- `pm2 logs dex-arb-shadow | grep "local-sim] hour"`: `arbsim own time
  median X ms, p90 Y ms`, and `N answer(s) came after the 60 ms timeout`.
- `bash deploy/arbsim-pm2.sh status`: "Check speed" lines (queue, pick
  block, copy-2 facts, EVM runs, ...), block apply times, locks held.
- `ARBSIM_COPY2_BOUND_FULL=1` (arbsim side) = the old, slower V4
  PoolManager balance bound (only to compare; answers are the same).

Copy 2 vs node disagreements (copy2-q): when the fast check and the node
give different verdicts, the bot asks the node again pinned at the copy's
block (a few an hour at most) and logs `"k":"recheck"` lines with
`result` in plain words:
- "EARLY: copy right, gap closed after": the node at the same moment
  agrees with the copy; the gap was real and someone took it before the
  node's later look (we were early: good).
- "MISMATCH at same moment": copy and chain disagree at the same block
  (Telegram alert: tell Claude). Cause can be stale/missing data, a maths
  issue, or the re-check asking slightly differently.
- "COULDN'T CHECK": no usable node answer (or the hourly re-check budget).
The hourly line counts them. Re-check lines carry `lr` / `lg` (the copy's
reason / gas) and `nr` / `nrAt` / `ngAt` (the node's, later and at the
copy's block), so a MISMATCH can be traced from the line alone.

`LOCAL_SIM_TIMEOUT_MS` stays 60: about 10x the expected time. Raising it
would only hide a slow fast check and start the node later.

## Trigger-first: check our trade the moment the feed shows the trigger

Why (live Oct 23): all 7 real trades lost. Each chance was real, but rivals
land at the top of block N+1 while we landed in N+2..N+11, because every
path WAITED for the followed trade first: for its pool reports (copy 2) or
its receipt (node), and only then checked our trade.

What it does: the moment the feed shows the trigger, the bot asks the fast
check "take your newest copy-2 version, replay every feed transaction
sequenced after it (before the trigger, the trigger itself exactly once, and
the ones after it we already saw: ours lands after them), then run our exact
trade". If copy 2 already holds the trigger, it is NOT replayed: our trade
runs on that version plus whatever came after. A sure profit goes straight
on to every existing safeguard (kill file, safety gate, loss caps, live route
blocks, send minimum, coin list, fit-to-wallet, outlier guard) and the
FastSender, **without waiting for pool reports or receipts and without any
node request**. Whether that lands us in the trigger's block or the next one
is to be measured, not promised. A local profit is a profit against the
simulated state; the contract's own on-chain min-profit check stays the
safety net. No size search on this path (it would run without the replay).

| Setting | What happens |
|---|---|
| `LOCAL_SIM_TRIGGER_FIRST=off` or missing (default) | Nothing at all (no buffer, no extra work). |
| `LOCAL_SIM_TRIGGER_FIRST=shadow` | **Practice.** Asked for every Robinhood trigger trade, logged next to what the existing path decided and when. Never sends. |
| `LOCAL_SIM_TRIGGER_FIRST=on` | A SURE answer at `TRIG_FIRST_MIN_CONFIDENCE` or better (default medium) decides (profit: on to the safeguards and the sender; loss / fail: refused as today). Unknown: the existing path, unchanged. Only while the fast check itself is ON (`LOCAL_SIM=on` + `LOCAL_SIM_CONFIRM=yes-fast-check`, not stepped back); otherwise practice. |

Needs `LOCAL_SIM` shadow/on and copy 2 running (`ARBSIM_SOURCE=pool-events`).

Under the strict rules (`TRIG_FIRST_STRICT=1`; since Oct 23 the default is
"best effort", see below, which turns several of these into named
assumptions), "unknown" (the old path decides) whenever anything is not exact:
`miss` (a value the copy doesn't hold, anywhere: routers, coins, other pools,
hooks, lenders), `stale_fill` (a replayed trade, or our trade, read or wrote a
value copy 2 only holds as a fill, re-read about once a minute, not followed
exactly at that block: replaying on it could apply a change twice),
`feed_gap` (the bot's feed messages don't reach back to the copy's block, or
one is missing), `feed_order` (trigger not where the feed says, seen twice,
block / sequence numbers don't line up), `feed_unreplayable` (a deposit,
retryable, batch-posting report, compressed / unsigned transaction in the
range), `unsupported_tx`, `replay_watch` (a replayed trade read an unknown
sender's balance / code, a sender's ETH balance, BASEFEE / GASPRICE /
COINBASE), `funding_overlap` (our test contract's pretend funding overlaps
what the replayed trades read), `alignment`, `copy2_*` (a route pool not
ready, reports not flowing), `trigger_not_in_buffer`, plus the usual
`unsure_pool`, `pending_reports`, `pool_manager_balance`, `deadline`.

### Best effort + confidence (Oct 23)

Owner's rule: "we don't need perfect knowledge of every transaction; we need
sufficiently accurate predictions, fast execution, and measured results
showing that wins outweigh failed-trade gas". A wrong prediction costs only
gas (~0.0000088 ETH, about 3 cents: the contract reverts any trade under its
on-chain minimum, `InsufficientProfit`); a late perfect answer earns nothing.
With the $0.25 send minimum, about 1 win in 9 sends breaks even.

So instead of "unknown", the fast check may now make a few NAMED assumptions
(details: `sim/src/check/ordered.rs`, "BEST EFFORT"), each written into the
answer and measured:

| Assumption | What it means |
|---|---|
| `sender_funds` | Values that belong to a replayed transaction's own sender (its ETH balance / nonce, its coin balances and allowances, Permit2 allowances it holds) are assumed to be enough: the sequencer accepted the transaction. Everything that decides what the trade does to the pools stays exact (amounts and limits in its data, pool state, router / pool / hook code). A trade that reverts on its own slippage limit is still computed exactly; one that fails with a "not enough funds / allowance, bad nonce / signature" error after reading an assumed value = unknown (`sender_funds_revert`). |
| `recent_fill` | A replayed transaction read a value copy 2 holds only as a fill (re-read about once a minute). |
| `call_fill` | Our own trade read such a value (the same trust every other copy-2 check has). |
| `skipped_unrelated:N` | N feed transactions we couldn't run (they needed values we don't hold) were left out: they never used our route's state before the missing value, and neither their `to` nor their data names our route's pools, our V4 pool ids, or both coins of one of our pools. |
| `skipped_related:N` | Same, but the transaction NAMES our route (it might touch it). |

A transaction that used our route's state and THEN needed a value we don't
hold is still unknown. The trigger itself is never skipped.

**Confidence** of each answer: `high` = nothing assumed; `medium` = only
sender_funds / recent_fill / call_fill / skipped_unrelated; `low` = a skipped
transaction that might matter (skipped_related).

Still unknown (we truly can't run it): unsupported transaction kinds,
messages we can't unpack, sequence gaps / copy too far behind, missing code /
state of our route or of the trigger's own path (other than its sender's
funds), GASPRICE / BASEFEE / COINBASE reads, engine errors.

| Setting (bot `.env`) | Default | What it does |
|---|---|---|
| `TRIG_FIRST_MIN_CONFIDENCE` | `medium` | Lowest confidence that may SEND in `on` mode (`high` / `medium` / `low`). Lower answers go to the existing path, unchanged. Shadow logs every level. |
| `TRIG_FIRST_STRICT` | `0` | `1` = no assumptions at all (the old strict rules). |
| `TRIG_FIRST_ASSUME` | `sender_funds,recent_fill,skip` | Which assumptions are allowed. |

arbsim side: `ARBSIM_TRIG_CALL_TRUST=best` (default) = the above;
`strict` = no assumptions at all (the old default); `copy2` = the old opt-in
(replays strict, our trade trusted like any copy-2 check, unlabelled).

What to read: `trig_first` log lines now carry `conf`, `as` (assumptions)
and `skp` (feed transactions left out); the hourly `[trigger-first] hour:`
line adds `confidence high a, medium b, low c`, `agree by confidence: ...;
by assumption: ...` (the later same-block re-check split by level and by
assumption kind, `exact` = none: this is how we see which assumptions are
safe), and in `on` mode `held back by the confidence floor`.

### Scoreboard: live-money truth, and the bot adjusting itself

Every REAL send is written down (`src/report/scoreboard.ts`) with its path
(`trig_first`, `copy2`, `node`, `guess` = sent on the model with check-first
off, `gap` = standing gap, `loop`), trigger-first's confidence and
assumptions, the expected profit, and, once the receipt is in: won / failed
on chain, the profit won (the contract's Executed event; if it couldn't be
priced: the expected profit, marked "at expected"), gas in ETH and USD.

- Hourly: log line `[scoreboard] hour: ...` and a `📊 Scoreboard` block in the
  hourly Telegram message: sends, wins, win rate, won, gas, NET, break-even
  win rate (= average gas per send / average profit per win: the win rate at
  which wins exactly pay for all the gas), per path and (trigger-first) per
  confidence; today's totals (Toronto day); paused buckets.
- File: `data/scoreboard.jsonl`, one line per settled send (`k:"send"`), plus
  `k:"pause"` / `k:"stepback"` lines; kept under 2 MB (older half in `.1`).
  A restart reloads it.
- **Bucket pause**: each send belongs to buckets (path, confidence,
  assumption kind; `exact` = none). When a bucket's latest sends (at least 12,
  at most 50) together lost money, that bucket stops sending for 6 h (log +
  Telegram `⏸`), then starts counting from zero. A paused trigger-first
  bucket hands the trade to the existing path.
- **Overall step back**: if every real send of the last 3 h together lost
  more than $1.50, trigger-first goes back to practice for 6 h by itself
  (log + Telegram `⚠️ TRIGGER-FIRST stepped back`; kept across a restart).

| Setting | Default |
|---|---|
| `SCORE_SELF_ADJUST` | `1` (`0` = report only, never pause) |
| `SCORE_BUCKET_MIN_SENDS` / `SCORE_BUCKET_WINDOW` / `SCORE_BUCKET_PAUSE_H` | 12 / 50 / 6 |
| `SCORE_STEPBACK_NET_USD` / `SCORE_STEPBACK_WINDOW_H` / `SCORE_STEPBACK_H` | 1.5 / 3 / 6 |
| `SCOREBOARD_FILE` / `SCOREBOARD_MAX_BYTES` | `data/scoreboard.jsonl` / 2000000 |

**Standing-gap fail block**: standing gaps still ignore the 6 h live route
block by design (each is sent right after its own fresh real check), but a
pool pair whose standing-gap LIVE trade failed on chain is not sent again as
a standing gap for `GAP_LIVE_FAIL_BLOCK_MIN` minutes (default 30, 0 = off).

What to read:
- `data/local-sim-shadow.jsonl` lines `"k":"trig_first"` (one per trigger,
  written ~8 s later): `v` verdict, `u` why unknown, `snap` copy block,
  `incl` trigger already in it, `msgs` / `txs` / `later` replayed (and how many
  after the trigger), `ansMs` feed seen -> answer, `subMs` feed seen ->
  signed (on), `exV` / `exMs` the existing path's verdict and time (shadow),
  `earlierMs` how much earlier than the report-based path, `rblk` / `rAfterMs`
  the trigger's block and when its pool reports came, `agree` / `same` the
  same trade re-checked later on copy 2 at that block (no feed replay) and
  whether that was exactly the same state.
- hourly `[trigger-first] hour:` line (also under the fast-check Telegram
  line): triggers, answered (profit / loss / fail), "required state there" %,
  feed->answer and feed->submit p50 / p90, earlier than the report-based
  path p50 / p90, re-checks agree X/Y (exact same state X/Y), warming node
  requests, top unknown reasons. "ALIGNMENT MISMATCH" = feed sequence vs
  block numbers disagree: check `ARBSIM_L2_BLOCK_OFFSET`.

Node use: none in the hot path. Values trigger-first checks miss are NOT
fetched by the fast check by itself; the bot's warmer asks for an account's
values once `TRIG_FIRST_WARM_MIN_SEEN` (2) checks missed it, within
`TRIG_FIRST_WARM_RPC_PER_HOUR` (60) node requests an hour (upper bound:
one proof per account + one code read per contract), counted in the hour line.

Other settings (defaults): `TRIG_FIRST_BUFFER_MSGS` (600 feed messages kept),
`TRIG_FIRST_BACK_MSGS` (8), `TRIG_FIRST_MAX_MSGS` (48 per question),
`TRIG_FIRST_TIMEOUT_MS` (60), `TRIG_FIRST_DEADLINE_MS` (120),
`TRIG_FIRST_AGREE_PER_HOUR` (600 later re-checks, fast check only),
`TRIG_FIRST_AGREE_WAIT_MS` (5000), `TRIG_FIRST_LOG_AFTER_MS` (8000).

Built since (Oct 23): the scoreboard's automatic step back on REAL money
lost (above). Not built (option for later): a step back when the later
same-state re-checks disagree too often.

### Entry point: every feed transaction is a possible trigger (Oct 23)

Before: trigger-first only ran for trades the old model guess had flagged,
and only after the 6 h "pair blocked" / benched lists (15 of 16 chances in
~50 min of practice were stopped by "pair blocked"). Now
(`src/execution/trigEntry.ts`), for EVERY Robinhood feed transaction:

1. Cheap skip: plain ETH transfers, contract creations, our own transactions
   / calls to our contract, approve / transfer / WETH wrap & unwrap / permit.
2. "Which of our pools does it move?": the fast check runs the transaction
   ALONE on copy 2's newest version (sidecar request `trig_discover`; same
   replay rules and assumptions, no node) and names the followed pools whose
   state it changed.
3. Candidate trades: the same pair on another exchange, both directions,
   starting from USDG / WETH, with the usual exchange / coin rules, size caps
   and lender (at most `TRIG_ENTRY_MAX_CANDIDATES`).
4. Each candidate gets the full trigger-first check (every feed transaction
   in order, then our exact trade) at the biggest size of
   `TRIG_ENTRY_SIZES_USD`; the smaller sizes run on the same replay in the same
   request (size ladder). Best net after gas wins.
5. Profitable (`MIN_EXEC_NET_USD`) at `TRIG_FIRST_MIN_CONFIDENCE` or better:
   `on` sends at once, `shadow` logs "would send".

An entry-point send still passes: kill file / switch, SafetyGate (coin
allowlist, caps, daily loss), the minimum profit, the confidence floor, the
30-min live-fail block on the pool pair (`GAP_LIVE_FAIL_BLOCK_MIN`; a failed
entry send sets it), the scoreboard's paused buckets, then fireTrade's
fit-to-wallet, outlier guard and live checks. It does NOT need the old model
guess and ignores the 6 h liveBlocks / benched lists (they stay for the old
paths). One send per trigger: the entry point and the old path share a lock.

| Setting | Default | |
|---|---|---|
| `TRIG_FIRST_ENTRY` | `1` | `0` = entry point off (`LOCAL_SIM_TRIGGER_FIRST` governs both: off / shadow / on) |
| `TRIG_ENTRY_MAX_IN_FLIGHT` | `4` | triggers worked on at once; more are dropped (counted) |
| `TRIG_ENTRY_MAX_CANDIDATES` | `6` | candidate trades built and checked per trigger (ranked first, then capped, then built) |
| `TRIG_ENTRY_MAX_POOLS` | `4` | more moved pools than this = suspicious answer: skipped, logged `u:"too_many_pools"` |
| `TRIG_ENTRY_PARALLEL` | `2` | candidate checks of one trigger at once (best-ranked first; stops at the first sure answer good enough to send) |
| `TRIG_ENTRY_MAX_CHECKS` | `2` | candidate checks at once over ALL triggers (the sidecar has `ARBSIM_WORKERS` workers, default 2, shared with the old paths) |
| `TRIG_ENTRY_SIZES_USD` | `50,150,400` | size ladder ($), capped by the trade / wallet limits |
| `TRIG_ENTRY_DISCOVER_TIMEOUT_MS` | `40` | the "which pools?" question |
| `TRIG_ENTRY_DEADLINE_MS` | `250` | the whole trigger (discover + checks) |

**Fix (Oct 23, after the first shadow run):** the first version named all
56 V4 pools for every V4 swap (it matched the changed values against each
pool's followed-values list, which for V4 pools also holds SHARED PoolManager
values), so every trigger built ~1700 candidates and ran out of time. Now
only a pool's OWN state counts (`sim/src/check/moved.rs`): a V4 pool by its
id's own slots inside the PoolManager (slot0, fee growth, liquidity, and its
ticks / bitmap / positions, recognised from the hashes the transaction
computed), any other pool by its contract's declared variables. Never: coin
balances, shared PoolManager values, values only read or filled in.
Candidates are ranked (a coin we hold first, then the model's quick price
check) and capped before anything is built; the sizes of the ladder run
after ONE replay; decoded feed transactions are cached in the sidecar.

What to read:
- `data/local-sim-shadow.jsonl` lines `"k":"trig_entry"` (only for
  transactions that moved one of our pools): `pools` moved (first 8), `np`
  how many, `mv` debug: per moved pool which kinds of its values changed
  (e.g. `0x1dae69f1..:liquidity+slot0+ticks`), `found` routes before the
  cap, `early` stopped at the first good answer, `dconf` / `das`
  how sure that answer was (`alone:N` = N earlier feed transactions left out
  of the discover run), `cands` / `tried` candidates found / checked, `best`
  route, `size` ($), `net` ($ after gas), `conf` / `as`, `u` why unknown,
  `would` (would send / sent), `held` what stopped it, `discMs` / `ansMs` /
  `subMs` feed seen -> discover / answer / signed, and the later same-block
  re-check (`agree`, `agV`, `same`, `agSkip`, `rblk`, `rAfterMs`).
- hourly `[trig-entry] hour:` line (also in the Telegram fast-check block):
  feed txs, looked at (skipped, dropped overloaded), moving our pools (% of
  answered), answered %, profitable ($ sum after gas), would send / sent /
  held back (why), feed->discover / answer / submit p50 / p90, top unknown
  reasons. Real sends are on the scoreboard as path `trig_first`, `src:"entry"`.

### Trigger-entry speed + visibility (Oct 23, second pass)

Live shadow (~45 min): feed -> answer p50 47 ms / p90 98 ms while the work
itself is ~0.05 ms; not-profitable answers logged no numbers. Changes:

1. **Logging.** Every answered trigger logs its best candidate even when it
   loses: `best` / `size` / `net` (after gas, can be negative), `bv` its
   verdict, `nle: true` = a "loss" answer (our contract only says "no
   profit", so the net is AT MOST minus gas), `cv` = every checked
   candidate `{l label, v verdict, n net, s size, r reason, c confidence}`.
   A SAMPLE of not-profitable answers (`TRIG_ENTRY_AGREE_SAMPLE`, 1 in 5,
   at most `TRIG_ENTRY_AGREE_SAMPLE_PER_HOUR` = 120) gets the later
   same-block re-check too: `smp: true`, `agree`, `agV`, `agNet` (the
   re-check's net). Hour line: best-net distribution (over $0.25 / $0-0.25 /
   -$0.10-0 / under -$0.10) and "not-profitable sample re-checked N: agree
   a/b, missed chances (re-check profitable) m".
2. **Per-hop timestamps** (`hops`, ms after the websocket frame arrived, 2
   decimals): `parse`, `queue`, `start`, `dSent` / `dAns` (discover or
   one-trip question sent / answer read), `scQ` / `scW` (the sidecar's own
   wait for a worker / work), `dW` (one trip: discovery's share), `built`,
   `checks` (per check `[sent, answered, sidecar queue, sidecar work]`; one
   trip: only work), `dec`, `sign`, `lag` / `lagA` (event-loop lag at the
   frame / at the answer). Hour line: "hops p50/p90 ms" per hop (`rtt` =
   answered - sent, `other` = rtt - sidecar queue - sidecar work = socket +
   the bot's own loop) and "event-loop lag p50 / p90 / max".
3. **One trip** (`TRIG_ENTRY_ONE_TRIP=1`, default). The bot keeps a candidate
   table in the sidecar (`trig_table`, rebuilt every `TRIG_ENTRY_TABLE_MS`,
   only changed pools re-sent): per watched pool its routes, the ranking
   facts and our exact check call (built by the same code as the two-step
   path). One question `trig_entry` = discover + pick (same picking as the
   bot, shared fixture `sim/tests/fixtures/trig_entry_select.json`) + check
   (each exactly as a trigger-first `call`), stopping at the first answer
   the bot would send. The bot reads every answer with its own code; when it
   disagrees with the sidecar's stop, or an entry is missing, it checks the
   rest the old way. No table / older sidecar = two steps, unchanged
   (`one` in the line: `1` = used, else why not).
4. **Priority.** The sidecar serves trigger-entry questions first, at most
   `ARBSIM_PRIO_BURST` (4) in a row while other questions wait
   (`sim/src/jobq.rs`). The bot starts entry work inside the feed handler
   (`TRIG_ENTRY_IMMEDIATE=1`) and, while it is in flight, background jobs
   in bites (gap scan, loop scan, reports...) take at most
   `TRIG_ENTRY_YIELD_SLICE_MS` (2) ms per bite instead of 5-8 ms.
5. `ARBSIM_WORKERS` stays 2: the server has 2 vCPUs, and more workers than
   cores do not make answers faster.

| Setting | Default | Meaning |
|---|---|---|
| `TRIG_ENTRY_ONE_TRIP` | `1` | discover + checks in one sidecar question (0 = two steps) |
| `TRIG_ENTRY_TABLE_MS` | `1000` | candidate table rebuild interval (0 = never by itself) |
| `TRIG_ENTRY_TABLE_REUSE_MS` | `5000` | a table route whose pools, coin price, size cap, gas and route pools did not change keeps its written-down question this long instead of being built again (~1 ms each); the bot still checks the question is exactly its own before using an answer. 0 = rebuild every route every time |
| `TRIG_ENTRY_AGREE_SAMPLE` | `5` | re-check 1 in N not-profitable answers (0 = none) |
| `TRIG_ENTRY_AGREE_SAMPLE_PER_HOUR` | `120` | at most this many sampled re-checks an hour |
| `TRIG_ENTRY_IMMEDIATE` | `1` | start entry work inside the feed handler (0 = setImmediate, as before) |
| `TRIG_ENTRY_YIELD_SLICE_MS` | `2` | longest background-job bite while entry work runs (0 = unchanged) |
| `ARBSIM_PRIO_BURST` (sidecar) | `4` | fast-lane jobs in a row before a waiting normal one (0 = no fast lane) |

## Rarely needed settings

`ARBSIM_SOCKET` (default `/tmp/arbsim.sock`), `LOCAL_SIM_TIMEOUT_MS` (60, per
question), `LOCAL_SIM_DEADLINE_MS` (120, whole check), `LOCAL_SIM_SAMPLE_EVERY`
(10), `LOCAL_SIM_SIZE_SEARCH=0` (no size search), `LOCAL_SIM_LOG`,
`LOCAL_SIM_LOG_MAX_BYTES` (2000000).
