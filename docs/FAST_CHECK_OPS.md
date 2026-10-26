# Fast check (arbsim sidecar): how to run it

Plain English: **arbsim** is a small, fast program that runs next to the bot on
the server. It keeps its own copy of Robinhood Chain and answers "what would
this trade do?" in about a millisecond, instead of asking the paid node
(~100 ms). The bot asks it only when `LOCAL_SIM` in `.env` says so. If the
sidecar is missing, slow or unsure, the bot just asks the node, exactly like
before. **Stopping the sidecar can never stop or break the bot.**

| `LOCAL_SIM` in `.env` | What happens |
|---|---|
| `off` or missing (default) | Sidecar not running. Bot uses the node for everything. |
| `shadow` | Sidecar runs; the bot compares its answers with the node's (practice only). |
| `on` | Bot uses the sidecar's answers when it is sure, the node when not. |

## 1. How the program gets to the server

The server can't build it (no Rust installed, too little memory), so GitHub
builds it:

1. A change is merged to `main`. If it touched `sim/`, GitHub's **Arbsim binary**
   workflow builds the program, runs all its tests (5-15 min), and puts it on a
   separate branch **`arbsim-bin`**. That branch holds one commit only, with:
   - `arbsim`: the program
   - `arbsim.sha256`: its checksum
   - `BUILD_INFO`: which code it was built from (`source_commit`, and
     `sim_tree` = git's fingerprint of the `sim/` folder at that commit)
2. The server's auto-deploy (every 2 minutes) runs `deploy/arbsim-update.sh`.
   It compares the fingerprint of the `sim/` folder **deployed on the server**
   (`git rev-parse HEAD:sim`) with `BUILD_INFO` on `arbsim-bin`:
   - **match**: downloads it read-only, checks the checksum, checks it runs
     on this server, installs it as `bin/arbsim` (the old one is kept as
     `bin/arbsim.prev`), restarts the sidecar. Telegram: `⚡ FAST CHECK UPDATED`.
   - **no match yet** (GitHub still building): log says
     `arbsim binary not ready for this version, keeping old one`. The old file
     is kept, but it is **not run** against code it wasn't built for: the
     sidecar is stopped and the bot uses the node until the new build arrives.
     The next 2-minute run picks it up by itself.
   - **bad download** (checksum wrong, won't run): not installed, old file
     untouched. Telegram: `⚠️ FAST CHECK PROBLEM` (once).
3. A merge that doesn't touch `sim/` keeps the same fingerprint: nothing happens.

**Deploy lock is unchanged.** While live, merges are not deployed, so the
deployed `sim/` doesn't change, so the sidecar program doesn't change either
(a newer build on GitHub just waits). It only changes when the bot's code is
deployed (`touch DEPLOY_ALLOW_LIVE` as always). During such a deploy the
sidecar switches over right before the bot restarts, and if the deploy is
rolled back, the sidecar switches back to `bin/arbsim.prev`.

The server never pushes anything. `bin/` is not in git.

## 2. Start / stop

The sidecar follows `LOCAL_SIM` by itself within 2 minutes. By hand (in the
bot folder, `~/multichain-arb-engine`):

```bash
bash deploy/arbsim-pm2.sh start     # start now (LOCAL_SIM must be shadow or on)
bash deploy/arbsim-pm2.sh stop      # stop, and STAY stopped until "start"
bash deploy/arbsim-pm2.sh restart
bash deploy/arbsim-update.sh        # check for / install the right program now
```

Turning it on for the first time:

1. Add `LOCAL_SIM=shadow` to `.env`.
2. `bash deploy/arbsim-update.sh` (installs the program and starts the sidecar).
3. `pm2 restart dex-arb-shadow --update-env` (so the bot reads `LOCAL_SIM`).

pm2 settings: app name `arbsim`, low priority (`nice 5`), restarted above
800 MB memory (dry run #19 on the server: ~393 MB with ~730 pools tick-walked, flat;
see deploy/arbsim-pm2.sh), crash restarts wait longer each time (1 s up to 15 s), log
lines timestamped, logs rotated by pm2-logrotate. After a server reboot it
comes back by itself within 2 minutes (auto-deploy), no `pm2 save` needed.

### Warm restart (copy 2, since copy2-n)

The sidecar no longer starts from nothing after a restart / deploy:

- Every minute, and when pm2 stops it, copy 2 saves itself to
  `data/arbsim-copy2-state.bin` (~40 MB, written in the background in
  ~0.1 s; pm2 waits up to 30 s for the final save before killing).
- At the next start it reads that file, and as soon as the bot's first
  block arrives it reads the missing blocks' pool reports from the node's
  logs (free node first, paid node if that fails: ~20 requests for a
  5-minute gap, ~50-100 for 30 minutes) and applies them. Checks get
  answers again after a few seconds instead of ~13 minutes, and no pool is
  loaded again.
- The same happens when only the BOT restarts (the sidecar keeps running):
  the blocks the bot didn't send are read from the node's logs instead of
  reloading every pool. Pools the new bot doesn't list yet (its loop-extra
  pools come ~3 minutes after its start) are kept aside and caught up from
  their own reports when it lists them again.
- Falls back to the normal full load by itself when the file is missing,
  damaged, from another program format, or more than 30 minutes
  (`ARBSIM_COPY2_RESUME_MAX_BLOCKS`) behind.
- To force a fresh load (e.g. after a fix to how copy 2 follows pools):
  `rm data/arbsim-copy2-state.bin` before restarting the sidecar (or set
  `ARBSIM_COPY2_STATE_FILE=off`). Status: `bash deploy/arbsim-pm2.sh status`
  shows the "warm restart" line.

## 3. See how it's doing

```bash
bash deploy/arbsim-pm2.sh status    # same as: node deploy/arbsim-status.js
pm2 status arbsim
pm2 logs arbsim --lines 50
grep '\[arbsim\]' deploy/auto-deploy.log | tail -20     # install / start / stop history
```

The status report says, in plain words: ready or not, its block vs the chain's
newest block, how many feed messages it replayed itself vs had to look up on the
node, how long it was "not sure" (dirty), its self-check vs the node (match /
**mismatch**), checks answered, paid-node use today vs its daily cap, memory.
Exit code 1 = not reachable.

Normal right after a start: `NOT READY yet` for a short while (it needs feed
messages from the bot).

## 4. Roll back to the previous program

```bash
cd ~/multichain-arb-engine
pm2 stop arbsim
cp -p bin/arbsim bin/arbsim.bad && cp -p bin/arbsim.build_info bin/arbsim.bad.build_info
cp -p bin/arbsim.prev bin/arbsim && cp -p bin/arbsim.prev.build_info bin/arbsim.build_info
touch bin/ARBSIM_PINNED            # tells the updater: hands off, don't re-install
pm2 restart arbsim
```

While `bin/ARBSIM_PINNED` exists the updater never changes the program, and
the "built for exactly the deployed code" safety check is skipped (you chose
this program on purpose; it still has to run on this server). Be aware the
previous program was built for the previous `sim/` code, so only pin it if the
bot side didn't change how it talks to the sidecar. When in doubt, use
`LOCAL_SIM=off` (section 5) instead until a fix is merged. To go back to
automatic updates: `rm bin/ARBSIM_PINNED` (the next 2-minute run installs the
right program again).

## 5. If it misbehaves

Fastest first. None of these touch the bot's trading.

1. **Turn it off completely** (the bot goes back to the node for every check):

   ```bash
   # in .env: LOCAL_SIM=off
   pm2 restart dex-arb-shadow --update-env
   pm2 stop arbsim                     # auto-deploy also removes it within 2 min
   ```

2. Just pause the sidecar (bot keeps `LOCAL_SIM`, uses the node meanwhile):
   `bash deploy/arbsim-pm2.sh stop`.
3. Send Claude the output of `bash deploy/arbsim-pm2.sh status` and
   `pm2 logs arbsim --lines 100`. Things to look for:
   - `mismatch` above zero in "Self-check vs node"
   - memory near 800 MB (new tick walks pause at 550 MB), or `pm2 status` showing many restarts
   - "Paid node use today" near its cap, or "refused"
   - "NOT READY" for more than a few minutes while the bot is running

## 5b. If the bot freezes

"Freezes" = the bot's one thread is busy and every feed trade waits. The
`[stalls]` log line (every 5 min) and the hourly report count them:
`Freezes over 50 ms: 204 (worst 630 ms) · top causes: ...`. A few per
5 min is normal; hundreds are not.

**1. Read what the bot already wrote (nothing to change):**

```bash
pm2 logs dex-arb-shadow --lines 3000 --nostream | grep -E "\[stalls\]|\[freeze-profile\]|\[mem\]|\[trig-entry\] hour|sequencer feed connected"
```

- `[freeze-profile]` (since Oct 23, `FREEZE_PROFILE=1` default): after 3
  freezes over 200 ms within a minute the bot records a 5 s CPU profile and
  logs the 10 functions that used the most time, e.g.
  `top self time: keccak (sha3.js:120) 820 ms 16%, ...`. Send Claude this
  line; the full profile is in `data/profiles/` (newest 5 kept).
- `[stalls]` top causes: since Oct 23 the feed has its own names:
  `feed unpack` (reading transactions out of a feed message), `feed tap`
  (trigger-first order buffer + entry skip test), `trig entry` (starting a
  trigger check), `feed decode` (trade list), `trig table` (one-trip table),
  `feed frame` (the rest). A busy name points at the setting to try below.
- Many `sequencer feed connected` lines = the feed keeps reconnecting (each
  reconnect replays a backlog; since Oct 23 messages already seen are skipped).
- `[trig-entry] hour`: `table N pools / R routes (X reused unchanged), rebuilt in T ms`.
  A big R and T means the one-trip table is the heavy job.

**2. Settings to try, cheapest and safest first.** One at a time, then
`pm2 restart dex-arb-shadow --update-env` and compare the next `[stalls]` lines
(wait 10-15 min). None of them changes what a check answers; each only
changes how much work runs on the bot's thread.

| Step | Setting in `.env` | What it does | Cost |
|---|---|---|---|
| 1 | `TRIG_ENTRY_TABLE_MS=3000` | one-trip table rebuilt every 3 s instead of every 1 s | table up to 3 s old: more triggers fall back to the two-step path (slower, same decisions) |
| 2 | `TRIG_ENTRY_ONE_TRIP=0` | no one-trip table at all (two steps per trigger, as before Oct 23) | trigger answers a little slower |
| 3 | `TRIG_ENTRY_IMMEDIATE=0` | trigger checks start right AFTER the feed message is handled, not inside it | ~0.1-1 ms later start |
| 4 | `TRIG_FIRST_ENTRY=0` | entry point off: no feed transaction is checked as a trigger | trigger-first entry trades stop (the older paths still trade) |
| 5 | `LOCAL_SIM_TRIGGER_FIRST=off` | trigger-first off completely (order buffer, entry point) | as before the trigger-first work |

Fix switches (only if Claude asks; each puts back the old behaviour of one
Oct 23 fix): `FEED_TX_MEMO=0` (unpack each feed transaction again per
reader), `FEED_SKIP_REPEATS=0` (unpack a reconnect's backlog again),
`TRIG_ENTRY_TABLE_REUSE_MS=0` (rebuild every table route every time).
Oct 24 fix switches (same idea, each puts back one old behaviour):
`FEED_LIGHT_DECODE=0` (ethers unpacks every feed transaction again),
`RPC_LEAN=0` (node requests / answers through ethers' slow text converters),
`RPC_LEAN_CALL=0` (bundled reads through provider.call again),
`SCAN_LOAD_CHUNKED=0` (saved pool scan read in one go),
`RIVAL_SLICED=0` (rival watch jobs all back to back again).
Oct 24 feed speed switches (PR "feed trade speed"; each puts back one old
behaviour, none changes what a trade decides):
`FEED_TRADE_DEFER=0` (the decide part of every trade in a feed message runs
back to back again, before the sidecar's answer can be read),
`FEED_FAST_PARSE=0` (ethers finds the router function again: a hash per
function, every call), `FEED_FAST_ABI=0` (ethers reads the call arguments
again: ~16x slower per swap, ~10x more throw-away memory; also the ~200
questions of a new pair's pool lookup), `PAIR_DISCOVERY_YIELD=0` (a new
pair's lookup is built inside the feed trade that noticed it again; now it
runs a moment later under its own name, `pair discovery`).
Feed helper thread (Oct 26, `FEED_WORKER`, default OFF): `FEED_WORKER=1`
moves the Robinhood feed websocket and the reading of every feed message
(un-zip, JSON, unpacking transactions, hashes, light read) to a helper
thread; the main thread only gets the finished lists and decides exactly as
before. Look for `[robinhood] FEED_WORKER=1: the feed is read by a helper
thread` at start. If the helper dies you see `feed helper thread ...
starting a fresh one` and the feed reconnects on the next health check;
if it can't start 3 times in a row the bot says so and reads the feed the
old way until restarted. Remove the line (or `FEED_WORKER=0`) and restart
to go back.
`[feed-turns] 5 min: N trades decided one per loop pass · longest line L ·
wait p50 / p90 / max ms` (every 5 min, next to `[stalls]`): how long trades
waited for their turn. A wait p90 over ~20 ms or a longest line in the
hundreds means the decide part itself is the bottleneck: send Claude the line.
Profiler: `FREEZE_PROFILE=0` off; `FREEZE_PROFILE_MS` (200),
`FREEZE_PROFILE_COUNT` (3), `FREEZE_PROFILE_WINDOW_S` (60),
`FREEZE_PROFILE_SECONDS` (5), `FREEZE_PROFILE_EVERY_MIN` (30),
`FREEZE_PROFILE_KEEP` (5), `FREEZE_PROFILE_DIR` (`data/profiles`).

**3. Send Claude** the lines from step 1 (before and after a change).

## 6. Settings (all optional; put them in `.env`)

`deploy/arbsim-run.sh` (what pm2 starts) reads ONLY these lines from `.env`
and nothing else. Node links are never printed, and never stored in pm2.

**Node links**

| Setting | Default | What it does |
|---|---|---|
| `ARBSIM_NODE_URL` | value of `CHAINSTACK_RPC_ROBINHOOD` | paid node 1 |
| `ARBSIM_NODE_URL_2` | value of `QUICKNODE_RPC_ROBINHOOD` | paid node 2 (backup) |
| `ARBSIM_PUBLIC_URL` | `https://rpc.mainnet.chain.robinhood.com` | free public node (most plain reads); `off` = don't use |
| `ARBSIM_BG_PUBLIC` | `0` | `1` = copy 2's background work (first loads, coin probes, held-value re-reads) asks the free node first, as far as its speed limit has room; the rest and any error go to the paid node. Works with `ARBSIM_PUBLIC_URL=off` too (then the free node is used for background only, never for new blocks or the tip) |
| `ARBSIM_NODE_BULK_RPS` | `0` (no cap) | most requests/s background work may use on the PAID node; urgent work keeps the full `ARBSIM_NODE_RPS` |

**Node use limits**

| Setting | Default | What it does |
|---|---|---|
| `ARBSIM_NODE_DAILY_CAP` | 6000 | paid-node requests per UTC day (shared by node1 + node2; on top of the bot's own use) |
| `ARBSIM_NODE_RPS` | 8 | paid-node requests per second |
| `ARBSIM_BUDGET_FILE` | `data/arbsim-node-budget.json` (set by the runner) | where today's count is kept across restarts |
| `ARBSIM_PUBLIC_RPS` | 6 | public-node requests per second |
| `ARBSIM_PUBLIC_BURST` | 40 | public-node short burst allowance |
| `ARBSIM_PUBLIC_DAILY_CAP` | 0 (no cap) | public-node requests per day |
| `ARBSIM_NODE_TIMEOUT_MS` | 8000 | time limit per node request |
| `ARBSIM_NODE_BATCH` | 25 | most calls per batched request |

**Sidecar**

| Setting | Default | What it does |
|---|---|---|
| `ARBSIM_SOCKET` | `/tmp/arbsim.sock` | socket path (the bot reads the same setting; keep them equal) |
| `ARBSIM_WORKERS` | 2 (1-16) | threads answering checks. Keep it at most the number of CPU cores (the live server has 2 vCPUs): more workers than cores only take turns on the same cores and do not make answers faster; the fast lane (`ARBSIM_PRIO_BURST`) is what lets entry work skip the line |
| `ARBSIM_PRIO_BURST` | 4 (0-64) | trigger-entry questions (`trig_entry`, `trig_discover`, entry checks marked `prio`) skip the line; after this many in a row one waiting normal question goes first (0 = one plain first-come line) |
| `ARBSIM_FEED_STORE_MSGS` | 2048 (0 = off) | speed-3 feed store: feed messages the bot hands over once (`feed_put`) and trigger-first questions then only name; oldest dropped first (~3.5 min). 0 = store off: the bot sees no store in `status` and sends messages inline with every question (old way). `status` → `feedStore` (held / handed over / named / missing) |
| `ARBSIM_MAX_STALE_MS` | 3000 | feed quiet longer than this = "stale" |
| `ARBSIM_WAIT_MS` | 30 | how long a check waits for the copy to catch up before "dirty" |
| `ARBSIM_HISTORY` | 64 | recent versions kept |
| `ARBSIM_MAX_PENDING` | 2000 | feed messages waiting to be replayed |
| `ARBSIM_VERIFY_EVERY_N_BLOCKS` | 20 | self-check vs node every N blocks... |
| `ARBSIM_VERIFY_MIN_INTERVAL_S` | 60 | ...but at most once per this many seconds |
| `ARBSIM_GAP_TRACE_MAX` | 8 | feed gaps up to this many blocks are filled from the node; bigger = restart the copy |
| `ARBSIM_GAP_WAIT_MS` | 1500 | wait for missing feed messages before looking them up |
| `ARBSIM_MAX_FILL_ROUNDS` | 12 | fetch rounds before giving up on a message |
| `ARBSIM_MAX_ACCOUNTS` | 50000 | memory cap: accounts |
| `ARBSIM_MAX_SLOTS` | 250000 | memory cap: storage values (copy 2: not counting our pools / coins, which are always kept) |
| `ARBSIM_COPY2_WALK_MAX_SLOTS` | 600000 | copy 2: most tick-walked values in total (~2x all ~800 pools) |
| `ARBSIM_COPY2_WALK_MAX_RSS_MB` | 300 (0 = off) | copy 2: no new tick walks while the program uses more memory than this |
| `ARBSIM_COPY2_WALK_FULL_WORDS` | 8000 (0 = off) | copy 2: a V4 pool's tick walk reads its WHOLE tick map when it has at most this many words (8000 = every tick spacing), so checks that run the price to its limit (thin pools, "ZeroAmount") are answered |
| `ARBSIM_COPY2_PM_BOUND` | 1 | copy 2: never hold the V4 PoolManager's coin / ETH balances (nobody reports them to us); checks that read them run at a proven lower bound and far above it and answer only when both agree. 0 = old behaviour (tests only: a stale balance) |
| `ARBSIM_COPY2_MAX_KEEP_LOGS` | 150000 | copy 2: most pool reports kept for slow loads (beyond the 10 minutes always kept) |
| `ARBSIM_COPY2_STATE_FILE` | `data/arbsim-copy2-state.bin` (set by the runner; `off` = never) | copy 2 warm restart: where the copy is saved and read back at start |
| `ARBSIM_COPY2_SAVE_S` | 60 | copy 2: save the copy every this many seconds (and always when pm2 stops it) |
| `ARBSIM_COPY2_RESUME_MAX_BLOCKS` | 18000 (~30 min; 0 = off) | copy 2: catch up at most this many blocks from the node's logs (after a restart, or when the bot missed blocks); more = normal full load / reload |
| `ARBSIM_COPY2_RESUME_OVERLAP_BLOCKS` | 64 | copy 2: blocks before the saved one whose reports are read again (late reports the copy may never have got) |
| `ARBSIM_COPY2_RESUME_RANGE` | 500 | copy 2: blocks per eth_getLogs request (halved by itself when the node says too big) |
| `ARBSIM_COPY2_RESUME_TIMEOUT_S` | 120 | copy 2: a catch-up without a complete answer for this long gives up (normal load / reload) |
| `ARBSIM_COPY2_DROP_GRACE_S` | 1800 (0 = off) | copy 2: a ready pool the bot stops listing stays resumable this long (the reports needed to bring it forward are kept past `ARBSIM_COPY2_MAX_KEEP_LOGS`), so listed again it comes back from its own reports instead of a full load. The bot reads the same line as its `COPY2_DROP_GRACE_S` fallback |
| `ARBSIM_COPY2_DROP_GRACE_MAX` | 400 | copy 2: most pools kept aside at once (the longest kept aside are given up first) |
| `ARBSIM_COPY2_DROP_GRACE_MAX_LOGS` | 400000 (~76 MB) | copy 2: hard cap on kept reports while pools are kept aside; past it the oldest go and those pools load normally if listed again |
| `ARBSIM_COPY2_SAVE_TIMEOUT_S` | 20 | copy 2: longest wait for the final save when pm2 stops the sidecar |
| `ARBSIM_IDLE_EVICT_S` | 21600 (6 h) | drop accounts unused this long |
| `ARBSIM_HEADER_EVERY_S` | 300 | block-header refresh |
| `ARBSIM_MAX_WARM` | 20000 | most "warm-up" items kept |
| `ARBSIM_PIN_TIMEOUT_MS` | 20000 | pinned (historical) check: time limit |
| `ARBSIM_PIN_ROUNDS` | 8 | pinned check: fetch rounds |
| `ARBSIM_PIN_CACHE` | 3 (1-8) | pinned blocks kept |
| `ARBSIM_L2_BLOCK_OFFSET` | 0 | block number = feed message number + this (Robinhood: 0) |
| `ARBSIM_ARBOS_VERSION` | built-in (ArbOS 61) | chain rules version |

Not read by `serve`: `ARBSYS_GAS` (only the `check-fixture` test tool), and
`CHAINSTACK_RPC_ROBINHOOD` is read by the program itself only as the fallback
for `ARBSIM_NODE_URL` (the runner already sets that).

Trigger-first speed (speed-3): every `trig_discover` / trigger-first `call`
answer now carries `ph` (microseconds per step: `read` socket JSON, `feedRead`,
`feedRefs`, `plan` (+ `planHash`, `decode`), `resolve` (+ `dirtyWait`), `prov`,
`facts`, `evm`, `moved`), `pn` (counts: bytes, msgs, txs, decode hits / misses,
runs, rounds, dirty waits) and `cpu` (the worker thread's CPU microseconds,
next to the wall time `us`: much lower CPU = waiting for a lock or a CPU).
`status` → `trigTiming` shows p50 / p90 / p99 / max per step over the last 1000
questions. Bot side: `TRIG_FIRST_FEED_STORE=0` switches the feed store off
(messages inline with every question, as before); the hourly `[trig-entry]`
line shows the sidecar split (`scCpu`, `scPlan`, `scEvm`, `scDirty`) and the
feed-store counters.

After changing any of these: `bash deploy/arbsim-pm2.sh restart`.

## 7. Files

| File | What |
|---|---|
| `.github/workflows/arbsim-binary.yml` | builds + tests + publishes to `arbsim-bin` (merges to main) |
| `.github/workflows/ci.yml` (job `sim`) | builds + tests `sim/` on every push / PR |
| `deploy/arbsim-update.sh` | install the right program (called by auto-deploy) |
| `deploy/arbsim-pm2.sh` | start / stop / ensure / status |
| `deploy/arbsim-run.sh` | what pm2 runs (reads the few `.env` lines, starts the program) |
| `deploy/arbsim-lib.sh` | shared helpers |
| `deploy/arbsim-status.js` | plain-English status |
| `bin/` (server only) | `arbsim`, `arbsim.prev`, their `.build_info`, `ARBSIM_PINNED` |
| `data/arbsim-copy2-state.bin` (server only) | copy 2's saved copy (warm restart); safe to delete (the next start loads normally) |
