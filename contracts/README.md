# ArbExecutor (on-chain execution contract)

Executes one arbitrage round trip in a single transaction. If it doesn't end
with at least `minProfit` more of the starting token, **the whole transaction
reverts** and only gas is lost.

**Status: tested on mocks AND on real mainnet pools (fork tests). Not deployed.
Not wired to send transactions.** The bot still runs in shadow mode. It now
builds the exact `execute()` calldata for each qualifying opportunity as a
dry run and logs `[exec-dryrun]` lines, so you can see coverage before going live.

## What it supports

| Pool type | `kind` | Venues |
|---|---|---|
| Uniswap V2 style | `0` | TraderJoe v1, Sushi, PancakeSwap V2, LFJ v1, Robinhood V2 |
| Solidly | `1` | Ramses V2 (stable + volatile) |
| V3 concentrated liquidity | `2` | Uniswap V3, PancakeSwap V3, Ramses V3 |

Not supported yet (reverts `UnsupportedKind`): LFJ Liquidity Book, Kuru orderbook, Uniswap V4.

Funding per trade (the first two need **no money in the contract**):
- `executeWithV3Flash(t, lendPool)`: flash loan from any Uniswap/PancakeSwap/Ramses V3 pool that holds the token and isn't part of the trade. Fee = that pool's fee tier (often 0.05%). Works on Robinhood, Monad and Avalanche.
- `execute(t, aavePool)`: Aave V3 flash loan (Avalanche).
- `execute(t, address(0))`: uses tokens already held by the contract.

Every lender (V3 pool or Aave pool) must be allowlisted by the owner with `setFlashPool`.

## Roles

- **owner**: the wallet that deploys it. Fixed forever. Use a cold wallet. Sets the executor, allowlists Aave, withdraws.
- **executor**: the bot's hot wallet. Can only call `execute()`. Rotate it with `setExecutor` if the key may be leaked.

A stolen executor key cannot withdraw, and any route that would reduce any
token balance the route touches reverts (tested against fake pools and a fake
lender). Still, sweep profits to the owner regularly.

## Build and test

```bash
cd contracts
forge test -vv --no-match-path test/Fork.t.sol         # unit tests (mocks)

# Real pools (needs an RPC per chain; CI runs these with public RPCs):
FOUNDRY_PROFILE=fork forge test --match-contract AvalancheForkTest --fork-url $AVALANCHE_RPC_URL
FOUNDRY_PROFILE=fork forge test --match-contract MonadForkTest     --fork-url $MONAD_RPC_URL
FOUNDRY_PROFILE=fork forge test --match-contract RobinhoodForkTest --fork-url $ROBINHOOD_RPC_URL
```

## Verified on real pools (fork tests, all passing)

| Chain | Route | Proves |
|---|---|---|
| Avalanche | TraderJoe v1 -> Sushi, own capital | V2 swaps |
| Avalanche | same, Aave V3 flash loan | full borrow / trade / repay loop |
| Monad | Uniswap V3 -> PancakeSwap V3 | both V3 callback names |
| Monad | PancakeSwap V2 -> Uniswap V3 | V2 + V3 mixed |
| Robinhood | Ramses V2 -> Ramses V3 | Solidly swaps, Ramses V3 callback |
| Robinhood | Ramses V2 -> PancakeSwap V3 | Solidly + Pancake V3 |
| Robinhood | **V3 flash loan** + Ramses V2 -> PancakeSwap V3 | borrow from a real V3 pool, trade, repay |
| Monad | **V3 flash loan** + Uniswap V3 -> PancakeSwap V3 | same, on Monad |

Each passes only if every swap executed and the trade was then stopped by the
profit guard (pools were in balance) or was genuinely profitable.

## Go-live checklist

Done:
- [x] Unit tests incl. stolen-executor-key attacks
- [x] Fork tests against real pools on all three chains
- [x] Ramses V3 callback name confirmed (works on live pool)
- [x] Aave V3 Pool on Avalanche confirmed at `0x794a61358D6845594F94dc1DB02A252b5b4814aD`
- [x] Bot builds `execute()` calldata (dry run in shadow mode)
- [x] Free pre-trade simulation of the real contract on all 3 chains (`src/execution/simulator.ts`, `[sim]` log lines, hourly digest)

Still to do (needs you):
1. **Independent review** of `src/ArbExecutor.sol` by someone other than its author.
2. **Token decimals for Avalanche**: the bot's strict decimals table only covers
   Monad and Robinhood, so Avalanche dry runs report "unknown decimals" until
   WAVAX (18) and USDC (6) are added. Note that the pricing code currently
   defaults unknown tokens to 18, which is wrong for Avalanche USDC.
3. **Aave flash fee**: the bot's cost model assumes 9 bps; confirm the live fee.
4. **Fee-on-transfer / rebasing tokens**: keep them out of routes.
5. **Deploy** from the owner (cold) wallet with the bot's hot wallet as executor.
   Allowlist Aave on Avalanche. Fund own-capital chains with a small float only.
   Then set `ARB_EXECUTOR_<CHAIN>` (and `AAVE_POOL_AVALANCHE`) in the server `.env`.
6. **Live firing**: implement signing + sending in each adapter's
   `fireTransaction()` (currently placeholders), using `maxBlock = current + 1`.
7. Start with tiny size caps and watch Telegram before raising them.
