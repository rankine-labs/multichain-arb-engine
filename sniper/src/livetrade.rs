//! LIVE TRADER: real buys and sells that follow the paper trader's decisions.
//!
//! The paper trader keeps running exactly as before and keeps deciding WHAT
//! to buy and WHEN to sell. When live mode is on, this layer mirrors some of
//! those decisions with real money, under hard limits, and records what
//! really happened next to what paper expected.
//!
//! Safety rules:
//!
//! - Off unless SNIPER_MODE=live AND the gate is open (SNIPER_LIVE=1, the
//!   owner's approval phrase, a 0600 key file, sizes under the hard caps; see
//!   live.rs). If live mode is asked for and the gate is closed, the bot
//!   refuses to start; it never silently trades paper instead.
//! - Uniswap V3 pools with WETH on one side only (the sender is SwapRouter02).
//! - One real position at a time, a fixed small size (default $5).
//! - Optional trading hours (SNIPER_LIVE_HOURS, e.g. "20-8" Toronto time).
//! - Daily loss cap on disk (survives restarts): no new buy that could take
//!   today's loss past it.
//! - New buys halt after 3 failed transactions in a row, or after any
//!   transaction whose fate is unknown (never double-sends).
//! - Keeps an ETH reserve for gas so a sell is always possible.
//! - Exact approvals only, a minimum-out on every swap, a 2-minute deadline.
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
//! KNOWN LIMIT (not built yet, must be fixed before scaling): a live buy
//! and sell wait for their receipts INSIDE the paper trader's main loop
//! (up to RECEIPT_WAIT = 20 s each). While waiting, nothing else is
//! watched. Acceptable for one $5 position; must become non-blocking
//! before more positions or bigger sizes.
//!
//! Real result = WETH back - WETH spent - gas actually paid, measured from
//! wallet balances and receipts, never from quotes.

use crate::live::{self, Gate, Ledger, Outcome, Sender, Signer};
use crate::paper::Pool;
use crate::sellcheck::Rpc;
use ruint::aliases::U256;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// WETH on Robinhood Chain (the only base live mode trades against).
pub const WETH: &str = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
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
/// U256 -> f64 (good to ~15 digits; for money display and P&L only).
pub fn uf(x: U256) -> f64 {
    x.to_string().parse::<f64>().unwrap_or(0.0)
}

/// Toronto offset used for trading hours (EST; summer time is not handled).
pub const TORONTO_OFFSET_H: i64 = -5;

/// One real position (also saved to disk while open).
#[derive(Clone, Debug, PartialEq)]
pub struct LivePos {
    pub pool: String,
    pub token: String,
    pub fee: u32,
    pub base_in: U256,
    pub tokens: U256,
    pub usd_per_base: f64,
    pub gas_eth: f64,
    pub opened_unix: u64,
    /// What paper expected for the same buy (tokens), for the comparison.
    pub paper_tokens: U256,
}

impl LivePos {
    pub fn to_json(&self) -> Value {
        json!({"pool": self.pool, "token": self.token, "fee": self.fee, "base_in": self.base_in.to_string(),
               "tokens": self.tokens.to_string(), "usd_per_base": self.usd_per_base, "gas_eth": self.gas_eth,
               "opened_unix": self.opened_unix, "paper_tokens": self.paper_tokens.to_string()})
    }

    pub fn from_json(v: &Value) -> Option<LivePos> {
        let u = |k: &str| v[k].as_str().and_then(|s| U256::from_str_radix(s, 10).ok());
        Some(LivePos {
            pool: v["pool"].as_str()?.to_string(),
            token: v["token"].as_str()?.to_string(),
            fee: v["fee"].as_u64()? as u32,
            base_in: u("base_in")?,
            tokens: u("tokens")?,
            usd_per_base: v["usd_per_base"].as_f64()?,
            gas_eth: v["gas_eth"].as_f64().unwrap_or(0.0),
            opened_unix: v["opened_unix"].as_u64().unwrap_or(0),
            paper_tokens: u("paper_tokens").unwrap_or(U256::ZERO),
        })
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

/// Real result of a round trip in USD: base back - base in - gas.
pub fn real_net_usd(base_in: U256, base_out: U256, usd_per_base: f64, gas_eth: f64, usd_per_eth: f64) -> f64 {
    let f = |x: U256| uf(x) / 1e18;
    (f(base_out) - f(base_in)) * usd_per_base - gas_eth * usd_per_eth
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
pub fn refuse_reason(halted: Option<&str>, has_open: bool, venue_is_v3: bool, base_is_weth: bool, hours_ok: bool, ledger_ok: bool) -> Option<String> {
    if let Some(h) = halted {
        return Some(format!("halted: {h}"));
    }
    if has_open {
        return Some("a live position is already open".into());
    }
    if !venue_is_v3 {
        return Some("live trades Uniswap V3 only".into());
    }
    if !base_is_weth {
        return Some("live trades WETH pools only".into());
    }
    if !hours_ok {
        return Some("outside live trading hours".into());
    }
    if !ledger_ok {
        return Some("daily loss cap reached".into());
    }
    None
}

pub struct LiveTrader {
    pub sender: Sender,
    pub gate: Gate,
    pub ledger: Ledger,
    pub hours: Option<(u32, u32)>,
    pub open: Option<LivePos>,
    pub halted: Option<String>,
    pub fails: u32,
    /// Stale-signal guard (SNIPER_LIVE_MAX_BEHIND_BLOCKS, 0 = off).
    pub max_behind_blocks: u64,
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
        let signer = Signer::from_file(&gate.key_file)?;
        let sender = Sender::new(Rpc::new(read_url), Rpc::new(&live::send_url_from_env()), signer)?;
        let ledger = Ledger::load(&gate.ledger, live::utc_day(SystemTime::now()))?;
        let hours = parse_hours(&std::env::var("SNIPER_LIVE_HOURS").unwrap_or_default())?;
        let state_path = out.join("live_open.json");
        let open = std::fs::read_to_string(&state_path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| LivePos::from_json(&v));
        let lt = LiveTrader { sender, gate, ledger, hours, open, halted: None, fails: 0, max_behind_blocks: max_behind_from(|k| std::env::var(k).ok()), state_path, log_path: out.join("live_trades.jsonl"), rpc: Rpc::new(read_url) };
        Ok(lt)
    }

    pub fn address(&self) -> String {
        self.sender.signer.address().to_string()
    }

    fn eth_balance(&self) -> Result<f64, String> {
        let r = self.rpc.call("eth_getBalance", json!([self.address(), "latest"]))?;
        let h = r.as_str().unwrap_or("0x0").trim_start_matches("0x");
        Ok(uf(U256::from_str_radix(if h.is_empty() { "0" } else { h }, 16).map_err(|e| e.to_string())?) / 1e18)
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
                let _ = std::fs::write(&self.state_path, p.to_json().to_string());
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

    /// Send a batch and wait for every receipt. Ok(gas ETH paid) only if
    /// all succeeded. An unknown outcome halts live mode (never double-send).
    fn run(&mut self, txs: &[(String, Vec<u8>, u64)], what: &str) -> Result<f64, String> {
        let hashes = self.sender.send_all(txs).inspect_err(|e| self.fail(&format!("{what}: {e}")))?;
        let mut gas_eth = 0.0;
        let mut err = None;
        for h in &hashes {
            match self.sender.wait(h, RECEIPT_WAIT) {
                Outcome::Ok { gas_used, gas_price, .. } => gas_eth += uf(U256::from(gas_used) * gas_price) / 1e18,
                Outcome::Reverted { gas_used, gas_price, .. } => {
                    gas_eth += uf(U256::from(gas_used) * gas_price) / 1e18;
                    err.get_or_insert(format!("{what}: transaction {h} reverted"));
                }
                Outcome::Unknown => {
                    self.halted = Some(format!("{what}: transaction {h} not confirmed in {}s (fate unknown)", RECEIPT_WAIT.as_secs()));
                    err.get_or_insert(format!("{what}: transaction {h} unknown"));
                }
            }
        }
        match err {
            None => {
                self.fails = 0;
                Ok(gas_eth)
            }
            Some(e) => {
                self.fail(&e);
                Err(e)
            }
        }
    }

    /// May we open a real trade on this pool now?
    pub fn refuse(&self, info: &Pool) -> Option<String> {
        let v3 = matches!(info.venue, crate::venue::Venue::V3 { .. });
        refuse_reason(
            self.halted.as_deref(),
            self.open.is_some(),
            v3,
            info.base_addr.eq_ignore_ascii_case(WETH),
            in_hours(self.hours, toronto_hour(SystemTime::now())),
            self.ledger.allows(self.gate.max_trade_usd, self.gate.max_day_loss_usd),
        )
    }

    /// The stale-signal guard for one buy (see `stale_reason`).
    pub fn refuse_stale(&self, delay: &Value) -> Option<String> {
        stale_reason(delay, self.max_behind_blocks)
    }

    /// Real buy of `gate.max_trade_usd` worth of WETH into `info.token`.
    pub fn buy(&mut self, pool: &str, info: &Pool, usd_per_base: f64, paper_tokens: U256) -> Result<(), String> {
        if let Some(why) = self.refuse(info) {
            return Err(why);
        }
        let fee = match info.venue {
            crate::venue::Venue::V3 { fee } => fee,
            _ => return Err("not V3".into()),
        };
        if usd_per_base <= 0.0 {
            return Err("no ETH price".into());
        }
        let base_in = U256::from((self.gate.max_trade_usd / usd_per_base * 1e18) as u128);
        let weth = self.sender.balance(WETH)?;
        if weth < base_in {
            return Err(format!("wallet has {:.6} WETH, needs {:.6}", uf(weth) / 1e18, uf(base_in) / 1e18));
        }
        if self.eth_balance()? < MIN_ETH_RESERVE {
            self.halted = Some("ETH for gas below reserve".into());
            return Err("ETH for gas below reserve".into());
        }
        let quote = crate::live::quote_now(&self.rpc, WETH, &info.token, fee, base_in)?;
        let before = self.sender.balance(&info.token)?;
        let txs = live::swap_pair(&self.address(), WETH, &info.token, fee, base_in, live::min_out(quote, SLIP_BPS), now_unix() + 120)?;
        let gas_eth = self.run(&txs, "buy")?;
        let tokens = self.sender.balance(&info.token)?.saturating_sub(before);
        let pos = LivePos { pool: pool.to_string(), token: info.token.clone(), fee, base_in, tokens, usd_per_base, gas_eth, opened_unix: now_unix(), paper_tokens };
        self.log(json!({"event": "buy", "pos": pos.to_json(), "quote_tokens": quote.to_string()}));
        eprintln!("LIVE: BUY {} ${:.2} -> {} tokens (paper expected {})", info.token, self.gate.max_trade_usd, tokens, paper_tokens);
        self.open = Some(pos);
        self.save_open();
        Ok(())
    }

    /// Sell everything of the open position. `emergency` widens the
    /// allowed slippage (stop loss, failed quote, restart cleanup).
    pub fn sell(&mut self, reason: &str, emergency: bool, paper_net: Option<f64>, usd_per_eth: f64) -> Result<f64, String> {
        let Some(pos) = self.open.clone() else { return Err("no live position".into()) };
        let tokens = self.sender.balance(&pos.token)?;
        if tokens.is_zero() {
            self.log(json!({"event": "sell_nothing", "token": pos.token, "reason": reason}));
            self.open = None;
            self.save_open();
            return Err("wallet holds none of the token".into());
        }
        let slip = if emergency { EMERGENCY_SLIP_BPS } else { SLIP_BPS };
        let quote = crate::live::quote_now(&self.rpc, &pos.token, WETH, pos.fee, tokens).unwrap_or(U256::ZERO);
        let weth_before = self.sender.balance(WETH)?;
        let txs = live::swap_pair(&self.address(), &pos.token, WETH, pos.fee, tokens, live::min_out(quote, slip), now_unix() + 120)?;
        let gas = self.run(&txs, if emergency { "emergency sell" } else { "sell" })?;
        let base_out = self.sender.balance(WETH)?.saturating_sub(weth_before);
        let net = real_net_usd(pos.base_in, base_out, pos.usd_per_base, pos.gas_eth + gas, usd_per_eth);
        self.ledger.record(net);
        self.ledger.save(&self.gate.ledger)?;
        self.log(json!({"event": "sell", "token": pos.token, "reason": reason, "emergency": emergency, "base_in": pos.base_in.to_string(),
                        "base_out": base_out.to_string(), "gas_eth": pos.gas_eth + gas, "real_net_usd": net, "paper_net_usd": paper_net,
                        "held_s": now_unix().saturating_sub(pos.opened_unix), "day_realized_usd": self.ledger.realized_usd}));
        eprintln!("LIVE: SELL {} ({reason}) real ${net:+.2} vs paper {:?} | today ${:+.2}", pos.token, paper_net, self.ledger.realized_usd);
        self.open = None;
        self.save_open();
        Ok(net)
    }

    /// One status line for the heartbeat.
    pub fn status(&self) -> String {
        format!(
            "LIVE: today ${:+.2} over {} trades (cap -${:.0}) | open: {} | {}",
            self.ledger.realized_usd,
            self.ledger.trades,
            self.gate.max_day_loss_usd,
            self.open.as_ref().map(|p| p.token.as_str()).unwrap_or("none"),
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
    let rpc = Rpc::new(read_url);
    let eth = rpc.call("eth_getBalance", json!([addr, "latest"]))?;
    let eth = uf(U256::from_str_radix(eth.as_str().unwrap_or("0x0").trim_start_matches("0x"), 16).unwrap_or(U256::ZERO)) / 1e18;
    let data = format!("0x{}", crate::fourmeme::hex(&live::data_balance(&addr)?));
    let w = rpc.call("eth_call", json!([{"to": WETH, "data": data}, "latest"]))?;
    let weth = uf(U256::from_str_radix(w.as_str().unwrap_or("0x0").trim_start_matches("0x"), 16).unwrap_or(U256::ZERO)) / 1e18;
    Ok(format!("live wallet {addr}\n  ETH (gas): {eth:.6}\n  WETH (trading): {weth:.6}"))
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
        assert_eq!(refuse_reason(None, false, true, true, true, true), None);
        assert!(refuse_reason(Some("3 fails"), false, true, true, true, true).unwrap().contains("halted"));
        assert!(refuse_reason(None, true, true, true, true, true).unwrap().contains("already open"));
        assert!(refuse_reason(None, false, false, true, true, true).unwrap().contains("V3"));
        assert!(refuse_reason(None, false, true, false, true, true).unwrap().contains("WETH"));
        assert!(refuse_reason(None, false, true, true, false, true).unwrap().contains("hours"));
        assert!(refuse_reason(None, false, true, true, true, false).unwrap().contains("loss cap"));
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
        // 0.01 WETH in, 0.0105 back at $2000/ETH = +$1, minus 0.0001 ETH gas = $0.20
        let net = real_net_usd(e18 / U256::from(100u64), e18 * U256::from(105u64) / U256::from(10_000u64), 2000.0, 0.0001, 2000.0);
        assert!((net - 0.8).abs() < 1e-6, "{net}");
    }

    #[test]
    fn open_position_survives_restart_file() {
        let p = LivePos { pool: "0xpool".into(), token: "0xtok".into(), fee: 3000, base_in: U256::from(123u64), tokens: U256::from(456u64), usd_per_base: 1800.0, gas_eth: 0.0001, opened_unix: 42, paper_tokens: U256::from(450u64) };
        assert_eq!(LivePos::from_json(&p.to_json()), Some(p));
        assert_eq!(LivePos::from_json(&json!({"pool": "x"})), None);
    }

    #[test]
    fn toronto_hour_is_utc_minus_5() {
        // 2026-11-17 13:00 UTC = 08:00 Toronto
        let t = UNIX_EPOCH + Duration::from_secs(1_794_920_400);
        assert_eq!(toronto_hour(t), 8);
    }
}
