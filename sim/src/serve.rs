// ============================================================================
// `arbsim serve`: start the sidecar (owner: workstream A).
//
// Plain English:
//   1. Read settings from env (see state/mirror.rs Config, node.rs).
//   2. Connect the node client (never prints URLs; "node1"/"node2"/"public").
//      No node at all is allowed (checks then only use what the feed replay
//      can do on its own, which is almost nothing: everything answers
//      "unknown"), but it's logged loudly.
//   3. Start the updater thread (keeps the copy current from the feed).
//   4. Serve the socket forever. Node trouble never stops the server: the
//      checks just answer "unknown" (not_ready / dirty) until it recovers.
// ============================================================================
use std::sync::Arc;

use crate::arb::arbos::ARBOS_STATE_ADDRESS;
use crate::node::{NodeApi, NodeClient};
use crate::server::{serve, Ctx};
use crate::state::fill::FillQueue;
use crate::state::mirror::{Config, Shared};
use crate::state::pinned::PinnedCache;
use crate::state::snap::Volatile;
use crate::state::updater;

/// Accounts that change inside every block in ways we can't replay (always
/// "missing"): ArbOS's own state account. (The poster/coinbase gets no fees
/// in our replay, its balance is learned volatile by verification.)
pub fn default_volatile() -> Volatile {
    Volatile::with_whole(&[ARBOS_STATE_ADDRESS])
}

/// Build everything (no socket yet). Used by `serve` and tests.
pub fn build(cfg: Config, node: Option<Arc<dyn NodeApi>>) -> Arc<Ctx> {
    let fills = Arc::new(FillQueue::new(20_000, cfg.max_warm));
    let pin_cache = cfg.pin_cache;
    let shared = Shared::new(cfg, node, Arc::new(default_volatile()));
    let updater = updater::spawn(shared.clone(), fills.clone());
    Arc::new(Ctx { shared, updater, fills, pinned: PinnedCache::new(pin_cache) })
}

pub fn serve_main(args: &[String]) {
    let socket = args
        .get(2)
        .cloned()
        .or_else(|| std::env::var("ARBSIM_SOCKET").ok())
        .unwrap_or_else(|| "/tmp/arbsim.sock".into());
    let cfg = Config::from_env();
    let node: Option<Arc<dyn NodeApi>> = match NodeClient::from_env() {
        Some(n) => {
            eprintln!("[arbsim] nodes: {}", n.labels().join(", "));
            Some(Arc::new(n))
        }
        None => {
            eprintln!("[arbsim] WARNING: no node configured (ARBSIM_NODE_URL / CHAINSTACK_RPC_ROBINHOOD); every check will answer unknown");
            None
        }
    };
    eprintln!(
        "[arbsim] serving on {socket}: l2 offset {}, verify every {} blocks (min {} s apart), daily node cap {}",
        cfg.l2_offset,
        cfg.verify_every,
        cfg.verify_min_interval_s,
        crate::node::env_u64("ARBSIM_NODE_DAILY_CAP", 6000)
    );
    let ctx = build(cfg, node);
    if let Err(e) = serve(ctx, &socket) {
        eprintln!("[arbsim] socket error: {e}");
        std::process::exit(1);
    }
}
