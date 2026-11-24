//! LIVE TRADER: real buys and sells that follow the paper trader's decisions.
//!
//! The paper trader keeps running exactly as before and keeps deciding WHAT
//! to buy and WHEN to sell. When live mode is on, this layer mirrors some of
//! those decisions with real money, under hard limits, and records what
//! really happened next to what paper expected.
//!
//! Venues (how each swap is built: liveroute.rs):
//!   Uniswap V3  SwapRouter02 (unchanged).
//!   Uniswap V4  Uniswap's Universal Router + Permit2; WETH, USDG or native
//!               ETH pools; pools whose hook can change amounts are refused.
//!   Uniswap V2  the same Universal Router; OFF unless SNIPER_LIVE_VENUES
//!               lists v2 (turn on only after a passing V2 live-dryrun).
//! Base coin: whatever the pool trades against (WETH, USDG or, V4 only,
//! native ETH). The wallet must already hold it; live mode never swaps
//! one base into another. Size is SNIPER_LIVE_MAX_USD in that coin.
//!
//! Safety rules:
//!
//! - Off unless SNIPER_MODE=live AND the gate is open (SNIPER_LIVE=1, the
//!   owner's approval phrase, a 0600 key file, sizes under the hard caps; see
//!   live.rs). If live mode is asked for and the gate is closed, the bot
//!   refuses to start; it never silently trades paper instead.
//! - One real position at a time, a fixed small size (default $5).
//! - Optional trading hours (SNIPER_LIVE_HOURS, e.g. "20-8" Toronto time).
//! - Daily loss cap on disk (survives restarts): no new buy that could take
//!   today's loss past it.
//! - New buys halt after 3 failed transactions in a row, or after any
//!   transaction whose fate is unknown (never double-sends).
//! - Keeps an ETH reserve for gas so a sell is always possible.
//! - Exact approvals only (also through Permit2, which expires in 10
//!   minutes), a minimum-out on every swap, a 2-minute deadline.
//! - An open position is saved to disk; after a crash or restart the first
//!   thing it does is sell it.
//! - Stale-signal guard (the dex bot's PR #249 lesson: never send a trade
//!   decided behind the feed tip): a buy is refused when the rush it
//!   answers is already more than SNIPER_LIVE_MAX_BEHIND_BLOCKS (default 5,
//!   ~0.5 s) blocks old at the moment the order would go out, measured by
//!   the paper trader's own `delay` record (behind_blocks; total_ms is
//!   shown in the reason). Logged as a live_skip. Paper keeps trading such
//!   rushes as before (so we keep measuring them). 0 = guard off.
//!
//! BLOCKING, AND WHY A SLOW RECEIPT CAN'T LEAVE PAPER AND LIVE OUT OF STEP:
//!   A live buy and sell wait for their receipts INSIDE the paper trader's
//!   main loop (up to RECEIPT_WAIT = 20 s each). While waiting, nothing else
//!   is watched; the paper twin of a buy is opened only after the live buy
//!   returns, so both clocks start together. Acceptable for one $5
//!   position; must become non-blocking before more positions or bigger
//!   sizes.
//!   The live position is written to disk BEFORE the buy is sent (marked
//!   "pending"). If the buy's receipt does not come in time, the position
//!   stays on record (and live mode halts new buys), so tokens that land
//!   late are never forgotten: the sell path sells whatever the wallet
//!   really holds. A pending position with no tokens is only dropped once
//!   the buy's own deadline has passed (after that it can no longer fill).
//!   A sell whose fate is unknown keeps the position too and remembers the
//!   base balance before it, so a sell that did land is still measured.
//!
//! Real result = base back - base spent - gas actually paid, measured from
//! wallet balances and receipts, never from quotes.

use crate::live::{self, Gate, Ledger, Outcome, Sender, Signer};
use crate::liveroute::{self, LiveTx, RouterCfg};
use crate::paper::Pool;
use crate::sellcheck::Rpc;
use crate::venue::{Venue, VenueKind, NATIVE_ETH};
use ruint::aliases::U256;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// WETH on Robinhood Chain.
pub const WETH: &str = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
/// USDG on Robinhood Chain (6 decimals).
pub const USDG: &str = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
/// Normal sell: accept up to 3% worse than the quote.
pub const SLIP_BPS: u64 = 300;
/// Emergency sell (stop loss, failed quote, leftover after a restart).
pub const EMERGENCY_SLIP_BPS: u64 = 1500;
/// Stop opening new trades after this many failed transactions in a row.
pub const MAX_FAILS: u32 = 3;
/// Keep at least this much ETH for gas (sells must always be affordable).
pub const MIN_ETH_RESERVE: f64 = 0.0005;
/// How long to wait for a receipt before calling a transaction "unknown".
pub const RECEIPT_WAIT: Duration = Duration::from_secs(20);
/// Every swap expires this many seconds after it is built.
pub const DEADLINE_SECS: u64 = 120;
/// U256 -> f64 (good to ~15 digits; for money display and P&L only).
pub fn uf(x: U256) -> f64 {
    x.to_string().parse::<f64>().unwrap_or(0.0)
}

/// Toronto offset used for trading hours (EST; summer time is not handled).
pub const TORONTO_OFFSET_H: i64 = -5;

/// Decimals of a base coin by name ("USDG" 6, WETH and ETH 18).
pub fn base_dec(base: &str) -> i32 {
    crate::rhc::base_decimals(base)
}

/// How much base coin buys `usd` (raw units).
pub fn base_amount(usd: f64, usd_per_base: f64, dec: i32) -> U256 {
    if !(usd > 0.0 && usd_per_base > 0.0) {
        return U256::ZERO;
    }
    U256::from((usd / usd_per_base * 10f64.powi(dec)) as u128)
}

/// One real position (also saved to disk while open).
#[derive(Clone, Debug, PartialEq)]
pub struct LivePos {
    pub pool: String,
    pub token: String,
    /// LP fee in millionths (V3 also uses it to pick the pool).
    pub fee: u32,
    /// Base coin really spent (measured from the wallet; the plan while pending).
    pub base_in: U256,
    /// Tokens really received (0 while pending).
    pub tokens: U256,
    pub usd_per_base: f64,
    pub gas_eth: f64,
    pub opened_unix: u64,
    /// What paper expected for ITS buy (tokens, at paper's size), for the comparison.
    pub paper_tokens: U256,
    /// Paper's size for that buy (USD).
    pub paper_usd_in: f64,
    /// Which exchange type, with what its swap needs.
    pub venue: Venue,
    /// "WETH", "USDG" or "ETH", and its address (0x000..0 for native ETH).
    pub base: String,
    pub base_addr: String,
    /// Buy transactions (hashes), for the record and late checks.
    pub buy_hashes: Vec<String>,
    /// The buy was sent but its result is not known yet.
    pub pending: bool,
    /// The buy's swap deadline (unix seconds): after it, it can't fill.
    pub deadline: u64,
    /// Set when a sell's fate was unknown: base balance just before it.
    pub sell_base_before: Option<U256>,
}

impl LivePos {
    pub fn to_json(&self) -> Value {
        json!({"pool": self.pool, "token": self.token, "fee": self.fee, "base_in": self.base_in.to_string(),
               "tokens": self.tokens.to_string(), "usd_per_base": self.usd_per_base, "gas_eth": self.gas_eth,
               "opened_unix": self.opened_unix, "paper_tokens": self.paper_tokens.to_string(), "paper_usd_in": self.paper_usd_in,
               "venue": liveroute::venue_to_json(&self.venue), "base": self.base, "base_addr": self.base_addr,
               "buy_hashes": self.buy_hashes, "pending": self.pending, "deadline": self.deadline,
               "sell_base_before": self.sell_base_before.map(|x| x.to_string())})
    }

    /// Read back. Files written before V4/V2 live support (V3 + WETH only)
    /// still load: missing venue = V3 with the saved fee, missing base = WETH.
    pub fn from_json(v: &Value) -> Option<LivePos> {
        let u = |k: &str| v[k].as_str().and_then(|s| U256::from_str_radix(s, 10).ok());
        let fee = v["fee"].as_u64()? as u32;
        let base = v["base"].as_str().unwrap_or("WETH").to_string();
        Some(LivePos {
            pool: v["pool"].as_str()?.to_string(),
            token: v["token"].as_str()?.to_string(),
            fee,
            base_in: u("base_in")?,
            tokens: u("tokens")?,
            usd_per_base: v["usd_per_base"].as_f64()?,
            gas_eth: v["gas_eth"].as_f64().unwrap_or(0.0),
            opened_unix: v["opened_unix"].as_u64().unwrap_or(0),
            paper_tokens: u("paper_tokens").unwrap_or(U256::ZERO),
            paper_usd_in: v["paper_usd_in"].as_f64().unwrap_or(0.0),
            venue: if v["venue"].is_null() { Venue::V3 { fee } } else { liveroute::venue_from_json(&v["venue"])? },
            base_addr: v["base_addr"].as_str().map(str::to_string).unwrap_or_else(|| if base == "USDG" { USDG.into() } else { WETH.into() }),
            base,
            buy_hashes: v["buy_hashes"].as_array().map(|a| a.iter().filter_map(|h| h.as_str().map(str::to_string)).collect()).unwrap_or_default(),
            pending: v["pending"].as_bool().unwrap_or(false),
            deadline: v["deadline"].as_u64().unwrap_or(0),
            sell_base_before: u("sell_base_before"),
        })
    }

    fn native(&self) -> bool {
        self.base_addr.eq_ignore_ascii_case(NATIVE_ETH)
    }
}

/// Trading hours "20-8" -> (20, 8). Empty or "all" = always.
pub fn parse_hours(s: &str) -> Result<Option<(u32, u32)>, String> {
    let s = s.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("all") {
        return Ok(None);
    }
    let (a, b) = s.split_once('-').ok_or(format!("SNIPER_LIVE_HOURS '{s}' should look like 20-8"))?;
    let (a, b) = (a.trim().parse::<u32>().map_err(|e| e.to_string())?, b.trim().parse::<u32>().map_err(|e| e.to_string())?);
    if a > 23 || b > 24 || a == b {
        return Err(format!("SNIPER_LIVE_HOURS '{s}' is not a valid window"));
    }
    Ok(Some((a, b)))
}

/// Is `hour` (0-23) inside the window? Handles windows over midnight.
pub fn in_hours(window: Option<(u32, u32)>, hour: u32) -> bool {
    match window {
        None => true,
        Some((a, b)) if a < b => hour >= a && hour < b,
        Some((a, b)) => hour >= a || hour < b,
    }
}

/// Toronto hour now (fixed EST offset).
pub fn toronto_hour(now: SystemTime) -> u32 {
    let s = now.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) + TORONTO_OFFSET_H * 3600;
    (s.rem_euclid(86_400) / 3600) as u32
}

/// Real result of a round trip in USD for an 18-decimal base (WETH/ETH).
pub fn real_net_usd(base_in: U256, base_out: U256, usd_per_base: f64, gas_eth: f64, usd_per_eth: f64) -> f64 {
    real_net_usd_dec(base_in, base_out, 18, usd_per_base, gas_eth, usd_per_eth)
}

/// Real result of a round trip in USD: (base back - base in) in the base
/// coin's own decimals, times its USD price, minus the gas paid in ETH.
pub fn real_net_usd_dec(base_in: U256, base_out: U256, dec: i32, usd_per_base: f64, gas_eth: f64, usd_per_eth: f64) -> f64 {
    let f = |x: U256| uf(x) / 10f64.powi(dec);
    (f(base_out) - f(base_in)) * usd_per_base - gas_eth * usd_per_eth
}

/// Base coin really spent on a buy, from the wallet before and after.
/// Native ETH paid the gas from the same balance, so the gas comes off.
pub fn spent_from(before: U256, after: U256, native: bool, gas_wei: U256) -> U256 {
    let d = before.saturating_sub(after);
    if native {
        d.saturating_sub(gas_wei)
    } else {
        d
    }
}

/// Base coin really received on a sell (native ETH: the gas is added back).
pub fn received_from(before: U256, after: U256, native: bool, gas_wei: U256) -> U256 {
    if native {
        (after + gas_wei).saturating_sub(before)
    } else {
        after.saturating_sub(before)
    }
}

/// Filled vs quoted, in percent (+ = got more than quoted). None if no quote.
pub fn fill_vs_quote_pct(filled: U256, quoted: U256) -> Option<f64> {
    (!quoted.is_zero()).then(|| (uf(filled) / uf(quoted) - 1.0) * 100.0)
}

/// Default for SNIPER_LIVE_MAX_BEHIND_BLOCKS (Robinhood: ~0.1 s a block).
pub const MAX_BEHIND_BLOCKS: u64 = 5;

/// Stale-signal guard: why a buy must NOT be sent because its rush is too
/// old by the time the order would go out (None = fresh enough).
/// `delay` is the paper trader's delay record for this buy (behind_blocks =
/// how many blocks the newest block we know is past the rush's block;
/// total_ms = rush in hand -> buy ready). A missing measure is treated as
/// stale (never trade on a signal we can't date). `max_behind` 0 = off.
pub fn stale_reason(delay: &Value, max_behind: u64) -> Option<String> {
    if max_behind == 0 {
        return None;
    }
    let total = delay["total_ms"].as_f64().map_or("?".to_string(), |t| format!("{t:.0}"));
    match delay["behind_blocks"].as_u64() {
        None => Some(format!("stale signal: no delay measure (need at most {max_behind} blocks behind)")),
        Some(b) if b > max_behind => Some(format!("stale signal: rush {b} blocks behind the newest block (max {max_behind}), {total} ms to decide")),
        Some(_) => None,
    }
}

/// SNIPER_LIVE_MAX_BEHIND_BLOCKS from a lookup (default 5; 0 = off).
pub fn max_behind_from(get: impl Fn(&str) -> Option<String>) -> u64 {
    get("SNIPER_LIVE_MAX_BEHIND_BLOCKS").and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(MAX_BEHIND_BLOCKS)
}

/// Why live mode won't open a trade right now (None = it may).
/// `venue_why` = liveroute::venue_refusal for this pool (venue switch,
/// unsafe V4 hook, unsupported base).
pub fn refuse_reason(halted: Option<&str>, has_open: bool, venue_why: Option<String>, hours_ok: bool, ledger_ok: bool) -> Option<String> {
    if let Some(h) = halted {
        return Some(format!("halted: {h}"));
    }
    if has_open {
        return Some("a live position is already open".into());
    }
    if let Some(v) = venue_why {
        return Some(v);
    }
    if !hours_ok {
        return Some("outside live trading hours".into());
    }
    if !ledger_ok {
        return Some("daily loss cap reached".into());
    }
    None
}

/// Live settings other than the gate: router, venues, stale guard.
#[derive(Clone, Debug, PartialEq)]
pub struct LiveCfg {
    pub router: RouterCfg,
    pub venues: Vec<VenueKind>,
    pub max_behind_blocks: u64,
}

impl LiveCfg {
    pub fn from_lookup(get: &dyn Fn(&str) -> Option<String>) -> Result<LiveCfg, String> {
        Ok(LiveCfg { router: RouterCfg::from_lookup(get)?, venues: liveroute::live_venues_from(get)?, max_behind_blocks: max_behind_from(get) })
    }
}

/// How the SWAP of a batch ended (approvals are reported as errors only).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwapFate {
    /// Included and succeeded.
    Done,
    /// Proven not done: reverted, refused by the node, or never sent.
    Failed,
    /// Might have happened: no receipt in time, or no answer to the send.
    Unknown,
}

/// What one batch (approvals + swap) did.
#[derive(Clone, Debug)]
pub struct RunOut {
    /// (label, hash) of every transaction signed.
    pub txs: Vec<(String, String)>,
    pub gas_eth: f64,
    pub gas_wei: U256,
    pub swap: SwapFate,
    pub error: Option<String>,
}

impl RunOut {
    fn txs_json(&self) -> Value {
        Value::Array(self.txs.iter().map(|(l, h)| json!({"what": l, "hash": h})).collect())
    }
}

pub struct LiveTrader {
    pub sender: Sender,
    pub gate: Gate,
    pub ledger: Ledger,
    pub hours: Option<(u32, u32)>,
    pub open: Option<LivePos>,
    pub halted: Option<String>,
    pub fails: u32,
    /// Router, live venues, stale-signal guard.
    pub cfg: LiveCfg,
    state_path: PathBuf,
    log_path: PathBuf,
    rpc: Rpc,
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl LiveTrader {
    /// Build from the environment. Err = live mode must NOT start (the
    /// caller refuses to run at all, with these reasons).
    pub fn from_env(read_url: &str, out: &Path) -> Result<LiveTrader, String> {
        let gate = Gate::from_env().map_err(|v| format!("live gate closed: {}", v.join("; ")))?;
        let cfg = LiveCfg::from_lookup(&|k| std::env::var(k).ok())?;
        let signer = Signer::from_file(&gate.key_file)?;
        let sender = Sender::new(Rpc::new(read_url), Rpc::new(&live::send_url_from_env()), signer)?;
        let ledger = Ledger::load(&gate.ledger, live::utc_day(SystemTime::now()))?;
        let hours = parse_hours(&std::env::var("SNIPER_LIVE_HOURS").unwrap_or_default())?;
        Ok(LiveTrader::assemble(sender, gate, ledger, hours, cfg, read_url, out))
    }

    /// Put the parts together (also used by tests with a fake node). Loads
    /// a position left open on disk.
    pub fn assemble(sender: Sender, gate: Gate, ledger: Ledger, hours: Option<(u32, u32)>, cfg: LiveCfg, read_url: &str, out: &Path) -> LiveTrader {
        let state_path = out.join("live_open.json");
        let open = std::fs::read_to_string(&state_path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| LivePos::from_json(&v));
        LiveTrader { sender, gate, ledger, hours, open, halted: None, fails: 0, cfg, state_path, log_path: out.join("live_trades.jsonl"), rpc: Rpc::new(read_url) }
    }

    pub fn address(&self) -> String {
        self.sender.signer.address().to_string()
    }

    fn eth_wei(&self) -> Result<U256, String> {
        let r = self.rpc.call("eth_getBalance", json!([self.address(), "latest"]))?;
        let h = r.as_str().unwrap_or("0x0").trim_start_matches("0x");
        U256::from_str_radix(if h.is_empty() { "0" } else { h }, 16).map_err(|e| e.to_string())
    }

    /// The wallet's balance of a base coin (native ETH read as ETH).
    fn base_balance(&self, addr: &str) -> Result<U256, String> {
        if addr.eq_ignore_ascii_case(NATIVE_ETH) {
            self.eth_wei()
        } else {
            self.sender.balance(addr)
        }
    }

    /// A fresh quote at the latest block, the same way paper prices this
    /// venue (V3 QuoterV2, V4 V4Quoter, V2 reserves maths).
    fn quote(&self, v: &Venue, token_in: &str, token_out: &str, amount: U256) -> Result<U256, String> {
        let call = |to: &str, data: &str| -> Result<Option<String>, String> {
            let r = self.rpc.call("eth_call", json!([{"to": to, "data": data}, "latest"]))?;
            Ok(r.as_str().map(str::to_string))
        };
        crate::paper::quote_via(&call, v, token_in, token_out, amount).map(|(out, _)| out)
    }

    fn log(&self, v: Value) {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&self.log_path) {
            let _ = writeln!(f, "{v}");
        }
    }

    fn save_open(&self) {
        match &self.open {
            Some(p) => {
                // Temp file then rename: a crash mid-write can't leave half a file.
                let tmp = self.state_path.with_extension("tmp");
                if std::fs::write(&tmp, p.to_json().to_string()).and_then(|_| std::fs::rename(&tmp, &self.state_path)).is_err() {
                    eprintln!("LIVE: could not save the open position file");
                }
            }
            None => {
                let _ = std::fs::remove_file(&self.state_path);
            }
        }
    }

    fn fail(&mut self, what: &str) {
        self.fails += 1;
        if self.fails >= MAX_FAILS {
            self.halted = Some(format!("{MAX_FAILS} failed transactions in a row (last: {what})"));
        }
    }

    /// Send a batch (approvals then the swap, last) and wait for every
    /// receipt. Any doubt about the swap halts new buys (never double-send).
    fn run(&mut self, txs: &[LiveTx], what: &str) -> RunOut {
        let mut out = RunOut { txs: Vec::new(), gas_eth: 0.0, gas_wei: U256::ZERO, swap: SwapFate::Failed, error: None };
        let last = txs.len().saturating_sub(1);
        let sent = match self.sender.send_txs(txs) {
            Ok(s) => s,
            Err(e) => {
                let e = format!("{what}: {e}");
                self.fail(&e);
                out.error = Some(e);
                return out; // nothing sent: the swap provably did not happen
            }
        };
        out.txs = sent.hashes.iter().enumerate().map(|(i, h)| (txs.get(i).map(|t| t.label.clone()).unwrap_or_default(), h.clone())).collect();
        let mut err: Option<String> = None;
        let mut swap = SwapFate::Failed;
        for (i, h) in sent.hashes.iter().take(sent.accepted).enumerate() {
            let fate = match self.sender.wait(h, RECEIPT_WAIT) {
                Outcome::Ok { gas_used, gas_price, .. } => {
                    out.gas_wei += U256::from(gas_used) * gas_price;
                    SwapFate::Done
                }
                Outcome::Reverted { gas_used, gas_price, .. } => {
                    out.gas_wei += U256::from(gas_used) * gas_price;
                    err.get_or_insert(format!("{what}: transaction {h} reverted"));
                    SwapFate::Failed
                }
                Outcome::Unknown => {
                    self.halted = Some(format!("{what}: transaction {h} not confirmed in {}s (fate unknown)", RECEIPT_WAIT.as_secs()));
                    err.get_or_insert(format!("{what}: transaction {h} unknown"));
                    SwapFate::Unknown
                }
            };
            if i == last {
                swap = fate;
            }
        }
        if let Some((i, e, definite)) = &sent.error {
            err.get_or_insert(format!("{what}: send refused after {i} of {}: {e}", txs.len()));
            if *i == last && !definite {
                // The swap itself got no answer: it may be out there.
                self.halted = Some(format!("{what}: no answer when sending the swap (fate unknown)"));
                swap = SwapFate::Unknown;
            }
        }
        out.gas_eth = uf(out.gas_wei) / 1e18;
        out.swap = swap;
        match err {
            None => self.fails = 0,
            Some(e) => {
                self.fail(&e);
                out.error = Some(e);
            }
        }
        out
    }

    /// May we open a real trade on this pool now?
    pub fn refuse(&self, info: &Pool) -> Option<String> {
        refuse_reason(
            self.halted.as_deref(),
            self.open.is_some(),
            liveroute::venue_refusal(&info.venue, info.base, &self.cfg.venues, &self.cfg.router),
            in_hours(self.hours, toronto_hour(SystemTime::now())),
            self.ledger.allows(self.gate.max_trade_usd, self.gate.max_day_loss_usd),
        )
    }

    /// The stale-signal guard for one buy (see `stale_reason`).
    pub fn refuse_stale(&self, delay: &Value) -> Option<String> {
        stale_reason(delay, self.cfg.max_behind_blocks)
    }

    /// Real buy of `gate.max_trade_usd` worth of the pool's base coin into
    /// `info.token`. `paper_tokens` / `paper_usd_in` = paper's own buy (its
    /// size can differ), logged side by side.
    pub fn buy(&mut self, pool: &str, info: &Pool, usd_per_base: f64, paper_tokens: U256, paper_usd_in: f64) -> Result<(), String> {
        if let Some(why) = self.refuse(info) {
            return Err(why);
        }
        if usd_per_base <= 0.0 {
            return Err(format!("no {} price", info.base));
        }
        let dec = base_dec(info.base);
        let base_in = base_amount(self.gate.max_trade_usd, usd_per_base, dec);
        if base_in.is_zero() {
            return Err("trade size rounds to zero".into());
        }
        let native = info.base_addr.eq_ignore_ascii_case(NATIVE_ETH);
        let reserve = U256::from((MIN_ETH_RESERVE * 1e18) as u128);
        let eth = self.eth_wei()?;
        if eth < reserve {
            self.halted = Some("ETH for gas below reserve".into());
            return Err("ETH for gas below reserve".into());
        }
        let show = |x: U256| uf(x) / 10f64.powi(dec);
        if native {
            if eth < base_in + reserve {
                return Err(format!("wallet has {:.6} ETH, needs {:.6} plus the {MIN_ETH_RESERVE} ETH gas reserve", show(eth), show(base_in)));
            }
        } else {
            let have = self.sender.balance(&info.base_addr)?;
            if have < base_in {
                return Err(format!("wallet has {:.6} {b}, needs {:.6} {b} (live never swaps between base coins)", show(have), show(base_in), b = info.base));
            }
        }
        let quote = self.quote(&info.venue, &info.base_addr, &info.token, base_in)?;
        if quote.is_zero() {
            return Err("quote is zero".into());
        }
        let min = live::min_out(quote, SLIP_BPS);
        let tok_before = self.sender.balance(&info.token)?;
        let base_before = self.base_balance(&info.base_addr)?;
        let now = now_unix();
        let txs = liveroute::trade_txs(&info.venue, &self.cfg.router, &self.address(), &info.base_addr, info.base, &info.token, base_in, min, now + DEADLINE_SECS, now)?;
        // Write the position down BEFORE sending, marked pending: whatever
        // happens to the receipt, tokens that arrive are never forgotten.
        let mut pos = LivePos {
            pool: pool.to_string(),
            token: info.token.clone(),
            fee: info.fee,
            base_in,
            tokens: U256::ZERO,
            usd_per_base,
            gas_eth: 0.0,
            opened_unix: now,
            paper_tokens,
            paper_usd_in,
            venue: info.venue.clone(),
            base: info.base.to_string(),
            base_addr: info.base_addr.clone(),
            buy_hashes: vec![],
            pending: true,
            deadline: now + DEADLINE_SECS,
            sell_base_before: None,
        };
        self.open = Some(pos.clone());
        self.save_open();
        let r = self.run(&txs, "buy");
        pos.buy_hashes = r.txs.iter().map(|(_, h)| h.clone()).collect();
        pos.gas_eth = r.gas_eth;
        let venue = info.venue_name();
        match r.swap {
            SwapFate::Done => {
                let tokens = self.sender.balance(&info.token)?.saturating_sub(tok_before);
                let base_after = self.base_balance(&info.base_addr)?;
                pos.base_in = spent_from(base_before, base_after, native, r.gas_wei);
                pos.tokens = tokens;
                pos.pending = false;
                let live_per_usd = uf(tokens) / self.gate.max_trade_usd;
                let paper_per_usd = if paper_usd_in > 0.0 { uf(paper_tokens) / paper_usd_in } else { 0.0 };
                self.log(json!({"event": "buy", "venue": venue, "pool": pool, "token": info.token, "base": info.base, "usd": self.gate.max_trade_usd,
                                "base_planned": base_in.to_string(), "base_spent": pos.base_in.to_string(),
                                "quote_tokens": quote.to_string(), "min_tokens": min.to_string(), "tokens": tokens.to_string(),
                                "fill_vs_quote_pct": fill_vs_quote_pct(tokens, quote), "gas_eth": r.gas_eth, "txs": r.txs_json(),
                                "paper_usd_in": paper_usd_in, "paper_tokens": paper_tokens.to_string(),
                                "paper_tokens_per_usd": paper_per_usd, "live_tokens_per_usd": live_per_usd,
                                "live_vs_paper_pct": (paper_per_usd > 0.0).then(|| (live_per_usd / paper_per_usd - 1.0) * 100.0),
                                "warning": r.error, "pos": pos.to_json()}));
                eprintln!("LIVE: BUY {} [{venue}] ${:.2} of {} -> {} tokens (quote {}, paper {} for ${paper_usd_in:.0})", info.token, self.gate.max_trade_usd, info.base, tokens, quote, paper_tokens);
                self.open = Some(pos);
                self.save_open();
                Ok(())
            }
            SwapFate::Failed => {
                self.log(json!({"event": "buy_failed", "venue": venue, "pool": pool, "token": info.token, "error": r.error, "gas_eth": r.gas_eth, "txs": r.txs_json()}));
                // Proven not filled (only gas was lost, shown in the log line).
                self.open = None;
                self.save_open();
                Err(r.error.unwrap_or_else(|| "buy failed".into()))
            }
            SwapFate::Unknown => {
                // Keep it pending (on disk too) and halted: the sell path
                // will sell whatever arrives.
                self.log(json!({"event": "buy_unknown", "venue": venue, "pool": pool, "token": info.token, "error": r.error, "txs": r.txs_json(), "pos": pos.to_json()}));
                self.open = Some(pos);
                self.save_open();
                Err(r.error.unwrap_or_else(|| "buy fate unknown".into()))
            }
        }
    }

    /// Sell everything of the open position. `emergency` widens the
    /// allowed slippage (stop loss, failed quote, restart cleanup).
    pub fn sell(&mut self, reason: &str, emergency: bool, paper_net: Option<f64>, usd_per_eth: f64) -> Result<f64, String> {
        let Some(mut pos) = self.open.clone() else { return Err("no live position".into()) };
        let dec = base_dec(&pos.base);
        let native = pos.native();
        let tokens = self.sender.balance(&pos.token)?;
        if tokens.is_zero() {
            return self.nothing_to_sell(pos, reason, usd_per_eth);
        }
        let slip = if emergency { EMERGENCY_SLIP_BPS } else { SLIP_BPS };
        // No quote = sell at any price (we want out); logged as quote 0.
        let quote = self.quote(&pos.venue, &pos.token, &pos.base_addr, tokens).unwrap_or(U256::ZERO);
        let min = live::min_out(quote, slip);
        let base_before = self.base_balance(&pos.base_addr)?;
        let now = now_unix();
        let txs = liveroute::trade_txs(&pos.venue, &self.cfg.router, &self.address(), &pos.token, "token", &pos.base_addr, tokens, min, now + DEADLINE_SECS, now)?;
        let what = if emergency { "emergency sell" } else { "sell" };
        let r = self.run(&txs, what);
        match r.swap {
            SwapFate::Done => {}
            SwapFate::Failed => {
                pos.gas_eth += r.gas_eth;
                self.log(json!({"event": "sell_failed", "venue": pos.venue.kind().name(), "token": pos.token, "reason": reason, "error": r.error, "gas_eth": r.gas_eth, "txs": r.txs_json()}));
                self.open = Some(pos);
                self.save_open();
                return Err(r.error.unwrap_or_else(|| "sell failed".into()));
            }
            SwapFate::Unknown => {
                pos.gas_eth += r.gas_eth;
                pos.sell_base_before = Some(base_before);
                self.log(json!({"event": "sell_unknown", "venue": pos.venue.kind().name(), "token": pos.token, "reason": reason, "error": r.error, "txs": r.txs_json()}));
                self.open = Some(pos);
                self.save_open();
                return Err(r.error.unwrap_or_else(|| "sell fate unknown".into()));
            }
        }
        let base_after = self.base_balance(&pos.base_addr)?;
        let base_out = received_from(base_before, base_after, native, r.gas_wei);
        let gas_total = pos.gas_eth + r.gas_eth;
        let net = real_net_usd_dec(pos.base_in, base_out, dec, pos.usd_per_base, gas_total, usd_per_eth);
        self.ledger.record(net);
        self.ledger.save(&self.gate.ledger)?;
        let usd_in = uf(pos.base_in) / 10f64.powi(dec) * pos.usd_per_base;
        self.log(json!({"event": "sell", "venue": pos.venue.kind().name(), "pool": pos.pool, "token": pos.token, "base": pos.base, "reason": reason, "emergency": emergency,
                        "tokens_sold": tokens.to_string(), "quote_base": quote.to_string(), "min_base": min.to_string(),
                        "fill_vs_quote_pct": fill_vs_quote_pct(base_out, quote),
                        "base_in": pos.base_in.to_string(), "base_out": base_out.to_string(), "gas_eth": gas_total, "txs": r.txs_json(),
                        "real_net_usd": net, "real_pct": (usd_in > 0.0).then(|| net / usd_in * 100.0),
                        "paper_net_usd": paper_net, "paper_usd_in": pos.paper_usd_in,
                        "paper_pct": paper_net.filter(|_| pos.paper_usd_in > 0.0).map(|n| n / pos.paper_usd_in * 100.0),
                        "held_s": now_unix().saturating_sub(pos.opened_unix), "day_realized_usd": self.ledger.realized_usd, "warning": r.error}));
        eprintln!("LIVE: SELL {} [{}] ({reason}) real ${net:+.2} vs paper {:?} | today ${:+.2}", pos.token, pos.venue.kind().name(), paper_net, self.ledger.realized_usd);
        self.open = None;
        self.save_open();
        Ok(net)
    }

    /// The wallet holds none of the token. Three cases:
    ///   - the buy is still pending and could still fill: keep waiting;
    ///   - an earlier sell's fate was unknown and it DID land: measure it now;
    ///   - otherwise nothing is left: close, counted as a full loss for the
    ///     daily cap (we can't prove otherwise; the safe direction).
    fn nothing_to_sell(&mut self, pos: LivePos, reason: &str, usd_per_eth: f64) -> Result<f64, String> {
        let dec = base_dec(&pos.base);
        if pos.pending && pos.tokens.is_zero() {
            if now_unix() <= pos.deadline + 60 {
                return Err("buy not settled yet (no tokens, its deadline has not passed): waiting".into());
            }
            // Past its deadline the buy can no longer fill: nothing was bought.
            self.log(json!({"event": "buy_never_filled", "token": pos.token, "txs": pos.buy_hashes}));
            self.open = None;
            self.save_open();
            return Err("buy never filled (deadline passed)".into());
        }
        let net = match pos.sell_base_before {
            Some(before) => {
                let after = self.base_balance(&pos.base_addr)?;
                let out = received_from(before, after, pos.native(), U256::ZERO);
                real_net_usd_dec(pos.base_in, out, dec, pos.usd_per_base, pos.gas_eth, usd_per_eth)
            }
            None => real_net_usd_dec(pos.base_in, U256::ZERO, dec, pos.usd_per_base, pos.gas_eth, usd_per_eth),
        };
        self.ledger.record(net);
        self.ledger.save(&self.gate.ledger)?;
        self.log(json!({"event": "sell_nothing", "token": pos.token, "reason": reason, "measured": pos.sell_base_before.is_some(), "real_net_usd": net, "day_realized_usd": self.ledger.realized_usd}));
        self.open = None;
        self.save_open();
        if pos.sell_base_before.is_some() {
            Ok(net)
        } else {
            Err("wallet holds none of the token (counted as a full loss)".into())
        }
    }

    /// One status line for the heartbeat.
    pub fn status(&self) -> String {
        format!(
            "LIVE: today ${:+.2} over {} trades (cap -${:.0}) | open: {}{} | {}",
            self.ledger.realized_usd,
            self.ledger.trades,
            self.gate.max_day_loss_usd,
            self.open.as_ref().map(|p| p.token.as_str()).unwrap_or("none"),
            if self.open.as_ref().is_some_and(|p| p.pending) { " (buy pending)" } else { "" },
            self.halted.as_deref().map(|h| format!("HALTED: {h}")).unwrap_or_else(|| "ok".into())
        )
    }
}

/// `sniper wallet-status`: address and balances of the live wallet. Needs
/// only the key file (no trading, no gate), prints no secret.
pub fn wallet_status(read_url: &str) -> Result<String, String> {
    let key = std::env::var("SNIPER_KEY_FILE").map_err(|_| "SNIPER_KEY_FILE not set".to_string())?;
    let signer = Signer::from_file(Path::new(&key))?;
    let addr = signer.address().to_string();
    drop(signer);
    let rpc = Rpc::new(read_url);
    let hexu = |v: &Value| U256::from_str_radix(v.as_str().unwrap_or("0x0").trim_start_matches("0x"), 16).unwrap_or(U256::ZERO);
    let eth = uf(hexu(&rpc.call("eth_getBalance", json!([addr, "latest"]))?)) / 1e18;
    let data = format!("0x{}", crate::fourmeme::hex(&live::data_balance(&addr)?));
    let bal = |token: &str| rpc.call("eth_call", json!([{"to": token, "data": data}, "latest"])).map(|v| hexu(&v));
    let weth = uf(bal(WETH)?) / 1e18;
    let usdg = uf(bal(USDG)?) / 1e6;
    let cfg = LiveCfg::from_lookup(&|k| std::env::var(k).ok());
    let cfg_line = match cfg {
        Ok(c) => format!("router {} (shape {}) | live venues {}", c.router.address, c.router.layout.name(), c.venues.iter().map(|k| k.name()).collect::<Vec<_>>().join(",")),
        Err(e) => format!("live settings problem: {e}"),
    };
    Ok(format!("live wallet {addr}\n  ETH (gas, and native-ETH V4 pools): {eth:.6}\n  WETH (trading): {weth:.6}\n  USDG (trading): {usdg:.2}\n  {cfg_line}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hours_window_over_midnight() {
        let w = parse_hours("20-8").unwrap();
        assert!(in_hours(w, 20) && in_hours(w, 23) && in_hours(w, 0) && in_hours(w, 7));
        assert!(!in_hours(w, 8) && !in_hours(w, 12) && !in_hours(w, 19));
        let d = parse_hours("8-20").unwrap();
        assert!(in_hours(d, 8) && !in_hours(d, 20) && !in_hours(d, 3));
        assert_eq!(parse_hours("").unwrap(), None);
        assert!(in_hours(None, 13));
        assert!(parse_hours("8-8").is_err() && parse_hours("x").is_err() && parse_hours("25-3").is_err());
    }

    #[test]
    fn refuse_order_and_reasons() {
        assert_eq!(refuse_reason(None, false, None, true, true), None);
        assert!(refuse_reason(Some("3 fails"), false, None, true, true).unwrap().contains("halted"));
        assert!(refuse_reason(None, true, None, true, true).unwrap().contains("already open"));
        assert!(refuse_reason(None, false, Some("V4 pool's hook can change swap amounts".into()), true, true).unwrap().contains("hook"));
        assert!(refuse_reason(None, false, None, false, true).unwrap().contains("hours"));
        assert!(refuse_reason(None, false, None, true, false).unwrap().contains("loss cap"));
        // Order: halted beats everything, then open, then venue.
        assert!(refuse_reason(Some("x"), true, Some("v".into()), false, false).unwrap().contains("halted"));
        assert!(refuse_reason(None, true, Some("v".into()), false, false).unwrap().contains("already open"));
    }

    #[test]
    fn refuse_reasons_for_real_pools() {
        // The same refusal the trader uses, on paper's own Pool records.
        let cfg = LiveCfg::from_lookup(&|_| None).unwrap();
        let why = |p: &Pool| liveroute::venue_refusal(&p.venue, p.base, &cfg.venues, &cfg.router);
        let v3 = crate::paper::v3_pool_from(
            &format!("0x{:0>64}", "1111111111111111111111111111111111111111"),
            &format!("0x{:0>64}", WETH.trim_start_matches("0x")),
            "0x0bb8",
            &format!("0x{:0>64}", crate::paper::V3_FACTORY.trim_start_matches("0x")),
        )
        .unwrap();
        assert_eq!(why(&v3), None);
        let key = crate::venue::V4Key { currency0: NATIVE_ETH.into(), currency1: "0x1111111111111111111111111111111111111111".into(), fee: 3000, tick_spacing: 60, hooks: NATIVE_ETH.into() };
        let v4 = crate::paper::v4_pool(&key).unwrap();
        assert_eq!(v4.base, "ETH");
        assert_eq!(why(&v4), None);
        let hooked = crate::paper::v4_pool(&crate::venue::V4Key { hooks: "0x0000000000000000000000000000000000000004".into(), ..key.clone() }).unwrap();
        assert!(why(&hooked).unwrap().contains("hook"));
        let v4u = crate::paper::v4_pool(&crate::venue::V4Key { currency0: "0x1111111111111111111111111111111111111111".into(), currency1: USDG.into(), ..key }).unwrap();
        assert_eq!((v4u.base, why(&v4u)), ("USDG", None));
        let v2 = crate::paper::v2_pool_from("0x2222222222222222222222222222222222222222", USDG, "0x1111111111111111111111111111111111111111", crate::venue::V2_FACTORY).unwrap();
        assert!(why(&v2).unwrap().contains("V2 is off"));
    }

    #[test]
    fn stale_signal_guard() {
        let d = |b: u64, t: f64| json!({"behind_blocks": b, "total_ms": t});
        assert_eq!(stale_reason(&d(0, 120.0), 5), None);
        assert_eq!(stale_reason(&d(5, 600.0), 5), None, "exactly at the line is still allowed");
        let r = stale_reason(&d(6, 700.0), 5).unwrap();
        assert!(r.starts_with("stale signal") && r.contains("6 blocks behind") && r.contains("700 ms"), "{r}");
        assert!(stale_reason(&json!({}), 5).unwrap().contains("no delay measure"), "undated = stale");
        assert_eq!(stale_reason(&d(50, 1.0), 0), None, "0 = guard off");
        assert_eq!(max_behind_from(|_| None), 5);
        assert_eq!(max_behind_from(|_| Some(" 2 ".into())), 2);
        assert_eq!(max_behind_from(|_| Some("junk".into())), 5);
    }

    #[test]
    fn real_result_counts_gas() {
        let e18 = U256::from(10u64).pow(U256::from(18u64));
        // 0.01 WETH in, 0.0105 back at $2000/ETH = +$1, minus 0.0001 ETH gas ($0.20) = +$0.80
        let net = real_net_usd(e18 / U256::from(100u64), e18 * U256::from(105u64) / U256::from(10_000u64), 2000.0, 0.0001, 2000.0);
        assert!((net - 0.8).abs() < 1e-6, "{net}");
    }

    #[test]
    fn real_result_per_base_coin() {
        // USDG (6 decimals): $5.00 in, $5.10 back, 0.00001 ETH gas at $3000 = +$0.07.
        let net = real_net_usd_dec(U256::from(5_000_000u64), U256::from(5_100_000u64), 6, 1.0, 0.00001, 3000.0);
        assert!((net - 0.07).abs() < 1e-9, "{net}");
        // Native ETH: balances move by the swap AND the gas. Buy: 1.0 -> 0.9969 ETH
        // with 0.0001 gas = 0.003 spent; sell: 0.9969 -> 0.99995 with 0.00005 gas
        // = 0.0031 received. Net = +0.0001 ETH - 0.00015 gas = -0.00005 ETH.
        let e = |x: f64| U256::from((x * 1e18).round() as u128);
        let spent = spent_from(e(1.0), e(0.9969), true, e(0.0001));
        assert_eq!(spent, e(0.003));
        let got = received_from(e(0.9969), e(0.99995), true, e(0.00005));
        assert_eq!(got, e(0.0031));
        let net = real_net_usd(spent, got, 3000.0, 0.00015, 3000.0);
        assert!((net + 0.15).abs() < 1e-6, "{net}");
        // ERC-20 bases: gas is paid in ETH, so the base balance move is the swap only.
        assert_eq!(spent_from(e(2.0), e(1.5), false, e(0.1)), e(0.5));
        assert_eq!(received_from(e(1.5), e(2.1), false, e(0.1)), e(0.6));
        // Fill vs quote.
        assert!((fill_vs_quote_pct(U256::from(99u64), U256::from(100u64)).unwrap() + 1.0).abs() < 1e-9);
        assert_eq!(fill_vs_quote_pct(U256::from(1u64), U256::ZERO), None);
        // Size per base: $5 at $2,500/ETH = 0.002 ETH; $5 of USDG = 5,000,000 raw.
        assert_eq!(base_amount(5.0, 2500.0, 18), e(0.002));
        assert_eq!(base_amount(5.0, 1.0, 6), U256::from(5_000_000u64));
        assert_eq!(base_amount(5.0, 0.0, 18), U256::ZERO);
    }

    #[test]
    fn open_position_survives_restart_file() {
        let p = LivePos {
            pool: "0xpool".into(),
            token: "0xtok".into(),
            fee: 3000,
            base_in: U256::from(123u64),
            tokens: U256::from(456u64),
            usd_per_base: 1800.0,
            gas_eth: 0.0001,
            opened_unix: 42,
            paper_tokens: U256::from(450u64),
            paper_usd_in: 100.0,
            venue: Venue::V4 { key: crate::venue::V4Key { currency0: NATIVE_ETH.into(), currency1: "0x1111111111111111111111111111111111111111".into(), fee: 3000, tick_spacing: 60, hooks: NATIVE_ETH.into() } },
            base: "ETH".into(),
            base_addr: NATIVE_ETH.into(),
            buy_hashes: vec!["0xaa".into(), "0xbb".into()],
            pending: true,
            deadline: 162,
            sell_base_before: Some(U256::from(9u64)),
        };
        assert_eq!(LivePos::from_json(&p.to_json()), Some(p));
        assert_eq!(LivePos::from_json(&json!({"pool": "x"})), None);
        // A file written by the V3-only version still loads (as V3 + WETH).
        let old = json!({"pool": "0xp", "token": "0xt", "fee": 500, "base_in": "1", "tokens": "2", "usd_per_base": 3000.0, "gas_eth": 0.0, "opened_unix": 1, "paper_tokens": "2"});
        let o = LivePos::from_json(&old).unwrap();
        assert_eq!((o.venue, o.base.as_str(), o.base_addr.as_str(), o.pending), (Venue::V3 { fee: 500 }, "WETH", WETH, false));
    }

    #[test]
    fn toronto_hour_is_utc_minus_5() {
        // 2026-11-17 13:00 UTC = 08:00 Toronto
        let t = UNIX_EPOCH + Duration::from_secs(1_794_920_400);
        assert_eq!(toronto_hour(t), 8);
    }
}
