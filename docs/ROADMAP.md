# Roadmap (future builds)

Things we've decided are worth building later, with the reason and the
signal that says "now". Nothing here is built yet.

## Pre-signed trades (speed)

**What:** keep a ready-made trade "form" with the account's trade counter
(nonce), gas price and fixed parts already filled in, and the connection to
the sequencer kept warm. When a chance appears, only the amounts and pools are
written in, then a quick signature.

**Why:** building and signing a trade is most of our reaction time today
(about 30 to 90 ms of our 60 to 120 ms total). Pre-signing could bring the
total down to around 10 to 20 ms.

**Why not now:** on Robinhood the rivals we've timed take about 110 to 580 ms,
so we're usually first already. On small pools the money is decided by
coverage (being on the right loops and pools), not speed.

**Build it when:** the hourly Telegram line "Other bots timed: ... Them X s,
us Y s" shows rivals getting close to or faster than us, or before we move to
a crowded chain. Effort: about 2 to 3 hours.

## Other future items (from Oct 7 planning)

- **Stage 1, rival-style strategy:** 3- and 4-pool loops, bars in cents,
  smaller pools. Started on branch `tri-routes` (route builder only).
  Waiting on the Stage 0 verdict (daily RIVAL BOT REPORT).
- **Exact pool math (price bands / ticks):** stops the bot overestimating
  small concentrated pools. Only if benching dud pool pairs isn't enough.
- **Other chains:** measure rival profit on 2 to 3 candidates (Monad,
  Avalanche, Base) with the rival watch before choosing. Prefer young chains
  where pro bots aren't established yet.
- **Pro-grade parts, one at a time, only where data says they pay:** own node
  next to the chain, local in-memory simulation, all-pool route finder,
  gas-optimised contract, priority bidding, faster language for the hot path.

## Other strategies to consider (notes only, Oct 7)

Ranked by how much they might be worth to us. None built.

1. **Multi-pool loops**: already planned as Stage 1.
2. **Exchange vs chain (CEX-DEX)**: compare on-chain prices with a big
   exchange (Coinbase, Kraken...). Buy where cheap, sell where dear. Usually
   the biggest MEV money on chains like this. Needs an exchange account and
   money on both sides; the two legs aren't one atomic trade, so there's price
   risk between them.
3. **Stock tokens at the US market open (9:30 Toronto)**: real stock prices
   jump at the open, on-chain pools lag. Predictable timing, unique to
   Robinhood Chain. Measure the lag first with a live stock price feed.
4. **Liquidations**: only if lending apps exist on the chain (unchecked).
5. **Holding stock (non-atomic arb)**: trade one leg now, rebalance later.
   More capital and price risk.
6. **Uniswap V4 special pools (hooks, dynamic fees)**: unusual gaps, more
   code per pool type.

More backrun ideas (Oct 7, evening):

7. **New pool first trade**: when someone creates a new pool for an existing
   coin, its starting price is set by hand and often a bit off. The first bot
   to trade it into line keeps the gap. Often bigger than 10 cents. Fits us
   best: young chain, all-in-one safe trade. Measure first: how often new
   pools appear with an off price. **Measuring since Oct 8**
   (core/newPoolWatch.ts): hourly line + "New pools" in the 9:00 report.
8. **Repeat traders (split orders)**: big traders splitting one order into
   chunks every few minutes push prices the same way on a schedule. Learn the
   pattern, be ready before each chunk. Timing beats speed.
- **Loop trader (Phase B)**: 3-pool loops through coins that should be
  worth the same (USDG -> token -> USDT -> USDG). Phase A, measurement only,
  runs since Oct 8 (LoopMonitor in core/crossQuoteMonitor.ts, verified coin
  list in data/token-groups.json, daily LOOP REPORT at 9:10). Build Phase B
  only if the LOOP REPORT verdict says so for a few days in a row.
9. **Dollar-coin pools**: USDG vs other dollar coins, if they have pools
   here. Should sit at $1.00; big trades knock them off briefly. Very safe.
10. **ETH vs wrapped ETH pools**: some Uniswap V4 pools use plain ETH, others
    WETH. Same coin, separate prices. Contract already handles both.
11. **Pool-manager rebalances**: apps that manage liquidity move it around
    periodically, often on a schedule, wobbling prices.

Not for us: sandwich / front-run (hurts traders, impossible here anyway),
sniping new launches (mostly scams), just-in-time liquidity (needs to see
trades before they happen).
