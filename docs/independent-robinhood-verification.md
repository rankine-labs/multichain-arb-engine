# Independent Robinhood verification — evidence and remaining inputs

This branch is **research-only**. Do not merge or deploy it as an execution change.

## Implemented
- `src/test/robinhoodProfitRegression.test.ts`: deterministic assertions for fee accounting, flash-loan vs own-capital costs, negative profit safety margins, $20 threshold, fixed gas sizing, and same-tick V3 sanity.
- `scripts/verify-unknown-dexes.js`: read-only code/selector probe for complete candidate factory addresses.
- `.github/workflows/independent-robinhood-regression.yml`: CI definition to run `npm test` without deployment.

## Evidence boundary
The regression fixtures are **synthetic** and do not establish that a historical competitor trade could have been won. V3 tests only cover same-tick approximations, **not** tick crossing or V4 hooks/native ETH flows. This branch cannot establish actual profit from simulated values.

## Unidentified factories from October 8 rival audit
| Observed prefix | Exact 20-byte factory address | Protocol | Verified |
| --- | --- | --- | --- |
| `0x16494a` | Missing | Unknown | No |
| `0x1ac9db` | Missing | Unknown | No |
| `0xece6ec` | Missing | Unknown | No |
| `0x548186` | Missing | Unknown | No |
| `0xaa5865` | Missing | Unknown | No |

Six hex characters are insufficient to uniquely identify a contract. **Never** insert a guessed address into the live registry. Request full addresses and source transaction hashes from the rival trace. For each candidate: verify contract bytecode on Robinhood, factory ownership/protocol, pool creation events, fee/tick model, token ordering, pool depth and historical swap outputs.

Run:
```bash
ROBINHOOD_RPC_URL='https://YOUR_READ_ONLY_RPC' node scripts/verify-unknown-dexes.js 0xFULL_ADDRESS ...
npm test
```

The verifier does not claim a protocol identity based solely on matching function selectors. Any output remains `UNVERIFIED` pending independent source and on-chain cross-checks.

## Completion criteria
1. `npm test` exits 0 in a reproducible environment (and any test failures investigated).
2. At least one historical replay fixture includes a **complete transaction hash**, block, pool addresses, token decimals, observed balance deltas, gas used, and outcome.
3. All five factory candidates have full addresses and independently corroborated identities, or are explicitly recorded as unresolved (not integrated).
4. Claude's branch is reviewed for conflicts before merge.

## Current constraints
- The connected GitHub interface can read and commit, but does not itself execute npm tests.
- No CI runs/statuses were returned when checked on the research branch.
- Historical replay logs and full factory addresses were not provided to this branch.

Do not report tests as passing or unknown DEXs as identified until there is evidence.

## External research (2026-10-08)
- Robinhood official network documentation identifies mainnet as chain ID 4663 and Blockscout as its explorer: https://docs.robinhood.com/chain/connecting/
- 0x's July 31, 2026 changelog lists many supported Robinhood DEX families, including Ekubo, Giga, RobinSwap, SwapHood, Swaap, SushiSwap and Uniswap variants: https://docs.0x.org/changelog/2026/7/31 . **This is a discovery list, not proof any family matches an unknown prefix.**
- Public verified-contract directory: https://www.hoodexplorer.org/contractsearch . Use independently of factory() checks.
- Added `scripts/recover-rival-factories.js` to recover complete factory addresses from full rival pool contract addresses. Usage:
  ```bash
  ROBINHOOD_RPC_URL=https://YOUR_RPC node scripts/recover-rival-factories.js 0xFULL_POOL_ADDRESS ...
  ```
- The rival replay source `scripts/probe-rival-replay.ts` on branch `research-rival-replay` already calls `factory()` for each non-V4 pool, but truncates unknown factory addresses in human-readable output. The most reliable fix is to emit **full** addresses (plus pool and transaction hashes) directly from that replay or pass its pool addresses to the new recovery script.
- Without complete observed pool addresses, there is no defensible mapping of the five abbreviated factory prefixes to named DEXs. None has been added to execution routing.
