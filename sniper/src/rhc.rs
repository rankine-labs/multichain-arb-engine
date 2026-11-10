// ============================================================================
// RHC PROBE: read-only speed-trading test on Robinhood Chain (any token).
//
// Plain English, what it records:
//   1. The SEQUENCER FEED (the same public feed the arb bot's copy reads):
//      the moment each ordered block is broadcast. This is the earliest
//      anyone can know a trade happened on Robinhood Chain.
//   2. Every Uniswap V3 and V4 SWAP on the chain, read from a normal node,
//      with the moment it arrived: which pool, the new price, the fee.
//      (Most tokens trade on these: meme coins, stock tokens, majors.)
//   From those, `sniper rhc-report` works out:
//     - how much earlier the feed is than a node (= our copy's head start
//       over bots that wait for normal block data), and
//     - after a buying rush on any token, whether a fast buy-then-sell
//       would have made money after fees.
//
// Nothing here signs or sends anything. No keys needed: the feed and the
// public RPC are both open (a paid RPC can be used instead).
//
// Config (environment variables):
//   SNIPER_RHC_FEED   sequencer feed (default wss://feed.mainnet.chain.robinhood.com)
//   SNIPER_RHC_HTTP   node for swaps (default https://rpc.mainnet.chain.robinhood.com)
//   SNIPER_OUT        output folder (default rhc-out/<unix time>)
//   SNIPER_DURATION_SECS  stop after this long (0 = until closed)
//   SNIPER_RHC_POLL_MS    how often to ask the node for new blocks (default 200)
// ============================================================================
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::fourmeme::{hex_u64, topic0};
use crate::sellcheck::Rpc;
use crate::ws::Clock;

pub const DEFAULT_FEED: &str = "wss://feed.mainnet.chain.robinhood.com";
pub const DEFAULT_HTTP: &str = "https://rpc.mainnet.chain.robinhood.com";
/// Uniswap V4 PoolManager on Robinhood Chain (from src/config/knownAddresses.ts,
/// bytecode verified on chain by the arb bot work).
pub const V4_POOL_MANAGER: &str = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
/// "Money" side of a pair. A swap is only analysed when exactly one side is
/// one of these, so we know which coin is being bought.
pub const BASES: &[(&str, &str)] = &[
    ("0x0bd7d308f8e1639fab988df18a8011f41eacad73", "WETH"),
    ("0x5fc5360d0400a0fd4f2af552add042d716f1d168", "USDG"),
    ("0x0000000000000000000000000000000000000000", "ETH"),
];

pub fn sig_v3_swap() -> String {
    topic0("Swap(address,address,int256,int256,uint160,uint128,int24)")
}
pub fn sig_v4_swap() -> String {
    topic0("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")
}
pub fn sig_v4_init() -> String {
    topic0("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)")
}

pub fn base_name(addr: &str) -> Option<&'static str> {
    BASES.iter().find(|(a, _)| a.eq_ignore_ascii_case(addr)).map(|(_, n)| *n)
}

/// What we know about a pool: its two coins and fee (millionths).
#[derive(Clone, Debug, PartialEq)]
pub struct PoolInfo {
    pub token0: String,
    pub token1: String,
    pub fee_ppm: Option<u64>,
}

impl PoolInfo {
    /// (token, base, token_is_token0) if exactly one side is a base coin.
    pub fn sides(&self) -> Option<(String, &'static str, bool)> {
        match (base_name(&self.token0), base_name(&self.token1)) {
            (Some(b), None) => Some((self.token1.clone(), b, false)),
            (None, Some(b)) => Some((self.token0.clone(), b, true)),
            _ => None,
        }
    }
}

fn word(data: &str, i: usize) -> Option<&str> {
    let d = data.strip_prefix("0x").unwrap_or(data);
    d.get(i * 64..i * 64 + 64)
}

fn topic_addr(t: &Value) -> String {
    let s = t.as_str().unwrap_or("");
    format!("0x{}", s.get(s.len().saturating_sub(40)..).unwrap_or("").to_ascii_lowercase())
}

/// sqrtPriceX96 word -> decimal string (it is at most 160 bits).
fn word_to_dec(w: &str) -> String {
    crate::fourmeme::word_dec(w)
}

/// One decoded swap (or V4 pool creation) from a log.
#[derive(Clone, Debug, PartialEq)]
pub enum Decoded {
    /// pool = pool address (V3) or pool id (V4)
    Swap { v4: bool, pool: String, sqrt_price: String, fee_ppm: Option<u64> },
    V4Init { pool: String, info: PoolInfo },
}

pub fn decode(log: &Value, v3_swap: &str, v4_swap: &str, v4_init: &str) -> Option<Decoded> {
    let topics = log["topics"].as_array()?;
    let t0 = topics.first()?.as_str()?.to_ascii_lowercase();
    let data = log["data"].as_str()?;
    if t0 == v3_swap {
        // data: amount0, amount1, sqrtPriceX96, liquidity, tick
        let pool = log["address"].as_str()?.to_ascii_lowercase();
        return Some(Decoded::Swap { v4: false, pool, sqrt_price: word_to_dec(word(data, 2)?), fee_ppm: None });
    }
    let from_pm = log["address"].as_str().map(|a| a.eq_ignore_ascii_case(V4_POOL_MANAGER)).unwrap_or(false);
    if t0 == v4_swap && from_pm {
        // topics: id, sender. data: amount0, amount1, sqrtPriceX96, liquidity, tick, fee
        let pool = topics.get(1)?.as_str()?.to_ascii_lowercase();
        let fee = u64::from_str_radix(word(data, 5)?.trim_start_matches('0'), 16).unwrap_or(0) & 0x7f_ffff;
        return Some(Decoded::Swap { v4: true, pool, sqrt_price: word_to_dec(word(data, 2)?), fee_ppm: Some(fee) });
    }
    if t0 == v4_init && from_pm {
        // topics: id, currency0, currency1. data: fee, tickSpacing, hooks, sqrtPriceX96, tick
        let pool = topics.get(1)?.as_str()?.to_ascii_lowercase();
        let fee = u64::from_str_radix(word(data, 0)?.trim_start_matches('0'), 16).unwrap_or(0) & 0x7f_ffff;
        return Some(Decoded::V4Init {
            pool,
            info: PoolInfo { token0: topic_addr(topics.get(2)?), token1: topic_addr(topics.get(3)?), fee_ppm: Some(fee) },
        });
    }
    None
}

/// Look up a V3 pool's coins and fee with one batched request.
fn v3_pool_info(rpc_url: &str, agent: &ureq::Agent, pool: &str) -> Option<PoolInfo> {
    let call = |id: u64, sel: &str| json!({"jsonrpc": "2.0", "id": id, "method": "eth_call", "params": [{"to": pool, "data": sel}, "latest"]});
    // token0() 0x0dfe1681, token1() 0xd21220a7, fee() 0xddca3f43
    let body = json!([call(1, "0x0dfe1681"), call(2, "0xd21220a7"), call(3, "0xddca3f43")]);
    let mut r = agent.post(rpc_url).send_json(&body).ok()?;
    let v: Value = r.body_mut().read_json().ok()?;
    let get = |id: u64| v.as_array()?.iter().find(|x| x["id"] == id).and_then(|x| x["result"].as_str()).map(str::to_string);
    let t0 = get(1)?;
    let t1 = get(2)?;
    let addr = |h: &str| format!("0x{}", h.trim_start_matches("0x")[24..64].to_ascii_lowercase());
    if t0.len() < 66 || t1.len() < 66 {
        return None;
    }
    let fee = get(3).and_then(|f| u64::from_str_radix(f.trim_start_matches("0x").trim_start_matches('0'), 16).ok());
    Some(PoolInfo { token0: addr(&t0), token1: addr(&t1), fee_ppm: fee })
}

enum Msg {
    Feed { t: u64, seq: u64, ts: u64 },
    Logs { t: u64, block_from: u64, block_to: u64, logs: Vec<Value> },
    Note(String),
}

pub struct Config {
    pub feed: String,
    pub http: String,
    pub out: PathBuf,
    pub duration: Option<Duration>,
    pub poll_ms: u64,
}

impl Config {
    pub fn from_env() -> Self {
        let unix = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let num = |k: &str, d: u64| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        let dur = num("SNIPER_DURATION_SECS", 0);
        Config {
            feed: std::env::var("SNIPER_RHC_FEED").unwrap_or_else(|_| DEFAULT_FEED.into()),
            http: std::env::var("SNIPER_RHC_HTTP").unwrap_or_else(|_| DEFAULT_HTTP.into()),
            out: PathBuf::from(std::env::var("SNIPER_OUT").unwrap_or_else(|_| format!("rhc-out/{unix}"))),
            duration: (dur > 0).then(|| Duration::from_secs(dur)),
            poll_ms: num("SNIPER_RHC_POLL_MS", 200),
        }
    }
}

/// Sequence numbers and L2 header timestamp of every message in a feed frame.
pub fn feed_frame_seqs(text: &str) -> Vec<(u64, u64)> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return vec![] };
    v["messages"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    let seq = m["sequenceNumber"].as_u64()?;
                    let ts = m["message"]["message"]["header"]["timestamp"].as_u64().unwrap_or(0);
                    Some((seq, ts))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn feed_thread(url: String, clock: Clock, stop: Arc<AtomicBool>, tx: mpsc::Sender<Msg>) {
    let mut backoff = Duration::from_secs(1);
    while !stop.load(Ordering::Relaxed) {
        match tungstenite::connect(url.as_str()) {
            Ok((mut ws, _)) => {
                let _ = tx.send(Msg::Note(format!("feed UP ({url})")));
                backoff = Duration::from_secs(1);
                loop {
                    if stop.load(Ordering::Relaxed) {
                        return;
                    }
                    match ws.read() {
                        Ok(tungstenite::Message::Text(s)) => {
                            let t = clock.now();
                            for (seq, ts) in feed_frame_seqs(&s) {
                                let _ = tx.send(Msg::Feed { t, seq, ts });
                            }
                        }
                        Ok(tungstenite::Message::Close(_)) => break,
                        Ok(_) => {}
                        Err(e) => {
                            let _ = tx.send(Msg::Note(format!("feed DOWN ({e})")));
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                let _ = tx.send(Msg::Note(format!("feed DOWN (connect: {e})")));
            }
        }
        std::thread::sleep(backoff);
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

fn poll_thread(url: String, poll: Duration, clock: Clock, stop: Arc<AtomicBool>, tx: mpsc::Sender<Msg>) {
    let rpc = Rpc::new(&url);
    let topics = vec![sig_v3_swap(), sig_v4_swap(), sig_v4_init()];
    let mut last: Option<u64> = None;
    let mut errors = 0u32;
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(poll);
        let head = match rpc.call("eth_blockNumber", json!([])) {
            Ok(v) => hex_u64(Some(&v)),
            Err(e) => {
                errors += 1;
                if errors % 20 == 1 {
                    let _ = tx.send(Msg::Note(format!("node error ({e})")));
                }
                continue;
            }
        };
        let from = match last {
            None => head,
            Some(l) if head <= l => continue,
            // Never ask for more than 50 blocks at once after a hiccup.
            Some(l) => (l + 1).max(head.saturating_sub(50)),
        };
        let params = json!([{"fromBlock": format!("0x{from:x}"), "toBlock": format!("0x{head:x}"), "topics": [topics]}]);
        match rpc.call("eth_getLogs", params) {
            Ok(v) => {
                let t = clock.now();
                let logs = v.as_array().cloned().unwrap_or_default();
                let _ = tx.send(Msg::Logs { t, block_from: from, block_to: head, logs });
                last = Some(head);
                errors = 0;
            }
            Err(e) => {
                errors += 1;
                if errors % 20 == 1 {
                    let _ = tx.send(Msg::Note(format!("node error ({e})")));
                }
            }
        }
    }
}

pub fn run(cfg: Config) -> Result<(), String> {
    fs::create_dir_all(&cfg.out).map_err(|e| e.to_string())?;
    let open = |n: &str| OpenOptions::new().create(true).append(true).open(cfg.out.join(n)).map(BufWriter::new).map_err(|e| e.to_string());
    let (mut f_feed, mut f_swaps, mut f_blocks, mut f_meta, mut f_pools) =
        (open("feed.jsonl")?, open("swaps.jsonl")?, open("blocks.jsonl")?, open("meta.jsonl")?, open("pools.jsonl")?);
    let clock = Clock::new();
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<Msg>();
    {
        let (u, s, t) = (cfg.feed.clone(), stop.clone(), tx.clone());
        std::thread::spawn(move || feed_thread(u, clock, s, t));
    }
    {
        let (u, s, t, p) = (cfg.http.clone(), stop.clone(), tx.clone(), Duration::from_millis(cfg.poll_ms));
        std::thread::spawn(move || poll_thread(u, p, clock, s, t));
    }
    drop(tx);
    let wall_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let w = |f: &mut BufWriter<std::fs::File>, v: Value| -> Result<(), String> {
        serde_json::to_writer(&mut *f, &v).map_err(|e| e.to_string())?;
        f.write_all(b"\n").map_err(|e| e.to_string())
    };
    w(&mut f_meta, json!({"event": "start", "t": 0, "wall_ms": wall_ms, "feed": cfg.feed, "http": crate::probe::redact(&cfg.http), "poll_ms": cfg.poll_ms}))?;
    eprintln!("rhc: writing to {}", cfg.out.display());

    let (v3s, v4s, v4i) = (sig_v3_swap(), sig_v4_swap(), sig_v4_init());
    let agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(10))).build().new_agent();
    let mut pools: HashMap<String, Option<PoolInfo>> = HashMap::new();
    let (mut n_feed, mut n_swaps, mut n_used) = (0u64, 0u64, 0u64);
    let started = Instant::now();
    let (mut last_flush, mut last_beat) = (Instant::now(), Instant::now());
    loop {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Msg::Feed { t, seq, ts }) => {
                n_feed += 1;
                w(&mut f_feed, json!({"seq": seq, "t": t, "ts": ts}))?;
            }
            Ok(Msg::Logs { t, block_from, block_to, logs }) => {
                w(&mut f_blocks, json!({"from": block_from, "to": block_to, "t": t}))?;
                for log in &logs {
                    match decode(log, &v3s, &v4s, &v4i) {
                        Some(Decoded::V4Init { pool, info }) => {
                            w(&mut f_pools, json!({"pool": pool, "token0": info.token0, "token1": info.token1, "fee_ppm": info.fee_ppm, "v4": true}))?;
                            pools.insert(pool, Some(info));
                        }
                        Some(Decoded::Swap { v4, pool, sqrt_price, fee_ppm }) => {
                            n_swaps += 1;
                            if !pools.contains_key(&pool) {
                                // V3: ask the pool. V4 pools created before we
                                // started stay unknown (their coins aren't in
                                // the swap event).
                                let info = if v4 { None } else { v3_pool_info(&cfg.http, &agent, &pool) };
                                if let Some(i) = &info {
                                    w(&mut f_pools, json!({"pool": pool, "token0": i.token0, "token1": i.token1, "fee_ppm": i.fee_ppm, "v4": false}))?;
                                }
                                pools.insert(pool.clone(), info);
                            }
                            let Some(Some(info)) = pools.get(&pool) else { continue };
                            let Some((token, base, token_is0)) = info.sides() else { continue };
                            n_used += 1;
                            w(
                                &mut f_swaps,
                                json!({
                                    "pool": pool, "v4": v4, "token": token, "base": base, "token_is0": token_is0,
                                    "sqrt_price": sqrt_price, "fee_ppm": fee_ppm.or(info.fee_ppm),
                                    "block": hex_u64(log.get("blockNumber")), "log_index": hex_u64(log.get("logIndex")),
                                    "tx": log["transactionHash"], "t": t,
                                }),
                            )?;
                        }
                        None => {}
                    }
                }
            }
            Ok(Msg::Note(s)) => {
                eprintln!("rhc: {s}");
                w(&mut f_meta, json!({"event": "note", "t": clock.now(), "detail": s}))?;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if last_flush.elapsed() >= Duration::from_secs(1) {
            for f in [&mut f_feed, &mut f_swaps, &mut f_blocks, &mut f_meta, &mut f_pools] {
                let _ = f.flush();
            }
            last_flush = Instant::now();
        }
        if last_beat.elapsed() >= Duration::from_secs(60) {
            eprintln!(
                "rhc: {}m | feed blocks {} | swaps seen {} | swaps on token/base pools {} | pools known {}",
                started.elapsed().as_secs() / 60,
                n_feed,
                n_swaps,
                n_used,
                pools.values().filter(|p| p.is_some()).count()
            );
            last_beat = Instant::now();
        }
        if cfg.duration.is_some_and(|d| started.elapsed() >= d) {
            break;
        }
    }
    stop.store(true, Ordering::Relaxed);
    w(&mut f_meta, json!({"event": "stop", "t": clock.now()}))?;
    for f in [&mut f_feed, &mut f_swaps, &mut f_blocks, &mut f_meta, &mut f_pools] {
        let _ = f.flush();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_event_ids() {
        // Uniswap V3 Swap event id (well known).
        assert_eq!(sig_v3_swap(), "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67");
        // Uniswap V4 Swap and Initialize event ids (well known).
        assert_eq!(sig_v4_swap(), "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f");
        assert_eq!(sig_v4_init(), "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438");
    }

    #[test]
    fn feed_frames_give_sequence_numbers() {
        let f = r#"{"version":1,"messages":[{"sequenceNumber":10,"message":{"message":{"header":{"kind":3,"timestamp":1700000000},"l2Msg":"AA=="}}},{"sequenceNumber":11,"message":{"message":{"header":{"kind":3,"timestamp":1700000001},"l2Msg":"AA=="}}}]}"#;
        assert_eq!(feed_frame_seqs(f), vec![(10, 1700000000), (11, 1700000001)]);
        assert!(feed_frame_seqs("not json").is_empty());
    }

    #[test]
    fn decodes_v3_and_v4_swaps_and_v4_init() {
        let (a, b, c) = (sig_v3_swap(), sig_v4_swap(), sig_v4_init());
        let w = |x: u64| format!("{x:064x}");
        let v3 = json!({"address": "0xPOOL", "topics": [a, "0x01", "0x02"],
                        "data": format!("0x{}{}{}{}{}", w(1), w(2), w(777), w(5), w(6))});
        assert_eq!(decode(&v3, &a, &b, &c), Some(Decoded::Swap { v4: false, pool: "0xpool".into(), sqrt_price: "777".into(), fee_ppm: None }));
        let v4 = json!({"address": V4_POOL_MANAGER, "topics": [b, "0xID", "0x02"],
                        "data": format!("0x{}{}{}{}{}{}", w(1), w(2), w(888), w(5), w(6), w(3000))});
        assert_eq!(decode(&v4, &a, &b, &c), Some(Decoded::Swap { v4: true, pool: "0xid".into(), sqrt_price: "888".into(), fee_ppm: Some(3000) }));
        // A V4-looking Swap from some other contract is ignored.
        let fake = json!({"address": "0xdead", "topics": [b, "0xID"], "data": v4["data"]});
        assert_eq!(decode(&fake, &a, &b, &c), None);
        let init = json!({"address": V4_POOL_MANAGER,
                          "topics": [c, "0xID2", format!("0x{:0>64}", "0bd7d308f8e1639fab988df18a8011f41eacad73"), format!("0x{:0>64}", "abcd")],
                          "data": format!("0x{}{}{}{}{}", w(10000), w(200), w(0), w(1), w(0))});
        match decode(&init, &a, &b, &c).unwrap() {
            Decoded::V4Init { pool, info } => {
                assert_eq!(pool, "0xid2");
                assert_eq!(info.sides().unwrap().1, "WETH");
                assert_eq!(info.fee_ppm, Some(10000));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn sides_pick_the_non_base_coin() {
        let p = PoolInfo { token0: "0xaaa".into(), token1: BASES[1].0.into(), fee_ppm: Some(3000) };
        assert_eq!(p.sides(), Some(("0xaaa".into(), "USDG", true)));
        let both = PoolInfo { token0: BASES[0].0.into(), token1: BASES[1].0.into(), fee_ppm: None };
        assert_eq!(both.sides(), None); // WETH/USDG: no "token" to snipe
    }
}
