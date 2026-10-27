// ============================================================================
// FAST LANE: see the shared design (sim/DESIGN.md and the fast lane brief).
//
// Plain English:
//   As each feed message (one L2 block) arrives, move our copy forward,
//   re-check routes whose pools changed and, if one pays, build + sign +
//   send at once so we land at the top of the very next block.
//   Module owners (parallel workstreams; each adds its own `pub mod` line):
//     copy2/ahead.rs        = A (predicted copy, lives with copy 2)
//     mode, safety, bridge  = D (switches, every Node safety gate, the files
//                              shared with the Node bot)
//     types, scan, convert  = B (Opportunity, standing-gap scanner)
//     gun                   = C (calldata, signing, nonce, sending)
//   FASTLANE=off (the default) runs none of it.
// ============================================================================
pub mod bridge;
pub mod gun;
pub mod mode;
pub mod safety;
