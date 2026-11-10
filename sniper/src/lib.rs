// ============================================================================
// sniper: Rust Predictive Sniper (Phase 1: read-only lead-time probe).
//
//   curve.rs     exact bonding-curve quotes (buy, sell, round trip)
//   calibrate.rs fits + verifies the curve against real trades
//   fourmeme.rs  Four.meme contract addresses, event ids, log decoding
//   ws.rs        websocket eth_subscribe client with reconnects
//   matcher.rs   joins pending sightings with confirmed Four.meme trades
//   probe.rs     the measurement run (threads + JSONL output)
//   registry.rs  live token list + burst / creator-dump / graduation signals
//   scan.rs      the live read-only scanner command
//   sellcheck.rs simulate buy + sell from our wallet before every buy
//   report.rs    coverage / lead time / follow-through numbers
// ============================================================================
pub mod calibrate;
pub mod curve;
pub mod fourmeme;
pub mod matcher;
pub mod probe;
pub mod registry;
pub mod report;
pub mod scan;
pub mod sellcheck;
pub mod ws;
