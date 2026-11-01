// ============================================================================
// arbsim: in-bot simulator for Robinhood Chain. See DESIGN.md.
// Module owners (parallel workstreams): state/feed/server/node = A,
// arb = B, check = C. Shared contracts: state::{StateRead, Lookup, MissItem,
// StateDiff}, arb::{BlockCtx, block_env, configure_cfg, ArbPrecompiles}.
// ============================================================================
pub mod arb;
pub mod bench_node;
pub mod check;
pub mod copy2;
// Fast lane (Oct 26): off unless FASTLANE=practice|live.
pub mod fastlane;
pub mod feed;
pub mod jobq;
pub mod memguard;
pub mod node;
pub mod proto;
pub mod server;
pub mod serve;
pub mod state;
pub mod timing;
