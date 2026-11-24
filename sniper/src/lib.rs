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
//   engine.rs    quotes from our own arbsim engine copy, node as fallback
//   enginetrial.rs  live trial of that engine (answers vs unknown, budget, memory)
//   wshot.rs     hot-pool WebSocket wake-up + its free cost estimate
//   paper.rs     Robinhood paper trader (real quotes, no money)
//   probe.rs     the measurement run (threads + JSONL output)
//   registry.rs  live token list + burst / creator-dump / graduation signals
//   scan.rs      the live read-only scanner command
//   sellcheck.rs simulate buy + sell from our wallet before every buy
//   rhc.rs       Robinhood Chain speed test probe (feed timing + all swaps)
//   rhc_report.rs  head start, rushes, simulated fast trades
//   report.rs    coverage / lead time / follow-through numbers
//   venue.rs     Uniswap V3 / V4 / V2 venue facts for the paper trader
// ============================================================================
pub mod calibrate;
pub mod curve;
pub mod engine;
pub mod enginetrial;
pub mod feedtx;
pub mod feedwake;
pub mod feedwatch;
pub mod fourmeme;
pub mod live;
pub mod livetrade;
pub mod liveroute;
pub mod livedry;
pub mod rugguard;
pub mod safety;
pub mod matcher;
pub mod paper;
pub mod probe;
pub mod registry;
pub mod report;
pub mod rhc;
pub mod rhc_report;
pub mod scan;
pub mod sellcheck;
pub mod taxcheck;
pub mod venue;
pub mod ws;
pub mod wshot;
