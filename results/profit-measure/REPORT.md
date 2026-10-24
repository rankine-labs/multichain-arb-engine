# Robinhood Chain arbitrage: how much money is there? (profit measure)

Window: 2026-10-22 20:34 UTC to 2026-10-23 20:34 UTC (24.0 h, blocks 95392255-96220748). Read-only, public node.

Swaps seen: 1,989,329 on 16779 pools. Multi-pool transactions: 174,255.
Receipts read: our-bot-shape (tier 1) 16794/16794 (100%), rest (tier 2) 133110/157461 (85%). "Est." numbers scale the sample up by coverage.
Arbitrage found: 59216 (trusted prices 15288, doubtful 31857, unpriced 12071). ETH ~$2,405.

## The money (trusted trades, after the gas they paid)

| Group | Trades seen | Kept after gas (seen) | Est. per day | Est. trades/day | Median | p90 | Max | >$0.25 | >$1 | >$5 | Median size |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all trusted | 15288 | $3,440 | $3,743 | 17140 | $0.01 | $0.08 | $385.60 | 839 | 346 | 81 | $62.15 |
| base coin profit | 11312 | $1,872 | $2,104 | 12555 | $0.01 | $0.09 | $373.31 | 612 | 245 | 55 | $60.21 |
| ours any route | 7846 | $1,248 | $1,366 | 8456 | $0.01 | $0.11 | $48.34 | 500 | 204 | 48 | $59.00 |
| ours 2pool same pair | 2750 | $284.54 | $284.57 | 2753 | $0.01 | $0.07 | $19.26 | 117 | 55 | 15 | $61.59 |
| ours any route REAL LOOPS | 3623 | $416.01 | $419.61 | 3677 | $0.01 | $0.10 | $29.12 | 215 | 78 | 19 | $41.96 |
| ours 2pool REAL LOOPS | 2236 | $225.10 | $225.11 | 2238 | $0.00 | $0.04 | $19.26 | 92 | 42 | 13 | $60.23 |
| base coin REAL LOOPS | 5274 | $912.83 | $1,007 | 5630 | $0.01 | $0.09 | $373.31 | 286 | 99 | 22 | $31.01 |

"ours" = every pool on an exchange our deployed contract can trade, profit taken in USDG or WETH. "2-pool same pair" = the bot's main route shape.

## Round-trip check (same coin in and out)

Trusted trades on our exchanges by shape: {"loop":3623,"sale":2767,"hidden":1441,"unknown":15}. Over $0.25: hidden 62 ($55.34/day), loop 215 ($372.34/day), sale 219 ($781.03/day), unknown 4 ($7.56/day). "sale" = one-way trade, "hidden" = a leg on an exchange we cannot read, "unknown" = hop amounts not readable.

## Who takes the REAL round trips (our exchanges)

| Bot contract | Trades | Kept (seen) | Est./day | Share | Median | Max |
| --- | --- | --- | --- | --- | --- | --- |
| rival A (0x103b52a6..) | 35 | $80.90 | $80.89 | 19% | $0.32 | $29.12 |
| 0x62fc8082..f4ca | 70 | $66.40 | $67.21 | 16% | $0.17 | $8.37 |
| 0x9c9f4ab6..09f8 | 25 | $29.43 | $29.57 | 7% | $0.46 | $6.76 |
| 0xb0550000..77bd | 99 | $27.12 | $27.28 | 7% | $0.03 | $7.70 |
| 0x17970d75..f693 | 123 | $26.19 | $26.57 | 6% | $0.07 | $3.13 |
| 0x636d3380..3d78 | 14 | $22.80 | $23.06 | 5% | $0.85 | $10.30 |
| 0xb4c42a6e..f8ca | 22 | $20.56 | $21.03 | 5% | $0.17 | $8.45 |
| 0x037fced7..3d14 | 7 | $20.08 | $20.08 | 5% | $2.89 | $8.47 |
| 0x87a98bdf..2eb5 | 24 | $12.42 | $12.44 | 3% | $0.08 | $7.92 |
| 0x8b738c62..4c87 | 768 | $12.02 | $12.02 | 3% | $0.01 | $1.63 |
| 0xbe40e23b..460b | 2 | $11.69 | $11.68 | 3% | $11.70 | $11.70 |
| 0x183e5518..d72f | 17 | $8.30 | $8.40 | 2% | $0.12 | $3.11 |

| Delay (real round trips >= $0.25, our exchanges) | Trades |
| --- | --- |
| same block | 126 |
| +1 block | 47 |
| +2 blocks | 9 |
| +3..10 | 11 |
| >10 blocks | 22 |
| none | 0 |

## Who takes it (routes on our exchanges, USDG/WETH profit, before round-trip check)

| Bot contract | Trades | Kept (seen) | Est./day | Share | Median | Max |
| --- | --- | --- | --- | --- | --- | --- |
| 0x24a4d86c..0da7 | 83 | $218.12 | $257.90 | 19% | -$0.01 | $48.05 |
| 0x0005ea38..b5ef | 17 | $168.04 | $198.76 | 15% | $3.77 | $48.34 |
| 0x7ddbd395..114a | 347 | $78.86 | $84.67 | 6% | $0.06 | $13.65 |
| rival A (0x103b52a6..) | 37 | $83.21 | $83.20 | 6% | $0.32 | $29.12 |
| 0x62fc8082..f4ca | 72 | $66.46 | $67.26 | 5% | $0.17 | $8.37 |
| 0xb92fe925..ff4f | 5 | $53.46 | $63.23 | 5% | $8.49 | $21.53 |
| 0xb0550000..77bd | 188 | $45.97 | $48.65 | 4% | $0.04 | $7.70 |
| 0xaa41e6c3..2299 | 45 | $45.77 | $46.79 | 3% | $1.01 | $1.31 |
| 0x36dc95f1..2bc2 | 2 | $33.01 | $39.04 | 3% | $29.80 | $29.80 |
| 0x9c9f4ab6..09f8 | 25 | $29.43 | $29.57 | 2% | $0.46 | $6.76 |
| 0x01eef8bb..ce62 | 28 | $27.36 | $28.31 | 2% | $0.99 | $1.33 |
| 0x17970d75..f693 | 128 | $26.37 | $26.75 | 2% | $0.07 | $3.13 |

## Who takes it (all USDG/WETH-profit arbitrage, any exchange)

| Bot contract | Trades | Kept (seen) | Est./day | Share |
| --- | --- | --- | --- | --- |
| 0x46174dfb..f998 | 26 | $385.94 | $456.50 | 22% |
| 0x24a4d86c..0da7 | 92 | $218.40 | $258.23 | 12% |
| 0x0005ea38..b5ef | 18 | $169.94 | $201.01 | 10% |
| 0x7ddbd395..114a | 446 | $120.48 | $133.90 | 6% |
| rival A (0x103b52a6..) | 40 | $83.64 | $83.70 | 4% |
| 0x62fc8082..f4ca | 72 | $66.46 | $67.26 | 3% |
| 0xb92fe925..ff4f | 7 | $53.57 | $63.36 | 3% |
| 0xb0550000..77bd | 283 | $57.06 | $61.76 | 3% |
| 0xaa41e6c3..2299 | 45 | $45.77 | $46.79 | 2% |
| 0x86b2a6ca..5315 | 1332 | $34.46 | $39.96 | 2% |
| 0x36dc95f1..2bc2 | 2 | $33.01 | $39.04 | 2% |
| 0x6e03e6b7..c96e | 1 | $30.22 | $35.75 | 2% |

## The two rivals that beat us

| Rival | Arbitrage seen (any price) | Trusted USDG/WETH | Kept (trusted) | Est./day | Median | Max | Same block / +1 / +2 | Wallets | Route lengths |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| rival A (0x103b52a6..) | 120 | 40 | $83.64 | $83.70 | $0.31 | $29.12 | 9 / 25 / 3 | 57 | {"2":41,"3":36,"4":39,"5":4} |
| rival B (0x9b5507bd..) | 3 | 0 | $0.00 | $0.00 | ? | ? | 0 / 0 / 0 | 1 | {"4":3} |

## Which pools carry the money (our exchanges)

| Pool | Exchange | Pair | Trades | Est./day | Swaps in window |
| --- | --- | --- | --- | --- | --- |
| 0x52e65b17..71ca | uniswap-v3 | WETH/USDG | 2455 | $315.59 | 159166 |
| 0x1649550a..7a2d | uniswap-v4 | WETH/TORCH | 10 | $157.49 | 2993 |
| 0x54f78839..ba32 | uniswap-v4 | WETH/USDG | 24 | $100.74 | 8331 |
| 0xfc54380c..361b | uniswap-v4 | TORCH/ODDS | 8 | $100.68 | 275 |
| 0x896b693e..cf6e | uniswap-v4 | BOOMER/USDG | 10 | $99.02 | 1220 |
| 0x8b46119c..d3d8 | uniswap-v4 | WETH/LYRO | 4 | $96.86 | 358 |
| 0x10cc6bd3..26ba | uniswap-v3 | WETH/PONS | 99 | $95.72 | 1117 |
| 0x24107d15..379e | uniswap-v4 | WETH/USDG | 224 | $84.04 | 31911 |
| 0x51b6ca77..57a5 | ramses-v3 | WETH/PONS | 137 | $81.73 | 6845 |
| 0x9cc8c4f6..e55f | uniswap-v3 | WETH/VIRTUAL | 88 | $76.49 | 3046 |
| 0x9a537af9..b8fb | uniswap-v3 | ANTH/ANTHROPIC | 2 | $60.84 | 15 |
| 0xca5e2b20..f768 | uniswap-v4 | WETH/ANTHROPIC | 2 | $60.84 | 67 |
| 0xed50bdee..22ff | uniswap-v3 | WETH/PONS | 64 | $58.78 | 2559 |
| 0xb94d8bf3..d7b8 | uniswap-v4 | TORCH/BURN | 1 | $56.83 | 11 |
| 0x1eb56966..cc73 | uniswap-v2 | VIRTUAL/LLL | 3 | $55.49 | 249 |

## Pairs (our exchanges)

| Pair | Trades | Est./day |
| --- | --- | --- |
| WETH/USDG | 3340 | $548.02 |
| WETH/TORCH | 10 | $157.49 |
| WETH/PONS | 287 | $105.52 |
| TORCH/ODDS | 8 | $100.68 |
| BOOMER/USDG | 10 | $99.02 |
| WETH/LYRO | 4 | $96.86 |
| WETH/VIRTUAL | 102 | $77.14 |
| ANTH/ANTHROPIC | 2 | $60.84 |
| WETH/ANTHROPIC | 2 | $60.84 |
| TORCH/BURN | 1 | $56.83 |

## Route length / exchange mix (USDG/WETH profit, any exchange)

| Route | Trades | Est./day |
| --- | --- | --- |
| 2 pools | 8053 | $1,036 |
| 3 pools | 2334 | $867.49 |
| 4+ pools | 925 | $199.86 |

| Exchanges used | Trades | Est./day |
| --- | --- | --- |
| factory:0xc63d7338 + uniswap-v3 + uniswap-v4 | 69 | $459.97 |
| uniswap-v4 | 925 | $353.71 |
| uniswap-v3 + uniswap-v4 | 848 | $282.57 |
| uniswap-v3 | 1215 | $107.28 |
| ramses-v3 + uniswap-v3 | 399 | $100.95 |
| uniswap-v3 + up-cl | 270 | $98.84 |
| uniswap-v2 + uniswap-v3 + uniswap-v4 | 14 | $70.37 |
| ramses-v3 + uniswap-v4 | 517 | $55.18 |
| factory:0xc63d7338 + uniswap-v3 | 440 | $52.95 |
| uniswap-v4 + up-cl | 195 | $43.65 |

## Speed: when did the winner land after the trade that opened the gap?

One block is about 104 ms.

| Delay | Our exchanges | Our exchanges, net >= $0.25 | All (USDG/WETH profit) |
| --- | --- | --- | --- |
| same block | 1364 | 163 | 1895 |
| +1 block | 1724 | 77 | 2593 |
| +2 blocks | 667 | 22 | 1040 |
| +3..10 | 1159 | 53 | 1560 |
| >10 blocks | 2582 | 174 | 3785 |
| no trade seen (within ~2000 blocks) | 350 | 11 | 439 |

| Bot | same block | +1 | +2 | +3..10 | >10 | none seen | median blocks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0x24a4d86c..0da7 | 2 | 1 | 3 | 26 | 40 | 11 | 16 |
| 0x0005ea38..b5ef | 0 | 0 | 0 | 1 | 14 | 2 | 66 |
| 0x7ddbd395..114a | 11 | 14 | 15 | 22 | 170 | 115 | 117 |
| rival A (0x103b52a6..) | 8 | 24 | 2 | 1 | 2 | 0 | 1 |
| 0x62fc8082..f4ca | 50 | 4 | 2 | 3 | 11 | 2 | 0 |
| 0xb92fe925..ff4f | 0 | 0 | 0 | 0 | 5 | 0 | 462 |
| 0xb0550000..77bd | 75 | 67 | 17 | 11 | 17 | 1 | 1 |
| 0xaa41e6c3..2299 | 0 | 0 | 0 | 12 | 32 | 1 | 16 |

| Position in block | Trades (our exchanges) |
| --- | --- |
| 4-10 | 2669 |
| 11+ | 2805 |
| 1 (first after system tx) | 896 |
| 2-3 | 1476 |

## Census: EVERY transaction in 7,312 recent blocks (0.21 h, incl. failed ones)

Transactions: 42,063, failed 9,481. Arbitrage: 621; trusted USDG/WETH profit kept $9.07 ($1,019/day pace).

| Contract | Txs | Failed | Fail rate | Arbs | Trusted kept | Gas paid | Gas on fails | Wallets |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0xb0550000..77bd | 184 | 177 | 96% | 6 | $3.63 | $1.92 | $1.72 | 60 |
| 0x037fced7..3d14 | 18 | 15 | 83% | 3 | $1.37 | $0.44 | $0.40 | 3 |
| 0x62fc8082..f4ca | 130 | 96 | 74% | 3 | $1.29 | $1.15 | $0.39 | 30 |
| 0x09b80dbe..2736 | 5 | 4 | 80% | 1 | $0.63 | $0.04 | $0.01 | 1 |
| 0x183e5518..d72f | 3 | 2 | 67% | 1 | $0.47 | $0.04 | $0.02 | 1 |
| 0xad5a9e0d..dd1d | 5 | 3 | 60% | 1 | $0.30 | $0.05 | $0.01 | 1 |
| 0x819f0485..eda9 | 17 | 0 | 0% | 2 | $0.27 | $0.15 | $0.00 | 17 |
| 0x86b2a6ca..5315 | 128 | 118 | 92% | 4 | $0.13 | $0.50 | $0.27 | 19 |
| 0x0019d4af..5485 | 258 | 6 | 2% | 1 | $0.09 | $2.20 | $0.08 | 85 |
| 0xda0757bd..1b0f | 164 | 152 | 93% | 11 | $0.05 | $0.74 | $0.46 | 64 |
| 0xfe2d8976..7405 | 191 | 167 | 87% | 20 | $0.05 | $0.64 | $0.34 | 20 |
| 0xe790e307..22a8 | 174 | 170 | 98% | 3 | $0.04 | $0.54 | $0.45 | 41 |
| 0x3e20e4b6..f831 | 53 | 3 | 6% | 22 | $0.03 | $0.82 | $0.01 | 1 |
| 0xae7077bb..8a8b | 3 | 1 | 33% | 1 | $0.03 | $0.03 | $0.00 | 1 |
| 0x2840f129..11fc | 243 | 1 | 0% | 34 | $0.02 | $1.58 | $0.02 | 16 |

## Our bot

Successful arbitrage by our executor in the window: 0 (none).
Sender nonce: 192 at the window end -> 205 at block 96339717 (= 13 transactions sent while this job ran).
In the census: 0 of our transactions, 0 succeeded, 0 were profitable arbitrage, 0 failed.

## Realistic share for us (per day)

Chances = trusted trades with net >= $0.25 on our exchanges. Win share X = fraction of those we win. Each lost race costs ~$0.03 gas. Size cap scales profit down linearly (a lower bound).

| Routes | Win share | Money | Chances/day | Our profit/day | Wins | Lost-race gas |
| --- | --- | --- | --- | --- | --- | --- |
| 2-pool same pair, real round trips | 10% | $2000 own money | 92 | $15.51 | $18.00 | $2.48 |
| 2-pool same pair, real round trips | 10% | no cap (flash loan) | 92 | $18.32 | $20.80 | $2.48 |
| 2-pool same pair, real round trips | 25% | $2000 own money | 92 | $42.93 | $45.00 | $2.07 |
| 2-pool same pair, real round trips | 25% | no cap (flash loan) | 92 | $49.94 | $52.01 | $2.07 |
| 2-pool same pair, real round trips | 50% | $2000 own money | 92 | $88.61 | $89.99 | $1.38 |
| 2-pool same pair, real round trips | 50% | no cap (flash loan) | 92 | $102.63 | $104.01 | $1.38 |
| 2-pool same pair, real round trips | 100% | $2000 own money | 92 | $179.99 | $179.99 | $0.00 |
| 2-pool same pair, real round trips | 100% | no cap (flash loan) | 92 | $208.02 | $208.02 | $0.00 |
| any route on our exchanges, real round trips | 10% | $2000 own money | 219 | $28.05 | $33.96 | $5.90 |
| any route on our exchanges, real round trips | 10% | no cap (flash loan) | 219 | $31.33 | $37.23 | $5.90 |
| any route on our exchanges, real round trips | 25% | $2000 own money | 219 | $79.98 | $84.89 | $4.92 |
| any route on our exchanges, real round trips | 25% | no cap (flash loan) | 219 | $88.17 | $93.09 | $4.92 |
| any route on our exchanges, real round trips | 50% | $2000 own money | 219 | $166.51 | $169.79 | $3.28 |
| any route on our exchanges, real round trips | 50% | no cap (flash loan) | 219 | $182.89 | $186.17 | $3.28 |
| any route on our exchanges, real round trips | 100% | $2000 own money | 219 | $339.58 | $339.58 | $0.00 |
| any route on our exchanges, real round trips | 100% | no cap (flash loan) | 219 | $372.34 | $372.34 | $0.00 |
| any route on our exchanges (before round-trip check) | 10% | $2000 own money | 528 | $103.66 | $117.91 | $14.24 |
| any route on our exchanges (before round-trip check) | 10% | no cap (flash loan) | 528 | $107.38 | $121.63 | $14.24 |
| any route on our exchanges (before round-trip check) | 25% | $2000 own money | 528 | $282.90 | $294.77 | $11.87 |
| any route on our exchanges (before round-trip check) | 25% | no cap (flash loan) | 528 | $292.20 | $304.07 | $11.87 |
| any route on our exchanges (before round-trip check) | 50% | $2000 own money | 528 | $581.62 | $589.54 | $7.91 |
| any route on our exchanges (before round-trip check) | 50% | no cap (flash loan) | 528 | $600.22 | $608.13 | $7.91 |
| any route on our exchanges (before round-trip check) | 100% | $2000 own money | 528 | $1,179 | $1,179 | $0.00 |
| any route on our exchanges (before round-trip check) | 100% | no cap (flash loan) | 528 | $1,216 | $1,216 | $0.00 |

## Caveats

- Arbitrage is detected from coin movements (bot ends with more of a coin and less of none). Exchanges whose swaps leave no known event are invisible; failed attempts are only visible in the census section.
- "Trusted" = all profit coins priced from a busy pool and profit under 5% of trade size. Doubtful/unpriced trades (mostly thin meme coins) are left out of the dollars.
- Per-day numbers scale the sampled receipts up by coverage and the window up to 24 h; time-of-day swings are not corrected.
- "Our exchanges" = uniswap-v2, pancakeswap-v2, ramses-v2, uniswap-v3, pancakeswap-v3, ramses-v3, uniswap-v4, giga-cl, up-cl, swaphood-v3, topaz-cl, raphael-cl, sushiswap-v3, abyss-cl (unhooked V4 only; Algebra and hooked V4 need a contract redeploy). The real watch list lives on the server and was not used.
- Node requests: 13098 HTTP (313258 calls), 429 answers 5753. Run took 254 min.
