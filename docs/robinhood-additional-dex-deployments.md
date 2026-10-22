# Additional Robinhood DEX deployments — research evidence (2026-10-08)

This list supplements `robinhood-dex-watchlist-20261008.md`. These are **not** identified matches for the five unknown rival factory prefixes. Verify each deployment and recent activity before execution.

## Goo Exchange (published by project)
- Source: https://goo.exchange/docs/
- Chain ID: 4663
- Model: Uniswap V3 fork; pools deployed by a separate deployer, so CREATE2 uses pool deployer and protocol init-code hash, **not** factory.
- Factory: `0x221A6239E40709792b0d4bdc140fA36158CD41C7`
- Pool deployer: `0x9eF8bfae948B012EDD9e902Beb0d55F475631396`
- SwapRouter: `0x16E5Ec75431AccB65bFcC7aEfFC1d2aeB44069b0`
- Main GOO/WETH pool (1%): `0x841f00216A273641eD583916e668e24b4A89d1e7`
- Factory deploy block: 73266708.
- Fee tiers: 0.05%, 0.25%, 0.3%, 0.9%, 1%, 10%, 20%.
- Suggested action: discover pools by factory `PoolCreated` events, verify code and current near-price depth, exclude unusual high-fee tiers from generic assumptions. Research only until verified.

## Reisa (published by project)
- Source: https://reisa.fi/docs/developers
- Factory: `0x82Fe4E8b87FfEdE76bC04d74218f588221Ba4e91`
- Router: `0xdAA29fCDf36B679CDFe6646DAd1B70312b9d8231`
- REISA/WETH pool: `0xC51442F1c6272704d8F0b5FA979747D442d3DA97`
- REISA/RESD pool: `0x61a16c14D2Ed39503204Fa9da21276274f42E1Bc`
- WETH/RESD pool: `0x27BDaB3528d6F7f3b6Be58deE7d5293C6E9e63B6`
- Suggested action: inspect verified source, pool model, liquidity and actual swaps; do not assume V2 constant product until confirmed.

## Ekubo V3
- Official deployment matrix: https://docs.ekubo.org/reference/contracts/evm-v3/
- Robinhood Chain (4663) is marked **Live**.
- Its EVM V3 uses EIP-1153 and EIP-7939; pricing requires Ekubo-specific modeling, not the generic V3 virtual-reserve approximation.
- Suggested action: locate canonical manager and position/order manager addresses in official contract documentation, verify active Robinhood pools and real token overlap.

## Other sources and candidate venues
- 0x Robinhood liquidity source catalog: https://docs.0x.org/changelog/2026/7/31
- DeFiLlama Robinhood DEX activity: https://defillama.com/dexs/chain/robinhood-chain
- Include GIGA, ElfomoFi, Arcus, Rialto, Orvex, Fables, Metric, SwapHood, Raphael Exchange, Kittenswap, and other high-activity venues in **read-only** discovery; verify AMM type and on-chain activity individually.

## Rival audit five unknown prefixes — still unresolved
`0x16494a`, `0x1ac9db`, `0xece6ec`, `0x548186`, `0xaa5865`.

One public transaction trace shows calls to an address abbreviated `0x1ac9db…b7f3`, but this does **not** prove it is the same factory in the rival audit. Trace: https://brokertools.info/tx/0x758d7dc316a9cb057a9647b206bf77ec398805b890df732cbbe0fe8c74972684?tab=trace

The strongest recovery path remains modifying the replay report to output **full factory address**, **full pool address**, and **transaction hash** rather than truncating `addrOf(fac)`. Verify matches on chain before mapping a protocol or enabling trades.
