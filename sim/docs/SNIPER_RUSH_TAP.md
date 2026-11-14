# Sniper rush tap: "seeing ahead" for the sniper's pools

Branch `sniper/rush-tap`. Written Nov 14, 2026. Status: design done, the
arbsim side is built and tested offline, nothing has run on the server yet.

## What this is, in one paragraph

The sniper buys "rushes" (3 or more buys of one coin within about a second,
price up 2% or more). Today it sees those buys in confirmed swap logs. The
sequencer feed shows the same transactions about 0.9 s earlier, but most
buys go through routers and bot contracts, so reading the feed directly
would need a decoder for every router. The arb bot's sidecar (arbsim)
already has "seeing ahead": it runs every relevant feed transaction on a
predicted copy of our pools using the pools' own code, whatever router it
goes through. The rush tap is a small switch that makes seeing ahead write
out, for a list of pools, every predicted swap as one line of JSON: pool,
direction, price before and after, transaction hash, sender, block.

## Short answers

**(a) What seeing ahead outputs per feed block today.** One "predicted tip"
per feed block: the block number, the confirmed block it was built on, a
predicted copy of our pools' state after the block, the list of our pools
that block changed, and the list of pools it cannot vouch for ("unsure").
Inside, it also keeps a note per transaction (ran, failed, skipped, which
pools it moved), but that is only used for its own accuracy counters. It
does not write prices or swaps anywhere. In `FASTLANE_AHEAD=observe` mode
the tips are not even handed to the fast lane; it only measures itself
(status `fastlaneAhead`, hourly accuracy line).

**(b) Which pools it follows.** Exactly the pools copy 2 follows, and
copy 2 follows exactly the list the TypeScript bot sends it (`track`
message, which REPLACES the whole list each time). That list is the bot's
watch list (the pairs the arb bot watches, which by nature have 2 or more
pools), plus pools in their drop grace period, plus the loop trader's extra
single pools if `LOOP_TRADER=1`, plus V4 pools that checks keep missing if
auto-follow is on (`ARBSIM_V4_AUTOFOLLOW=1` on arbsim, `COPY2_AUTOFOLLOW_MAX`
on the bot). `COPY2_ACTIVE_MAX=N` (off by default) cuts this down to about N
pools of the busiest pairs, counted from push-feed events over 10 to 20
minutes and re-picked every 5 minutes. On top of that, seeing ahead skips a
transaction that names only pools no arb route uses
(`FASTLANE_AHEAD_ROUTES_ONLY`, on by default). Bottom line: a fresh meme
coin with one pool is normally NOT followed, so seeing ahead cannot predict
it today.

**(c) Can arbsim run without the TS bot?** Not as it stands. arbsim is a
passive sidecar on a Unix socket. The bot sends it three things: the feed
messages (`feed_put`, already unpacked into transactions), the pool list
(`track`), and every confirmed block's pool events (`pool_logs` /
`block_tick`, from the bot's Chainstack WebSocket subscription). Copy 2
only moves forward on the confirmed events, and seeing ahead always builds
on copy 2's newest confirmed block. Reading feed frames from the relay at
`ws://127.0.0.1:9642` would be easy (arbsim already has a Rust frame
unpacker, `sim/src/feed/frame.rs`), but with no pool list and no confirmed
events there is nothing to build on: zero predictions. Running without the
bot means writing a small "pool events feeder" (headers plus logs for the
followed pools and their coin transfers), about 2 to 3 days. Note: the arb
bot was paused on Nov 13; the tap needs the bot process running (it can run
with sending off).

**(d) Memory, CPU and node needs.**
- Memory: arbsim normally sits at about 1,000 to 1,250 MB following about
  1,500 to 1,800 pools with seeing ahead on (pm2 restarts it at 1,800 MB;
  seeing ahead pauses itself at 1,350 MB). The tap itself adds well under
  5 MB (its pool list, one block of lines at a time, a bounded queue). Each
  extra pool copy 2 follows costs roughly 0.5 MB (dry run #19: about 393 MB
  for about 730 fully loaded pools), so 50 sniper pools is about 25 MB.
- CPU: seeing ahead runs on its own low-priority thread with a 10 ms budget
  per feed message (about 10 messages a second, so at most about 10% of one
  core). The tap adds a few microseconds per tapped swap; the JSON writing
  happens on its own low-priority thread.
- Node (Chainstack): seeing ahead and the tap make ZERO node requests. What
  costs node units: (1) the keeper, which seeing ahead's observe mode turns
  on by default and needs for good accuracy: about 1.7 million units a day
  if it follows every block (`FASTLANE_AHEAD_KEEP_UNITS_DAY` caps it);
  (2) each newly followed pool: a one-time load (a few requests plus one
  trace), re-walked when its price moves far, plus its events on the
  WebSocket subscription (billed per event). Meme pools are busy while they
  are hot, so expect noticeable event traffic per tapped pool.

**(e) The smallest change.** Done on this branch (see "What is built"):
inside seeing ahead, right where each transaction's run is kept, read the
tapped pool's price word (slot0) before and after, and write one line per
(transaction, tapped pool). Plus one rule change, only when the tap is on:
a transaction naming a tapped pool is run even if no arb route uses that
pool. What is NOT in this change and is still needed for meme coins: getting
the sniper's pools onto copy 2's list (the bot's `track` list and its
WebSocket subscription). That is a TypeScript change in the live bot and is
designed below, not built.

## Recommended approach

1. Keep the tap inside arbsim (built). It reuses the exact same runs seeing
   ahead already does, so it costs almost nothing and needs no router
   decoders.
2. Add a "sniper extra pools" list to the bot (not built): a file the
   sniper writes (`COPY2_EXTRA_POOLS_FILE`, one pool per line, capped at
   about 50), merged into what copy 2 follows and what the WebSocket
   subscribes to. Off when unset. The same file can be given to the tap as
   `ARBSIM_RUSH_TAP_POOLS_FILE`.
3. Measure before trusting it: run in observe mode for a few hours and
   compare every tap line with the confirmed swap logs the sniper already
   reads (was the swap real, was the price right, how many ms earlier).
   Seeing ahead's own history says this matters: on the Nov 9 run 38% of
   replayed transactions were "unsure", and "wrong when sure" was 3.8% on
   the Oct 31 offline replay. Router-heavy meme trading may be worse or
   better; we do not know yet.
4. Only if the measured lead time and accuracy are good, let the sniper act
   on `sure: true` swap lines.

I do not recommend the standalone feeder (c) yet. It is the biggest piece
of work and only pays off if the tap proves useful and the arb bot stays
off for good.

## What is built (implemented and tested offline)

- `sim/src/copy2/rushtap.rs`: settings, the tapped pool list, line format,
  and a writer thread (file or local UDP).
- `sim/src/copy2/ahead.rs`: the hook in the per-transaction run, the
  "unsure" lines from transaction notes, "each block written once", the
  route rule exemption, and the runtime wiring (pool list, list file,
  status `fastlaneAhead.rushTap`).
- `sim/src/serve.rs`: a loud log line if the tap is asked for but seeing
  ahead is off.
- Tests: `sim/tests/rush_tap.rs` (5) and unit tests in `rushtap.rs` (9).

### How to turn it on

All of these are `ARBSIM_*` names, so `deploy/arbsim-run.sh` already passes
them from `.env` with no script change.

| Setting | Default | Meaning |
|---|---|---|
| `ARBSIM_RUSH_TAP` | off | `on` turns the tap on. Anything else: nothing runs. |
| `ARBSIM_RUSH_TAP_POOLS` | empty | pool addresses / V4 pool ids, comma separated, or `all` (every followed V3 / V4 pool) |
| `ARBSIM_RUSH_TAP_POOLS_FILE` | none | one pool per line (`#` comments), re-read within a second when it changes |
| `ARBSIM_RUSH_TAP_OUT` | `data/arbsim-rush-tap.jsonl` | a file, or `udp:127.0.0.1:PORT` (local only; other addresses are refused) |
| `ARBSIM_RUSH_TAP_MAX_MB` | 256 | file is renamed to `.1` past this size |

The tap only works while seeing ahead runs: `FASTLANE=practice` and
`FASTLANE_AHEAD=observe` (observe never feeds any trading decision).

### One line

```json
{"t":1763100000123,"seq":5012345,"block":5012345,"baseSeq":5012344,"ahead":1,
 "txIndex":3,"tx":"0x..","from":"0x..","to":"0x<router>","row":"swap",
 "fate":"ran","sure":true,"pool":"0x<pool>","poolKind":"v3",
 "token0":"0x..","token1":"0x..","feedAgeUs":2100,
 "sqrtPriceBefore":"...","tickBefore":-12000,"sqrtPriceAfter":"...","tickAfter":-11950,
 "dir":"buy0","priceChangePct":0.51}
```

- `row`: `swap` (price changed), `moved` (pool changed, price did not:
  liquidity added or removed), `unsure` (a transaction that may touch the
  pool but could not be run exactly; no prices, `why` says why).
- `sure: false`: do not act on it (built on a value that may be wrong, the
  pool was already unsure, or the run assumed a sender's funds).
- `dir`: `buy0` = token0 got more expensive (someone bought token0),
  `buy1` = the other way. Price is token1 per token0 in raw units.
- `ahead`: how many blocks ahead of copy 2's confirmed copy this was.
- `feedAgeUs`: time from the feed message reaching arbsim to the line.
- Each block is written once, from its FIRST prediction. If copy 2 later
  confirms something different and the block is predicted again, it is not
  written again (counted `rebuilt` in status).

Supported pool kinds: Uniswap V3, PancakeSwap V3, Uniswap V4. Others are
listed in status as `unsupported` and get no lines. Listed pools copy 2 does
not follow are listed as `notFollowed`.

## Risks to the live arb bot, and how this avoids them

| Risk | How it is avoided |
|---|---|
| Behaviour change with the tap off | Off unless `ARBSIM_RUSH_TAP=on`. Off: no thread, no list, the hooks see `None` and skip. Every existing test still passes (see test results). |
| The predicted copy slowed down | The hook only reads one storage word per tapped pool a transaction actually changes. JSON and file writes are on a separate low-priority thread. |
| A slow disk or dead listener blocks trading | The queue to the writer is bounded and never waited on: full = lines dropped and counted (`rushTap.dropped`). UDP is non-blocking. |
| Predictions for arb routes change | With the tap on, one rule changes: a transaction naming a tapped pool is run instead of skipped as "off route". That only affects that pool's own prediction (and makes later runs in the same block more exact). It never feeds the fast lane in observe mode. |
| Memory | Lines are handed out every loop; the queue holds at most 1,024 blocks; the file rotates. |
| Node budget | The tap makes no node requests. Extra followed pools (step 2) do; that is where the cap goes. |
| Data leaving the machine | UDP only to 127.x / localhost / [::1]; other targets are refused. |

## Risks to the sniper idea (be clear-eyed)

- **Coverage:** until step 2 is done, only pools the arb bot already
  follows get lines. Most fresh meme pools are not among them.
- **Accuracy:** router and bot transactions often read values copy 2 does
  not hold; those become `unsure` lines, not swaps. How often is unknown for
  meme trading until measured.
- **Lead time:** a prediction needs copy 2's previous block confirmed
  first. If copy 2 lags (it publishes about 30 ms after a block header, and
  more under load), the lead shrinks. `ahead` and `feedAgeUs` measure it.
- **A predicted swap is not a confirmed swap:** the sequencer orders
  transactions; a buy we saw can still revert. Never treat a tap line as a
  fill.

## Remaining steps

| Step | What | Estimate |
|---|---|---|
| 1 | Deploy this branch's arbsim on the server in observe mode with the tap on (`ARBSIM_RUSH_TAP_POOLS=all` first, to see lines from pools we already follow), with the bot running and sending off | 1 to 2 hours |
| 2 | Bot side: `COPY2_EXTRA_POOLS_FILE` (sniper's pools into copy 2's list and the WebSocket subscription, capped, off when unset) + tests | 0.5 to 1 day |
| 3 | Sniper side: read the tap (file tail or UDP), match each line to the confirmed swap later, report lead time, hit rate, wrong rate | 1 day |
| 4 | Offline check on recorded captures (`ahead-replay` with the tap) to get numbers without waiting for live hours | 0.5 day |
| 5 | Only if 3 and 4 look good: let the paper trader act on `sure` swap lines and compare against today's log-based entries | 0.5 to 1 day |
| 6 | Optional: standalone pool-events feeder so arbsim runs without the arb bot | 2 to 3 days |

## Running the tests

```bash
cd sim
cargo test --release                      # everything (slow: fat LTO)
cargo test --test rush_tap                # the tap, end to end on the predicted copy
cargo test --lib rushtap                  # settings, line format, writer
```
