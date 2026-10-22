// ============================================================================
// `arbsim serve`: start the sidecar (owner: workstream A).
//
// Plain English:
//   1. Read settings from env (see state/mirror.rs Config, node.rs).
//   2. Connect the node client (never prints URLs; "node1"/"node2"/"public").
//      No node at all is allowed (checks then only use what the feed replay
//      can do on its own, which is almost nothing: everything answers
//      "unknown"), but it's logged loudly.
//   3. Start the thread that keeps the copy current. ARBSIM_SOURCE picks it:
//        feed         (default) the feed updater (state/updater.rs, copy 1)
//        pool-events  copy 2: our pools' own events (copy2/intake.rs)
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

/// Where the copy's updates come from (ARBSIM_SOURCE).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// The sequencer feed, every transaction replayed (copy 1, default).
    Feed,
    /// Our pools' own events (copy 2).
    PoolEvents,
}

impl Source {
    pub fn from_env() -> Result<Self, String> {
        match std::env::var("ARBSIM_SOURCE").unwrap_or_default().trim() {
            "" | "feed" => Ok(Source::Feed),
            "pool-events" => Ok(Source::PoolEvents),
            o => Err(format!("ARBSIM_SOURCE='{o}' (use 'feed' or 'pool-events')")),
        }
    }
}

/// Build everything (no socket yet), feed source. Used by `serve` and tests.
pub fn build(cfg: Config, node: Option<Arc<dyn NodeApi>>) -> Arc<Ctx> {
    build_with(cfg, node, Source::Feed)
}

/// Build everything for the given source.
pub fn build_with(cfg: Config, node: Option<Arc<dyn NodeApi>>, source: Source) -> Arc<Ctx> {
    let fills = Arc::new(FillQueue::new(20_000, cfg.max_warm));
    let pin_cache = cfg.pin_cache;
    let shared = Shared::new(cfg, node, Arc::new(default_volatile()));
    match source {
        Source::Feed => {
            let updater = updater::spawn(shared.clone(), fills.clone());
            Arc::new(Ctx { shared, updater, fills, pinned: PinnedCache::new(pin_cache), copy2: None })
        }
        Source::PoolEvents => {
            // The feed updater is NOT started (one writer only); its handle
            // exists but nothing reads it.
            let (_unused, updater) = updater::manual(shared.clone(), fills.clone());
            let c2cfg = crate::copy2::intake::C2Config::from_env();
            eprintln!(
                "[arbsim] copy2: {} node workers in flight (ARBSIM_COPY2_INFLIGHT), {} pools per load job (ARBSIM_COPY2_LOAD_BATCH)",
                c2cfg.loaders, c2cfg.load_batch
            );
            let c2 = crate::copy2::intake::spawn(shared.clone(), fills.clone(), c2cfg);
            Arc::new(Ctx { shared, updater, fills, pinned: PinnedCache::new(pin_cache), copy2: Some(c2) })
        }
    }
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
            eprintln!("[arbsim] nodes: {}; speed limit {} HTTP requests/s (ARBSIM_NODE_RPS{}), daily cap {}", n.labels().join(", "), n.usage()["rps"], if std::env::var("ARBSIM_NODE_RPS").is_ok() { "" } else { " NOT SET: default 8" }, n.usage()["cap"]);
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
    let source = match Source::from_env() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[arbsim] {e}");
            std::process::exit(2);
        }
    };
    eprintln!("[arbsim] source: {source:?}");
    // Stop signals (pm2 stop / restart / deploy): copy 2 saves itself first
    // (warm restart, copy2/persist.rs), then the process exits. Installed
    // before anything starts so an early signal still exits cleanly.
    crate::copy2::persist::install_stop_handlers();
    let ctx = build_with(cfg, node, source);
    {
        let ctx = ctx.clone();
        std::thread::Builder::new()
            .name("arbsim-stop".into())
            .spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(100));
                if !crate::copy2::persist::STOP.load(std::sync::atomic::Ordering::SeqCst) {
                    continue;
                }
                eprintln!("[arbsim] stop signal received");
                if let Some(c2) = &ctx.copy2 {
                    // pm2 waits ARBSIM kill_timeout (deploy/arbsim-pm2.sh) before
                    // killing: the save takes well under a second.
                    let secs = crate::node::env_u64("ARBSIM_COPY2_SAVE_TIMEOUT_S", 20);
                    if let Err(e) = c2.shutdown(std::time::Duration::from_secs(secs)) {
                        eprintln!("[arbsim] copy2: no final save ({e}); the last periodic save (if any) is used at the next start");
                    }
                }
                std::process::exit(0);
            })
            .expect("stop thread");
    }
    if let Err(e) = serve(ctx, &socket) {
        eprintln!("[arbsim] socket error: {e}");
        std::process::exit(1);
    }
}
