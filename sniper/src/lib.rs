// ============================================================================
// sniper: Rust Predictive Sniper (Phase 1: read-only lead-time probe).
//
//   fourmeme.rs  Four.meme contract addresses, event ids, log decoding
//   ws.rs        websocket eth_subscribe client with reconnects
//   matcher.rs   joins pending sightings with confirmed Four.meme trades
//   probe.rs     the measurement run (threads + JSONL output)
//   report.rs    coverage / lead time / follow-through numbers
// ============================================================================
pub mod fourmeme;
pub mod matcher;
pub mod probe;
pub mod report;
pub mod ws;
