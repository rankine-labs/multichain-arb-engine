// ============================================================================
// arbsim: in-bot simulator for Robinhood Chain. See DESIGN.md.
// Module owners (parallel workstreams): state/feed/server/node = A,
// arb = B, check = C. Shared contracts: state::{StateRead, Lookup, MissItem,
// StateDiff}, arb::{BlockCtx, block_env, configure_cfg, ArbPrecompiles}.
// ============================================================================
pub mod arb;
pub mod check;
pub mod feed;
pub mod state;
