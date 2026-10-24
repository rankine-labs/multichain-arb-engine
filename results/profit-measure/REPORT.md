# Robinhood Chain arbitrage: how much money is there? (profit measure)

Window: 2026-10-22 20:34 UTC to 2026-10-23 20:34 UTC (24.0 h, blocks 95392255-96220748). Read-only, public node.

Swaps seen: 1,989,329 on 16779 pools. Multi-pool transactions: 174,255.
Receipts read: our-bot-shape (tier 1) 16794/16794 (100%), rest (tier 2) 133110/157461 (85%). "Est." numbers scale the sample up by coverage.
Arbitrage found: 59216 (trusted prices 15035, doubtful 32110, unpriced 12071). ETH ~$2,405.

## The money (trusted trades, after the gas they paid)

| Group | Trades seen | Kept after gas (seen) | Est. per day | Est. trades/day | Median | p90 | Max | >$0.25 | >$1 | >$5 | Median size |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all trusted | 15035 | $3,340 | $3,632 | 16873 | $0.01 | $0.08 | $385.60 | 779 | 324 | 72 | $62.27 |
| base coin profit | 11123 | $1,699 | $1,920 | 12358 | $0.01 | $0.09 | $373.31 | 558 | 223 | 45 | $60.05 |
| ours any route | 7700 | $1,128 | $1,246 | 8310 | $0.01 | $0.10 | $48.34 | 459 | 188 | 40 | $58.94 |
| ours 2pool same pair | 2672 | $225.65 | $225.69 | 2675 | $0.01 | $0.06 | $11.70 | 96 | 46 | 11 | $61.81 |

"ours" = every pool on an exchange our deployed contract can trade, profit taken in USDG or WETH. "2-pool same pair" = the bot's main route shape.

## Who takes it (routes on our exchanges, USDG/WETH profit)

| Bot contract | Trades | Kept (seen) | Est./day | Share | Median | Max |
| --- | --- | --- | --- | --- | --- | --- |
| 0x24a4d86c..0da7 | 83 | $218.12 | $257.90 | 21% | -$0.01 | $48.05 |
| 0x0005ea38..b5ef | 17 | $168.04 | $198.76 | 16% | $3.77 | $48.34 |
| 0x7ddbd395..114a | 347 | $78.86 | $84.67 | 7% | $0.06 | $13.65 |
| 0x62fc8082..f4ca | 73 | $66.57 | $67.38 | 5% | $0.15 | $8.37 |
| 0xb92fe925..ff4f | 5 | $53.46 | $63.23 | 5% | $8.49 | $21.53 |
| 0xaa41e6c3..2299 | 45 | $45.77 | $46.79 | 4% | $1.01 | $1.31 |
| 0xb0550000..77bd | 183 | $40.51 | $43.25 | 3% | $0.05 | $7.70 |
| 0x36dc95f1..2bc2 | 2 | $33.01 | $39.04 | 3% | $29.80 | $29.80 |
| 0x9c9f4ab6..09f8 | 25 | $29.43 | $29.57 | 2% | $0.46 | $6.76 |
| 0x01eef8bb..ce62 | 28 | $27.36 | $28.31 | 2% | $0.99 | $1.33 |
| 0x17970d75..f693 | 129 | $26.80 | $27.18 | 2% | $0.07 | $3.13 |
| 0xc9a1dcff..7144 | 231 | $21.40 | $24.43 | 2% | $0.06 | $1.44 |

## Who takes it (all USDG/WETH-profit arbitrage, any exchange)

| Bot contract | Trades | Kept (seen) | Est./day | Share |
| --- | --- | --- | --- | --- |
| 0x46174dfb..f998 | 26 | $385.94 | $456.50 | 24% |
| 0x24a4d86c..0da7 | 92 | $218.40 | $258.23 | 13% |
| 0x0005ea38..b5ef | 18 | $169.94 | $201.01 | 10% |
| 0x7ddbd395..114a | 446 | $120.48 | $133.90 | 7% |
| 0x62fc8082..f4ca | 73 | $66.57 | $67.38 | 4% |
| 0xb92fe925..ff4f | 7 | $53.57 | $63.36 | 3% |
| 0xb0550000..77bd | 274 | $49.75 | $54.18 | 3% |
| 0xaa41e6c3..2299 | 45 | $45.77 | $46.79 | 2% |
| 0x86b2a6ca..5315 | 1333 | $34.70 | $40.17 | 2% |
| 0x36dc95f1..2bc2 | 2 | $33.01 | $39.04 | 2% |
| 0x47aff0bd..f5a0 | 7 | $30.21 | $33.23 | 2% |
| 0x9c9f4ab6..09f8 | 26 | $29.56 | $29.73 | 2% |

## Which pools carry the money (our exchanges)

| Pool | Exchange | Pair | Trades | Est./day | Swaps in window |
| --- | --- | --- | --- | --- | --- |
| 0x52e65b17..71ca | uniswap-v3 | WETH/USDG | 2404 | $280.78 | 159166 |
| 0x1649550a..7a2d | uniswap-v4 | WETH/TORCH | 10 | $157.49 | 2993 |
| 0xfc54380c..361b | uniswap-v4 | TORCH/ODDS | 8 | $100.68 | 275 |
| 0x54f78839..ba32 | uniswap-v4 | WETH/USDG | 23 | $99.96 | 8331 |
| 0x896b693e..cf6e | uniswap-v4 | BOOMER/USDG | 10 | $99.02 | 1220 |
| 0x8b46119c..d3d8 | uniswap-v4 | WETH/LYRO | 4 | $96.86 | 358 |
| 0x10cc6bd3..26ba | uniswap-v3 | WETH/PONS | 99 | $95.72 | 1117 |
| 0x51b6ca77..57a5 | ramses-v3 | WETH/PONS | 136 | $79.93 | 6845 |
| 0x9cc8c4f6..e55f | uniswap-v3 | WETH/VIRTUAL | 87 | $74.85 | 3046 |
| 0x24107d15..379e | uniswap-v4 | WETH/USDG | 195 | $74.52 | 31911 |
| 0x9a537af9..b8fb | uniswap-v3 | ANTH/ANTHROPIC | 2 | $60.84 | 15 |
| 0xca5e2b20..f768 | uniswap-v4 | WETH/ANTHROPIC | 2 | $60.84 | 67 |
| 0xed50bdee..22ff | uniswap-v3 | WETH/PONS | 64 | $58.55 | 2559 |
| 0xb94d8bf3..d7b8 | uniswap-v4 | TORCH/BURN | 1 | $56.83 | 11 |
| 0x1eb56966..cc73 | uniswap-v2 | VIRTUAL/LLL | 3 | $55.49 | 249 |

## Pairs (our exchanges)

| Pair | Trades | Est./day |
| --- | --- | --- |
| WETH/USDG | 3263 | $499.83 |
| WETH/TORCH | 10 | $157.49 |
| WETH/PONS | 286 | $103.49 |
| TORCH/ODDS | 8 | $100.68 |
| BOOMER/USDG | 10 | $99.02 |
| WETH/LYRO | 4 | $96.86 |
| WETH/VIRTUAL | 100 | $75.45 |
| ANTH/ANTHROPIC | 2 | $60.84 |
| WETH/ANTHROPIC | 2 | $60.84 |
| TORCH/BURN | 1 | $56.83 |

## Route length / exchange mix (USDG/WETH profit, any exchange)

| Route | Trades | Est./day |
| --- | --- | --- |
| 2 pools | 7968 | $970.68 |
| 3 pools | 2253 | $755.00 |
| 4+ pools | 902 | $194.59 |

| Exchanges used | Trades | Est./day |
| --- | --- | --- |
| factory:0xc63d7338 + uniswap-v3 + uniswap-v4 | 66 | $445.58 |
| uniswap-v4 | 925 | $353.77 |
| uniswap-v3 + uniswap-v4 | 779 | $237.64 |
| uniswap-v3 | 1218 | $106.22 |
| ramses-v3 + uniswap-v3 | 400 | $100.95 |
| uniswap-v3 + up-cl | 272 | $97.99 |
| uniswap-v2 + uniswap-v3 + uniswap-v4 | 13 | $70.22 |
| factory:0xc63d7338 + uniswap-v3 | 440 | $52.95 |
| ramses-v3 + uniswap-v4 | 514 | $44.30 |
| raphael-cl + uniswap-v4 | 93 | $34.69 |

## Speed: when did the winner land after the trade that opened the gap?

One block is about 104 ms.

| Delay | Our exchanges | All (USDG/WETH profit) |
| --- | --- | --- |
| same block | 1316 | 1824 |
| +1 block | 1651 | 2500 |
| +2 blocks | 655 | 1028 |
| +3..10 | 1149 | 1550 |
| >10 blocks | 2580 | 3784 |
| no trade seen (within ~2000 blocks) | 349 | 437 |

| Bot | same block | +1 | +2 | +3..10 | >10 | none seen | median blocks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0x24a4d86c..0da7 | 2 | 1 | 3 | 26 | 40 | 11 | 16 |
| 0x0005ea38..b5ef | 0 | 0 | 0 | 1 | 14 | 2 | 66 |
| 0x7ddbd395..114a | 11 | 14 | 15 | 22 | 170 | 115 | 117 |
| 0x62fc8082..f4ca | 50 | 5 | 2 | 3 | 11 | 2 | 0 |
| 0xb92fe925..ff4f | 0 | 0 | 0 | 0 | 5 | 0 | 462 |
| 0xaa41e6c3..2299 | 0 | 0 | 0 | 12 | 32 | 1 | 16 |
| 0xb0550000..77bd | 76 | 61 | 17 | 11 | 17 | 1 | 1 |
| 0x36dc95f1..2bc2 | 0 | 0 | 0 | 0 | 2 | 0 | 284 |

| Position in block | Trades (our exchanges) |
| --- | --- |
| 4-10 | 2644 |
| 11+ | 2728 |
| 1 (first after system tx) | 881 |
| 2-3 | 1447 |

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
| any route on our exchanges (incl. loops) | 10% | $2000 own money | 486 | $95.41 | $108.54 | $13.13 |
| any route on our exchanges (incl. loops) | 10% | no cap (flash loan) | 486 | $96.80 | $109.93 | $13.13 |
| any route on our exchanges (incl. loops) | 25% | $2000 own money | 486 | $260.42 | $271.36 | $10.94 |
| any route on our exchanges (incl. loops) | 25% | no cap (flash loan) | 486 | $263.88 | $274.82 | $10.94 |
| any route on our exchanges (incl. loops) | 50% | $2000 own money | 486 | $535.42 | $542.72 | $7.30 |
| any route on our exchanges (incl. loops) | 50% | no cap (flash loan) | 486 | $542.35 | $549.65 | $7.30 |
| any route on our exchanges (incl. loops) | 100% | $2000 own money | 486 | $1,085 | $1,085 | $0.00 |
| any route on our exchanges (incl. loops) | 100% | no cap (flash loan) | 486 | $1,099 | $1,099 | $0.00 |

## Caveats

- Arbitrage is detected from coin movements (bot ends with more of a coin and less of none). Exchanges whose swaps leave no known event are invisible; failed attempts are only visible in the census section.
- "Trusted" = all profit coins priced from a busy pool and profit under 5% of trade size. Doubtful/unpriced trades (mostly thin meme coins) are left out of the dollars.
- Per-day numbers scale the sampled receipts up by coverage and the window up to 24 h; time-of-day swings are not corrected.
- "Our exchanges" = uniswap-v2, pancakeswap-v2, ramses-v2, uniswap-v3, pancakeswap-v3, ramses-v3, uniswap-v4, giga-cl, up-cl, swaphood-v3, topaz-cl, raphael-cl, sushiswap-v3, abyss-cl (unhooked V4 only; Algebra and hooked V4 need a contract redeploy). The real watch list lives on the server and was not used.
- Node requests: 13098 HTTP (313258 calls), 429 answers 5753. Run took 254 min.
