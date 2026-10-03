# ArbExecutor (on-chain execution contract)

Executes one arbitrage round trip in a single transaction. If it doesn't end
with at least `minProfit` more of the starting token, **the whole transaction
reverts** and only gas is lost.

**Status: tested against mocks only. Not deployed. Not wired into the bot.**
The bot still runs in shadow mode. Nothing here can move real funds until the
checklist below is done.

## What it supports

| Pool type | `kind` | Venues |
|---|---|---|
| Uniswap V2 style | `0` | TraderJoe v1, Sushi, PancakeSwap V2, LFJ v1, Robinhood V2 |
| Solidly | `1` | Ramses V2 (stable + volatile) |
| V3 concentrated liquidity | `2` | Uniswap V3, PancakeSwap V3, Ramses V3 |

Not supported yet (reverts `UnsupportedKind`): LFJ Liquidity Book, Kuru orderbook, Uniswap V4.

Funding per trade:
- `flashPool = <Aave V3 Pool>`: flash loan (Avalanche). Must be allowlisted with `setFlashPool`.
- `flashPool = address(0)`: uses tokens already held by the contract (Robinhood, Monad).

## Roles

- **owner**: the wallet that deploys it. Fixed forever. Use a cold wallet. Sets the executor, allowlists Aave, withdraws.
- **executor**: the bot's hot wallet. Can only call `execute()`. Rotate it with `setExecutor` if the key may be leaked.

A stolen executor key cannot withdraw, and any route that would reduce any
token balance the route touches reverts (tested against fake pools and a fake
lender). Still, sweep profits to the owner regularly.

## Build and test

```bash
cd contracts
forge test -vv
```

## Go-live checklist (do NOT skip)

1. **Fork tests against real pools** on each chain (needs an RPC URL): one real
   pool of each kind you plan to use, confirming `token0` ordering, fee, and
   that the V3 callback name matches what that DEX actually calls.
2. **Ramses V3 callback name**: confirm on-chain. The contract accepts
   `uniswapV3SwapCallback`, `pancakeV3SwapCallback` and `ramsesV2SwapCallback`.
3. **Fee-on-transfer / rebasing tokens**: exclude them from routes.
4. **Aave on each chain**: confirm the Pool address and the current flash fee
   (the bot's cost model assumes 9 bps; Aave V3 is usually 5 bps).
5. **Independent review** of `src/ArbExecutor.sol` by someone other than its author.
6. Deploy from the **owner (cold) wallet** with the bot's hot wallet as executor.
   Allowlist Aave per chain. Fund own-capital chains with a small float only.
7. Wire `fireTransaction()` in each chain adapter to build `execute()` calldata,
   with `maxBlock` set to the current block + 1 and `minProfit` derived from
   `conservativeNetProfitUsd`.
8. Start with tiny size caps and watch Telegram before raising them.
