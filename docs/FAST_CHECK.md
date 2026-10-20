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

## Turning it off

Set `LOCAL_SIM=off` in `.env` and `pm2 restart dex-arb-shadow`. That's all.
For an instant stop without restarting the bot: `bash deploy/arbsim-pm2.sh stop`
(the bot falls back to the node within a fraction of a second).

## Rarely needed settings

`ARBSIM_SOCKET` (default `/tmp/arbsim.sock`), `LOCAL_SIM_TIMEOUT_MS` (60, per
question), `LOCAL_SIM_DEADLINE_MS` (120, whole check), `LOCAL_SIM_SAMPLE_EVERY`
(10), `LOCAL_SIM_SIZE_SEARCH=0` (no size search), `LOCAL_SIM_LOG`,
`LOCAL_SIM_LOG_MAX_BYTES` (2000000).
