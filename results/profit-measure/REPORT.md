# Robinhood Chain arbitrage: how much money is there? (profit measure)

Window: 2026-10-22 20:34 UTC to 2026-10-23 20:34 UTC (24.0 h, blocks 95392255-96220748). Read-only, public node.

Swaps seen: 1,989,329 on 16779 pools. Multi-pool transactions: 174,255.
Receipts read: our-bot-shape (tier 1) 16794/16794 (100%), rest (tier 2) 133110/157461 (85%). "Est." numbers scale the sample up by coverage.
Arbitrage found: 59456 (trusted prices 11972, doubtful 35244, unpriced 12240). ETH ~$2,405.

## The money (trusted trades, after the gas they paid)

| Group | Trades seen | Kept after gas (seen) | Est. per day | Est. trades/day | Median | p90 | Max | >$0.25 | >$1 | >$5 | Median size |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all trusted | 11972 | $2,970 | $3,195 | 13250 | $0.01 | $0.08 | $385.60 | 693 | 289 | 56 | $53.33 |
| base coin profit | 8988 | $1,397 | $1,564 | 9833 | $0.01 | $0.09 | $373.31 | 487 | 197 | 33 | $52.41 |
| ours any route | 6198 | $863.17 | $932.07 | 6533 | $0.01 | $0.12 | $48.34 | 396 | 165 | 29 | $54.11 |
| ours 2pool same pair | 2665 | $225.61 | $225.64 | 2667 | $0.01 | $0.06 | $11.70 | 96 | 46 | 11 | $61.81 |

"ours" = every pool on an exchange our deployed contract can trade, profit taken in USDG or WETH. "2-pool same pair" = the bot's main route shape.

## Who takes it (routes on our exchanges, USDG/WETH profit)

| Bot contract | Trades | Kept (seen) | Est./day | Share | Median | Max |
| --- | --- | --- | --- | --- | --- | --- |
| 0x0005ea38..b5ef | 12 | $135.16 | $159.86 | 17% | $3.77 | $48.34 |
| 0x24a4d86c..0da7 | 70 | $96.43 | $113.96 | 12% | -$0.01 | $46.93 |
| 0x62fc8082..f4ca | 61 | $62.15 | $62.14 | 7% | $0.18 | $8.37 |
| 0x7ddbd395..114a | 299 | $56.63 | $58.38 | 6% | $0.07 | $6.87 |
| 0xaa41e6c3..2299 | 45 | $45.77 | $46.79 | 5% | $1.01 | $1.31 |
| 0x36dc95f1..2bc2 | 2 | $33.01 | $39.04 | 4% | $29.80 | $29.80 |
| 0xb92fe925..ff4f | 4 | $31.93 | $37.76 | 4% | $8.49 | $9.95 |
| 0xb0550000..77bd | 155 | $32.89 | $34.24 | 4% | $0.04 | $7.70 |
| 0x9c9f4ab6..09f8 | 20 | $28.62 | $28.62 | 3% | $0.69 | $6.76 |
| 0x01eef8bb..ce62 | 28 | $27.36 | $28.31 | 3% | $0.99 | $1.33 |
| 0x17970d75..f693 | 112 | $24.71 | $24.71 | 3% | $0.07 | $3.13 |
| 0xc9a1dcff..7144 | 231 | $21.40 | $24.43 | 3% | $0.06 | $1.44 |

## Who takes it (all USDG/WETH-profit arbitrage, any exchange)

| Bot contract | Trades | Kept (seen) | Est./day | Share |
| --- | --- | --- | --- | --- |
| 0x46174dfb..f998 | 26 | $385.94 | $456.50 | 29% |
| 0x0005ea38..b5ef | 13 | $137.05 | $162.11 | 10% |
| 0x24a4d86c..0da7 | 79 | $96.71 | $114.29 | 7% |
| 0x7ddbd395..114a | 373 | $80.63 | $86.77 | 6% |
| 0x62fc8082..f4ca | 61 | $62.15 | $62.14 | 4% |
| 0xaa41e6c3..2299 | 45 | $45.77 | $46.79 | 3% |
| 0xb0550000..77bd | 221 | $39.36 | $41.89 | 3% |
| 0x36dc95f1..2bc2 | 2 | $33.01 | $39.04 | 2% |
| 0xb92fe925..ff4f | 6 | $32.04 | $37.89 | 2% |
| 0x47aff0bd..f5a0 | 7 | $30.21 | $33.23 | 2% |
| 0x9c9f4ab6..09f8 | 21 | $28.75 | $28.77 | 2% |
| 0x01eef8bb..ce62 | 28 | $27.36 | $28.31 | 2% |

## Which pools carry the money (our exchanges)

| Pool | Exchange | Pair | Trades | Est./day | Swaps in window |
| --- | --- | --- | --- | --- | --- |
| 0x52e65b17..71ca | uniswap-v3 | WETH/USDG | 2370 | $228.42 | 159166 |
| 0x54f78839..ba32 | uniswap-v4 | WETH/USDG | 21 | $99.92 | 8331 |
| 0x896b693e..cf6e | uniswap-v4 | BOOMER/USDG | 10 | $99.02 | 1220 |
| 0x8b46119c..d3d8 | uniswap-v4 | WETH/LYRO | 4 | $96.86 | 358 |
| 0x10cc6bd3..26ba | uniswap-v3 | WETH/PONS | 99 | $95.72 | 1117 |
| 0x51b6ca77..57a5 | ramses-v3 | WETH/PONS | 125 | $78.08 | 6845 |
| 0x24107d15..379e | uniswap-v4 | WETH/USDG | 155 | $72.68 | 31911 |
| 0x9cc8c4f6..e55f | uniswap-v3 | WETH/VIRTUAL | 86 | $61.07 | 3046 |
| 0x9a537af9..b8fb | uniswap-v3 | ANTH/ANTHROPIC | 2 | $60.84 | 15 |
| 0xca5e2b20..f768 | uniswap-v4 | WETH/ANTHROPIC | 2 | $60.84 | 67 |
| 0xed50bdee..22ff | uniswap-v3 | WETH/PONS | 58 | $57.13 | 2559 |
| 0x1eb56966..cc73 | uniswap-v2 | VIRTUAL/LLL | 3 | $55.49 | 249 |
| 0x4a99b93a..756d | uniswap-v3 | WETH/HMY | 43 | $52.97 | 111 |
| 0x6a913ab1..f417 | up-cl | WETH/HMY | 43 | $52.97 | 94 |
| 0xdec74a2a..7185 | abyss-cl | WETH/ABYSS | 206 | $37.26 | 1400 |

## Pairs (our exchanges)

| Pair | Trades | Est./day |
| --- | --- | --- |
| WETH/USDG | 3175 | $443.35 |
| WETH/PONS | 268 | $100.25 |
| BOOMER/USDG | 10 | $99.02 |
| WETH/LYRO | 4 | $96.86 |
| WETH/VIRTUAL | 99 | $61.67 |
| ANTH/ANTHROPIC | 2 | $60.84 |
| WETH/ANTHROPIC | 2 | $60.84 |
| VIRTUAL/LLL | 3 | $55.49 |
| WETH/HMY | 43 | $52.97 |
| USDG/microduck | 113 | $41.84 |

## Route length / exchange mix (USDG/WETH profit, any exchange)

| Route | Trades | Est./day |
| --- | --- | --- |
| 3 pools | 1859 | $721.80 |
| 2 pools | 6456 | $717.21 |
| 4+ pools | 673 | $125.03 |

| Exchanges used | Trades | Est./day |
| --- | --- | --- |
| factory:0xc63d7338 + uniswap-v3 + uniswap-v4 | 45 | $443.52 |
| uniswap-v3 + uniswap-v4 | 595 | $186.93 |
| uniswap-v4 | 266 | $180.95 |
| uniswap-v3 | 1218 | $106.22 |
| ramses-v3 + uniswap-v3 | 400 | $100.95 |
| uniswap-v3 + up-cl | 272 | $97.99 |
| uniswap-v2 + uniswap-v3 + uniswap-v4 | 10 | $56.43 |
| factory:0xc63d7338 + uniswap-v3 | 440 | $52.95 |
| ramses-v3 + uniswap-v4 | 177 | $27.27 |
| abyss-cl + uniswap-v3 | 197 | $26.58 |

## Speed: when did the winner land after the trade that opened the gap?

One block is about 104 ms.

| Delay | Our exchanges | All (USDG/WETH profit) |
| --- | --- | --- |
| same block | 1206 | 1678 |
| +1 block | 1524 | 2323 |
| +2 blocks | 576 | 893 |
| +3..10 | 920 | 1240 |
| >10 blocks | 1686 | 2494 |
| no trade seen (within ~2000 blocks) | 286 | 360 |

| Bot | same block | +1 | +2 | +3..10 | >10 | none seen | median blocks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0x0005ea38..b5ef | 0 | 0 | 0 | 1 | 9 | 2 | 66 |
| 0x24a4d86c..0da7 | 0 | 1 | 3 | 26 | 34 | 6 | 14 |
| 0x62fc8082..f4ca | 43 | 4 | 2 | 1 | 9 | 2 | 0 |
| 0x7ddbd395..114a | 9 | 6 | 12 | 17 | 143 | 112 | 129 |
| 0xaa41e6c3..2299 | 0 | 0 | 0 | 12 | 32 | 1 | 16 |
| 0x36dc95f1..2bc2 | 0 | 0 | 0 | 0 | 2 | 0 | 284 |
| 0xb92fe925..ff4f | 0 | 0 | 0 | 0 | 4 | 0 | 584 |
| 0xb0550000..77bd | 66 | 52 | 15 | 10 | 12 | 0 | 1 |

| Position in block | Trades (our exchanges) |
| --- | --- |
| 4-10 | 2072 |
| 11+ | 2282 |
| 1 (first after system tx) | 716 |
| 2-3 | 1128 |

## Census: EVERY transaction in 7,312 recent blocks (0.21 h, incl. failed ones)

Transactions: 42,063, failed 9,481. Arbitrage: 621; trusted USDG/WETH profit kept $5.96 ($669.49/day pace).

| Contract | Txs | Failed | Fail rate | Arbs | Trusted kept | Gas paid | Gas on fails | Wallets |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0x037fced7..3d14 | 18 | 15 | 83% | 3 | $1.37 | $0.44 | $0.40 | 3 |
| 0x62fc8082..f4ca | 130 | 96 | 74% | 3 | $1.29 | $1.15 | $0.39 | 30 |
| 0xb0550000..77bd | 184 | 177 | 96% | 6 | $1.15 | $1.92 | $1.72 | 60 |
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
| 0xaa521f74..61ea | 49 | 38 | 78% | 5 | $0.02 | $0.87 | $0.61 | 3 |

## Our bot

Successful arbitrage by our executor in the window: 0 (none).
Sender nonce: 192 at the window end -> 205 at block 96339717 (= 13 transactions sent while this job ran).
In the census: 0 of our transactions, 0 succeeded, 0 were profitable arbitrage, 0 failed.

## Realistic share for us (per day)

Chances = trusted trades with net >= $0.25 on our exchanges. Win share X = fraction of those we win. Each lost race costs ~$0.03 gas. Size cap scales profit down linearly (a lower bound).

| Routes | Win share | Money | Chances/day | Our profit/day | Wins | Lost-race gas |
| --- | --- | --- | --- | --- | --- | --- |
| 2-pool same pair (today's main route) | 10% | $2000 own money | 96 | $15.47 | $18.06 | $2.59 |
| 2-pool same pair (today's main route) | 10% | no cap (flash loan) | 96 | $16.64 | $19.23 | $2.59 |
| 2-pool same pair (today's main route) | 25% | $2000 own money | 96 | $42.99 | $45.15 | $2.16 |
| 2-pool same pair (today's main route) | 25% | no cap (flash loan) | 96 | $45.92 | $48.08 | $2.16 |
| 2-pool same pair (today's main route) | 50% | $2000 own money | 96 | $88.87 | $90.31 | $1.44 |
| 2-pool same pair (today's main route) | 50% | no cap (flash loan) | 96 | $94.72 | $96.16 | $1.44 |
| 2-pool same pair (today's main route) | 100% | $2000 own money | 96 | $180.62 | $180.62 | $0.00 |
| 2-pool same pair (today's main route) | 100% | no cap (flash loan) | 96 | $192.33 | $192.33 | $0.00 |
| any route on our exchanges (incl. loops) | 10% | $2000 own money | 412 | $69.88 | $81.00 | $11.12 |
| any route on our exchanges (incl. loops) | 10% | no cap (flash loan) | 412 | $71.23 | $82.35 | $11.12 |
| any route on our exchanges (incl. loops) | 25% | $2000 own money | 412 | $193.24 | $202.51 | $9.27 |
| any route on our exchanges (incl. loops) | 25% | no cap (flash loan) | 412 | $196.61 | $205.87 | $9.27 |
| any route on our exchanges (incl. loops) | 50% | $2000 own money | 412 | $398.85 | $405.02 | $6.18 |
| any route on our exchanges (incl. loops) | 50% | no cap (flash loan) | 412 | $405.57 | $411.75 | $6.18 |
| any route on our exchanges (incl. loops) | 100% | $2000 own money | 412 | $810.05 | $810.05 | $0.00 |
| any route on our exchanges (incl. loops) | 100% | no cap (flash loan) | 412 | $823.49 | $823.49 | $0.00 |

## Caveats

- Arbitrage is detected from coin movements (bot ends with more of a coin and less of none). Exchanges whose swaps leave no known event are invisible; failed attempts are only visible in the census section.
- "Trusted" = all profit coins priced from a busy pool and profit under 5% of trade size. Doubtful/unpriced trades (mostly thin meme coins) are left out of the dollars.
- Per-day numbers scale the sampled receipts up by coverage and the window up to 24 h; time-of-day swings are not corrected.
- "Our exchanges" = uniswap-v2, pancakeswap-v2, ramses-v2, uniswap-v3, pancakeswap-v3, ramses-v3, uniswap-v4, giga-cl, up-cl, swaphood-v3, topaz-cl, raphael-cl, sushiswap-v3, abyss-cl (unhooked V4 only; Algebra and hooked V4 need a contract redeploy). The real watch list lives on the server and was not used.
- Node requests: 13098 HTTP (313258 calls), 429 answers 5753. Run took 254 min.
