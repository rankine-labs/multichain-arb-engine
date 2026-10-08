# Robinhood Chain: DEX expansion investigation (2026-10-08)

Research only. Do not enable execution or add unknown pool types to the generic V2/V3 adapter.

## Market evidence (DeFiLlama snapshot; USD reported 24h DEX volume)
- Uniswap ~$819m
- Fables ~$90.5m
- Tessera V ~$25m
- RamsesX ~$21.5m
- Metric ~$16.5m
- up ~$11.9m
- Sushi ~$4.9m
- GIGA ~$4.5m
- ElfomoFi ~$4.2m
- Rialto ~$3.2m
- Arcus ~$3.8m
- Ekubo ~$1.9m
- PancakeSwap ~$0.75m
- Orvex ~$0.63m
- SwapHood ~$0.34m
Source: https://defillama.com/dexs/chain/robinhood-chain
Volume is NOT arb profitability. Distinguish spot pools from perp markets and aggregators; avoid double counting routed volume.

## Highest-priority new discovery targets
| Venue | Evidence | Pool math / integration work |
| --- | --- | --- |
| Fables | DeFiLlama reports ~$90m daily | Find canonical contracts, pool model, token overlap, recent swap receipts; **addresses not yet verified** |
| Tessera V | ~$25m daily | Verify whether spot AMM pools are accessible and model; **addresses not yet verified** |
| Metric V1/V2 | ~$16m daily; 0x explicitly routes both | Recover factories and model V1 vs V2 separately |
| GIGA CL | ~$4.5m GIGA combined daily; 0x routes Giga CL | Concentrated-liquidity adapter, tick crossing |
| GIGA Classic | 0x routes Giga Classic; GIGA UI shows stable and volatile variants | Identify stable invariant vs constant product, real fee and reserves |
| Ekubo V3 | Official chain 4663 marked live | **Singleton Core**, not per-pool factory. Discover pool keys/config and use Ekubo-specific quote, settlement and extension handling |
| Alandale V2/CL | 0x Aug 31: Velodrome V2 and Algebra CL | Stable/volatile and Algebra-specific adapter |
| BrownFi V3, Parity V3 | 0x Aug 31 added both | Verify V3-compatible factory, fee tier, tick crossing |
| SushiSwap V3, RobinSwap V3, SwapHood V2/V3 | 0x Jul 31 | Inspect factories and active peer pools |
| Fables, Tessera V, up, ElfomoFi, Rialto, Arcus, Orvex, Kittenswap | DeFiLlama activity | Classify as spot AMM, bonding curve, perp, aggregator or other before adding |

## Confirmed official Ekubo V3 Robinhood deployment
Source: https://docs.ekubo.org/reference/contracts/evm-v3/
- Chain ID 4663: live, original position/order managers.
- Core singleton: `0x00000000000014aA86C5d3c41765bb24e11bd701`
- CoreDataFetcher: `0xF68F25CA6C817733b7B15a42191AE72A34d56a2B`
- QuoteDataFetcher: `0x5a3F0F1dA4Ac0c4b937d5685f330704c8e8303f1`
- PriceFetcher: `0xFE0Aa09c1CC2bA299b3AaFA52716bE00f40F1D6d`
- Positions (original): `0x02D9876A21AF7545f8632C3af76eC90b5ad4b66D`
- Orders (original): `0x3325428adB409c239E88ca472F50b0efe00E98B4`
- MEVCapture extension: `0x5555fF9Ff2757500BF4EE020DcfD0210CFfa41Be`
- Oracle extension: `0x517E506700271AEa091b02f42756F5E174Af5230`
- TWAMM extension: `0xd47f1B1eDCfEaBb08F6eBd8FC337c27E636C75BA`
- Architecture: core holds all pools; pool config packs extension, fee and type. Types include concentrated liquidity, stableswap and full-range. Fees use uint64 fractions of 2^64; ETH can be address(0). Swaps use lock/callback/settlement; MEVCapture may add dynamic fees. Do NOT apply Uniswap V3 factory events or generic swap math.

## GIGA live pool evidence
GIGA UI: https://www.gigadex.org/pools/
- USDe/USDG CLAMM 0.01% displayed, and Classic Stable 0.30% listed.
- At time of page crawl, CLAMM had ~$208k TVL and ~$171k daily volume; classic stable listed near-zero TVL.
- This is a specific pair candidate to observe, NOT proof of profitable gaps.
- Official docs: https://docs.gigadex.app/
- **No canonical factory addresses established from these sources.** Require project docs or on-chain factory verification.

## 0x liquidity source evidence
July 31: https://docs.0x.org/changelog/2026/7/31
August 31: https://docs.0x.org/changelog
July list: Alley/Catnip, Bags, Baseline, Ekubo V3/ve33, Fermi, Flap, Giga CL/Classic, Hanji, Kaliber, Kipseli, LiquidCore, Metric V1/V2, Pancake V2/V3, Pons bonding curve, Ramses V3/DLMM/legacy, RobinSwap V3, SectorOne, Sheriff/Algebra, Sushi V3, Swaap V2, SwapHood V2/V3, Uniswap V2/V3/V4, Up/UpCL, Virtuals.
August additions: Alandale Velodrome V2, Alandale CL Algebra, BrownFi V3, Curve, ERC-4626 vaults, Parity V3.
Not all are standard AMMs. Aggregators and perps should NOT be mistaken for independent swap liquidity.

## Next concrete tasks for Claude
1. Emit full `txHash, poolAddress, factoryAddress` from `scripts/probe-rival-replay.ts` (its current output truncates unknown factories). Resolve original five prefixes only with full addresses and code.
2. Add a read-only, adapter-aware venue discovery registry (pool-manager, factory, pair or orderbook); do not mutate live router.
3. Check 24h actual swap counts and depth around price for the above venues; identify overlapping WETH/USDG, USDe/USDG and other verified blue-chip pairs.
4. Add quote replay tests for each pool model; use real historical receipts and block-state snapshots, compare predicted output to observed output and account for gas and loan fees.
5. Report counts by DEX pair, rejection reason, historical executable profit and simulation success rate before considering production enablement.

## Status
Ekubo canonical addresses **officially documented**. GIGA pool examples and broad source support documented. Fables/Metric/GIGA/Tessera factory addresses and five audit prefixes **not yet recovered**. No on-chain code verification or test run performed here.
