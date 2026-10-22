# Arbitrum / Robinhood notes for arbsim (workstream B)

Plain English summary of how Robinhood Chain (Arbitrum Nitro) differs from
plain Ethereum, and what arbsim does about it. Sources: OffchainLabs/nitro
master @ ccc5c828 (2026-08-28), OffchainLabs/go-ethereum master @ 260bc5dc.

## 1. The 21..3,217 gas gap at go/no-go #1: probably the L1 data fee

**Most likely cause (from the Nitro source; still to be confirmed on the server):**
the node's number includes Nitro's **L1 data fee, expressed as gas**. It is
not execution gas.

- Nitro's callTracer overwrites the top frame's `gasUsed` with the
  **receipt's** gasUsed (go-ethereum `eth/tracers/native/call.go` L237-249).
- The receipt gasUsed includes **poster gas**: the cost of posting the tx's
  bytes to Ethereum, divided by the L2 base fee and charged as gas before
  execution starts (nitro `arbos/tx_processor.go` L603-653, `GetPosterGas`
  L582-601). The receipt reports it separately as `gasUsedForL1`
  (`FillReceiptInfo` L1037-1044).
- Poster gas = `L1 price per unit x 16 x (brotli-compressed tx size) / L2 base fee`.
  It depends on how well that particular tx compresses and on the L1 price at
  that moment. That explains why the gap is different for every trade, often
  small (21, 27...), sometimes thousands, and why arbsim is always LOWER.
- **The 23 exact matches**: poster gas was 0. The fee is only charged when the
  L1 price estimate is above 0 and the result rounds to 1 gas or more. With a
  ~0.01 gwei L2 base fee and a cheap L1 price, many small txs round to 0.
  (Not proven yet: `gas-diff.js` prints `gasUsedForL1` per trade.)
- Ruled out from source: ArbSys gas (803, the same for all 50 txs, and every
  trade calls it first: `_blockNumber()` runs before anything else in
  `execute`/`executeWithV3Flash`), warm/cold rules (all precompiles start warm,
  the same as our setup), refunds (only the poster part is non-refundable),
  ArbOS storage pricing (only inside precompiles), GASPRICE/BASEFEE in V3/V4
  pools (not used).

**What it means for the bot (which node number to compare with):**
- `eth_simulateV1` (no `baseFeePerGas` override, the bot's replayRpc): the base fee
  is 0, so **no poster gas**. gasUsed = execution only = arbsim.
  (`internal/ethapi/simulate.go` L212-222 + `tx_processor.go` L627.)
- `eth_call` / `debug_traceCall` / `eth_estimateGas`: the real base fee is kept
  in `BaseFeeInBlock`, so Nitro **adds an estimated poster gas** (from a fake tx,
  padded +1%, `l1pricing.go` L603-616). Their gasUsed = arbsim + that estimate.
- `debug_traceTransaction` of a mined tx (our go/no-go fixtures): + the real
  poster gas = receipt `gasUsedForL1`.
arbsim reports execution gas. The L1 fee is a separate cost that the bot's
gas model adds.

**Confirm on the server:** `node tools/gas-diff.js` prints, per trade,
`node gasUsed`, `gasUsedForL1` and arbsim's number, and a summary line
`arbsim == node gasUsed-gasUsedForL1: N`. Expected result: 50/50.

## 2. Opcodes on Nitro

| Opcode | Nitro answer | arbsim |
|---|---|---|
| NUMBER | parent-chain (Ethereum) block number from ArbOS state = header `l1BlockNumber` (`core/vm/instructions.go` L478-486) | `BlockCtx.l1_block_number` |
| BLOCKHASH | hash of a **parent-chain** block, only the 256 below NUMBER, from ArbOS state (L432-466, `arbos/blockhash/blockhash.go`) | reads slot `1+(n%256)` of ArbOS state; missing slot = MISS |
| PREVRANDAO / DIFFICULTY | always **1** (header difficulty; `core/evm.go` L61-68). NOT mixHash (mixHash holds ArbOS info) | 1 in Arbitrum mode |
| TIMESTAMP, COINBASE, GASLIMIT | from the header; coinbase is normally `0xA4B0...73657175656e636572` (the batch poster); gas limit is always 2^50 | from BlockCtx |
| BASEFEE | block base fee; **0 in eth_call / debug_traceCall / eth_simulateV1 when gas price is 0** (`internal/ethapi/api.go` L782-786) | `block_env()` = mined; `block_env_ethcall()` = 0 |
| GASPRICE | the **base fee** (tips are dropped) unless the chain collects tips (ArbOS 60+ setting) (`arbos/tx_processor.go` L995-1035) | custom opcode |
| CHAINID | 4663 | 4663 |
| BLOBBASEFEE | **error** "not supported on Arbitrum" (`core/vm/eips.go` L293-296) | fails the frame |
| BLOBHASH | 0 (no blob txs) | revm default |

## 3. EVM version (spec) and ArbOS version

Nitro picks the Ethereum rule set from the ArbOS version, not from dates
(`params/config.go` L838-866): ArbOS >= 11 Shanghai, >= 20 Cancun,
**>= 40 Prague (EIP-7702)**, **>= 50 Osaka (CLZ opcode, P256 6,900 gas, new
modexp pricing)**. The EIP-7825 per-tx gas cap is skipped on Arbitrum, and the
EIP-7623 calldata floor applies only if the chain owner switched it on.

Robinhood mainnet launched 2026-07-01. The current releases were ArbOS 51 "Dia"
(Jan 2026) and then ArbOS 61 "Elara" (Aug 2026). I could NOT confirm Robinhood's
exact version from the sandbox (no RPC access). arbsim assumes **51** (Osaka
rules) and you can override it with env `ARBSIM_ARBOS_VERSION`. `gas-diff.js` prints the
real value (ArbOS state + header mixHash bytes 16..24). For our ArbExecutor
trades the spec doesn't change any numbers: all offline fixtures are exact
under ArbOS 32, 40, 51 and 61 rules.

Precompile set per version (`gethhook/geth-hook.go` L108-114): ArbOS 30-49 =
Cancun set + P256VERIFY (0x100, 3,450 gas), **no BLS**; ArbOS >= 50 = Osaka set
(BLS 0x0b-0x11, P256 6,900).

## 4. Nitro precompiles: gas and warmness

How Nitro charges for an ArbOS precompile method (`precompiles/precompile.go`
L727-866, `precompiles/context.go` L139-176, `arbos/storage/storage.go` L61):

1. Bad input, unknown method, method not active yet, a view method called via
   DELEGATECALL, a write in a static call, or value sent to a non-payable
   method all revert and burn **all** the gas supplied.
2. Opening ArbOS state (any non-pure method) = 1 storage read = **800**.
3. Arguments: **3 per 32-byte word**.
4. Each further ArbOS storage read: **800**.
5. Result: **3 per 32-byte word** (the same for a Solidity custom error).

| Method | Gas | Notes |
|---|---|---|
| ArbSys.arbBlockNumber() | **803** | returns the L2 block number |
| arbChainID / arbOSVersion / isTopLevelCall / wasMyCallersAddressAliased / getStorageGasAvailable | 803 | arbOSVersion = 55 + ArbOS version |
| mapL1SenderContractAddressToL2Alias(a,b) | 9 | pure: no ArbOS open |
| arbBlockHash(n) out of range | 800+3+9 | reverts InvalidBlockNumber(n, cur) |
| arbBlockHash(recent n) | unsupported | we keep no L2 block hashes |
| ArbGasInfo one-slot getters (getMinimumGasPrice, getL1BaseFeeEstimate, getGasBacklog, getMaxTxGasLimit, ...) | **1603** | reads the ArbOS slot from our state copy (a MISS if absent) |
| getGasAccountingParams | 2409 | 2 reads + 3 words |
| everything else (ArbRetryableTx, ArbOwner*, ArbWasm, NodeInterface 0xc8, myCallersAddressWithoutAliasing, sendTxToL1, getPricesInWei, getCurrentTxL1GasFees, ...) | **unsupported** | run aborts with "unsupported precompile 0x.. selector 0x..", flag readable via `ArbPrecompiles::unsupported()` |
| a call into a **Stylus (WASM) contract** (code starts EF F0 00) | unsupported | |

**Warmness:** Nitro puts every active precompile address (Ethereum and ArbOS)
in the access list at the start of the tx (`core/vm/contracts.go` L252-279 and
`core/state/statedb.go` L1585-1587). So `STATICCALL 0x64` costs 100 (warm) + 803.

## 5. Feed message to L2 block number

Each sequencer-feed message produces exactly one L2 block:
`block = sequenceNumber + genesisBlockNum` (`arbutil/block_message_relation.go`
L11-20). Orbit chains start at genesis 0, so on Robinhood **block = sequenceNumber**
(Arbitrum One is the exception: 22,207,817). Functions: `arb::l2_block_for_seq`
and `arb::seq_for_l2_block`. Runtime check: `gas-diff.js` prints
`genesisBlockNum` from ArbOS state. The feed also verifies itself: when a
feed message with `blockHash` arrives, compare it with
`eth_getBlockByNumber(seq + genesis).hash`. Block context for a replayed
message: NUMBER = the message header's `blockNumber` (L1) once it is above
the stored value; timestamp = max(header timestamp, parent timestamp);
coinbase = the poster; base fee = ArbOS L2 base fee (slot l2pricing offset 2).

## 6. The "-arbsys" offline fixture

Anvil used a Solidity stub at 0x64. Stub: 2600 (cold call) + 145 (stub code).
Nitro: 100 (warm) + 803. So arbsim is exactly **1,842 lower**, with identical
output (test `stub_offset_breakdown` replays the real stub bytecode and gets
anvil's number exactly).
