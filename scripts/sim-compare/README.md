# sim-compare: does arbsim give the same answers as the node? (go/no-go #2)

**Plain English:** the bot checks every possible trade by asking the node ("if our
contract ran this round trip right now, what would it make?"). arbsim is meant to
answer the same question in under 2 ms instead of ~100 ms. This tool replays
thousands of past blocks and asks both of them the exact same questions the bot
would have asked. It then reports how often they agree, to the last unit.

It is **read only**: it never signs or sends anything. From the bot's `.env` it
reads **only** the node URL lines (`SIM_RPC_ROBINHOOD`, `QUICKNODE_RPC_ROBINHOOD`,
`ROBINHOOD_RPC_HTTP`, in that order) and never prints a URL.

## How the match rate is counted (printed at the top of every report)

> MATCH RATE = checks where the fast engine gave the SAME success flag and
> BYTE-IDENTICAL output as the node (same verdict, same exact profit or same exact
> error), divided by ALL checks the node answered. "Fast unknown" and "not
> answered" count as NOT matching. Checks the node itself could not answer are
> left out and counted separately. Gas is reported separately and is not part of
> the match rate.

So an engine can't look good by saying "not sure" on the hard ones. The report
also shows coverage (how often the fast side answered) and the exact rate among
the checks it did answer.

## What gets checked

1. **Follow-a-trade checks.** Every transaction in the range that traded on a pool
   the bot watches. Trades are found from the pools' own events (Swap/Sync), read
   with the bot's own event parser (`core/blockReader.ts`). For each trade, the
   tool builds round trips between that pool and every other watched pool of the
   same pair, in both directions. Like the bot, it replays the trade's block up to
   and including that trade on the block before (`eth_simulateV1`, via the bot's
   own `replayRpc`), then runs our trade.
2. **Standing-gap checks.** Every 20th block, a repeatable random sample of 4
   routes, tested on the state at the start of that block (plain `eth_call`, like
   the bot).

The request itself is **not rebuilt** by this tool. It runs the bot's own
`simulateRoundTrip` and catches the call it is about to send: calldata from
`buildExecuteCall`, the own-money balance-slot override, the flash-loan
allowlist, V4 settings and the contract code. The tests prove the stored request
is byte-identical to what the bot sends.

Simplified on purpose (also printed in the report):
- **Sizes:** a fixed list per start coin (USDG 100/1000/5000, WETH 0.03/0.3/1.5;
  change with `--sizes-usdg` / `--sizes-weth`), not the bot's per-trade size
  search. Agreement doesn't depend on which size is picked.
- **Funding:** every route is checked with own money. One size per route is also
  checked as a flash loan (the bot's `pickV3Lender`), so both contract entry
  points get tested.
- **Pairs:** pairs with neither USDG nor WETH are skipped (the bot can't start
  there). Pools the contract can't trade, or venues that aren't
  practice-tested, are left out exactly as the bot leaves them out.
- **Coverage:** trades are taken from events, so the run also includes trades
  the bot's feed decoder would not have read. The report splits them out ("bot
  decoder reads it" vs "seen in events only").

## The fast side (`--engine`)

| engine | what it tests | needs |
|---|---|---|
| `arbsim` (default) | the whole thing: arbsim's own copy of the chain + its engine | arbsim running with the **pinned** request below |
| `fixture` | engine accuracy ONLY. The node supplies the exact state the check touches (`prestateTracer`), and `arbsim check-fixture` runs on that file | `sim/target/release/arbsim` with `check-fixture` (worker C) |
| `echo` | **FAKE**. Copies the node's answer, as a pipeline dry run (must show 100%) | nothing |

Fixture mode reports two numbers separately: *engine vs exact touched state*
(engine accuracy alone) and *exact-state trace vs the node's replay* (whether
the fixture's state equals what the bot's check saw). The fixture files of
mismatches are kept in `fixtures/` for worker C.

### What arbsim needs: the "pinned" request (for workers A and C)

The live mirror follows the chain head, so past blocks need one addition to the
`call` request in `sim/DESIGN.md`:

```json
{ "id": 7, "type": "call",
  "at": { "pinned": "0x<block N>", "env": "next" },
  "overrides": { "...": "same as today" },
  "blockOverrides": { "time": "0x<real block N+1 time>", "gasLimit": "0x77359400" },
  "validation": false,
  "calls": [ "<replayed user txs of block N+1, up to and including the trade>", "<our call>" ] }
```

- `pinned: N` = run on the exact state at the **end of block N**. Every account
  and slot arbsim needs is filled from the node **at block N** (batched
  `eth_getStorageAt` / `eth_getCode` / `eth_getBalance` / `eth_getTransactionCount`
  with that block number). arbsim **waits for the fill** instead of answering
  `miss`. Filled state is kept per pinned block (a small LRU, 2-4 blocks), so
  the ~6-20 checks on one block share it.
- `env: "next"` (follow-a-trade) = the calls run in a new block N+1, exactly like
  `eth_simulateV1` on N: block number N+1, time and gas limit from
  `blockOverrides`, Arbitrum L1 block number of the real block N+1. `env: "same"`
  (standing gap) = run in block N's own context, exactly like `eth_call` at N.
- `validation: false` = no nonce or fee checks (the replayed trades are other
  people's transactions).
- The answer is the same as today's `call` answer: `results` has **one entry per
  call**, in order. The harness compares the replayed trades' success flags too
  (a difference there means the state before our trade already differed). `unknown`
  is still allowed, but it counts against the match rate.
- The harness reads the `fills` counter from `status` before and after a run, to
  report arbsim's own node use.

`check-fixture <file>` output the harness reads (first that fits):
`{"success":bool,"output":"0x..","gasUsed":"0x.."}`, the same under `"result"`,
or the revm bench report shape (`correctness.success.revm`, ...).

## Run it on the server

```bash
cd ~/multichain-arb-engine
npm install                                    # only if node_modules is missing
npx tsc -p scripts/sim-compare/tsconfig.json   # build (about 5 s)

# Shortcut used below: lowest CPU priority, small memory
SC="nice -n 19 node --max-old-space-size=64 --max-semi-space-size=2 .scripts-build/scripts/sim-compare/main.js"

# 1. Plan: counts the real trades in the range, prints the request count and
#    time, and checks how far back the node still has state (needs about 15 requests).
$SC plan --last 2000 --rps 2

# 2. Collect + node answers (the slow part, about 10-20 min for 2,000 blocks at 2 req/s)
$SC collect --last 2000 --rps 2
$SC node --out data/sim-compare/<from>-<to> --rps 2

# 3a. Pipeline dry run with the FAKE engine (must say 100%)
$SC fast   --out data/sim-compare/<from>-<to> --engine echo
$SC report --out data/sim-compare/<from>-<to> --engine echo

# 3b. Engine accuracy, as soon as `arbsim check-fixture` exists (3 node requests per check)
$SC fast   --out data/sim-compare/<from>-<to> --engine fixture --rps 2
$SC report --out data/sim-compare/<from>-<to> --engine fixture

# 3c. The real thing, once arbsim serves the pinned request (arbsim makes its own node requests)
$SC fast   --out data/sim-compare/<from>-<to> --engine arbsim --socket /tmp/arbsim.sock
$SC report --out data/sim-compare/<from>-<to> --engine arbsim
```

Or all steps in one: `$SC all --last 2000 --rps 2 --engine echo`.

- **Ctrl-C** stops cleanly after the checks in flight. Run the same command again,
  or add `--resume`, to continue. Every answer is saved the moment it arrives,
  and the node is never asked the same check twice. "Slow down" answers are not
  saved, so they are retried next time.
- A progress line every 30 s: done/total, errors, requests per second, time left.
- Results: `data/sim-compare/<from>-<to>/report[-fixture|-FAKE].txt` (plain
  English) and `.json`. The 20 worst mismatches each get
  `repro/<id>.json`, a ready-to-send node request (the contract code is
  already expanded) plus the check itself.

Main options: `--from/--to` or `--last N`, `--max-cases 20000`,
`--routes-per-trade 6`, `--trade-share 0.2` (follow 1 in 5 trades, the same pick
every run, to spread `--max-cases` over a longer range), `--standing-every 20`,
`--standing-routes 4`, `--rps 5`, `--concurrency 2`, `--max-requests 30000` (a
hard cap for this run), `--node QUICKNODE_RPC_ROBINHOOD` (pick one node setting),
`--pools <file>`.

### Cost for 2,000 blocks (about 4 minutes of chain time at ~0.11 s per block)

Node requests ≈ `blocks/500` (logs) + `blocks with a watched-pool trade` (one
block read each) + `1 per check` + a few balance-slot lookups (once per coin,
saved). With the defaults (6 routes per trade, standing sample every 20 blocks
× 4):

| watched-pool trades in range | checks | node requests | time at 2 req/s | at 5 req/s |
|---|---|---|---|---|
| 200 | ~1,600 | ~1,800 | ~15 min | ~6 min |
| 500 | ~3,400 | ~3,900 | ~33 min | ~13 min |
| 1,000 | ~6,400 | ~7,400 | ~62 min | ~25 min |

Fixture mode adds about 2 requests per check, plus 1 per block that has a trade.
`plan` gives the real numbers for the actual range before anything heavy runs.
Memory measured with 17,700 checks: about 130 MB peak RSS (with the flags above).
Disk: about 3 KB per check.

## Risks / things to know

- **Node history depth.** Every check needs the state of a past block. A full
  (non-archive) Nitro node only keeps recent state and answers older blocks with
  "missing trie node". The bot already handles this (`STATE_GONE`, and its
  fallbacks to "end of trigger block" and then "tested late"). Such checks are
  counted as *node errors*: left out of the match rate and listed in the report.
  How far back the node goes is unknown until `plan` measures it.
  Expectations: QuickNode-style paid endpoints are usually archive (no limit);
  a pruned full node is safe for about the last 128 blocks (~14 s) and beyond
  that only as far as its saved snapshots allow. If `plan` shows shallow
  history, run small ranges close to the head (`--last 100`) repeatedly.
- **Sharing the node with the live bot.** The harness has its own speed limit
  (`--rps`), and also goes through the bot's per-node budget (`nodeBudget.ts`). It
  stops at start if the bot has nearly used up the node's daily allowance. But
  the bot's own requests in the same second are not visible to it. On QuickNode
  (4 req/s, 14,000 a day for the bot), use `--rps 2` and `--max-requests 5000`,
  or a separate node in `SIM_RPC_ROBINHOOD`.
- **eth_simulateV1 vs a single debug_traceCall.** Fixture mode builds the "after
  the trade" state from `debug_traceBlockByNumber` diffs applied as overrides.
  Any difference between that and the node's real replay shows up in the
  separate "exact-state trace vs node replay" line, so it never hides inside the
  engine number.
- **Gas** is only compared on follow-a-trade checks. The bot's plain `eth_call`
  for standing gaps returns no gas.
- **Contract code changes.** Each check records a hash of the bot's
  `ARB_EXECUTOR_RUNTIME_CODE`. If that code changes after collecting, the harness
  refuses to use the old checks (collect again into a new folder).
- **Watch list = today's.** The run uses `data/watched-pools.json` as it is now.
  For a recent range that is close to what the bot watched then. Pools added
  later are included too, which only adds checks.

## Files

```
scripts/sim-compare/
  main.ts         command line (plan / collect / node / fast / report / all)
  collect.ts      step 1: trades from events, routes, captured requests -> cases.jsonl, blocks/
  pools.ts        watch list, start coin, routes and sizes (bot's buildExecuteCall / pickV3Lender)
  nodeCheck.ts    step 2a: node answers via the bot's replayRpc / eth_call -> node.jsonl
  engines.ts      step 2b: FastEngine interface; arbsim socket client; fixture mode; fakes
  compare.ts      verdicts (bot rules), grouping, totals, worst list
  pipeline.ts     streaming runs (concurrency, resume, progress), report.json / report.txt
  util.ts         files, node access (.env URL lines only), speed limit, request cap
  types.ts        shared shapes
  test/           fake node with recorded-style answers + 89 tests
  tsconfig.json   builds only these files and the bot code they use
```

Tests: `npx tsc -p scripts/sim-compare/tsconfig.json && node .scripts-build/scripts/sim-compare/test/simCompare.test.js`
(89 PASS lines; any FAIL exits non-zero). `npm test` covers `src/test/` only and
still passes. To make it run these tests too, the owner of `package.json` can
add the line above to the `test` script.
