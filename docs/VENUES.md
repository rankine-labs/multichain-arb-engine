# Robinhood extra venues (Oct 8)

## The short version

- **All 8 "unknown factories" from the rival-trade probes are now named, with full addresses.** The two biggest are **Alandale** (an Algebra copy, holding the deep SPY/USDG and WETH/USDG pools) and **GIGA CL** (a PancakeSwap V3 copy).
- **Our pricing maths matches real swaps exactly on every venue we can price.** We checked 133 live swaps across 13 exchanges: predicted output and new price equal the real ones to 0.000 bps whenever the swap stayed inside one price band.
- **Nothing new can be traded.** Every venue here has `executionEnabled: false` (a code-level `false`, not a setting). The trade path refuses them, so they only show up in reports as "missed: exchange we can't trade yet".
- **Reading their prices is off by default.** `RH_EXTRA_VENUES=1` turns on price reading and the missed-trade counters. With it off, the live bot is exactly as before.

## Venues

The addresses come from these sources, not from guessing:
- DefiLlama's public volume adapters (github.com/DefiLlama/dimension-adapters), which read these contracts daily
- the project's own docs where they exist
- the venue probe, which confirmed every contract has code on chain and tied each traded pool to its factory with `pool.factory()`

| Venue | Model | Factory / key contract | Seen in probe | Pricing check | Why we can't trade it yet |
|---|---|---|---|---|---|
| Alandale | Algebra Integral | `0x16494A80E08Bcb9285D87b67149d7b01774D82F8` | 21 to 35 swaps, 7 to 10 pools | 13/13 exact | Algebra callback (`algebraSwapCallback`) isn't in our contract |
| GIGA CL | PancakeSwap V3 copy | `0xEce6eCd61177336ea6Fb9b17937AC439D85EE20B` | 21 to 60 swaps, 7 pools | 15/15 exact | Callback supported; not yet tested with our executor |
| GIGA Classic | Solidly, own fee per pair | `0x6Fdf38f92eAd1adFc04B73aaa947ab254f6c0916` | none in sample | adapter tested on a fake chain only | per-pair fee; stable curve not priceable |
| GIGA BrownFi | oracle AMM | `0x831880Bd3b331249DF63bacC6e21495e5e8f1eAA` | n/a | not priceable from state | price comes from an oracle |
| Fables | Uniswap V4 + hook (dynamic fee) | registry `0x159a113e012593d9b3cc63ad45e30f0467e13ef3` (65 pools) | 25 to 52 swaps | 13/13 exact using the fee each swap paid | the hook charges a different fee from the pool's listed fee (see below) |
| Metric | oracle market maker (OMM) | `0x2a53833cc95548cf52c7b159110e22D3a9018f32` (+ retired `0x6229…EDe4`, older `0xe22F…2e0C`) | n/a | not priceable from state | price set by a price provider |
| Tessera | proprietary market maker | `0x55555522005BcAE1c2424D474BfD5ed477749E3e` | 5 to 43 trades | not priceable | private quotes |
| Ekubo | singleton | core `0x00000000000014aA86C5d3c41765bb24e11bd701` | 4 to 15 core logs | needs own adapter | own pool ids, extensions, lock settlement |
| UP CL | Slipstream copy | `0x1ac9dB4a2608ba45D6127B1737949b51Bb54B7F3` | 22 to 70 swaps | 13/13 in band exact | not yet tested with our executor |
| SwapHood V3 | PancakeSwap V3 copy | `0x0Ec554F0BfF0Be6C99d1e95C8015bb0950f6A2C7` | 1 to 6 swaps | 5/5 exact | not yet tested |
| Topaz CL | Slipstream copy | `0xaa5865dC3A60b25D305226d66fd573021f0D8fFB` | 2 swaps | 5/5 exact | not yet tested |
| Raphael CL | Slipstream copy | `0x5481864ddd46a2D798Df0925C23B7846e776E5E3` | 7 swaps | 3/3 exact | not yet tested |
| SushiSwap V3 | Uniswap V3 copy | `0xE51960f1B45f1C9FB6D166E6a884F866fC70433B` | 4 to 18 swaps | 5/5 exact | not yet tested |
| KittenSwap | Algebra | `0xf03875b5Ec5eAc83cab83A6c2ab17844304AA7a0` | 4 swaps | 3/3 exact | Algebra callback; plugins can override the fee |
| Goo Exchange | Uniswap V3 copy | `0x221A6239E40709792b0d4bdc140fA36158CD41C7` | 2 to 3 swaps | not sampled | unusual fee tiers |

**Still unnamed (1 swap each in the sample, not worth chasing yet):**
- `0x9a8442cb89fe713ce7c2f22852e61fbffee97ecf`
- `0xe7fef2bc860b25bbdeb6f6ab96d88baaa77ddad7`
- `0xba04837dc830fb2c5c16855bd8256f0409cde656`
- `0xd09ecb37748938e6997cc90c3ea1b051d94b0085`
- `0x21fd9ab06cc927e66013e89b045c26b3ede7bb20`
- `0xc802a440559cee8a66e2023403d34be9084a720e`
- `0x0841f30f311376bdb35ed36bb6a67ce42360b291`
- `0x649fee51b30dce68eed7b356f5ec6185e3982adf`
- `0xea561e058313b96011e5070ca7d0f027a44e3748`

## How the validation works (scripts/probe-venues.ts)

1. **Identify.** Read the bytecode of each contract. The Blockscout explorer refuses GitHub's servers (403), so names come from the sources above.
2. **Map pools to venues.** Read sampled blocks over the last few hours, collect every swap, and ask each pool for its `factory()`. V4 swaps are matched to Fables through the registry's `activePools()`.
3. **Validate at the chain head.** The public node keeps only very recent state, seconds on this chain, so checking old swaps returns "state unreadable". Instead, for each new block:
   - read the pool state at the block before
   - predict the swap's output with `src/core/venueMath.ts`
   - compare the prediction with the swap event (amount out, new price, liquidity)

   Swaps that weren't the first touch of their pool in the block are skipped, because their state is no longer "the block before".
4. **Read the results.**
   - "In band" means the liquidity was the same before and after, so no tick was crossed and the maths must be exact.
   - "Crossed" swaps left the price band; our one-band maths is only an estimate there, and was still within 0.24 bps.

Runs: 37845231412 (identification and mapping), 37851009313 and 37853652882 (validation, 133 + 108 swaps).

## Fables fee

Every Fables pool lists an `lpFee` of 0. The hook sets the real fee on each swap: run 37853652882 saw 0.035% to 0.45%, most often 0.26%. Our maths is exact when given the fee the swap actually paid (12/12 in-band swaps). Until we can predict the hook's fee, Fables pools are priced with a conservative 0.30% estimate (`HOOKED_V4_FEE_PIPS`, default 3000), so missed-trade counts aren't overstated. Fables can't be traded.

## Review of PR #75 (ChatGPT, research registry)

**Good:**
- Research only, with `executionEnabled: false`.
- Ekubo correctly treated as a singleton, not a V3 factory.
- Goo and Reisa addresses come with sources.

**Problems:**
- Its workflow lives only on the branch, and a `workflow_dispatch` workflow must be on the default branch to be started. It also relies on artifact downloads, which our tooling can't fetch.
- It never resolves the unknown factories: 20 venues are names with no addresses.
- It only scans Goo and Reisa.

**Superseded by this branch:**
- `src/config/robinhoodVenues.ts` has full addresses for every venue in the priority list, plus the rest.
- `scripts/probe-venues.ts` runs through the existing `probe.yml` (`only=venues`).

Recommend closing #75 once this is approved, or keeping its Reisa entry, which this branch didn't verify.

## What's needed before any of these can be traded

1. **GIGA CL, SwapHood V3, SushiSwap V3** (callbacks we already have): run the executor on a fork against their pools (the Phase 3 fork test pattern) and confirm the simulation matches.
2. **Slipstream copies (UP, Topaz, Raphael):** same, plus pool lookup by tick spacing in the executor's calldata.
3. **Algebra (Alandale, KittenSwap):** add `algebraSwapCallback` to the contract. That's a contract change and a redeploy, so it needs owner approval.
4. **Fables:** predict the hook fee; V4 hook pools also need the hook address in the pool key the executor builds.
5. **Metric, Tessera, BrownFi, Ekubo:** quote-call or custom adapters. Not worth it until the counters show money there.
