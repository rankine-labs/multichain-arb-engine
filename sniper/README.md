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

## Server auto-run (no terminal needed)

`sniper/deploy/` is published with every build to the `sniper-bin` branch.
One-time setup on the server:

    cd ~/sniper-bin && git fetch -q origin && git reset -q --hard origin/sniper-bin && bash deploy/install-sniper-cron.sh

After that, cron runs `deploy/sniper-cron.sh` every 2 minutes: it pulls new
builds, applies `deploy/run.env` (settings, `SNIPER_ENABLED=0` = kill switch),
keeps the paper sniper running, and every 15 minutes posts the scoreboard to
the GitHub issue "Sniper paper status". Paper only; never touches the arb bot
(it only reads `GH_STATUS_TOKEN` from the arb bot's `.env` to post the issue).
