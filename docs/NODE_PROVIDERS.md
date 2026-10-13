# Node providers: switching with .env only

The bot can run its practice checks and its every-block reader on **any** node
provider (Chainstack, QuickNode, Alchemy, Infura, dRPC, ...). You switch by
editing `.env` and restarting the bot (`pm2 restart <name> --update-env`).
There's no code change.

**Every setting below is OFF by default.** If none of them are in `.env`, the
bot behaves exactly as before: checks on QuickNode with Alchemy as backup, and
the block reader polling the free Robinhood node.

Logs and reports only ever show the provider **name**, taken from the URL's
host (for example "Chainstack"), never the URL. URLs contain your API key, so
never paste one into a ticket, chat or PR.

---

## 1. Practice checks (eth_call + eth_simulateV1)

| Setting | What it does |
|---|---|
| `CHECK_RPC_MAIN` | Node the checks run on. `https://...` or `wss://...` (a wss URL is turned into https with the same path). **Setting it switches the checks over. Leaving it out keeps QuickNode/Alchemy.** |
| `CHECK_RPC_FALLBACK` | Optional backup node. When the main node refuses (rate limit, plan limit, can't connect), checks move here for 5 minutes, then try main again. Not set means no backup. |
| `CHECK_RPC_MAIN_DAILY` | Daily allowance (number of requests) for the main node. When it's used up, checks pause until midnight UTC (8 pm Toronto) or move to the backup. |
| `CHECK_RPC_FALLBACK_DAILY` | Daily allowance for the backup node. |
| `CHECK_RPC_MAIN_RPS` / `CHECK_RPC_FALLBACK_RPS` | Optional speed limit, in requests per second (default 4). |

If you don't set an allowance:
- A provider the bot already knows keeps its existing allowance (QuickNode 14,000/day, Alchemy 30,000/day).
- Any other provider gets **10,000/day**, so a new plan can never get drained without anyone noticing.

To work out an allowance, take your monthly plan and divide by 30. Then
divide by the provider's cost per call, if it bills in "credits" or
"units". For example, 3M requests a month comes to about 100,000 a day.

Both nodes show up in the hourly report under **Node usage today**, with
today's usage against the allowance. If you set an allowance, they're labelled
"<Provider> (checks)" and "<Provider> (checks backup)". If you didn't, they're
counted on the provider's existing line.

Note: these allowances apply to the **checks**. If the same URL also serves
another job (for example, `CHECK_RPC_FALLBACK` set to the same Alchemy URL as
`ROBINHOOD_RPC_HTTP`, which the chain-wide scan uses), that job keeps its own
counter under the provider's built-in allowance. Both draw on the same monthly
plan, so leave room for both when you pick the number.

On startup the log prints one line like this:

```
[sim] robinhood: checks on Chainstack (50,000/day), fallback Alchemy (30,000/day)
```

## 2. Every-block reader over WebSocket (push instead of polling)

| Setting | What it does |
|---|---|
| `BLOCK_READER_WSS` | `wss://...` URL. When it's set, the node **pushes** each block's pool events to the bot as they happen, instead of the bot asking ~4 times a second. |
| `BLOCK_READER_WSS_HEADS` | `1` = also subscribe to new block headers. **Off by default**: that's about 9 extra billed messages a second, and the reader doesn't need them. |
| `BLOCK_READER_RPC` | (Existing setting.) The HTTP node used for polling, and now also for the gap fill after a reconnect. Default is the free Robinhood node. |

How it behaves:
- **It uses the same events and the same price-update path as the polling reader**, so nothing downstream changes.
- **Polling stays as the safety net.** While the WebSocket is healthy, polling pauses. If the WebSocket drops, or nothing arrives for 10 seconds, polling takes over straight away from the last block the push feed delivered.
- **Reconnects** happen after 1 s, then 2 s, 4 s and so on, up to 30 s between tries.
- **Gap fill:** after a reconnect, one `eth_getLogs` call on `BLOCK_READER_RPC` re-reads the blocks it may have missed (200 at most).
- **Reorgs:** events marked "removed" are never applied, and those blocks get re-read.
- Keep-alive pings are WebSocket control frames. Providers don't bill them.
- The block reader must be on (it is unless `BLOCK_READER=0`).

**Cost note:** the subscription covers every pool trade on the chain (it uses
no address filter, the same as the polling reader), and every event is one
pushed message. Some providers bill per pushed message. Watch the
"(pushed messages)" line in the hourly report for the first day.

The 5-minute `[blockreader]` log line gets an extra part:

```
push Chainstack WebSocket: live, msgs 18342, reconnects 0, fallback 2 s, last block 1234567
```

`DOWN (polling)` means polling is covering for it. `refused N` means the
provider rejected the subscription. Some providers don't allow log
subscriptions without an address filter. If you see that, remove
`BLOCK_READER_WSS`: polling keeps working either way.

## Example .env lines (placeholders: put your own endpoint and key)

```
# Checks on Chainstack, Alchemy as backup
CHECK_RPC_MAIN=https://robinhood-mainnet.core.chainstack.com/YOUR_KEY
CHECK_RPC_MAIN_DAILY=50000
CHECK_RPC_FALLBACK=https://robinhood-mainnet.g.alchemy.com/v2/YOUR_KEY
CHECK_RPC_FALLBACK_DAILY=30000

# Push block reader on Chainstack
BLOCK_READER_WSS=wss://robinhood-mainnet.core.chainstack.com/ws/YOUR_KEY
```

## Swapping providers

1. Get the provider's HTTPS and/or WSS endpoint for Robinhood Chain (chain id 4663).
2. Put it in `.env` as shown above, and set the daily allowance to match the plan.
3. Restart: `pm2 restart <name> --update-env`.
4. Check the startup `[sim] robinhood: checks on ...` line, plus the next `[blockreader]` line, which should say `live`.
5. To go back: delete the lines and restart. The bot returns to QuickNode/Alchemy and the polling reader.
