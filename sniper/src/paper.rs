// ============================================================================
// PAPER TRADER (Robinhood Chain): the fast buy/sell idea, live, no money.
//
// Plain English:
//   1. Watch every Uniswap V3 trade on Robinhood Chain (coins priced in WETH
//      or USDG), straight from a node, a few times a second.
//   2. RUSH = at least 3 different buyers in one coin within ~1 second and
//      the price up >= 2% (the only rule that beat random entries in our
//      research). Single big buys are ignored: they lost money.
//   3. On a rush, "buy" a fixed dollar amount: ask Uniswap's own on-chain
//      price contract (QuoterV2) exactly how many tokens that buys right now.
//      Real pool maths, real fee, real depth. Nothing is signed or sent.
//   4. Sell at +TP%, -SL%, or after HOLD seconds, whichever comes first,
//      again with a real on-chain quote. Gas is estimated and subtracted.
//   5. One trade at a time (risk rule). Every trade and every rush we had to
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
//   SNIPER_PAPER_USD     dollars per trade (default 50)
//   SNIPER_TP_PCT / SNIPER_SL_PCT / SNIPER_HOLD_SECS   exits (5 / 5 / 10)
//   SNIPER_RUSH_BUYS / SNIPER_RUSH_WINDOW_S / SNIPER_RUSH_RISE_PCT  (3 / 1 / 2)
//   SNIPER_RHC_POLL_MS   how often to ask the node (default 200)
// ============================================================================
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
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
    /// (block, tx) of recent buys
    buys: VecDeque<(u64, String)>,
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
}

#[derive(Default)]
pub struct Detector {
    pools: HashMap<String, PoolState>,
}

impl Detector {
    /// Feed one swap (in order). Returns a rush if this swap completes one.
    pub fn on_swap(&mut self, pool: &str, block: u64, tx: &str, price: f64, r: &Rules) -> Option<RushSig> {
        let st = self.pools.entry(pool.to_string()).or_default();
        if let Some(prev) = st.last_price {
            if price > prev {
                st.buys.push_back((block, tx.to_string()));
            }
        }
        st.last_price = Some(price);
        match st.prices.back_mut() {
            Some((b, p)) if *b == block => *p = price,
            _ => st.prices.push_back((block, price)),
        }
        // Forget anything older than two windows.
        let lo = block.saturating_sub(r.window_blocks - 1);
        while st.buys.front().is_some_and(|(b, _)| *b < lo) {
            st.buys.pop_front();
        }
        while st.prices.len() > 2 && st.prices[1].0 < lo {
            st.prices.pop_front();
        }
        if block < st.cooldown_until || st.buys.len() < r.buys {
            return None;
        }
        let txs: HashSet<&str> = st.buys.iter().map(|(_, t)| t.as_str()).collect();
        if txs.len() < r.buys {
            return None;
        }
        // Price just before the window.
        let p0 = st.prices.iter().rev().find(|(b, _)| *b < lo).map(|(_, p)| *p)?;
        if 100.0 * (price / p0 - 1.0) < r.rise_pct {
            return None;
        }
        st.cooldown_until = block + r.window_blocks;
        Some(RushSig { pool: pool.to_string(), block, price })
    }

    pub fn last_price(&self, pool: &str) -> Option<f64> {
        self.pools.get(pool).and_then(|s| s.last_price)
    }
}

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
    pub http: String,
    pub out: PathBuf,
    pub duration: Option<Duration>,
    pub usd: f64,
    pub tp: f64,
    pub sl: f64,
    pub hold: Duration,
    pub rules: Rules,
    pub poll: Duration,
}

impl Config {
    pub fn from_env() -> Self {
        let unix = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let f = |k: &str, d: f64| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        let block_ms = 105.0;
        Config {
            http: std::env::var("SNIPER_RHC_HTTP").unwrap_or_else(|_| crate::rhc::DEFAULT_HTTP.into()),
            out: PathBuf::from(std::env::var("SNIPER_OUT").unwrap_or_else(|_| format!("paper-out/{unix}"))),
            duration: Some(f("SNIPER_DURATION_SECS", 0.0)).filter(|d| *d > 0.0).map(Duration::from_secs_f64),
            usd: f("SNIPER_PAPER_USD", 50.0),
            tp: f("SNIPER_TP_PCT", 5.0) / 100.0,
            sl: f("SNIPER_SL_PCT", 5.0) / 100.0,
            hold: Duration::from_secs_f64(f("SNIPER_HOLD_SECS", 10.0)),
            rules: Rules {
                buys: f("SNIPER_RUSH_BUYS", 3.0) as usize,
                window_blocks: ((f("SNIPER_RUSH_WINDOW_S", 1.0) * 1000.0 / block_ms).round() as u64).max(1),
                rise_pct: f("SNIPER_RUSH_RISE_PCT", 2.0),
            },
            poll: Duration::from_millis(f("SNIPER_RHC_POLL_MS", 200.0) as u64),
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
    let agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(10))).build().new_agent();
    let mut eth = eth_usd(&quoter).ok_or("could not price ETH in USDG (node or quoter unreachable)")?;
    let mut eth_at = Instant::now();
    let wall_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    write(
        &mut f_meta,
        json!({"event": "start", "wall_ms": wall_ms, "usd": cfg.usd, "tp": cfg.tp, "sl": cfg.sl, "hold_s": cfg.hold.as_secs_f64(),
               "rush_buys": cfg.rules.buys, "window_blocks": cfg.rules.window_blocks, "rise_pct": cfg.rules.rise_pct,
               "node": crate::probe::redact(&cfg.http), "eth_usd": eth}),
    )?;
    eprintln!("paper: writing to {} | ETH ${eth:.0} | ${} per trade, TP {}% SL {}% hold {}s", cfg.out.display(), cfg.usd, cfg.tp * 100.0, cfg.sl * 100.0, cfg.hold.as_secs_f64());

    let swap_topic = sig_v3_swap();
    let mut pools: HashMap<String, Option<Pool>> = HashMap::new();
    let mut det = Detector::default();
    let mut pos: Option<Position> = None;
    let mut last_block: Option<u64> = None;
    let (mut n_trades, mut n_wins, mut total, mut n_rush, mut n_skipped) = (0u64, 0u64, 0.0f64, 0u64, 0u64);
    let started = Instant::now();
    let mut beat = Instant::now();
    let mut errors = 0u32;

    loop {
        std::thread::sleep(cfg.poll);
        if cfg.duration.is_some_and(|d| started.elapsed() >= d) {
            break;
        }
        if eth_at.elapsed() > Duration::from_secs(300) {
            if let Some(e) = eth_usd(&quoter) {
                eth = e;
            }
            eth_at = Instant::now();
        }
        // ---- new swaps ----
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
        let mut rushes: Vec<RushSig> = Vec::new();
        if from <= head {
            let params = json!([{"fromBlock": format!("0x{from:x}"), "toBlock": format!("0x{head:x}"), "topics": [[swap_topic]]}]);
            match rpc.call("eth_getLogs", params) {
                Ok(v) => {
                    last_block = Some(head);
                    let mut logs = v.as_array().cloned().unwrap_or_default();
                    logs.sort_by_key(|l| (hex_u64(l.get("blockNumber")), hex_u64(l.get("logIndex"))));
                    for log in &logs {
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
                        let tx = log["transactionHash"].as_str().unwrap_or("");
                        if let Some(r) = det.on_swap(&pool, block, tx, price, &cfg.rules) {
                            rushes.push(r);
                        }
                    }
                }
                Err(e) => {
                    errors += 1;
                    if errors % 20 == 1 {
                        eprintln!("paper: node error ({e})");
                    }
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
                                   "usd_in": cfg.usd, "gross_usd": gross, "gas_usd": gross - net, "net_usd": net,
                                   "base_in": p.base_in.to_string(), "base_out": out.to_string(), "tokens": p.tokens.to_string(),
                                   "wall_ms": SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)}),
                        )?;
                        eprintln!("paper: SELL {} ({reason}, {:.1}s) net ${net:+.2} | total ${total:+.2} over {n_trades} trades", p.info.token, p.opened.elapsed().as_secs_f64());
                        pos = None;
                    }
                    Err(e) => {
                        // Can't price the exit: keep trying; record it.
                        if p.opened.elapsed() > cfg.hold * 3 {
                            write(&mut f_trades, json!({"pool": p.pool, "token": p.info.token, "reason": "exit_quote_failed", "error": e, "net_usd": -cfg.usd}))?;
                            total -= cfg.usd;
                            n_trades += 1;
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
            let usd_per_base = if info.base == "USDG" { 1.0 } else { eth };
            let base_in = U256::from(((cfg.usd / usd_per_base) * 10f64.powi(base_decimals(info.base))) as u128);
            match quoter.quote(&info.base_addr, &info.token, info.fee, base_in) {
                Ok((tokens, gas_in)) if !tokens.is_zero() => {
                    write(&mut f_sig, json!({"pool": r.pool, "token": info.token, "block": r.block, "taken": true}))?;
                    eprintln!("paper: BUY  {} ${} ({}/{} rush at block {})", info.token, cfg.usd, info.base, r.pool, r.block);
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
                    });
                }
                other => {
                    write(&mut f_sig, json!({"pool": r.pool, "token": info.token, "block": r.block, "taken": false, "why": format!("quote failed: {other:?}")}))?;
                }
            }
        }

        if beat.elapsed() >= Duration::from_secs(60) {
            let h = started.elapsed().as_secs_f64() / 3600.0;
            eprintln!(
                "paper: {}m | rushes {n_rush} (skipped while busy {n_skipped}) | trades {n_trades} | wins {:.0}% | total ${total:+.2} (${:+.2}/h) | open: {}",
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
    let rows: Vec<Value> = fs::read_to_string(dir.join("paper_trades.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
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
    let mean = if n > 0 { total / n as f64 } else { 0.0 };
    let sd = if n > 1 { (nets.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n - 1) as f64).sqrt() } else { 0.0 };
    let half = 1.96 * sd / (n.max(1) as f64).sqrt();
    format!(
        "PAPER TRADER ({:.1} h, ${} per trade)\n\
         rushes seen {} | trades {} | skipped (busy or no quote) {}\n\
         TOTAL ${:+.2}  =  ${:+.2} per hour  |  per trade ${:+.2} (rough 95% range ${:+.2} .. ${:+.2})\n\
         wins {:.0}% | best ${:+.2} | worst ${:+.2} | gas paid ${:.2}\n\
         exits: {:?}\n",
        hours,
        start.and_then(|m| m["usd"].as_f64()).unwrap_or(0.0),
        sig.len(),
        n,
        sig.len() - taken,
        total,
        if hours > 0.0 { total / hours } else { 0.0 },
        mean,
        mean - half,
        mean + half,
        if n > 0 { 100.0 * wins as f64 / n as f64 } else { 0.0 },
        if n > 0 { best } else { 0.0 },
        if n > 0 { worst } else { 0.0 },
        gas,
        reasons
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
}
