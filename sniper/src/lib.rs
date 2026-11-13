// ============================================================================
// sniper: Rust Predictive Sniper (Phase 1: read-only lead-time probe).
//
//   curve.rs     exact bonding-curve quotes (buy, sell, round trip)
//   calibrate.rs fits + verifies the curve against real trades
//   fourmeme.rs  Four.meme contract addresses, event ids, log decoding
//   ws.rs        websocket eth_subscribe client with reconnects
//   matcher.rs   joins pending sightings with confirmed Four.meme trades
//   feedtx.rs    unpack user transactions from the sequencer feed
//   feedwatch.rs feed head start + which routers swaps use
//   paper.rs     Robinhood paper trader (real quotes, no money)
//   probe.rs     the measurement run (threads + JSONL output)
//   registry.rs  live token list + burst / creator-dump / graduation signals
//   scan.rs      the live read-only scanner command
//   sellcheck.rs simulate buy + sell from our wallet before every buy
//   rhc.rs       Robinhood Chain speed test probe (feed timing + all swaps)
//   rhc_report.rs  head start, rushes, simulated fast trades
//   report.rs    coverage / lead time / follow-through numbers
// ============================================================================
pub mod calibrate;
pub mod curve;
pub mod feedtx;
pub mod feedwatch;
pub mod fourmeme;
pub mod matcher;
pub mod paper;
pub mod probe;
pub mod registry;
pub mod report;
pub mod rhc;
pub mod rhc_report;
pub mod scan;
pub mod sellcheck;
pub mod ws;
