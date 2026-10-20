# Fixture format (shared by both engines)

One JSON file = one simulated contract call, plus everything the call touches.

```json
{
  "name": "offline-v3-v3-v2",
  "chainId": 4663,
  "block": {
    "number": "0x...",          // what BLOCK.NUMBER returns (on Arbitrum = parent-chain block)
    "timestamp": "0x...",
    "baseFee": "0x...",
    "coinbase": "0x...",
    "gasLimit": "0x...",
    "prevrandao": "0x...",
    "difficulty": "0x1"
  },
  "l2BlockNumber": "0x...",     // what ArbSys(0x64).arbBlockNumber() returns. null = no ArbSys (fall through).
  "tx": { "from": "0x...", "to": "0x...", "data": "0x...", "gas": "0x...", "value": "0x0", "gasPrice": "0x0" },
  "prestate": {
    "0xaddr": { "balance": "0x...", "nonce": 0, "code": "0x...", "storage": { "0xslot32": "0xval32" } }
  },
  "expected": {                 // from the reference node / anvil eth_call (debug_traceCall callTracer)
    "success": false,
    "output": "0x...",          // return data or revert data
    "gasUsed": "0x..."
  }
}
```

Rules for engines:
- Any account or slot NOT in `prestate` is empty / zero (prestateTracer lists everything the call touched).
- Precompile 0x64 (ArbSys): implement selector `0xa3b1b31d` arbBlockNumber() -> uint256 `l2BlockNumber`
  when `l2BlockNumber` is not null. Any other selector: revert. When null: address 0x64 is an empty account.
- EVM spec: Cancun rules (Robinhood Chain = Arbitrum Nitro, ArbOS w/ Cancun opcodes). PUSH0, MCOPY, TSTORE ok.
- No base-fee check, no nonce check, no balance check for gas (it's an eth_call). gasPrice 0.
- A run is correct when success, output and gasUsed equal `expected`.
  (gasUsed may differ by the intrinsic 21000 + calldata cost depending on how "gasUsed" is reported; report both
  raw execution gas and tx-level gas so we can see which one matches.)
