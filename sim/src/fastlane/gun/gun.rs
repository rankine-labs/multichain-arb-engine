// ============================================================================
// GUN: Gun::fire (calldata -> safety gate -> nonce -> sign -> send)
//
// Plain English:
//   One call turns a found trade into a signed transaction and, when live,
//   hands it to the send endpoint. It returns a FireRecord with what was
//   built and how long each step took (microseconds):
//     calldata_us  build the contract call
//     gate_us      the safety gate (workstream D plugs its checks in here)
//     sign_us      nonce + EIP-1559 transaction + secp256k1 signature
//     handed_us    from fire start until the bytes were written to the
//                  socket (live only; the caller waits only for THIS)
//   The sequencer's reply (~115 ms, mostly queueing) arrives later on the
//   sender thread and goes to the `on_reply` hook (workstream D's bridge
//   writes it to data/fastlane-sends.jsonl for the Node live tracker).
//
// Modes (env FASTLANE, default off):
//   off       nothing is created (Gun::from_env returns None).
//   practice  everything, signing included, with a THROWAWAY random key;
//             never broadcasts; logs "would send" with the timings. Never
//             reads the real key and makes NO network calls at all (final
//             review M-2: no gas / nonce refresher thread; the gas price in
//             a practice transaction is 0 until something sets it, the
//             deadline comes from the feed's own block number).
//   live      broadcasts only when ALL of these hold (otherwise it runs as
//             practice and says why at start):
//               FASTLANE=live and RUST_SENDER=on (one sender at a time: the
//                 Node bot stops broadcasting when RUST_SENDER=on, D)
//               EXECUTION_ENABLED=true, LIVE_SEND_CONFIRM=yes-real-money
//                 (the same switches the Node sender needs)
//               BOT_PRIVATE_KEY (the SAME executor wallet as Node: the
//                 contract allows one executor) and ARB_EXECUTOR_ROBINHOOD
//               a REAL safety gate (Gate::is_real; the do-nothing NoGate
//                 is for practice and tests only and can never broadcast)
//             and, at each fire, the gate says broadcasting is allowed right
//             now (Gate::may_broadcast_now: kill switch, Node agrees, ...).
//             `Gun::broadcasting()` is the ONE answer to "are we live right
//             now": true only when every one of these holds.
//   The key is read ONLY in live mode, ONLY from BOT_PRIVATE_KEY, never
//   logged, and the env text is not kept (the Signer wipes its copy on drop).
//
// Same rules as the Node sender (src/execution/fastSender.ts + the loop
// senders in trigEntryLoops.ts / loopLive.ts):
//   type 2, chain 4663, value 0, tip 0, maxFee = 2 x base fee + 1,
//   gas limit = tuned limit + 1.5 x posting gas, maxBlock = the block the
//   trade was found on (the FEED TIP's own block number, CallInput.block) +
//   FASTLANE_MAX_BLOCK_MARGIN (default 2) (final review blocker 2: never the
//   block guessed from the public node's last read; Node's MAX_BLOCK_MARGIN
//   rule stays in gas.rs for compatibility)
//   (live: refuses with "block info stale" when the gas price / block info
//   is > 10 s old, and "no block number" without a feed block; practice
//   builds the same maxBlock, so its bytes look like live ones),
//   minProfit = usdToTokenUnits(net after gas, price, decimals), refused if it
//   rounds to zero, "no trade contract set" if live without an executor.
//
// Sending (send.rs): a signed trade that waits in the send queue longer than
// FASTLANE_MAX_QUEUE_MS (default 80) is dropped unsent ("stale_in_queue"),
// its nonce released for the next fire. A send that was written but got no
// reply is "unknown" (not failed): its hash is still reported, so the
// receipt tracker follows it, and its nonce counts as used.
//
// Integration note (M5, not done here): the safety check (D) and recording
// the send (D's record_send) should happen under ONE lock around fire(), so
// two fires can't both pass a limit that only one of them fits under.
// ============================================================================
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use revm::primitives::{Address, U256};

use super::calldata::{encode_for_funding, usd_to_token_units, CallErr, ExecutorHop, Funding, Trade, Units};
use super::gas::{spawn_refresher, Gas, GasConfig};
use super::nonce::NonceTracker;
use super::rpc::{pending_nonce, ReadRpc, UreqRpc};
use super::send::{Job, SendOutcome, SendPool, SendStatus};
use super::tx::{Signer, TxFields};
use crate::check::hexutil::to_hex;

/// Robinhood Chain id.
pub const CHAIN_ID: u64 = 4663;

/// FASTLANE setting: the one shared parser and type (fastlane/mode.rs).
pub use crate::fastlane::mode::Mode;

/// RUST_SENDER=on|true|1|yes (any case): fastlane/mode.rs parse_on.
pub fn rust_sender_on() -> bool {
    crate::fastlane::mode::parse_on(std::env::var("RUST_SENDER").ok().as_deref())
}

/// What the gun needs to fire one trade (the fields the Node loop senders
/// pass to encodeExecuteRaw / encodeExecuteV3FlashRaw, plus what the safety
/// gate looks at). Workstream B's `Opportunity` converts into this.
#[derive(Clone, Debug)]
pub struct CallInput {
    /// Block the trade was found for (logs, send records).
    pub block: u64,
    pub route_label: String,
    /// The coin the route starts and ends in.
    pub token_in: Address,
    pub amount_in: U256,
    /// The route in the contract's format (2 or more hops).
    pub hops: Vec<ExecutorHop>,
    /// Own money, Aave, or a V3 pool flash loan.
    pub funding: Funding,
    /// Expected profit after gas and loan fee (USD): the on-chain floor.
    pub net_usd: f64,
    /// USD price of token_in and its decimals (to turn net_usd into units).
    pub usd_per_token_in: f64,
    pub token_in_decimals: u32,
    /// Trade size (USD) for the safety gate.
    pub size_usd: f64,
    /// Expected gas cost (USD) for the safety gate / records.
    pub gas_usd: f64,
    /// When the trade was found (for "found -> handed" timings).
    pub found_at: Instant,
}

impl CallInput {
    /// Pools in route order (for D's SafetyInput.pools / pair blocks).
    pub fn pools(&self) -> Vec<Address> {
        self.hops.iter().map(|h| h.pool).collect()
    }

    /// Flash-loan lender, None = own money (D's SafetyInput.lender).
    pub fn lender(&self) -> Option<Address> {
        match self.funding {
            Funding::Own => None,
            Funding::Aave(a) | Funding::V3Flash(a) => Some(a),
        }
    }

    /// Every coin the route touches (for the token allowlist).
    pub fn tokens(&self) -> Vec<Address> {
        let mut v = vec![self.token_in];
        for h in &self.hops {
            for t in [h.token_in, h.token_out] {
                if !v.contains(&t) {
                    v.push(t);
                }
            }
        }
        v
    }
}

/// The contract call as built (kept in the record).
#[derive(Clone, Debug)]
pub struct CallPlan {
    pub to: Address,
    pub data: Vec<u8>,
    pub min_profit: U256,
    pub max_block: U256,
    pub funding: Funding,
}

/// Safety gate (workstream D implements it): called right before signing.
/// Err(reason) = do not send.
pub trait Gate: Send + Sync {
    fn allow(&self, c: &CallInput) -> Result<(), String>;
    /// True only for a gate that really runs the safety checks (D's Safety).
    /// No default on purpose: every gate must say. The gun never broadcasts
    /// through a gate that answers false.
    fn is_real(&self) -> bool;
    /// May we broadcast right now (FASTLANE=live, both sides' RUST_SENDER,
    /// no kill switch, Node's state fresh...)? Looked at by
    /// `Gun::broadcasting()` and before every live send.
    fn may_broadcast_now(&self) -> bool;
}

/// No checks at all: practice and tests only. NOT a real gate, so a gun
/// built with it never broadcasts (fire refuses, from_env runs as practice).
pub struct NoGate;
impl Gate for NoGate {
    fn allow(&self, _c: &CallInput) -> Result<(), String> {
        Ok(())
    }
    fn is_real(&self) -> bool {
        false
    }
    fn may_broadcast_now(&self) -> bool {
        false
    }
}

/// Why from_env's live mode can't broadcast (empty = it can). Pure, so the
/// rules are testable without touching the process environment.
pub fn live_blockers(get: &dyn Fn(&str) -> Option<String>, gate: &dyn Gate) -> Vec<&'static str> {
    let is = |k: &str, want: &str| get(k).map(|v| v == want).unwrap_or(false);
    let mut why = Vec::new();
    if !crate::fastlane::mode::parse_on(get("RUST_SENDER").as_deref()) {
        why.push("RUST_SENDER is not on");
    }
    if !is("EXECUTION_ENABLED", "true") {
        why.push("EXECUTION_ENABLED is not true");
    }
    if !is("LIVE_SEND_CONFIRM", "yes-real-money") {
        why.push("LIVE_SEND_CONFIRM is not yes-real-money");
    }
    if get("BOT_PRIVATE_KEY").map_or(true, |k| k.trim().is_empty()) {
        why.push("BOT_PRIVATE_KEY is not set");
    }
    if get("ARB_EXECUTOR_ROBINHOOD").and_then(|s| crate::check::hexutil::parse_address(s.trim()).ok()).is_none() {
        why.push("ARB_EXECUTOR_ROBINHOOD is not set");
    }
    if !gate.is_real() {
        why.push("no real safety gate supplied");
    }
    why
}

/// FASTLANE_MAX_QUEUE_MS: whole ms, 1..=5000; unset / junk -> 80.
pub fn max_queue_from(raw: Option<&str>) -> Duration {
    match raw.map(|s| s.trim()).filter(|s| !s.is_empty()).and_then(|s| s.parse::<u64>().ok()) {
        Some(v) if (1..=5_000).contains(&v) => Duration::from_millis(v),
        _ => Duration::from_millis(80),
    }
}

/// Result of one fire.
#[derive(Clone, Debug, Default)]
pub struct FireRecord {
    /// "practice" or "live".
    pub mode: &'static str,
    /// True when the transaction was handed to the send endpoint.
    pub sent: bool,
    /// Signed (practice: "would send").
    pub signed: bool,
    /// Why not sent / not signed (refusal, gate, send error).
    pub why: Option<String>,
    pub route_label: String,
    pub block: u64,
    pub nonce: Option<u64>,
    /// Our transaction hash (known before sending).
    pub hash: Option<String>,
    pub to: Option<Address>,
    pub min_profit: Option<U256>,
    pub max_block: Option<U256>,
    pub max_fee_per_gas: Option<u128>,
    pub gas_limit: Option<u64>,
    pub calldata_len: usize,
    pub calldata_us: u64,
    pub gate_us: u64,
    pub sign_us: u64,
    /// Fire start -> bytes written to the socket (live only).
    pub handed_us: Option<u64>,
    /// Live send state at return: Unknown = written (or not confirmed in
    /// time), final answer comes through the reply hook WITH the hash;
    /// NotWritten / StaleInQueue = never left us. None = no send attempted.
    pub send_status: Option<SendStatus>,
    /// found_at -> fire start (how long the trade waited for us).
    pub found_to_fire_us: u64,
}

/// Settings (env names in the header / mod.rs).
pub struct GunConfig {
    pub mode: Mode,
    /// Really broadcast (live switches all set).
    pub broadcast: bool,
    pub executor: Option<Address>,
    /// Max wait for "handed to socket".
    pub hand_timeout: Duration,
    /// FASTLANE_MAX_QUEUE_MS [80]: a signed trade older than this when a
    /// connection is free is dropped unsent (stale_in_queue).
    pub max_queue: Duration,
}

/// The sender.
pub struct Gun {
    cfg: GunConfig,
    signer: Signer,
    gas: Arc<Gas>,
    nonce: Arc<NonceTracker>,
    rpc: Option<Arc<dyn ReadRpc>>,
    pool: Option<SendPool>,
    gate: Arc<dyn Gate>,
    on_reply: Arc<dyn Fn(&SendOutcome) + Send + Sync>,
    stop: Arc<AtomicBool>,
    /// Practice-mode nonce (never synced: no network in practice).
    practice_nonce: AtomicU64,
    pub fires: AtomicU64,
}

impl Drop for Gun {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Gun {
    /// Build from env. None when FASTLANE=off. `gate` = workstream D's safety
    /// gate; `on_reply` gets every live send's outcome (D's bridge).
    pub fn from_env(gate: Arc<dyn Gate>, on_reply: Arc<dyn Fn(&SendOutcome) + Send + Sync>) -> Result<Option<Gun>, String> {
        Self::from_lookup(&|k: &str| std::env::var(k).ok(), gate, on_reply, None)
    }

    /// `from_env` from any key -> value lookup (tests: a map, so "live but
    /// no key" can be proven without touching the process environment).
    /// `rpc`: the read node (None = ROBINHOOD_FAST_RPC / the public node).
    pub fn from_lookup(get: &dyn Fn(&str) -> Option<String>, gate: Arc<dyn Gate>, on_reply: Arc<dyn Fn(&SendOutcome) + Send + Sync>, rpc: Option<Arc<dyn ReadRpc>>) -> Result<Option<Gun>, String> {
        let mode = Mode::parse(get("FASTLANE").as_deref());
        if mode == Mode::Off {
            return Ok(None);
        }
        let num = |k: &str, d: u64| get(k).and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(d);
        let executor = get("ARB_EXECUTOR_ROBINHOOD").and_then(|s| crate::check::hexutil::parse_address(s.trim()).ok());
        let why_not_live = if mode == Mode::Live { live_blockers(get, gate.as_ref()) } else { Vec::new() };
        let broadcast = mode == Mode::Live && why_not_live.is_empty();
        if mode == Mode::Live && !broadcast {
            eprintln!("[fastlane] FASTLANE=live but NOT broadcasting ({}): running as practice", why_not_live.join(", "));
            if why_not_live.contains(&"BOT_PRIVATE_KEY is not set") {
                // deploy/arbsim-run.sh does not pass the wallet key to arbsim.
                eprintln!("[fastlane] live blocked: no key passed to arbsim (owner decision pending)");
            }
        }
        let signer = if broadcast {
            // The ONLY place the real key is read.
            let mut text = get("BOT_PRIVATE_KEY").unwrap_or_default();
            let s = Signer::from_hex(&text);
            zeroize::Zeroize::zeroize(&mut text);
            s.map_err(|e| format!("BOT_PRIVATE_KEY: {e}"))?
        } else {
            Signer::random()?
        };
        // M-2: practice never talks to a node (no read connection at all).
        let rpc: Option<Arc<dyn ReadRpc>> = match rpc {
            Some(r) => Some(r),
            None if !broadcast => None,
            None => Some(Arc::new(UreqRpc::new(
                get("ROBINHOOD_FAST_RPC").filter(|s| !s.trim().is_empty()).unwrap_or_else(|| super::rpc::ROBINHOOD_PUBLIC_RPC.to_string()).trim(),
                Duration::from_millis(num("FASTLANE_READ_TIMEOUT_MS", 4000)),
            ))),
        };
        let pool = if broadcast {
            let conns = num("FASTLANE_SEND_CONNS", 2) as usize;
            let timeout = Duration::from_millis(num("FASTLANE_SEND_TIMEOUT_MS", 5000));
            let warm = Duration::from_millis(num("SEND_WARM_MS", 1000).max(250));
            let url = get("ROBINHOOD_SEND_RPC").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| super::send::ROBINHOOD_SEQUENCER_RPC.to_string());
            Some(SendPool::start(&url, conns, timeout, warm)?)
        } else {
            None
        };
        let cfg = GunConfig {
            mode: if broadcast { Mode::Live } else { Mode::Practice },
            broadcast,
            executor,
            hand_timeout: Duration::from_millis(num("FASTLANE_SEND_TIMEOUT_MS", 5000)),
            max_queue: max_queue_from(get("FASTLANE_MAX_QUEUE_MS").as_deref()),
        };
        let gun = Gun::with_parts(cfg, signer, rpc, pool, gate, on_reply, GasConfig::from_env());
        gun.start_background();
        eprintln!(
            "[fastlane] gun ready: mode {}, wallet {:#x}, {}",
            gun.cfg.mode.name(),
            gun.signer.address(),
            if broadcast { "sending to the send endpoint" } else { "throwaway key, never broadcasts" }
        );
        Ok(Some(gun))
    }

    /// Assemble from parts (tests, and from_env). Nothing runs until
    /// start_background (or a manual gas refresh).
    pub fn with_parts(
        cfg: GunConfig,
        signer: Signer,
        rpc: Option<Arc<dyn ReadRpc>>,
        pool: Option<SendPool>,
        gate: Arc<dyn Gate>,
        on_reply: Arc<dyn Fn(&SendOutcome) + Send + Sync>,
        gas_cfg: GasConfig,
    ) -> Gun {
        let nonce = Arc::new(NonceTracker::new());
        Gun {
            cfg,
            signer,
            gas: Arc::new(Gas::new(gas_cfg)),
            nonce,
            rpc,
            pool,
            gate,
            on_reply,
            stop: Arc::new(AtomicBool::new(false)),
            practice_nonce: AtomicU64::new(0),
            fires: AtomicU64::new(0),
        }
    }

    /// Start the gas refresher (every 2 s); it also loads / re-syncs the
    /// nonce off the fire path. LIVE ONLY (final review M-2): in practice
    /// nothing is broadcast, so the gun makes no network calls at all.
    /// Returns true when the refresher was started.
    pub fn start_background(&self) -> bool {
        if !self.cfg.broadcast {
            return false;
        }
        let Some(rpc) = self.rpc.clone() else { return false };
        let also: Box<dyn Fn() + Send> = if self.cfg.broadcast {
            let (nonce, rpc2, who) = (self.nonce.clone(), rpc.clone(), self.signer.address());
            Box::new(move || resync_if_wanted(&nonce, rpc2.as_ref(), who))
        } else {
            Box::new(|| {})
        };
        spawn_refresher(self.gas.clone(), rpc, self.stop.clone(), also);
        true
    }

    pub fn address(&self) -> Address {
        self.signer.address()
    }
    pub fn mode(&self) -> Mode {
        self.cfg.mode
    }
    /// THE answer to "is the gun live right now" (H3: the single source of
    /// truth for the send record's mode). True only when ALL hold: built for
    /// live with every switch set (cfg.broadcast, mode live), a send pool and
    /// an executor exist, the gate is a real one, and the gate allows
    /// broadcasting right now.
    pub fn broadcasting(&self) -> bool {
        self.why_not_broadcasting().is_none()
    }

    /// Why broadcasting() is false (None = it is true).
    pub fn why_not_broadcasting(&self) -> Option<&'static str> {
        if !(self.cfg.broadcast && self.cfg.mode == Mode::Live) {
            return Some("not in live mode");
        }
        if self.pool.is_none() {
            return Some("no send connection");
        }
        if self.cfg.executor.is_none() {
            return Some("no trade contract set");
        }
        if !self.gate.is_real() {
            return Some("no real safety gate (refusing to broadcast)");
        }
        if !self.gate.may_broadcast_now() {
            return Some("safety gate: broadcasting not allowed right now");
        }
        None
    }
    pub fn gas(&self) -> &Arc<Gas> {
        &self.gas
    }
    pub fn nonce(&self) -> &Arc<NonceTracker> {
        &self.nonce
    }

    /// A sent trade was never mined (the receipt tracker says so): its nonce
    /// is free again; the next background tick re-syncs from the chain.
    pub fn trade_dropped(&self) {
        self.nonce.dropped();
    }

    /// Not ready to send live (None = ready). Practice needs nothing from
    /// the network, so it is always ready.
    pub fn not_ready(&self) -> Option<&'static str> {
        if !self.cfg.broadcast {
            return None;
        }
        if self.gas.max_fee().is_none() {
            return Some("gas price not read yet");
        }
        if self.cfg.broadcast && self.nonce.peek().is_none() {
            return Some("nonce not loaded yet");
        }
        None
    }

    /// Build the contract call (same steps as the Node loop senders).
    pub fn plan(&self, c: &CallInput, now: Instant) -> Result<CallPlan, String> {
        // Blocker 2: the deadline is the feed tip's OWN block (the block
        // the trade was found on) + FASTLANE_MAX_BLOCK_MARGIN. Live still
        // needs fresh block info (the gas price must be current).
        if self.cfg.broadcast && !self.gas.fresh(now) {
            return Err("block info stale".into());
        }
        if self.cfg.broadcast && c.block == 0 {
            return Err("no block number".into());
        }
        let max_block = U256::from(c.block.saturating_add(self.gas.fast_margin()));
        let min_profit = match usd_to_token_units(c.net_usd, c.usd_per_token_in, c.token_in_decimals) {
            Units::Exact(v) if !v.is_zero() => v,
            Units::Exact(_) => return Err("profit floor rounds to zero".into()),
            _ => return Err("profit floor out of range".into()),
        };
        let to = match (self.cfg.executor, self.cfg.broadcast) {
            (Some(a), _) => a,
            (None, true) => return Err("no trade contract set".into()),
            (None, false) => Address::ZERO,
        };
        if c.hops.is_empty() {
            return Err("route has no hops".into());
        }
        if let Funding::V3Flash(l) = c.funding {
            // Same rule as buildExecuteCall: a pool can't lend while it trades.
            if c.hops.iter().any(|h| h.pool == l) {
                return Err("lender pool is also a trade pool".into());
            }
        }
        let trade = Trade { token: c.token_in, amount_in: c.amount_in, min_profit, max_block, hops: c.hops.clone() };
        let data = encode_for_funding(&trade, c.funding).map_err(|e: CallErr| e.to_string())?;
        Ok(CallPlan { to, data, min_profit, max_block, funding: c.funding })
    }

    /// Fire one trade (see file header).
    pub fn fire(&self, c: &CallInput) -> FireRecord {
        let t0 = Instant::now();
        self.fires.fetch_add(1, Ordering::Relaxed);
        let mut rec = FireRecord {
            mode: self.cfg.mode.name(),
            route_label: c.route_label.clone(),
            block: c.block,
            found_to_fire_us: t0.saturating_duration_since(c.found_at).as_micros() as u64,
            ..Default::default()
        };
        let us = |a: Instant| a.elapsed().as_micros() as u64;

        // 1. Calldata.
        let plan = self.plan(c, t0);
        rec.calldata_us = us(t0);
        let plan = match plan {
            Ok(p) => p,
            Err(e) => {
                rec.why = Some(e);
                return rec;
            }
        };
        rec.calldata_len = plan.data.len();
        rec.to = Some(plan.to);
        rec.min_profit = Some(plan.min_profit);
        rec.max_block = Some(plan.max_block);
        if self.cfg.broadcast {
            // Built for live: every live condition must hold right now (no
            // silent fallback to practice: the caller must see the refusal).
            if let Some(w) = self.why_not_broadcasting() {
                rec.why = Some(w.into());
                return rec;
            }
            if let Some(nr) = self.not_ready() {
                rec.why = Some(nr.into());
                return rec;
            }
        }

        // 2. Safety gate (workstream D), right before signing.
        let tg = Instant::now();
        let gate = self.gate.allow(c);
        rec.gate_us = us(tg);
        if let Err(e) = gate {
            rec.why = Some(format!("safety gate: {e}"));
            return rec;
        }

        // 3. Nonce + sign.
        let ts = Instant::now();
        let nonce = if self.cfg.broadcast {
            match self.nonce.take() {
                Ok(n) => n,
                Err(e) => {
                    rec.why = Some(e.to_string());
                    return rec;
                }
            }
        } else {
            self.practice_nonce.fetch_add(1, Ordering::Relaxed)
        };
        let max_fee = self.gas.max_fee().unwrap_or(0);
        let gas_limit = self.gas.current_gas_limit();
        let fields = TxFields {
            chain_id: CHAIN_ID,
            nonce,
            max_priority_fee_per_gas: 0,
            max_fee_per_gas: max_fee,
            gas_limit,
            to: plan.to,
            value: U256::ZERO,
            data: plan.data,
        };
        let signed = self.signer.sign_tx(&fields);
        rec.sign_us = us(ts);
        rec.signed = true;
        rec.nonce = Some(nonce);
        rec.max_fee_per_gas = Some(max_fee);
        rec.gas_limit = Some(gas_limit);
        let hash = format!("{:#x}", signed.hash);
        rec.hash = Some(hash.clone());

        // 4. Send (live) or log "would send" (practice).
        // Live only if broadcasting() holds at this very moment (checked again
        // after signing: the kill switch may have just been turned on).
        let pool = match self.pool.as_ref() {
            Some(p) if self.cfg.broadcast => {
                if let Some(w) = self.why_not_broadcasting() {
                    self.nonce.unused(nonce);
                    rec.why = Some(w.into());
                    return rec;
                }
                Some(p)
            }
            _ => None,
        };
        let Some(pool) = pool else {
            eprintln!(
                "[fastlane] would send {} (block {}): net ${:.2} on ${:.0}, {} bytes, calldata {} us, gate {} us, sign {} us",
                c.route_label,
                c.block,
                c.net_usd,
                c.size_usd,
                rec.calldata_len,
                rec.calldata_us,
                rec.gate_us,
                rec.sign_us
            );
            return rec;
        };
        let (htx, hrx) = mpsc::sync_channel(1);
        let (nonce_t, rpc, who, hook) = (self.nonce.clone(), self.rpc.clone(), self.signer.address(), self.on_reply.clone());
        let job = Job {
            raw: signed.raw,
            nonce,
            hash,
            t0,
            queued_at: Instant::now(),
            max_queue: self.cfg.max_queue,
            handed: htx,
            done: Box::new(move |out: SendOutcome| {
                match (out.status, &out.result) {
                    (SendStatus::Accepted, _) => nonce_t.accepted(out.nonce),
                    // Written, no answer: may be on chain. Never re-sign it.
                    (SendStatus::Unknown, _) => nonce_t.unknown(out.nonce),
                    // Never left us: the number is free for the next fire.
                    (SendStatus::StaleInQueue, _) => nonce_t.unused(out.nonce),
                    (_, Err(e)) => nonce_t.failed(out.nonce, e),
                    (_, Ok(_)) => nonce_t.accepted(out.nonce),
                }
                hook(&out);
                // Re-sync right away when it is due (off the fire path).
                if let Some(r) = rpc.as_ref() {
                    resync_if_wanted(&nonce_t, r.as_ref(), who);
                }
            }),
        };
        if let Err(e) = pool.submit(job) {
            self.nonce.unused(nonce);
            rec.why = Some(e);
            rec.send_status = Some(SendStatus::NotWritten);
            return rec;
        }
        // Wait for "handed to socket" no longer than the queue limit plus a
        // little for the write itself (a reconnect can take a moment): the
        // job then either goes out or is dropped stale, and the reply hook
        // says which, with the hash.
        let wait = self.cfg.hand_timeout.min(self.cfg.max_queue + Duration::from_millis(250));
        match hrx.recv_timeout(wait) {
            Ok(Ok(h)) => {
                rec.sent = true;
                rec.handed_us = Some(h);
                // Final answer (accepted / refused / unknown) comes through the hook.
                rec.send_status = Some(SendStatus::Unknown);
            }
            Ok(Err((st, e))) => {
                rec.why = Some(e);
                rec.send_status = Some(st);
            }
            Err(_) => {
                rec.why = Some("send not confirmed handed in time (result comes through the reply hook)".into());
                rec.send_status = Some(SendStatus::Unknown);
            }
        }
        rec
    }
}

/// Load / re-sync the nonce from the chain when the tracker wants it.
fn resync_if_wanted(nonce: &NonceTracker, rpc: &dyn ReadRpc, who: Address) {
    if !nonce.wants_resync() {
        return;
    }
    let remote = pending_nonce(rpc, who).ok();
    if let Some(line) = nonce.resync(remote) {
        eprintln!("{line}");
    }
}

/// Hex of the calldata (records / tests).
pub fn plan_hex(p: &CallPlan) -> String {
    to_hex(&p.data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_words_match_workstream_d() {
        assert_eq!(Mode::parse(None), Mode::Off);
        assert_eq!(Mode::parse(Some("")), Mode::Off);
        assert_eq!(Mode::parse(Some(" Practice ")), Mode::Practice);
        assert_eq!(Mode::parse(Some("shadow")), Mode::Practice);
        assert_eq!(Mode::parse(Some("dry")), Mode::Practice);
        assert_eq!(Mode::parse(Some("LIVE")), Mode::Live);
        assert_eq!(Mode::parse(Some("yes")), Mode::Off);
    }
}
