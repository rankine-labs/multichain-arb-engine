// ============================================================================
// COPY 2 REPLAY (placeholder until workstream B's version lands).
//
// Plain English:
//   For V3 / PancakeSwap V3 / Algebra / Uniswap V4 pools, the new state after
//   an event is found by re-running the same action with the pool's own code
//   on our copy (workstream B, branch inbot-sim/copy2-b, replaces this file).
//   Until then every such event answers "unsure", so those pools are simply
//   never used by the fast check (the bot asks the node, as today).
//
// INTERFACE (what the intake calls; B keeps this signature):
//   pub fn apply_replay(db: &mut Overlay, pool: &TrackedPool, log: &PoolLog,
//                       ctx: &BlockCtx) -> ApplyResult
//   - db: the block's working copy (copy2/overlay.rs). Read it strictly
//     (Missing is never zero); run revm on a `db.fork()` through
//     `state::db::ViewDb::new(&fork)`; on `DbMiss::Miss(item)` answer
//     `NeedItems(vec![item])` (the intake fetches it from the node and calls
//     again with the SAME log); on success check the event's own numbers,
//     then `db.commit(&diff)` with ONLY the pool's (and, for V4, the
//     PoolManager's) changes, and answer `Applied`.
//   - Must not change `db` unless it answers `Applied`.
//   - Anything not exact: `Unsure(reason)`.
//   - Coin balances: the intake applies coin Transfer logs itself, so the
//     replayer must NOT commit token-contract slot changes.
// ============================================================================
use super::overlay::Overlay;
use super::{ApplyResult, BlockCtx, PoolLog, TrackedPool};

/// Apply one V3 / PancakeV3 / Algebra / V4 event by replay (placeholder).
pub fn apply_replay(_db: &mut Overlay, _pool: &TrackedPool, _log: &PoolLog, _ctx: &BlockCtx) -> ApplyResult {
    ApplyResult::Unsure("replay not built".into())
}

/// End of a block for one pool (Algebra side events; see B's file). The
/// placeholder has nothing waiting.
pub fn finish_block(_db: &mut Overlay, _pool: &TrackedPool, _ctx: &BlockCtx) -> ApplyResult {
    ApplyResult::Applied
}

/// Algebra side events waiting for their main event? (placeholder: never)
pub fn has_pending(_db: &Overlay, _pool: &TrackedPool) -> bool {
    false
}
