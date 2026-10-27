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
//     types, scan, convert  = B (Opportunity, standing-gap scanner, and the
//                              Opportunity -> gun / safety copy)
//     gun                   = C (calldata, signing, nonce, sending)
//     lane, practice        = integration (the per-block loop that joins
//                              them, and practice-mode scoring)
//     trigger               = fire-first decided and fired inside Rust
//                              (Oct 27): the bot's one-trip check run the
//                              moment a feed message arrives, its good
//                              answer straight to the same safety + gun
//   FASTLANE=off (the default) runs none of it.
// ============================================================================
pub mod bridge;
pub mod c2runner;
pub mod convert;
pub mod gun;
pub mod lane;
pub mod mode;
pub mod practice;
pub mod safety;
pub mod scan;
pub mod trigger;
pub mod types;
