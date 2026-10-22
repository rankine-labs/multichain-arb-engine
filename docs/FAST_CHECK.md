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
  (`pool_logs`, in order; `block_tick` for every block with nothing for our
  pools). Each message carries the block's header from the WebSocket's
  `newHeads` subscription: time, parent-chain block and **logsBloom**, so
  the copy answers "unknown" for a pool whose reports for that block are
  still on their way (dry run #17). Blocks are put together by exactly the
  dry-run checker's rules (`src/execution/copy2Blocks.ts`, shared): a block
  goes out 30 ms after its header, or once a block 2 later shows up; a
  block whose header never came has it read from the HTTP node (counted as
  "copy 2 headers / fill-ins"); no header at all = the block is not sent and
  the copy reloads. A message that can't be handed over is dropped, counted,
  and the next one makes the copy reload (never a silent gap). A WebSocket
  outage is filled in from the HTTP node (up to 200 blocks, with their
  headers), otherwise the copy reloads.
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
same pools (each swap also moves two coins), **plus one header per block**
(~9 a second on Robinhood, roughly 780,000 a day at 0.11 s blocks). They
count against `BLOCK_READER_WSS_DAILY` (400,000 a day by default). Copy 2's
subscriptions stop for the rest of the UTC day once today's messages reach
`COPY2_WSS_MAX_PCT` (80) % of that cap, so the price feed always keeps its
share; copy 2 then stops being ready and the node decides. To run copy 2 all
day, the cap has to be raised (about 1.2 million covers headers + events)
and the provider plan must allow it.

Settings (all optional): `LOCAL_SIM_COPY2=off` (never use copy 2),
`COPY2_SKIP_DEXES` (exchange names never followed, comma separated),
`COPY2_GRACE_MS` (30, a block is complete this long after its header),
`COPY2_HEADERLESS_MAX_MS` (1500), `COPY2_WSS_MAX_PCT` (80, 0 = no copy-2
limit), `COPY2_STATUS_MS` (2000),
`COPY2_MAX_STATUS_AGE_MS` (10000), `COPY2_BACKFILL_MAX` (200),
`ARBSIM_L2_BLOCK_OFFSET` (0 on Robinhood).

Log lines start with `[copy2]`; the `[blockreader]` line shows
`copy 2 events live (N logs, M headers)`.

## Turning it off

Set `LOCAL_SIM=off` in `.env` and `pm2 restart dex-arb-shadow`. That's all.
For an instant stop without restarting the bot: `bash deploy/arbsim-pm2.sh stop`
(the bot falls back to the node within a fraction of a second).

## Rarely needed settings

`ARBSIM_SOCKET` (default `/tmp/arbsim.sock`), `LOCAL_SIM_TIMEOUT_MS` (60, per
question), `LOCAL_SIM_DEADLINE_MS` (120, whole check), `LOCAL_SIM_SAMPLE_EVERY`
(10), `LOCAL_SIM_SIZE_SEARCH=0` (no size search), `LOCAL_SIM_LOG`,
`LOCAL_SIM_LOG_MAX_BYTES` (2000000).
