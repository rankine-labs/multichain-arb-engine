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
