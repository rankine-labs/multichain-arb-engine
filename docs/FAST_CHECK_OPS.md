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
150 MB memory, crash restarts wait longer each time (1 s up to 15 s), log
lines timestamped, logs rotated by pm2-logrotate. After a server reboot it
comes back by itself within 2 minutes (auto-deploy), no `pm2 save` needed.

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
   - memory near 150 MB, or `pm2 status` showing many restarts
   - "Paid node use today" near its cap, or "refused"
   - "NOT READY" for more than a few minutes while the bot is running

## 6. Settings (all optional; put them in `.env`)

`deploy/arbsim-run.sh` (what pm2 starts) reads ONLY these lines from `.env`
and nothing else. Node links are never printed, and never stored in pm2.

**Node links**

| Setting | Default | What it does |
|---|---|---|
| `ARBSIM_NODE_URL` | value of `CHAINSTACK_RPC_ROBINHOOD` | paid node 1 |
| `ARBSIM_NODE_URL_2` | value of `QUICKNODE_RPC_ROBINHOOD` | paid node 2 (backup) |
| `ARBSIM_PUBLIC_URL` | `https://rpc.mainnet.chain.robinhood.com` | free public node (most plain reads); `off` = don't use |

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
| `ARBSIM_WORKERS` | 2 (1-16) | threads answering checks |
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
| `ARBSIM_MAX_SLOTS` | 250000 | memory cap: storage values |
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
