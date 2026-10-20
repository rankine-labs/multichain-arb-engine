# arbsim: in-bot simulator for Robinhood Chain (design, v1)

Plain English: a small Rust program ("sidecar") that runs next to the bot. It keeps
an in-memory copy of the chain state the bot cares about, keeps it current, and
runs our ArbExecutor contract on it in under 2 ms. The bot asks it questions over
a local socket instead of asking the node.

Go/no-go #1 (Oct 20): revm 43.0.3 = 50/50 exact answers on real trades,
0.5 ms median per check from Node on the server (see claude/InBot_GoNoGo1).

## Hard rules
- Correctness first. When the sidecar is not SURE its copy is complete and
  current for a question, it answers `unknown` (never a guess). The bot then
  uses the node check as today.
- Never holds keys, never sends transactions. It only READS from nodes.
- Small and gentle: server is a t3.small (2 vCPU, ~300 MB free RAM). Target
  < 80 MB RSS, idle CPU < 3%.
- Node URLs come from env vars, are never logged (log `endpointLabel`-style
  names only).

## State model (owner: A)
Three layers, newest wins:
1. **Base**: exact state as of confirmed block B, per account:
   `{ balance, nonce, code_hash, code, storage: map<slot, value> }` with an
   explicit "known" flag per item. Unknown != zero. A slot we never loaded is a
   MISS, not zero.
2. **Pending overlay**: changes made by replaying, locally, the sequencer feed
   messages after block B (each feed message = exactly one L2 block on Nitro).
   Versioned per message (persistent maps, e.g. `im`/`rpds`, or a
   per-message diff list) so a check can run "right after message N".
3. **Request overlay**: per check, never stored (state overrides from the bot,
   the trigger tx replay, and our own calls).

Base updates: per confirmed block, `debug_traceBlockByNumber(n, {tracer:
"prestateTracer", tracerConfig: {diffMode: true}})` on the paid node. Apply each
tx's `post` (and deletions: present in `pre`, absent in `post` = cleared) for
accounts we track. Strictly in order; a gap or a parent-hash mismatch = drop
the overlay and refetch (reorgs are not expected on an FCFS Orbit chain but must
not corrupt state).

Self-check (free accuracy signal): when block n's diff arrives, compare it with
what our own feed replay produced for message n on the tracked accounts.
Counters: `replay_match`, `replay_mismatch` (+ first few examples logged).

Filling misses: a check that touches an unknown item stops and returns
`unknown` + the list of missing (account, slot). The sidecar then fetches them
in the background (`eth_getStorageAt` / `eth_getCode` / `eth_getBalance` /
`eth_getTransactionCount` at block B, batched) so the next check is warm.
Late fills must be reconciled with diffs that arrived meanwhile (keep the last
~64 blocks of diffs; a fill fetched at block k gets blocks k+1..B re-applied).
Warm-up: the bot can send `warm` with a list of accounts (watched pools, their
tokens, our contract, routers); the sidecar also learns from every miss.

Memory bound: LRU on accounts not touched for 6 h, total cap configurable.

## Feed replay (owner: A)
The bot forwards each raw sequencer-feed websocket text frame (`feed` message)
untouched. The sidecar parses it (same format as src/chains/nitroFeed.ts:
header kind 3 = L2 message, l2Msg kinds 4 signed tx / 3 batch), recovers
senders, and replays every user tx of the message in order on the pending
overlay, using the message's header (timestamp, L1 block number) for the block
context (owner B provides the block-context builder). A tx that hits a MISS
cannot be replayed exactly: the overlay is marked `dirty` from that message on
(checks at/after it answer `unknown`) until the base catches up past it.
Expected: dirty is rare once warm, because almost all txs that touch our pools
go through a few routers.

## Robinhood / Arbitrum specifics (owner: B)
- NUMBER opcode = parent chain (L1) block; ArbSys(0x64).arbBlockNumber() = L2 block.
- Precompiles: 0x64 ArbSys (arbBlockNumber, arbChainID, ...), plus whatever
  else real txs touch (0x6c ArbGasInfo? 0x6e ArbRetryableTx? 0x6b ArbOwnerPublic?).
  Exact gas per Nitro source (github.com/OffchainLabs/nitro, precompiles/).
- Block env: timestamp, basefee, coinbase, gas limit, prevrandao/difficulty
  (Nitro: difficulty=1), chain id 4663, GASPRICE behaviour in eth_call.
- Explain the 27/50 gas mismatches seen at go/no-go #1 (21 to 3,217 gas).
- L1 data fee: not part of execution, the bot adds it separately (gas model).

## Checks (owner: C)
Pure function over a state view: run a list of calls in order, each on top of
the previous one's changes, with eth_call semantics (no nonce/balance/basefee
checks, gas price 0), geth-style state overrides (`code`, `balance`, `nonce`,
`state`, `stateDiff`). Returns per call: success, output (return or revert
data), gasUsed (tx-level like eth_simulateV1/callTracer), logs optional.
Size search: given an executor call template and a list or range of amounts,
find the most profitable amount (profit read from `InsufficientProfit(got,
wanted)` revert with minProfit = max). Budget: whole search < 5 ms.

## Socket protocol (owner: A server, C client)
Unix socket at `$ARBSIM_SOCKET` (default /tmp/arbsim.sock). Each message = 4-byte
big-endian length + UTF-8 JSON. Requests carry `id`; answers echo it. Requests
may be pipelined on one connection; answers may come back out of order.

Requests:
```
{ "id":1, "type":"feed", "frame":"<raw ws text>" }                         (no answer)
{ "id":2, "type":"warm", "accounts":["0x.."], "slots":{"0xacct":["0xslot"]} } -> {ok}
{ "id":3, "type":"call",
  "at": {"after":"head"} | {"afterSeq":123} | {"afterTx":"0xhash"} | {"block":"0x..."},
  "overrides": { "0xaddr": {"code":"0x..","balance":"0x..","nonce":"0x..","state":{..},"stateDiff":{..}} },
  "calls": [ {"from":"0x..","to":"0x..","data":"0x..","gas":"0x..","value":"0x0"} ],
  "rawTxs": ["0x02f8..."]          optional: signed txs to apply first (e.g. a trigger not yet in the feed)
}
 -> { "id":3, "ok":true, "at":{"block":"0x..","seq":123}, "results":[{"success":false,"output":"0x..","gasUsed":"0x.."}], "us":412 }
 -> { "id":3, "ok":false, "unknown":"miss" | "dirty" | "stale" | "not_ready", "missing":[{"account":"0x..","slot":"0x.."}], "us":90 }
{ "id":4, "type":"size_search", "at":..., "overrides":..., "rawTxs":..., "template":{"from","to","gas","data"},
  "amountOffset": 36, "amounts":["0x.."] | "range":{"lo":"0x..","hi":"0x..","steps":12} }
 -> { "id":4, "ok":true, "best":{"amount":"0x..","profit":"0x..","gasUsed":"0x.."}, "tried":[...], "us":3100 }
{ "id":5, "type":"status" } -> { head, baseBlock, overlayDepth, dirtyFrom, accounts, slots, rssMb, replay_match, replay_mismatch, misses, fills, ... }
```
`amountOffset`: byte offset of the amountIn word inside `data` (after the 4-byte
selector), so the sidecar can patch the size without ABI work.

## Bot side (owner: C client, integration later)
- `src/execution/localSim.ts`: sidecar client + an `Rpc`-compatible adapter that
  answers `eth_call` (with overrides) and `eth_simulateV1` (as used by
  `replayRpc`) from the sidecar, and returns a node-style error
  `{error:{message:"local sim unknown: <why>"}}` when the sidecar says unknown,
  so existing code (`simulateRoundTrip`) works unchanged and callers can fall
  back to the node.
- Everything behind `LOCAL_SIM=off|shadow|on` (default off). `shadow` = run both,
  log differences, decide with the node (practice). `on` only after go/no-go #2
  and Rudy's OK.

## Comparison harness (owner: D)
Replays many past blocks: for each, build the checks the bot would have run
(trigger-follow checks on watched pools + a sample of standing routes),
answer them with the node (eth_simulateV1 at the parent block with the
block's prefix txs, like `replayRpc`) and with arbsim (state loaded at the
same point), and report: same verdict %, same profit %, profit diff stats, gas
diff stats, unknown %, time per check. Writes a JSON + a plain table.

## Layout
```
sim/                     Rust crate "arbsim" (binary + lib)
  src/main.rs            CLI: serve | bench <fixture> | check-fixture <fixture>
  src/lib.rs
  src/proto.rs           message types (shared)
  src/server.rs          socket server            (A)
  src/node.rs            JSON-RPC client          (A)
  src/state/             base, overlay, view, fill, updater (A)
  src/feed/              frame parse, sender recovery, replay (A)
  src/arb/               precompiles, block env    (B)
  src/check/             run calls, overrides, size search (C)
  tests/                 fixture tests (fixtures/ = small JSON test files)
src/execution/localSim.ts  (C)
scripts/sim-compare/       (D)
```
