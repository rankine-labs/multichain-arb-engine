# Rust Predictive Sniper: Phase 1 lead-time probe

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

## Tests

```bash
cd sniper && cargo test
```

Unit tests cover event decoding (including the Four.meme event ids), the
matcher and the report maths. `tests/probe_e2e.rs` runs the real probe
against two fake websocket nodes, including a dropped connection and a node
that refuses full pending txs.
