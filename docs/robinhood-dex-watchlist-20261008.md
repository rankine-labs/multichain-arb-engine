# Robinhood Chain DEX discovery watchlist — 2026-10-08

## Sources and confidence
- Official Robinhood mainnet chain ID 4663, public RPC, Blockscout: https://docs.robinhood.com/chain/deploy-smart-contracts/
- 0x liquidity sources supported on Robinhood Chain as of 2026-07-31: https://docs.0x.org/changelog/2026/7/31
- DeFiLlama chain DEX volume rankings: https://defillama.com/dexs/chain/robinhood-chain
- Current bot's known factories (from `scripts/probe-rival-replay.ts`, branch `research-rival-replay`): Uniswap V3, PancakeSwap V3, Ramses V3, PancakeSwap V2, Ramses V2.
- **No protocol below has been mapped to one of the five unknown audit prefixes without a complete observed factory address.** 0x routing support is not proof of on-chain factory identity, profitable pairs, or that the bot can quote/execute that DEX.

## Track now — supported by bot's existing V2/V3 family or important incumbent
| DEX family | 0x source | Implementation | Priority |
| --- | --- | --- | --- |
| Uniswap V2 | Yes | Standard constant product; factory verify | P0 |
| Uniswap V3 | Yes | V3 with tick-crossing verification | P0 |
| Uniswap V4 | Yes | V4 pool manager, hooks, native ETH accounting | P0 research; NOT V2/V3 adapter |
| PancakeSwap V2 | Yes | Standard V2 with actual fee | P0 |
| PancakeSwap V3 | Yes | V3 tick math and fee tier | P0 |
| Ramses V3 | Yes | V3-like; verify exact fee/math | P0 |
| Ramses legacy Solidly | Yes | Stable/volatile pool variants; NOT generic V2 math | P0 research |
| Metric V1/V2 | Yes | Verify pool math/fee before quoting | P1 |
| RobinSwap V3 | Yes | Verify factory and tick math | P1 |
| SwapHood V2/V3 | Yes | Verify factories and pool fees | P1 |
| SushiSwap V3 | Yes | Verify deployment and tick math | P1 |
| Ekubo V3 / ve(3,3) | Yes | Specialized math, dedicated adapter | P1 |
| Giga CL / Classic | Yes | Verify CL vs constant product separately | P1 |
| Swaap V2 | Yes | Specialized pricing; dedicated adapter | P1 |

## Research lane — observe before adding execution
Alley (Catnip), Bags bonding curve, Baseline, Fermi, Flap, Hanji, Kaliber, Kipseli, LiquidCore, Pons V2 bonding curve, Ramses DLMM, SectorOne, Sheriff (Algebra), Up, UpCL, Virtuals. All listed in the 0x source catalog, but not all are ordinary two-token AMM pools. Never feed them to `computeAmountOut()` until adapter-specific behavior is proven.

DeFiLlama also reports Fables and Tessera V among Robinhood DEX volume leaders. These are **discovery candidates**, not automatically supported by 0x's July 31 list or by the bot.

## Five unknown factory prefixes from competitor audit
`0x16494a`, `0x1ac9db`, `0xece6ec`, `0x548186`, `0xaa5865`.
**Identity unresolved.** Six hex digits do not uniquely identify a factory. The existing `research-rival-replay` script computes `addrOf(fac)` but prints `slice(0,8)`; change its reporting to include the **entire address** and full pool and transaction hash. Do not change the production DEX registry until verified.

## Suggested implementation order
1. Instrument pool discovery to record `chainId, block, txHash, pool, factory, token0, token1, fee, poolType, swapTopic` (full 20-byte addresses).
2. Recover full factory addresses from rival pool addresses with `scripts/recover-rival-factories.js`; verify deployed code, source and factory creation events.
3. Rank venues by **real pair overlap**, pool depth *near current price*, volume, and recent competitor activity. Reject manipulated/unpriceable tokens.
4. Add monitoring/quotes only for standard verified V2/V3 pools first. Keep specialized models in a separate research lane.
5. Validate tick-crossing, native ETH, hook fees, and exact flash funding on real historical trades before enabling live execution.
6. Record 24h evidence: opportunity counts by DEX pair, expected net, simulation pass/fail, and missed competitors. Do not infer profitability from volume alone.

## Safety
Discovery is read-only. No paid RPC, contract deployment, production merge or trading authorized by this document.
