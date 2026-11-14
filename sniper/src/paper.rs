// ============================================================================
// PAPER TRADER (Robinhood Chain): the fast buy/sell idea, live, no money.
//
// Plain English:
//   1. Watch every Uniswap V3 trade on Robinhood Chain (coins priced in WETH
//      or USDG), straight from a node, a few times a second.
//   2. RUSH = at least 3 different buyers in one coin within ~1 second and
//      the price up >= 2% (the only rule that beat random entries in our
//      research). Single big buys are ignored: they lost money.
//      "Different buyers" = different wallets RECEIVING the tokens in the
//      swap log (the V3 Swap "recipient"). Limit: when people trade through
//      a router that receives the tokens itself, several real people can
//      look like one buyer (we under-count, the safe direction), and one
//      person using several wallets still looks like several buyers.
//   3. Safety filters, cheapest first. Any one failing skips the rush:
//        - "blocked token": the token is on our permanent blocklist (it
//          failed a trap check or we could not price its sale before).
//        - "no sell history": we have not yet seen at least MIN_SELLS
//          people sell this token into this pool since we started.
//        - "already jumped": the price already rose more than MAX_RISE_PCT
//          from just before the first rush buy; we would be buying the top.
//        - "unsafe": the tax/trap check (0.1% of the pool) failed.
//        - "too thin": no size in the size list survives an instant round
//          trip with <= AUTO_MAX_RT loss (fees plus our own price impact).
//        - "unsafe: real size": the trap check with OUR exact token amount
//          (all of it sold back) failed.
//   4. Size: the "auto" size (largest list size that passed the round-trip
//      test), capped at MAX_USD. Then "buy": ask Uniswap's own on-chain
//      price contract (QuoterV2) exactly how many tokens that buys right now.
//      Real pool maths, real fee, real depth. Nothing is signed or sent.
//   5. Sell at +TP%, -SL%, or after HOLD seconds, whichever comes first,
//      again with a real on-chain quote. Gas is estimated and subtracted.
//      If the sale can't even be priced, the trade counts as lost in full
//      (its own size) and the token goes on the blocklist.
//   6. One trade at a time (risk rule). Every trade and every rush we had to
//      skip is written to disk; a status line prints every minute.
//
// Honest limits (shown in the report):
//   - Reads trades from a node, ~0.1-0.3 s behind the sequencer feed, so this
//     is the "slower bot" version. The arb bot's copy would be faster.
//   - A quote is pool maths: it doesn't catch tokens that tax or block
//     transfers. (The sell-check covers that before any real money.)
//   - Our own buy isn't in the pool, so later prices don't include it; for
//     small sizes that's minor.
//
// Config (environment variables):
//   SNIPER_RHC_HTTP      node (default: free public Robinhood RPC)
//   SNIPER_OUT           output folder (default paper-out/<unix time>)
//   SNIPER_DURATION_SECS stop after (0 = until closed)
//   SNIPER_SIZES         size list in USD (default 25,50,100); every trade
//                        is also priced at each size (size study)
//   SNIPER_MAX_USD       largest trade size allowed (default 50)
//   SNIPER_AUTO_MAX_RT_PCT  max instant round-trip loss for a size (1.5)
//   SNIPER_PAPER_USD     size used ONLY if SNIPER_SIZES is empty (default 50)
//   SNIPER_MIN_SELLS     sells of the token seen in the pool before we buy (3)
//   SNIPER_MAX_RISE_PCT  skip if price already rose more than this (8)
//   SNIPER_TAXCHECK      off = skip both trap checks (default on)
//   SNIPER_TP_PCT / SNIPER_SL_PCT / SNIPER_HOLD_SECS   exits (5 / 5 / 10)
//   SNIPER_RUSH_BUYS / SNIPER_RUSH_WINDOW_S / SNIPER_RUSH_RISE_PCT  (3 / 1 / 2)
//   SNIPER_RHC_POLL_MS   how often to ask the node (default 200)
//   SNIPER_LATE_BLOCKS   race check: re-quote every buy and sell this many
//                        blocks after we decide (default 2, see below)
//
// Blocklist: saved to <out>/blocked_tokens.json and loaded at start, so a
// restart keeps it. Entries never expire during a run. Delete the file (or
// a line in it) by hand to forgive a token.
//
// Race check: the normal quote is taken the instant we decide, which assumes
// our transaction would land on that exact price. In reality it lands at
// least one block later, after other traders. So every buy and every sell is
// quoted a second time once the chain is LATE_BLOCKS blocks further on. That
// "late" result is written as an extra line ("late_for") and summed in the
// report, next to the optimistic total. Nothing waits for it: the trader
// keeps running and finishes these re-quotes as the blocks arrive.
// ============================================================================
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ruint::aliases::U256;
use serde_json::{json, Value};

use crate::fourmeme::{hex, hex_u64, keccak};
use crate::rhc::{base_decimals, sig_v3_swap};
use crate::rhc_report::token_price;
use crate::sellcheck::Rpc;

/// Uniswap V3 on Robinhood Chain (src/config/knownAddresses.ts ROBINHOOD_V3).
pub const V3_FACTORY: &str = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
pub const V3_QUOTER_V2: &str = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7";
pub const WETH: &str = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
pub const USDG: &str = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
/// Extra gas per swap on top of the quoter's estimate (router, transfers).
const GAS_OVERHEAD: u64 = 60_000;

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/// Anything that can price a swap. Real one asks the chain; tests use a fake.
pub trait Quoter {
    /// (amount out, gas estimate) for swapping `amount_in` of token_in.
    fn quote(&self, token_in: &str, token_out: &str, fee: u32, amount_in: U256) -> Result<(U256, u64), String>;
    /// Gas price in wei.
    fn gas_price(&self) -> Result<U256, String>;
}

fn word_addr(a: &str) -> String {
    format!("{:0>64}", a.trim_start_matches("0x").to_ascii_lowercase())
}

/// calldata for QuoterV2.quoteExactInputSingle((tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96))
pub fn data_quote(token_in: &str, token_out: &str, fee: u32, amount_in: U256) -> String {
    let sel = hex(&keccak(b"quoteExactInputSingle((address,address,uint256,uint24,uint160))")[..4]);
    format!("0x{sel}{}{}{amount_in:064x}{:064x}{:064x}", word_addr(token_in), word_addr(token_out), fee, 0)
}

pub struct ChainQuoter {
    pub rpc: Rpc,
}

impl Quoter for ChainQuoter {
    fn quote(&self, token_in: &str, token_out: &str, fee: u32, amount_in: U256) -> Result<(U256, u64), String> {
        let r = self
            .rpc
            .call("eth_call", json!([{"to": V3_QUOTER_V2, "data": data_quote(token_in, token_out, fee, amount_in)}, "latest"]))?;
        let h = r.as_str().ok_or("quote: no data")?.trim_start_matches("0x");
        if h.len() < 64 * 4 {
            return Err("quote: short answer".into());
        }
        // returns (amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate)
        let out = U256::from_str_radix(&h[0..64], 16).map_err(|e| e.to_string())?;
        let gas = u64::from_str_radix(h[192..256].trim_start_matches('0'), 16).unwrap_or(150_000);
        Ok((out, gas))
    }
    fn gas_price(&self) -> Result<U256, String> {
        let r = self.rpc.call("eth_gasPrice", json!([]))?;
        U256::from_str_radix(r.as_str().unwrap_or("0x0").trim_start_matches("0x"), 16).map_err(|e| e.to_string())
    }
}

/// ETH price in USDG from the deepest WETH/USDG fee tier.
pub fn eth_usd(q: &dyn Quoter) -> Option<f64> {
    let one = U256::from(10u64).pow(U256::from(18));
    [500u32, 3000, 100, 10000]
        .iter()
        .filter_map(|f| q.quote(WETH, USDG, *f, one).ok())
        .map(|(out, _)| f64::from(out) / 1e6)
        .fold(None, |a: Option<f64>, x| Some(a.map_or(x, |y| y.max(x))))
}

// ---------------------------------------------------------------------------
// Pool facts and rush detection (pure, testable)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct Pool {
    pub token: String,
    pub base: &'static str,
    pub base_addr: String,
    pub token_is0: bool,
    pub fee: u32,
}

#[derive(Clone, Debug, Default)]
struct PoolState {
    last_price: Option<f64>,
    /// Recent buys: (block, buyer wallet, price just BEFORE this buy).
    buys: VecDeque<(u64, String, f64)>,
    /// (block, last price in block), recent
    prices: VecDeque<(u64, f64)>,
    cooldown_until: u64,
}

pub struct Rules {
    pub buys: usize,
    pub window_blocks: u64,
    pub rise_pct: f64,
}

/// A rush, ready to trade.
#[derive(Clone, Debug, PartialEq)]
pub struct RushSig {
    pub pool: String,
    pub block: u64,
    pub price: f64,
    /// Price just before the first buy of this rush (for "already jumped").
    pub start_price: f64,
}

#[derive(Default)]
pub struct Detector {
    pools: HashMap<String, PoolState>,
}

impl Detector {
    /// Feed one swap (in order). `buyer` is the wallet that received the
    /// tokens (see swap_buyer). Returns a rush if this swap completes one.
    pub fn on_swap(&mut self, pool: &str, block: u64, buyer: &str, price: f64, r: &Rules) -> Option<RushSig> {
        let st = self.pools.entry(pool.to_string()).or_default();
        if let Some(prev) = st.last_price {
            if price > prev {
                st.buys.push_back((block, buyer.to_string(), prev));
            }
        }
        st.last_price = Some(price);
        match st.prices.back_mut() {
            Some((b, p)) if *b == block => *p = price,
            _ => st.prices.push_back((block, price)),
        }
        // Forget anything older than two windows.
        let lo = block.saturating_sub(r.window_blocks - 1);
        while st.buys.front().is_some_and(|(b, _, _)| *b < lo) {
            st.buys.pop_front();
        }
        while st.prices.len() > 2 && st.prices[1].0 < lo {
            st.prices.pop_front();
        }
        if block < st.cooldown_until || st.buys.len() < r.buys {
            return None;
        }
        // Count DIFFERENT buyer wallets, not buy events: one wallet splitting
        // its buy into many pieces is not a crowd.
        let buyers: HashSet<&str> = st.buys.iter().map(|(_, w, _)| w.as_str()).collect();
        if buyers.len() < r.buys {
            return None;
        }
        // Price just before the window.
        let p0 = st.prices.iter().rev().find(|(b, _)| *b < lo).map(|(_, p)| *p)?;
        if 100.0 * (price / p0 - 1.0) < r.rise_pct {
            return None;
        }
        st.cooldown_until = block + r.window_blocks;
        let start_price = st.buys.front().map_or(p0, |(_, _, before)| *before);
        Some(RushSig { pool: pool.to_string(), block, price, start_price })
    }

    pub fn last_price(&self, pool: &str) -> Option<f64> {
        self.pools.get(pool).and_then(|s| s.last_price)
    }
}

/// Who bought, from a V3 Swap log: topic 2 is the "recipient" (the wallet
/// that received what came out of the pool). Topic 1 is the "sender", which
/// is usually a router contract, so it says little about the real buyer.
/// Limit: a router that takes delivery itself hides the real wallet. If the
/// recipient is missing (malformed log), fall back to the transaction hash
/// so the old behaviour (one buy per transaction) still applies.
pub fn swap_buyer(log: &Value) -> String {
    let recipient = log["topics"]
        .as_array()
        .and_then(|t| t.get(2))
        .and_then(|t| t.as_str())
        .map(|t| t.trim_start_matches("0x"))
        .filter(|t| t.len() == 64)
        .map(|t| format!("0x{}", t[24..].to_ascii_lowercase()));
    recipient.unwrap_or_else(|| log["transactionHash"].as_str().unwrap_or("").to_string())
}

/// Is a 64-hex-digit signed number (int256) below zero? (Top bit set.)
fn word_is_negative(w: &str) -> bool {
    w.len() == 64 && w.chars().next().and_then(|c| c.to_digit(16)).is_some_and(|d| d >= 8)
}

/// Was this V3 swap a SELL of the token? A V3 Swap log's first two data
/// words are amount0 and amount1, from the pool's point of view: negative =
/// the pool paid that coin out. A sell means the pool paid out the BASE
/// coin (WETH/USDG). The base is token1 when the token is token0, and the
/// other way round.
pub fn is_sell_swap(words: &[&str], token_is0: bool) -> bool {
    let base_word = if token_is0 { words.get(1) } else { words.first() };
    base_word.is_some_and(|w| word_is_negative(w))
}

/// How many sells of its token each pool has shown since we started.
#[derive(Default)]
pub struct SellHistory {
    counts: HashMap<String, u64>,
}

impl SellHistory {
    /// Count one more sell in this pool.
    pub fn record(&mut self, pool: &str) {
        *self.counts.entry(pool.to_string()).or_default() += 1;
    }
    /// Sells seen in this pool so far (0 if none).
    pub fn count(&self, pool: &str) -> u64 {
        self.counts.get(pool).copied().unwrap_or(0)
    }
    /// Has this pool shown enough sells for us to believe people can sell?
    pub fn enough(&self, pool: &str, min_sells: u64) -> bool {
        self.count(pool) >= min_sells
    }
}

/// Percent the price rose from `start` to `now` (None if start is not > 0).
pub fn rise_pct(start: f64, now: f64) -> Option<f64> {
    (start > 0.0).then(|| 100.0 * (now / start - 1.0))
}

/// "Already jumped": the rush has already lifted the price more than
/// `max_pct`, so most of the move is behind us. An unreadable start price
/// counts as jumped (we skip what we can't measure).
pub fn already_jumped(start: f64, now: f64, max_pct: f64) -> bool {
    rise_pct(start, now).is_none_or(|r| r > max_pct)
}

/// What size to trade, or None = "too thin" (skip).
///   - `sizes` is the configured size list. If it is EMPTY there is no auto
///     size, so we use `fallback` (SNIPER_PAPER_USD), still capped.
///   - Otherwise `auto` (from pick_auto) must be above zero, then it is
///     raised to at least the smallest list size and capped at `max_usd`.
///     The cap wins if the two disagree: the cap is the safety limit.
pub fn decide_size(auto: f64, sizes: &[f64], max_usd: f64, fallback: f64) -> Option<f64> {
    let positive = |x: f64| (x > 0.0).then_some(x);
    if sizes.is_empty() {
        return positive(fallback.min(max_usd));
    }
    if auto <= 0.0 {
        return None;
    }
    let floor = sizes.iter().cloned().fold(f64::INFINITY, f64::min);
    positive(auto.max(floor).min(max_usd))
}

// ---------------------------------------------------------------------------
// Permanent blocklist (saved next to the run's other files)
// ---------------------------------------------------------------------------

/// Tokens we will never buy again: token address -> why it was blocked.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Blocklist {
    pub tokens: BTreeMap<String, String>,
}

impl Blocklist {
    /// The file name inside the output folder.
    pub const FILE: &'static str = "blocked_tokens.json";

    /// Read the blocklist. A missing file is an empty list (first run). A
    /// file we can't read or understand is an ERROR, so the trader refuses
    /// to start instead of quietly forgetting tokens that hurt us.
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = match fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(format!("blocklist {}: {e}", path.display())),
        };
        let tokens: BTreeMap<String, String> =
            serde_json::from_str(&text).map_err(|e| format!("blocklist {} is damaged ({e}); fix or delete it", path.display()))?;
        Ok(Blocklist { tokens: tokens.into_iter().map(|(k, v)| (k.to_ascii_lowercase(), v)).collect() })
    }

    /// Write the blocklist. Written to a temp file first and then renamed,
    /// so a crash mid-write can't leave a half-written file behind.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let tmp = path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(&self.tokens).map_err(|e| e.to_string())?;
        fs::write(&tmp, text).map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())
    }

    /// Is this token blocked? (Addresses compared in lower case.)
    pub fn contains(&self, token: &str) -> bool {
        self.tokens.contains_key(&token.to_ascii_lowercase())
    }

    /// Block a token. Returns true if it was new (so the caller saves).
    /// The first reason is kept if the token is already blocked.
    pub fn add(&mut self, token: &str, why: &str) -> bool {
        let k = token.to_ascii_lowercase();
        if self.tokens.contains_key(&k) {
            return false;
        }
        self.tokens.insert(k, why.to_string());
        true
    }
}

/// Skip reasons we count separately in the report (in report order). Each
/// skip line in signals.jsonl has a "why" starting with one of these.
pub const SKIP_REASONS: [&str; 5] = ["blocked token", "no sell history", "already jumped", "too thin", "unsafe"];

// ---------------------------------------------------------------------------
// The paper position
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct Position {
    pub pool: String,
    pub info: Pool,
    pub opened: Instant,
    pub open_block: u64,
    pub base_in: U256,
    pub tokens: U256,
    pub entry_price: f64,
    pub gas_in: u64,
    pub usd_per_base: f64,
    /// This trade's own size in USD (auto size, capped).
    pub usd_in: f64,
    /// Size study: the same trade priced at other sizes (usd, base_in, tokens).
    pub ladder: Vec<(f64, U256, U256)>,
    /// The size the auto-sizer would have picked (0 = none viable).
    pub auto_usd: f64,
    /// Race check: tokens the same buy would have got LATE_BLOCKS blocks
    /// later (None until that re-quote has run, or if it failed).
    pub late_tokens: Option<U256>,
}

// ---------------------------------------------------------------------------
// Race check: re-quote each trade a few blocks late (we never land instantly)
// ---------------------------------------------------------------------------

/// If a late re-quote keeps failing (node hiccup), keep retrying for this
/// many blocks past its due block (~2 s), then record it as failed.
pub const LATE_GIVE_UP_BLOCKS: u64 = 20;

/// The block at which a late re-quote should run: the block we decided at,
/// plus how many blocks late we assume we land.
pub fn late_due(decided_block: u64, late_blocks: u64) -> u64 {
    decided_block + late_blocks
}

/// Has the trader seen the chain reach `due` yet? (No block seen = not yet.)
pub fn is_due(due: u64, last_block: Option<u64>) -> bool {
    last_block.is_some_and(|b| b >= due)
}

/// Should we stop retrying a late re-quote that keeps failing?
pub fn gave_up(due: u64, last_block: u64) -> bool {
    last_block >= due + LATE_GIVE_UP_BLOCKS
}

/// How much worse the late price is than the optimistic one, in percent.
/// Both inputs are "what you get per unit" (higher is better for us), so
/// +1.0 means the late fill was 1% worse; negative means it was better.
/// None if the optimistic number is zero (nothing to compare against).
pub fn slip_pct(optimistic: f64, late: f64) -> Option<f64> {
    (optimistic > 0.0).then(|| 100.0 * (1.0 - late / optimistic))
}

/// Middle value of a list (average of the two middle ones if even).
pub fn median(v: &[f64]) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    let m = s.len() / 2;
    Some(if s.len().is_multiple_of(2) { (s[m - 1] + s[m]) / 2.0 } else { s[m] })
}

/// State of one late re-quote.
#[derive(Clone, Debug, PartialEq)]
pub enum LateQuote {
    /// Not run yet (or failed and still retrying).
    Pending,
    /// Worked: (amount out, gas estimate).
    Done(U256, u64),
    /// Kept failing until we gave up; holds the last error.
    Failed(String),
}

/// The exit half of a race check, filled in when the sell is decided.
#[derive(Clone, Debug)]
pub struct LateExit {
    /// Block at which to re-quote the sell.
    pub due: u64,
    /// The optimistic sell result (base out), if the instant quote worked.
    pub opt_out: Option<U256>,
}

/// One trade's race check: the same buy and sell, priced a few blocks late.
#[derive(Clone, Debug)]
pub struct LateTrade {
    pub pool: String,
    pub info: Pool,
    pub open_block: u64,
    pub base_in: U256,
    pub usd_per_base: f64,
    /// Tokens the optimistic (instant) buy quote gave.
    pub opt_tokens: U256,
    pub buy_due: u64,
    pub buy: LateQuote,
    /// None while the position is still open.
    pub exit: Option<LateExit>,
}

/// Do whatever part of one race check is due now. Order is always: late buy
/// first, then (once the sell has been decided and its block is reached)
/// the late sell. Returns the finished "late_for" line when the trade's race
/// check is complete; the caller writes it and drops the job. Never waits.
pub fn step_late(t: &mut LateTrade, last_block: u64, q: &dyn Quoter, eth_usd: f64) -> Option<Value> {
    // Step 1: the late buy (same money in, same pool and fee).
    if t.buy == LateQuote::Pending && last_block >= t.buy_due {
        match q.quote(&t.info.base_addr, &t.info.token, t.info.fee, t.base_in) {
            Ok((toks, gas)) if !toks.is_zero() => t.buy = LateQuote::Done(toks, gas),
            other => {
                if gave_up(t.buy_due, last_block) {
                    t.buy = LateQuote::Failed(format!("{other:?}"));
                }
            }
        }
    }
    // Step 2: the late sell, only once the sell is decided and due.
    let ex = t.exit.clone()?;
    if last_block < ex.due {
        return None;
    }
    let entry_slip = |late: U256| slip_pct(f64::from(t.opt_tokens), f64::from(late));
    let base = json!({"late_for": t.pool, "token": t.info.token, "open_block": t.open_block});
    let with = |mut v: Value, extra: Value| {
        if let (Some(m), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            m.extend(e.clone());
        }
        v
    };
    match t.buy.clone() {
        // Still retrying the buy: wait (bounded by LATE_GIVE_UP_BLOCKS).
        LateQuote::Pending => None,
        // Late buy impossible: we would never have held the coin.
        LateQuote::Failed(e) => Some(with(base, json!({"late_net_usd": null, "late_failed": "buy", "error": e}))),
        LateQuote::Done(late_tokens, gas_in) => match q.quote(&t.info.token, &t.info.base_addr, t.info.fee, late_tokens) {
            Ok((out, gas_out)) => {
                let gp = q.gas_price().unwrap_or(U256::ZERO);
                let (_, net) = pnl_usd(t.base_in, out, t.info.base, t.usd_per_base, gas_in + gas_out + 2 * GAS_OVERHEAD, gp, eth_usd);
                // Exit slip compares price per token sold (the two sells can be
                // different sizes, because the late buy got a different amount).
                let per = |o: U256, toks: U256| f64::from(o) / f64::from(toks).max(1.0);
                let exit_slip = ex.opt_out.and_then(|o| slip_pct(per(o, t.opt_tokens), per(out, late_tokens)));
                Some(with(
                    base,
                    json!({"late_net_usd": net, "entry_slip_pct": entry_slip(late_tokens), "exit_slip_pct": exit_slip,
                           "late_tokens": late_tokens.to_string(), "late_base_out": out.to_string()}),
                ))
            }
            Err(e) if gave_up(ex.due, last_block) => Some(with(base, json!({"late_net_usd": null, "late_failed": "exit", "error": e, "entry_slip_pct": entry_slip(late_tokens)}))),
            Err(_) => None, // try again next loop
        },
    }
}

/// Auto-size rule: the LARGEST size whose instant round trip (buy, then sell
/// straight back) loses at most `max_rt` (fees + our own price impact).
/// Thin pools => small size, deep pools => bigger size; capped by the list.
pub fn pick_auto(round_trips: &[(f64, f64)], max_rt: f64) -> f64 {
    round_trips.iter().filter(|(_, loss)| *loss <= max_rt).map(|(usd, _)| *usd).fold(0.0, f64::max)
}

/// Why we'd exit right now, if at all.
pub fn exit_reason(gain: f64, held: Duration, tp: f64, sl: f64, hold: Duration) -> Option<&'static str> {
    if gain >= tp {
        Some("take_profit")
    } else if gain <= -sl {
        Some("stop_loss")
    } else if held >= hold {
        Some("time")
    } else {
        None
    }
}

/// Dollar result of a closed trade (base amounts in raw units).
pub fn pnl_usd(base_in: U256, base_out: U256, base: &str, usd_per_base: f64, gas_units: u64, gas_price: U256, eth_usd: f64) -> (f64, f64) {
    let d = 10f64.powi(base_decimals(base));
    let gross = (f64::from(base_out) - f64::from(base_in)) / d * usd_per_base;
    let gas_usd = gas_units as f64 * f64::from(gas_price) / 1e18 * eth_usd;
    (gross, gross - gas_usd)
}

// ---------------------------------------------------------------------------
// Live loop
// ---------------------------------------------------------------------------

pub struct Config {
    /// Sizes to price every trade at, for the size study (USD).
    pub sizes: Vec<f64>,
    /// Auto-size: max instant round-trip loss allowed (0.015 = 1.5%).
    pub auto_max_rt: f64,
    /// Run the tax/trap check before every buy (SNIPER_TAXCHECK=off disables).
    pub taxcheck: bool,
    pub http: String,
    /// Optional websocket node (e.g. Chainstack). When set, swaps are PUSHED
    /// to us as each block is made (eth_subscribe "logs") instead of asking
    /// the node over and over: faster, and only a handful of requests a day.
    pub wss: Option<String>,
    pub out: PathBuf,
    pub duration: Option<Duration>,
    /// Fallback size, used only when the size list is empty.
    pub usd: f64,
    /// Largest trade size allowed (SNIPER_MAX_USD).
    pub max_usd: f64,
    /// Sells of the token a pool must have shown before we buy.
    pub min_sells: u64,
    /// Skip if the rush already lifted the price more than this (percent).
    pub max_rise_pct: f64,
    pub tp: f64,
    pub sl: f64,
    pub hold: Duration,
    pub rules: Rules,
    pub poll: Duration,
    /// Race check: how many blocks after deciding we assume our tx lands.
    pub late_blocks: u64,
}

impl Config {
    pub fn from_env() -> Self {
        let unix = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let f = |k: &str, d: f64| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        let block_ms = 105.0;
        Config {
            http: std::env::var("SNIPER_RHC_HTTP").unwrap_or_else(|_| crate::rhc::DEFAULT_HTTP.into()),
            wss: std::env::var("SNIPER_RHC_WSS").ok().filter(|s| !s.trim().is_empty()),
            sizes: std::env::var("SNIPER_SIZES").unwrap_or_else(|_| "25,50,100".into()).split(',').filter_map(|x| x.trim().parse().ok()).collect(),
            auto_max_rt: std::env::var("SNIPER_AUTO_MAX_RT_PCT").ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(1.5) / 100.0,
            taxcheck: std::env::var("SNIPER_TAXCHECK").map(|v| v != "off").unwrap_or(true),
            out: PathBuf::from(std::env::var("SNIPER_OUT").unwrap_or_else(|_| format!("paper-out/{unix}"))),
            duration: Some(f("SNIPER_DURATION_SECS", 0.0)).filter(|d| *d > 0.0).map(Duration::from_secs_f64),
            usd: f("SNIPER_PAPER_USD", 50.0),
            max_usd: f("SNIPER_MAX_USD", 50.0),
            min_sells: f("SNIPER_MIN_SELLS", 3.0) as u64,
            max_rise_pct: f("SNIPER_MAX_RISE_PCT", 8.0),
            tp: f("SNIPER_TP_PCT", 5.0) / 100.0,
            sl: f("SNIPER_SL_PCT", 5.0) / 100.0,
            hold: Duration::from_secs_f64(f("SNIPER_HOLD_SECS", 10.0)),
            rules: Rules {
                buys: f("SNIPER_RUSH_BUYS", 3.0) as usize,
                window_blocks: ((f("SNIPER_RUSH_WINDOW_S", 1.0) * 1000.0 / block_ms).round() as u64).max(1),
                rise_pct: f("SNIPER_RUSH_RISE_PCT", 2.0),
            },
            poll: Duration::from_millis(f("SNIPER_RHC_POLL_MS", 200.0) as u64),
            late_blocks: f("SNIPER_LATE_BLOCKS", 2.0) as u64,
        }
    }
}

/// Look up a pool: must be a Uniswap V3 pool (our factory) with exactly one
/// side WETH or USDG. One batched request.
fn pool_info(url: &str, agent: &ureq::Agent, pool: &str) -> Option<Pool> {
    let call = |id: u64, sel: &str| json!({"jsonrpc": "2.0", "id": id, "method": "eth_call", "params": [{"to": pool, "data": sel}, "latest"]});
    // token0, token1, fee, factory
    let body = json!([call(1, "0x0dfe1681"), call(2, "0xd21220a7"), call(3, "0xddca3f43"), call(4, "0xc45a0155")]);
    let mut r = agent.post(url).send_json(&body).ok()?;
    let v: Value = r.body_mut().read_json().ok()?;
    let get = |id: u64| v.as_array()?.iter().find(|x| x["id"] == id).and_then(|x| x["result"].as_str()).map(str::to_string);
    let addr = |h: String| (h.len() >= 66).then(|| format!("0x{}", h.trim_start_matches("0x")[24..64].to_ascii_lowercase()));
    let (t0, t1, factory) = (addr(get(1)?)?, addr(get(2)?)?, addr(get(4)?)?);
    if factory != V3_FACTORY {
        return None; // other V3 forks: the Uniswap quoter can't price them
    }
    let fee = u32::from_str_radix(get(3)?.trim_start_matches("0x").trim_start_matches('0'), 16).ok()?;
    let p = crate::rhc::PoolInfo { token0: t0.clone(), token1: t1.clone(), fee_ppm: Some(fee as u64) };
    let (token, base, token_is0) = p.sides()?;
    if base == "ETH" {
        return None;
    }
    let base_addr = if token_is0 { t1 } else { t0 };
    Some(Pool { token, base, base_addr, token_is0, fee })
}

/// Race check: when a position closes, tell its late job when to re-quote
/// the sell (decision block + late blocks) and what the instant sell gave.
fn schedule_late_exit(late: &mut [LateTrade], p: &Position, last_block: Option<u64>, late_blocks: u64, opt_out: Option<U256>) {
    let decided = last_block.unwrap_or(p.open_block);
    if let Some(t) = late.iter_mut().find(|t| t.pool == p.pool && t.open_block == p.open_block && t.exit.is_none()) {
        t.exit = Some(LateExit { due: late_due(decided, late_blocks), opt_out });
    }
}

fn words(data: &str) -> Vec<&str> {
    let d = data.trim_start_matches("0x");
    (0..d.len() / 64).map(|i| &d[i * 64..i * 64 + 64]).collect()
}

pub fn run(cfg: Config) -> Result<(), String> {
    fs::create_dir_all(&cfg.out).map_err(|e| e.to_string())?;
    let open = |n: &str| OpenOptions::new().create(true).append(true).open(cfg.out.join(n)).map(BufWriter::new).map_err(|e| e.to_string());
    let (mut f_trades, mut f_sig, mut f_meta) = (open("paper_trades.jsonl")?, open("signals.jsonl")?, open("meta.jsonl")?);
    let write = |f: &mut BufWriter<std::fs::File>, v: Value| -> Result<(), String> {
        serde_json::to_writer(&mut *f, &v).map_err(|e| e.to_string())?;
        f.write_all(b"\n").map_err(|e| e.to_string())?;
        f.flush().map_err(|e| e.to_string())
    };
    let rpc = Rpc::new(&cfg.http);
    let quoter = ChainQuoter { rpc: Rpc::new(&cfg.http) };
    let mut taxcheck = crate::taxcheck::Checker::default();
    let agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(10))).build().new_agent();
    let mut eth = eth_usd(&quoter).ok_or("could not price ETH in USDG (node or quoter unreachable)")?;
    let mut eth_at = Instant::now();
    let wall_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    write(
        &mut f_meta,
        json!({"event": "start", "wall_ms": wall_ms, "usd": cfg.usd, "sizing": "auto", "max_usd": cfg.max_usd, "sizes": cfg.sizes,
               "min_sells": cfg.min_sells, "max_rise_pct": cfg.max_rise_pct, "tp": cfg.tp, "sl": cfg.sl, "hold_s": cfg.hold.as_secs_f64(),
               "rush_buys": cfg.rules.buys, "window_blocks": cfg.rules.window_blocks, "rise_pct": cfg.rules.rise_pct,
               "node": crate::probe::redact(&cfg.http), "push": cfg.wss.as_deref().map(crate::probe::redact), "eth_usd": eth, "late_blocks": cfg.late_blocks}),
    )?;
    // Permanent blocklist: load what earlier runs in this folder learned.
    let block_path = cfg.out.join(Blocklist::FILE);
    let mut blocklist = Blocklist::load(&block_path)?;
    eprintln!(
        "paper: writing to {} | ETH ${eth:.0} | auto size, max ${} | TP {}% SL {}% hold {}s | {} blocked tokens loaded",
        cfg.out.display(),
        cfg.max_usd,
        cfg.tp * 100.0,
        cfg.sl * 100.0,
        cfg.hold.as_secs_f64(),
        blocklist.tokens.len()
    );

    let swap_topic = sig_v3_swap();
    // Push mode: a websocket thread hands us each V3 swap log as it happens.
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let log_rx = cfg.wss.clone().map(|url| {
        let (ltx, lrx) = std::sync::mpsc::channel::<Value>();
        let (stop2, topic, shown) = (stop.clone(), swap_topic.clone(), crate::probe::redact(&url));
        std::thread::spawn(move || {
            let subs = [crate::ws::Sub { label: "logs", params: json!(["logs", {"topics": [[topic]]}]), fallback: None }];
            crate::ws::run(
                &url,
                &subs,
                crate::ws::Clock::new(),
                &stop2,
                |_, _, v| {
                    let _ = ltx.send(v.clone());
                },
                // Never print a node link (it holds the API key).
                |_, up, d| eprintln!("paper: push node {} ({})", if up { "UP" } else { "DOWN" }, if d.contains("://") { crate::probe::redact(&d) } else { d }),
            );
        });
        eprintln!("paper: swaps pushed from {shown}");
        lrx
    });
    let mut pools: HashMap<String, Option<Pool>> = HashMap::new();
    let mut det = Detector::default();
    let mut sells = SellHistory::default();
    let mut pos: Option<Position> = None;
    let mut last_block: Option<u64> = None;
    let (mut n_trades, mut n_wins, mut total, mut n_rush, mut n_skipped) = (0u64, 0u64, 0.0f64, 0u64, 0u64);
    let mut n_unsafe = 0u64; // rushes skipped by the tax/trap check
    let mut n_filtered = 0u64; // rushes skipped by the other safety filters
    // Put a token on the blocklist and save the file right away.
    let block = |bl: &mut Blocklist, token: &str, why: &str| {
        if bl.add(token, why) {
            eprintln!("paper: BLOCKED {token} ({why})");
            if let Err(e) = bl.save(&block_path) {
                eprintln!("paper: could not save blocklist ({e})");
            }
        }
    };
    let started = Instant::now();
    let mut beat = Instant::now();
    let mut errors = 0u32;
    // Race check jobs: trades whose late buy/sell re-quotes are not done yet.
    let mut late: Vec<LateTrade> = Vec::new();

    loop {
        // Push mode waits on the stream (below); poll mode sleeps between asks.
        if log_rx.is_none() {
            std::thread::sleep(cfg.poll);
        }
        if cfg.duration.is_some_and(|d| started.elapsed() >= d) {
            break;
        }
        if eth_at.elapsed() > Duration::from_secs(300) {
            if let Some(e) = eth_usd(&quoter) {
                eth = e;
            }
            eth_at = Instant::now();
        }
        // ---- new swaps (pushed or polled) ----
        let mut logs: Vec<Value> = Vec::new();
        if let Some(rx) = &log_rx {
            // Wait briefly for the next swap, then take everything queued.
            if let Ok(v) = rx.recv_timeout(cfg.poll.min(Duration::from_millis(50))) {
                logs.push(v);
                logs.extend(rx.try_iter());
            }
            if let Some(b) = logs.iter().map(|l| hex_u64(l.get("blockNumber"))).max() {
                last_block = Some(last_block.map_or(b, |x| x.max(b)));
            }
        } else {
            let head = match rpc.call("eth_blockNumber", json!([])) {
                Ok(v) => hex_u64(Some(&v)),
                Err(e) => {
                    errors += 1;
                    if errors % 20 == 1 {
                        eprintln!("paper: node error ({e})");
                    }
                    continue;
                }
            };
            let from = match last_block {
                None => head,
                Some(l) if head <= l => head + 1,
                Some(l) => (l + 1).max(head.saturating_sub(50)),
            };
            if from <= head {
                let params = json!([{"fromBlock": format!("0x{from:x}"), "toBlock": format!("0x{head:x}"), "topics": [[swap_topic]]}]);
                match rpc.call("eth_getLogs", params) {
                    Ok(v) => {
                        last_block = Some(head);
                        logs = v.as_array().cloned().unwrap_or_default();
                    }
                    Err(e) => {
                        errors += 1;
                        if errors % 20 == 1 {
                            eprintln!("paper: node error ({e})");
                        }
                    }
                }
            }
        }
        let mut rushes: Vec<RushSig> = Vec::new();
        {
            let mut logs = logs;
            logs.sort_by_key(|l| (hex_u64(l.get("blockNumber")), hex_u64(l.get("logIndex"))));
            for log in &logs {
                // A log the node takes back (short re-org) is not a real swap.
                if log["removed"].as_bool() == Some(true) {
                    continue;
                }
                let Some(pool) = log["address"].as_str().map(str::to_ascii_lowercase) else { continue };
                if !pools.contains_key(&pool) {
                    let info = pool_info(&cfg.http, &agent, &pool);
                    pools.insert(pool.clone(), info);
                }
                let Some(Some(info)) = pools.get(&pool) else { continue };
                let w = words(log["data"].as_str().unwrap_or(""));
                let Some(sp) = w.get(2) else { continue };
                let Some(price) = token_price(&crate::fourmeme::word_dec(sp), info.token_is0) else { continue };
                let block = hex_u64(log.get("blockNumber"));
                // Sell history: did someone sell the token (base paid out)?
                if is_sell_swap(&w, info.token_is0) {
                    sells.record(&pool);
                }
                let buyer = swap_buyer(log);
                if let Some(r) = det.on_swap(&pool, block, &buyer, price, &cfg.rules) {
                    rushes.push(r);
                }
            }
        }

        // ---- race check: run any late re-quotes that are now due ----
        if let Some(lb) = last_block {
            let mut i = 0;
            while i < late.len() {
                let line = step_late(&mut late[i], lb, &quoter, eth);
                let t = &late[i];
                // Copy the late buy result onto the open position it belongs to.
                if let Some(p) = pos.as_mut().filter(|p| p.pool == t.pool && p.open_block == t.open_block && p.late_tokens.is_none()) {
                    if let LateQuote::Done(toks, _) = t.buy {
                        p.late_tokens = Some(toks);
                    }
                }
                if let Some(line) = line {
                    eprintln!("paper: RACE {} late net {}", t.info.token, line["late_net_usd"].as_f64().map_or("failed".to_string(), |n| format!("${n:+.2}")));
                    write(&mut f_trades, line)?;
                    late.remove(i);
                } else {
                    i += 1;
                }
            }
        }

        // ---- manage the open position ----
        if let Some(p) = pos.clone() {
            let price = det.last_price(&p.pool).unwrap_or(p.entry_price);
            let gain = price / p.entry_price - 1.0;
            if let Some(reason) = exit_reason(gain, p.opened.elapsed(), cfg.tp, cfg.sl, cfg.hold) {
                match quoter.quote(&p.info.token, &p.info.base_addr, p.info.fee, p.tokens) {
                    Ok((out, gas_out)) => {
                        let gp = quoter.gas_price().unwrap_or(U256::ZERO);
                        let gas_units = p.gas_in + gas_out + 2 * GAS_OVERHEAD;
                        let (gross, net) = pnl_usd(p.base_in, out, p.info.base, p.usd_per_base, gas_units, gp, eth);
                        n_trades += 1;
                        if net > 0.0 {
                            n_wins += 1;
                        }
                        total += net;
                        write(
                            &mut f_trades,
                            json!({"pool": p.pool, "token": p.info.token, "base": p.info.base, "open_block": p.open_block, "close_block": last_block,
                                   "held_s": p.opened.elapsed().as_secs_f64(), "reason": reason, "pool_move_pct": 100.0 * gain,
                                   "usd_in": p.usd_in, "gross_usd": gross, "gas_usd": gross - net, "net_usd": net,
                                   "base_in": p.base_in.to_string(), "base_out": out.to_string(), "tokens": p.tokens.to_string(),
                                   "wall_ms": SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)}),
                        )?;
                        // Size study: sell the same trade at every other size, right now.
                        let mut ladder = Vec::new();
                        for (usd, b_in, toks) in &p.ladder {
                            if let Ok((o, g)) = quoter.quote(&p.info.token, &p.info.base_addr, p.info.fee, *toks) {
                                let (_, n) = pnl_usd(*b_in, o, p.info.base, p.usd_per_base, p.gas_in + g + 2 * GAS_OVERHEAD, gp, eth);
                                ladder.push(json!({"usd": usd, "net": n}));
                            }
                        }
                        write(&mut f_trades, json!({"ladder_for": p.pool, "open_block": p.open_block, "auto_usd": p.auto_usd, "ladder": ladder}))?;
                        eprintln!("paper: SELL {} ({reason}, {:.1}s) net ${net:+.2} | total ${total:+.2} over {n_trades} trades", p.info.token, p.opened.elapsed().as_secs_f64());
                        // Race check: re-quote this same sell a few blocks from now.
                        schedule_late_exit(&mut late, &p, last_block, cfg.late_blocks, Some(out));
                        pos = None;
                    }
                    Err(e) => {
                        // Can't price the exit: keep trying; record it.
                        if p.opened.elapsed() > cfg.hold * 3 {
                            write(&mut f_trades, json!({"pool": p.pool, "token": p.info.token, "reason": "exit_quote_failed", "error": e, "usd_in": p.usd_in, "net_usd": -p.usd_in}))?;
                            // Size study: every size is lost in full too.
                            let ladder: Vec<Value> = p.ladder.iter().map(|(usd, _, _)| json!({"usd": usd, "net": -usd})).collect();
                            write(&mut f_trades, json!({"ladder_for": p.pool, "open_block": p.open_block, "auto_usd": p.auto_usd, "ladder": ladder}))?;
                            total -= p.usd_in;
                            n_trades += 1;
                            // Never touch this token again (survives restarts).
                            block(&mut blocklist, &p.info.token, "exit_quote_failed");
                            // Race check: still try the late sell (no optimistic price to compare).
                            schedule_late_exit(&mut late, &p, last_block, cfg.late_blocks, None);
                            pos = None;
                            eprintln!("paper: EXIT FAILED {} (counted as total loss)", p.info.token);
                        }
                    }
                }
            }
        }

        // ---- new rushes ----
        for r in rushes {
            n_rush += 1;
            let info = pools.get(&r.pool).cloned().flatten().unwrap();
            if pos.is_some() {
                n_skipped += 1;
                write(&mut f_sig, json!({"pool": r.pool, "token": info.token, "block": r.block, "taken": false, "why": "busy"}))?;
                continue;
            }
            // A skipped rush: one line in signals.jsonl with the reason.
            let skip = |f: &mut BufWriter<std::fs::File>, why: String| write(f, json!({"pool": r.pool, "token": info.token, "block": r.block, "taken": false, "why": why}));
            // Cheap filters first (no node calls).
            if blocklist.contains(&info.token) {
                n_filtered += 1;
                skip(&mut f_sig, "blocked token".into())?;
                continue;
            }
            if !sells.enough(&r.pool, cfg.min_sells) {
                n_filtered += 1;
                skip(&mut f_sig, format!("no sell history ({} of {} sells seen)", sells.count(&r.pool), cfg.min_sells))?;
                continue;
            }
            if already_jumped(r.start_price, r.price, cfg.max_rise_pct) {
                n_filtered += 1;
                let up = rise_pct(r.start_price, r.price).map_or("?".to_string(), |x| format!("{x:.1}%"));
                skip(&mut f_sig, format!("already jumped (up {up}, max {}%)", cfg.max_rise_pct))?;
                continue;
            }
            // Safety first: never buy a token that is taxed, blocked or unchecked.
            if cfg.taxcheck {
                let verdict = taxcheck.check(&rpc, &info.token, &r.pool);
                if !matches!(verdict, Ok(crate::taxcheck::Verdict::Ok)) {
                    n_unsafe += 1;
                    // A real finding (taxed/blocked) is permanent; a node error is not.
                    if let Ok(v) = &verdict {
                        block(&mut blocklist, &info.token, &format!("trap check: {v:?}"));
                    }
                    skip(&mut f_sig, format!("unsafe: {verdict:?}"))?;
                    continue;
                }
            }
            let usd_per_base = if info.base == "USDG" { 1.0 } else { eth };
            let raw = |usd: f64| U256::from(((usd / usd_per_base) * 10f64.powi(base_decimals(info.base))) as u128);
            // Size study: price this trade at every size, plus an instant
            // round trip at each (what fees + our own impact cost us).
            let mut ladder = Vec::new();
            let mut round_trips = Vec::new();
            for usd in &cfg.sizes {
                if let Ok((toks, _)) = quoter.quote(&info.base_addr, &info.token, info.fee, raw(*usd)) {
                    if toks.is_zero() {
                        continue;
                    }
                    if let Ok((back, _)) = quoter.quote(&info.token, &info.base_addr, info.fee, toks) {
                        round_trips.push((*usd, 1.0 - f64::from(back) / f64::from(raw(*usd)).max(1.0)));
                    }
                    ladder.push((*usd, raw(*usd), toks));
                }
            }
            let auto_usd = pick_auto(&round_trips, cfg.auto_max_rt);
            // The trade's real size: auto size, capped at MAX_USD.
            let Some(usd_in) = decide_size(auto_usd, &cfg.sizes, cfg.max_usd, cfg.usd) else {
                if round_trips.is_empty() {
                    // Nothing could be priced at all: a quote problem, not depth.
                    skip(&mut f_sig, "quote failed: size study got no round-trip quotes".into())?;
                } else {
                    n_filtered += 1;
                    skip(&mut f_sig, format!("too thin (no size within {}% round trip)", cfg.auto_max_rt * 100.0))?;
                }
                continue;
            };
            let base_in = raw(usd_in);
            match quoter.quote(&info.base_addr, &info.token, info.fee, base_in) {
                Ok((tokens, gas_in)) if !tokens.is_zero() => {
                    // Real-size trap check: OUR exact token amount out of the
                    // pool and ALL of it back in, before we take the trade.
                    if cfg.taxcheck {
                        let verdict = crate::taxcheck::test_amount(&rpc, &info.token, &r.pool, tokens);
                        if !matches!(verdict, Ok(crate::taxcheck::Verdict::Ok)) {
                            n_unsafe += 1;
                            if let Ok(v) = &verdict {
                                block(&mut blocklist, &info.token, &format!("real-size check: {v:?}"));
                            }
                            skip(&mut f_sig, format!("unsafe: real size: {verdict:?}"))?;
                            continue;
                        }
                    }
                    write(&mut f_sig, json!({"pool": r.pool, "token": info.token, "block": r.block, "taken": true, "usd_in": usd_in}))?;
                    eprintln!("paper: BUY  {} ${usd_in} ({}/{} rush at block {})", info.token, info.base, r.pool, r.block);
                    // Race check: price this exact buy again a few blocks from
                    // the newest block we have seen (when we really decided).
                    let decided = last_block.unwrap_or(r.block).max(r.block);
                    late.push(LateTrade {
                        pool: r.pool.clone(),
                        info: info.clone(),
                        open_block: r.block,
                        base_in,
                        usd_per_base,
                        opt_tokens: tokens,
                        buy_due: late_due(decided, cfg.late_blocks),
                        buy: LateQuote::Pending,
                        exit: None,
                    });
                    pos = Some(Position {
                        pool: r.pool.clone(),
                        info,
                        opened: Instant::now(),
                        open_block: r.block,
                        base_in,
                        tokens,
                        entry_price: det.last_price(&r.pool).unwrap_or(r.price),
                        gas_in,
                        usd_per_base,
                        usd_in,
                        ladder,
                        auto_usd,
                        late_tokens: None,
                    });
                }
                other => {
                    skip(&mut f_sig, format!("quote failed: {other:?}"))?;
                }
            }
        }

        if beat.elapsed() >= Duration::from_secs(60) {
            let h = started.elapsed().as_secs_f64() / 3600.0;
            eprintln!(
                "paper: {}m | rushes {n_rush} (skipped while busy {n_skipped}, unsafe {n_unsafe}, filtered {n_filtered}) | trades {n_trades} | wins {:.0}% | total ${total:+.2} (${:+.2}/h) | open: {}",
                started.elapsed().as_secs() / 60,
                if n_trades > 0 { 100.0 * n_wins as f64 / n_trades as f64 } else { 0.0 },
                if h > 0.0 { total / h } else { 0.0 },
                pos.as_ref().map(|p| p.info.token.as_str()).unwrap_or("none")
            );
            beat = Instant::now();
        }
    }
    write(&mut f_meta, json!({"event": "stop", "trades": n_trades, "total_usd": total}))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

pub fn report(dir: &std::path::Path) -> String {
    let all: Vec<Value> = fs::read_to_string(dir.join("paper_trades.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    // Trade lines vs size-study lines ("ladder_for").
    let rows: Vec<Value> = all.iter().filter(|r| r.get("reason").is_some()).cloned().collect();
    let ladders: Vec<&Value> = all.iter().filter(|r| r.get("ladder_for").is_some()).collect();
    let meta: Vec<Value> = fs::read_to_string(dir.join("meta.jsonl")).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let sig: Vec<Value> = fs::read_to_string(dir.join("signals.jsonl")).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let start = meta.iter().find(|m| m["event"] == "start");
    let start_ms = start.and_then(|m| m["wall_ms"].as_u64()).unwrap_or(0);
    let last_ms = rows.iter().filter_map(|r| r["wall_ms"].as_u64()).max().unwrap_or(start_ms);
    let hours = (last_ms.saturating_sub(start_ms)) as f64 / 3.6e6;
    let nets: Vec<f64> = rows.iter().filter_map(|r| r["net_usd"].as_f64()).collect();
    let n = nets.len();
    let total: f64 = nets.iter().sum();
    let wins = nets.iter().filter(|x| **x > 0.0).count();
    let gas: f64 = rows.iter().filter_map(|r| r["gas_usd"].as_f64()).sum();
    let worst = nets.iter().cloned().fold(f64::INFINITY, f64::min);
    let best = nets.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let mut reasons: HashMap<String, usize> = HashMap::new();
    for r in &rows {
        *reasons.entry(r["reason"].as_str().unwrap_or("?").to_string()).or_default() += 1;
    }
    let taken = sig.iter().filter(|s| s["taken"] == json!(true)).count();
    let unsafe_n = sig.iter().filter(|s| s["why"].as_str().is_some_and(|w| w.starts_with("unsafe"))).count();
    // Skips by the safety filters, per reason (SKIP_REASONS order; last is unsafe).
    let skips = count_skips(&sig);
    let filtered: usize = skips[..skips.len() - 1].iter().sum();
    // Header: new runs size each trade automatically; old runs used one size.
    let size_txt = match start.and_then(|m| m["max_usd"].as_f64()) {
        Some(max) => format!("auto size, max ${max}"),
        None => format!("${} per trade", start.and_then(|m| m["usd"].as_f64()).unwrap_or(0.0)),
    };
    // Each trade's own size (lines from older runs may not have one).
    let sizes_in: Vec<f64> = rows.iter().filter_map(|r| r["usd_in"].as_f64()).collect();
    let skip_txt = format!(
        "skips: {} | average trade size ${:.2}\n",
        SKIP_REASONS.iter().zip(skips.iter()).map(|(name, n)| format!("{name} {n}")).collect::<Vec<_>>().join(" | "),
        if sizes_in.is_empty() { 0.0 } else { sizes_in.iter().sum::<f64>() / sizes_in.len() as f64 }
    );
    // Size study: total per fixed size, plus what the auto-sizer would have made.
    let mut by_size: std::collections::BTreeMap<u64, (f64, usize)> = Default::default();
    let (mut auto_total, mut auto_n) = (0.0f64, 0usize);
    for l in &ladders {
        let auto = l["auto_usd"].as_f64().unwrap_or(0.0);
        for e in l["ladder"].as_array().cloned().unwrap_or_default() {
            let (usd, net) = (e["usd"].as_f64().unwrap_or(0.0), e["net"].as_f64().unwrap_or(0.0));
            let slot = by_size.entry(usd as u64).or_default();
            slot.0 += net;
            slot.1 += 1;
            if auto > 0.0 && (usd - auto).abs() < 0.01 {
                auto_total += net;
                auto_n += 1;
            }
        }
    }
    let mut sizes_txt = String::new();
    if !ladders.is_empty() {
        sizes_txt += "size study (same trades priced at each size):\n";
        for (usd, (t, n)) in &by_size {
            sizes_txt += &format!("  ${usd:>4}: ${t:+.2} over {n} trades (${:+.2}/h)\n", if hours > 0.0 { t / hours } else { 0.0 });
        }
        sizes_txt += &format!("  AUTO (largest size with <=1.5% round-trip cost): ${auto_total:+.2} over {auto_n} trades (${:+.2}/h)\n", if hours > 0.0 { auto_total / hours } else { 0.0 });
    }
    let race_txt = race_section(&all, start.and_then(|m| m["late_blocks"].as_u64()), hours);
    let mean = if n > 0 { total / n as f64 } else { 0.0 };
    let sd = if n > 1 { (nets.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n - 1) as f64).sqrt() } else { 0.0 };
    let half = 1.96 * sd / (n.max(1) as f64).sqrt();
    format!(
        "PAPER TRADER ({:.1} h, {})\n\
         rushes seen {} | trades {} | skipped (busy or no quote) {} | blocked as unsafe {}\n\
         TOTAL ${:+.2}  =  ${:+.2} per hour  |  per trade ${:+.2} (rough 95% range ${:+.2} .. ${:+.2})\n\
         wins {:.0}% | best ${:+.2} | worst ${:+.2} | gas paid ${:.2}\n\
         exits: {:?}\n{}{}{}",
        hours,
        size_txt,
        sig.len(),
        n,
        sig.len().saturating_sub(taken + unsafe_n + filtered),
        unsafe_n,
        total,
        if hours > 0.0 { total / hours } else { 0.0 },
        mean,
        mean - half,
        mean + half,
        if n > 0 { 100.0 * wins as f64 / n as f64 } else { 0.0 },
        if n > 0 { best } else { 0.0 },
        if n > 0 { worst } else { 0.0 },
        gas,
        reasons,
        sizes_txt,
        race_txt,
        skip_txt
    )
}

/// Count skipped rushes per safety reason (same order as SKIP_REASONS),
/// matching the start of each signal line's "why".
pub fn count_skips(sig: &[Value]) -> [usize; SKIP_REASONS.len()] {
    let mut out = [0usize; SKIP_REASONS.len()];
    for s in sig {
        if let Some(w) = s["why"].as_str() {
            if let Some(i) = SKIP_REASONS.iter().position(|r| w.starts_with(r)) {
                out[i] += 1;
            }
        }
    }
    out
}

/// Report section for the race check: the same trades, but priced as if our
/// buy and sell each landed a few blocks after we decided. Reads only the
/// "late_for" lines. Empty if the run had no race check lines.
fn race_section(all: &[Value], late_blocks: Option<u64>, hours: f64) -> String {
    let late: Vec<&Value> = all.iter().filter(|r| r.get("late_for").is_some()).collect();
    if late.is_empty() {
        return String::new();
    }
    // Finished race checks have a number; failed ones have null.
    let nets: Vec<f64> = late.iter().filter_map(|r| r["late_net_usd"].as_f64()).collect();
    let failed = late.len() - nets.len();
    let total: f64 = nets.iter().sum();
    let wins = nets.iter().filter(|x| **x > 0.0).count();
    let col = |k: &str| late.iter().filter_map(|r| r[k].as_f64()).collect::<Vec<f64>>();
    let show = |m: Option<f64>| m.map_or("n/a".to_string(), |x| format!("{x:+.2}%"));
    format!(
        "RACE CHECK (we land {} blocks late)\n         count {} | late total ${:+.2} (${:+.2}/h) | late wins {:.0}%\n         median entry slip {} | median exit slip {} | late quotes failed {}\n",
        late_blocks.map_or("?".to_string(), |b| b.to_string()),
        nets.len(),
        total,
        if hours > 0.0 { total / hours } else { 0.0 },
        if nets.is_empty() { 0.0 } else { 100.0 * wins as f64 / nets.len() as f64 },
        show(median(&col("entry_slip_pct"))),
        show(median(&col("exit_slip_pct"))),
        failed
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> Rules {
        Rules { buys: 3, window_blocks: 10, rise_pct: 2.0 }
    }

    #[test]
    fn quoter_selector_is_uniswaps() {
        // QuoterV2.quoteExactInputSingle(QuoteExactInputSingleParams): 0xc6a5026a (published)
        assert!(data_quote(WETH, USDG, 500, U256::from(1u64)).starts_with("0xc6a5026a"));
    }

    #[test]
    fn quote_calldata_layout() {
        let d = data_quote(WETH, USDG, 500, U256::from(1000u64));
        // 4-byte selector + 5 words
        assert_eq!(d.len(), 2 + 8 + 64 * 5);
        assert!(d.contains(&word_addr(WETH)));
        assert!(d.contains(&format!("{:064x}", 500)));
        assert!(d.contains(&format!("{:064x}", 1000)));
    }

    #[test]
    fn three_buyers_with_a_rise_make_a_rush_once() {
        let mut d = Detector::default();
        let r = rules();
        assert!(d.on_swap("p", 1, "a", 100.0, &r).is_none());
        // window covers blocks 3..=12 at block 12
        assert!(d.on_swap("p", 10, "b", 101.0, &r).is_none());
        assert!(d.on_swap("p", 11, "c", 102.0, &r).is_none());
        let s = d.on_swap("p", 12, "d", 103.0, &r).unwrap();
        assert_eq!(s.block, 12);
        // cooldown: no repeat right away
        assert!(d.on_swap("p", 13, "e", 104.0, &r).is_none());
    }

    #[test]
    fn one_wallet_splitting_buys_is_not_a_rush() {
        let mut d = Detector::default();
        let r = rules();
        d.on_swap("p", 1, "x", 100.0, &r);
        for (i, p) in [101.0, 102.0, 103.0, 104.0].iter().enumerate() {
            assert!(d.on_swap("p", 10 + i as u64, "same", *p, &r).is_none());
        }
    }

    #[test]
    fn buyers_without_a_real_rise_are_not_a_rush() {
        let mut d = Detector::default();
        let r = rules();
        d.on_swap("p", 1, "x", 100.0, &r);
        for (i, p) in [100.1, 100.2, 100.3, 100.4].iter().enumerate() {
            assert!(d.on_swap("p", 10 + i as u64, &format!("t{i}"), *p, &r).is_none());
        }
    }

    #[test]
    fn rush_remembers_price_before_first_buy() {
        let mut d = Detector::default();
        let r = rules();
        d.on_swap("p", 1, "x", 100.0, &r);
        d.on_swap("p", 10, "a", 101.0, &r);
        d.on_swap("p", 11, "b", 102.0, &r);
        let s = d.on_swap("p", 12, "c", 110.0, &r).unwrap();
        // Price before the first rush buy (block 10) was 100.
        assert_eq!(s.start_price, 100.0);
        assert!(already_jumped(s.start_price, s.price, 8.0)); // up 10%
        assert!(!already_jumped(s.start_price, s.price, 12.0));
    }

    #[test]
    fn many_transactions_from_one_wallet_are_one_buyer() {
        // Real logs: three different transactions, same recipient wallet.
        let log = |tx: &str| json!({"transactionHash": tx, "topics": ["0xsig", format!("0x{:0>64}", "r0u7e2"), format!("0x{:0>64}", "beef")]});
        let buyers: Vec<String> = ["0x1", "0x2", "0x3"].iter().map(|t| swap_buyer(&log(t))).collect();
        assert!(buyers.iter().all(|b| b == "0x000000000000000000000000000000000000beef"));
        let mut d = Detector::default();
        let r = rules();
        d.on_swap("p", 1, "x", 100.0, &r);
        for (i, b) in buyers.iter().enumerate() {
            assert!(d.on_swap("p", 10 + i as u64, b, 101.0 + i as f64, &r).is_none());
        }
    }

    #[test]
    fn buyer_falls_back_to_tx_hash_without_recipient() {
        assert_eq!(swap_buyer(&json!({"transactionHash": "0xabc", "topics": ["0xsig"]})), "0xabc");
        assert_eq!(swap_buyer(&json!({"transactionHash": "0xabc"})), "0xabc");
    }

    #[test]
    fn sell_is_base_paid_out_of_the_pool() {
        let neg = "f".repeat(60) + "fc18"; // -1000 as int256
        let pos = format!("{:064x}", 1000);
        // token is token0, base is token1: base word negative = sell
        assert!(is_sell_swap(&[pos.as_str(), neg.as_str()], true));
        assert!(!is_sell_swap(&[neg.as_str(), pos.as_str()], true)); // a buy
        // token is token1, base is token0
        assert!(is_sell_swap(&[neg.as_str(), pos.as_str()], false));
        assert!(!is_sell_swap(&[pos.as_str(), neg.as_str()], false));
        // malformed data is never a sell
        assert!(!is_sell_swap(&[], true));
        assert!(!is_sell_swap(&["ff"], false));
    }

    #[test]
    fn sell_history_counts_per_pool() {
        let mut h = SellHistory::default();
        assert!(!h.enough("p", 3));
        assert!(h.enough("p", 0));
        for _ in 0..3 {
            h.record("p");
        }
        h.record("q");
        assert_eq!(h.count("p"), 3);
        assert!(h.enough("p", 3));
        assert!(!h.enough("q", 3));
        assert_eq!(h.count("none"), 0);
    }

    #[test]
    fn rise_filter() {
        assert!((rise_pct(100.0, 108.0).unwrap() - 8.0).abs() < 1e-9);
        assert_eq!(rise_pct(0.0, 5.0), None);
        assert!(!already_jumped(100.0, 107.9, 8.0));
        assert!(already_jumped(100.0, 108.1, 8.0));
        assert!(already_jumped(0.0, 108.0, 8.0)); // can't measure = skip
    }

    #[test]
    fn size_is_auto_capped_and_floored() {
        let ladder = [25.0, 50.0, 100.0];
        assert_eq!(decide_size(100.0, &ladder, 50.0, 50.0), Some(50.0)); // capped
        assert_eq!(decide_size(25.0, &ladder, 50.0, 50.0), Some(25.0));
        assert_eq!(decide_size(0.0, &ladder, 50.0, 50.0), None); // too thin
        assert_eq!(decide_size(10.0, &ladder, 50.0, 50.0), Some(25.0)); // floor
        assert_eq!(decide_size(100.0, &ladder, 10.0, 50.0), Some(10.0)); // cap beats floor
        // Empty size list: fallback, still capped.
        assert_eq!(decide_size(0.0, &[], 50.0, 30.0), Some(30.0));
        assert_eq!(decide_size(0.0, &[], 50.0, 80.0), Some(50.0));
        assert_eq!(decide_size(0.0, &[], 50.0, 0.0), None);
    }

    #[test]
    fn blocklist_saves_and_loads() {
        let dir = std::env::temp_dir().join(format!("sniper-block-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(Blocklist::FILE);
        // Missing file = empty list.
        let mut b = Blocklist::load(&path).unwrap();
        assert!(b.tokens.is_empty());
        assert!(b.add("0xABC", "exit_quote_failed"));
        assert!(!b.add("0xabc", "again")); // already there, first reason kept
        assert!(b.contains("0xAbC"));
        b.save(&path).unwrap();
        let back = Blocklist::load(&path).unwrap();
        assert_eq!(back, b);
        assert_eq!(back.tokens["0xabc"], "exit_quote_failed");
        // A damaged file stops the trader instead of forgetting tokens.
        fs::write(&path, "{not json").unwrap();
        assert!(Blocklist::load(&path).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn report_counts_skips_and_real_sizes() {
        let dir = std::env::temp_dir().join(format!("sniper-paper-skips-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("meta.jsonl"), json!({"event": "start", "wall_ms": 0, "usd": 50.0, "max_usd": 50.0}).to_string()).unwrap();
        let trades = [
            json!({"net_usd": 1.0, "gas_usd": 0.01, "reason": "time", "wall_ms": 3_600_000, "usd_in": 50.0}).to_string(),
            // a failed exit loses its OWN size, not a constant
            json!({"reason": "exit_quote_failed", "usd_in": 25.0, "net_usd": -25.0}).to_string(),
        ];
        fs::write(dir.join("paper_trades.jsonl"), trades.join("\n")).unwrap();
        let why = |w: &str| json!({"taken": false, "why": w}).to_string();
        let sig = [
            json!({"taken": true}).to_string(),
            json!({"taken": true}).to_string(),
            why("busy"),
            why("blocked token"),
            why("no sell history (1 of 3 sells seen)"),
            why("no sell history (2 of 3 sells seen)"),
            why("already jumped (up 9.0%, max 8%)"),
            why("too thin (no size within 1.5% round trip)"),
            why("unsafe: Ok(Blocked(\"x\"))"),
            why("unsafe: real size: Ok(Taxed)"),
        ];
        fs::write(dir.join("signals.jsonl"), sig.join("\n")).unwrap();
        let r = report(&dir);
        assert!(r.starts_with("PAPER TRADER (1.0 h, auto size, max $50)"), "{r}");
        assert!(r.contains("TOTAL $-24.00"), "{r}");
        // only "busy" is left in the old busy/no-quote bucket
        assert!(r.contains("skipped (busy or no quote) 1 | blocked as unsafe 2"), "{r}");
        assert!(r.contains("skips: blocked token 1 | no sell history 2 | already jumped 1 | too thin 1 | unsafe 2 | average trade size $37.50"), "{r}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn auto_size_takes_largest_cheap_round_trip() {
        let rt = [(25.0, 0.006), (50.0, 0.008), (100.0, 0.012), (200.0, 0.02), (500.0, 0.05)];
        assert_eq!(pick_auto(&rt, 0.015), 100.0);
        assert_eq!(pick_auto(&rt, 0.001), 0.0);
    }

    #[test]
    fn exits_in_priority_order() {
        let s = Duration::from_secs;
        assert_eq!(exit_reason(0.06, s(1), 0.05, 0.05, s(10)), Some("take_profit"));
        assert_eq!(exit_reason(-0.06, s(1), 0.05, 0.05, s(10)), Some("stop_loss"));
        assert_eq!(exit_reason(0.01, s(11), 0.05, 0.05, s(10)), Some("time"));
        assert_eq!(exit_reason(0.01, s(1), 0.05, 0.05, s(10)), None);
    }

    #[test]
    fn pnl_counts_gas_and_decimals() {
        // 50 USDG in, 52 USDG out, 300k gas at 0.01 gwei, ETH $2500
        let (gross, net) = pnl_usd(U256::from(50_000_000u64), U256::from(52_000_000u64), "USDG", 1.0, 300_000, U256::from(10_000_000u64), 2500.0);
        assert!((gross - 2.0).abs() < 1e-9);
        assert!((gross - net - 0.0075).abs() < 1e-9);
    }

    struct FakeQuoter;
    impl Quoter for FakeQuoter {
        fn quote(&self, token_in: &str, _out: &str, fee: u32, amount_in: U256) -> Result<(U256, u64), String> {
            // 1 WETH = 2500 USDG on the 500 tier, worse elsewhere
            if token_in == WETH {
                let px = if fee == 500 { 2500u64 } else { 2400 };
                return Ok((amount_in / U256::from(10u64).pow(U256::from(12)) * U256::from(px), 100_000));
            }
            Err("no pool".into())
        }
        fn gas_price(&self) -> Result<U256, String> {
            Ok(U256::from(1u64))
        }
    }

    #[test]
    fn eth_price_uses_the_best_tier() {
        assert_eq!(eth_usd(&FakeQuoter), Some(2500.0));
    }

    #[test]
    fn report_sums_trades() {
        let dir = std::env::temp_dir().join(format!("sniper-paper-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("meta.jsonl"), json!({"event": "start", "wall_ms": 0, "usd": 50.0}).to_string()).unwrap();
        let t = |net: f64, ms: u64| json!({"net_usd": net, "gas_usd": 0.01, "reason": "time", "wall_ms": ms}).to_string();
        fs::write(dir.join("paper_trades.jsonl"), [t(1.0, 1_800_000), t(-0.5, 3_600_000)].join("\n")).unwrap();
        fs::write(dir.join("signals.jsonl"), [json!({"taken": true}).to_string(), json!({"taken": true}).to_string(), json!({"taken": false}).to_string()].join("\n")).unwrap();
        let r = report(&dir);
        assert!(r.contains("trades 2"), "{r}");
        assert!(r.contains("TOTAL $+0.50"), "{r}");
        assert!(r.contains("$+0.50 per hour"), "{r}");
        assert!(r.contains("skipped (busy or no quote) 1"), "{r}");
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn late_job_is_due_only_once_the_chain_gets_there() {
        let due = late_due(100, 2);
        assert_eq!(due, 102);
        assert!(!is_due(due, None));
        assert!(!is_due(due, Some(101)));
        assert!(is_due(due, Some(102)));
        assert!(is_due(due, Some(150)));
        assert!(!gave_up(due, 102 + LATE_GIVE_UP_BLOCKS - 1));
        assert!(gave_up(due, 102 + LATE_GIVE_UP_BLOCKS));
    }

    #[test]
    fn slip_is_positive_when_late_is_worse() {
        assert!((slip_pct(100.0, 98.0).unwrap() - 2.0).abs() < 1e-9);
        assert!((slip_pct(100.0, 101.0).unwrap() + 1.0).abs() < 1e-9);
        assert_eq!(slip_pct(0.0, 5.0), None);
    }

    #[test]
    fn median_odd_even_empty() {
        assert_eq!(median(&[3.0, 1.0, 2.0]), Some(2.0));
        assert_eq!(median(&[4.0, 1.0, 3.0, 2.0]), Some(2.5));
        assert_eq!(median(&[]), None);
    }

    /// Fake market for race check tests: buys give `buy_tokens` per call,
    /// sells give `sell_out`; either can be set to fail.
    struct RaceQuoter {
        buy_tokens: std::cell::Cell<Option<u64>>,
        sell_out: std::cell::Cell<Option<u64>>,
    }
    impl Quoter for RaceQuoter {
        fn quote(&self, token_in: &str, _out: &str, _fee: u32, _amount_in: U256) -> Result<(U256, u64), String> {
            let v = if token_in == USDG { self.buy_tokens.get() } else { self.sell_out.get() };
            v.map(|x| (U256::from(x), 100_000)).ok_or_else(|| "no pool".to_string())
        }
        fn gas_price(&self) -> Result<U256, String> {
            Ok(U256::ZERO)
        }
    }

    fn late_trade() -> LateTrade {
        LateTrade {
            pool: "p".into(),
            info: Pool { token: "0xtok".into(), base: "USDG", base_addr: USDG.into(), token_is0: true, fee: 3000 },
            open_block: 100,
            base_in: U256::from(50_000_000u64), // $50 of USDG
            usd_per_base: 1.0,
            opt_tokens: U256::from(1000u64),
            buy_due: 102,
            buy: LateQuote::Pending,
            exit: None,
        }
    }

    #[test]
    fn late_trade_waits_then_prices_buy_and_sell() {
        let q = RaceQuoter { buy_tokens: Some(980).into(), sell_out: Some(51_000_000).into() };
        let mut t = late_trade();
        // Before the due block nothing happens.
        assert!(step_late(&mut t, 101, &q, 2500.0).is_none());
        assert_eq!(t.buy, LateQuote::Pending);
        // Due: late buy runs, but the sell isn't decided yet.
        assert!(step_late(&mut t, 102, &q, 2500.0).is_none());
        assert_eq!(t.buy, LateQuote::Done(U256::from(980u64), 100_000));
        // Sell decided at 110 (optimistic: 1000 tokens -> $52), due at 112.
        t.exit = Some(LateExit { due: 112, opt_out: Some(U256::from(52_000_000u64)) });
        assert!(step_late(&mut t, 111, &q, 2500.0).is_none());
        let line = step_late(&mut t, 112, &q, 2500.0).unwrap();
        assert_eq!(line["late_for"], "p");
        assert_eq!(line["open_block"], 100);
        // $51 back for $50 in, gas free in this fake.
        assert!((line["late_net_usd"].as_f64().unwrap() - 1.0).abs() < 1e-9);
        // 980 vs 1000 tokens = 2% worse entry.
        assert!((line["entry_slip_pct"].as_f64().unwrap() - 2.0).abs() < 1e-9);
        // per token: optimistic 52000 vs late 51e6/980 = 52040.8 => slightly better (negative slip)
        let ex = line["exit_slip_pct"].as_f64().unwrap();
        assert!((ex - 100.0 * (1.0 - (51e6 / 980.0) / 52_000.0)).abs() < 1e-9, "{ex}");
    }

    #[test]
    fn late_buy_that_keeps_failing_is_recorded() {
        let q = RaceQuoter { buy_tokens: None.into(), sell_out: Some(1).into() };
        let mut t = late_trade();
        t.exit = Some(LateExit { due: 103, opt_out: None });
        // Retries quietly until the give-up point...
        assert!(step_late(&mut t, 103, &q, 2500.0).is_none());
        // ...then reports a failed late buy.
        let line = step_late(&mut t, 102 + LATE_GIVE_UP_BLOCKS, &q, 2500.0).unwrap();
        assert_eq!(line["late_failed"], "buy");
        assert!(line["late_net_usd"].is_null());
    }

    #[test]
    fn late_sell_that_keeps_failing_is_recorded() {
        let q = RaceQuoter { buy_tokens: Some(1000).into(), sell_out: None.into() };
        let mut t = late_trade();
        t.exit = Some(LateExit { due: 110, opt_out: Some(U256::from(1u64)) });
        assert!(step_late(&mut t, 110, &q, 2500.0).is_none());
        let line = step_late(&mut t, 110 + LATE_GIVE_UP_BLOCKS, &q, 2500.0).unwrap();
        assert_eq!(line["late_failed"], "exit");
        // Recovers if the node comes back before giving up.
        let mut t2 = late_trade();
        t2.exit = Some(LateExit { due: 110, opt_out: None });
        assert!(step_late(&mut t2, 110, &q, 2500.0).is_none());
        q.sell_out.set(Some(50_000_000));
        let ok = step_late(&mut t2, 111, &q, 2500.0).unwrap();
        assert!(ok["late_net_usd"].as_f64().is_some());
        assert!(ok["exit_slip_pct"].is_null());
    }

    #[test]
    fn report_appends_race_check() {
        let dir = std::env::temp_dir().join(format!("sniper-paper-race-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("meta.jsonl"), json!({"event": "start", "wall_ms": 0, "usd": 50.0, "late_blocks": 2}).to_string()).unwrap();
        let t = |net: f64, ms: u64| json!({"net_usd": net, "gas_usd": 0.01, "reason": "time", "wall_ms": ms}).to_string();
        let l = |net: f64, es: f64, xs: f64| json!({"late_for": "p", "open_block": 1, "late_net_usd": net, "entry_slip_pct": es, "exit_slip_pct": xs}).to_string();
        let lines = [
            t(1.0, 1_800_000),
            json!({"ladder_for": "p", "open_block": 1, "auto_usd": 0.0, "ladder": []}).to_string(),
            l(0.5, 1.0, 2.0),
            t(-0.5, 3_600_000),
            l(-1.5, 3.0, 4.0),
            l(2.0, 2.0, 0.0),
            json!({"late_for": "p", "open_block": 9, "late_net_usd": null, "late_failed": "exit"}).to_string(),
        ];
        fs::write(dir.join("paper_trades.jsonl"), lines.join("\n")).unwrap();
        fs::write(dir.join("signals.jsonl"), "").unwrap();
        let r = report(&dir);
        // Existing lines unchanged (late lines are not counted as trades).
        assert!(r.contains("trades 2"), "{r}");
        assert!(r.contains("TOTAL $+0.50"), "{r}");
        assert!(r.contains("RACE CHECK (we land 2 blocks late)"), "{r}");
        assert!(r.contains("count 3 | late total $+1.00 ($+1.00/h) | late wins 67%"), "{r}");
        assert!(r.contains("median entry slip +2.00% | median exit slip +2.00% | late quotes failed 1"), "{r}");
        let _ = fs::remove_dir_all(&dir);
    }
}
