// ============================================================================
// FEED WATCH: how far ahead does the sequencer feed show us each swap, and
// which contracts (routers) do the swaps come through?
//
// Plain English:
//   Two things run side by side on the server:
//     1. The SEQUENCER FEED: every user transaction, the moment the sequencer
//        orders it (see feedtx.rs). We remember each one for 2 minutes:
//        when we saw it, which contract it calls and with which function.
//     2. The NODE: asked every few hundred ms for new swap events (Uniswap
//        V3 and V4), which is how a "normal" (slow) bot learns about trades.
//   For every swap the node shows, we look its transaction up in what the
//   feed already showed us:
//     lead time  = node time - feed time (our head start over slow bots),
//     router     = which contract + function the swap went through.
//   Router call data samples are kept so the fast trader can decode buys
//   straight from the feed, before any block exists.
//
//   Read-only: no keys, never sends anything.
//
// Output folder (SNIPER_OUT, default feed-out/<unix>):
//   matched.jsonl  one line per swap: tx, pool, v4, block, seq, lead_ms, to, sel
//   samples.jsonl  up to 5 full call-data samples per (router, function)
//   meta.jsonl     start/stop/notes + a summary every 10 min
//
// Settings: SNIPER_RHC_FEED, SNIPER_RHC_HTTP, SNIPER_FW_POLL_MS (default 500)
// Report:   sniper feed-report <dir>
// ============================================================================
use std::collections::{HashMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::feedtx::{self, FeedTx};
use crate::fourmeme::hex_u64;
use crate::rhc::{sig_v3_swap, sig_v4_swap, V4_POOL_MANAGER};
use crate::sellcheck::Rpc;
use crate::ws::Clock;

/// How long we remember a feed transaction (ms).
const KEEP_MS: u64 = 120_000;

pub struct Config {
    pub feed: String,
    pub http: String,
    pub out: PathBuf,
    pub poll_ms: u64,
}

impl Config {
    pub fn from_env() -> Self {
        let unix = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        Config {
            feed: std::env::var("SNIPER_RHC_FEED").unwrap_or_else(|_| crate::rhc::DEFAULT_FEED.into()),
            http: std::env::var("SNIPER_RHC_HTTP").unwrap_or_else(|_| crate::rhc::DEFAULT_HTTP.into()),
            out: PathBuf::from(std::env::var("SNIPER_OUT").unwrap_or_else(|_| format!("feed-out/{unix}"))),
            // Own setting (not SNIPER_RHC_POLL_MS) so it doesn't share the paper
            // trader's pace; slower = fewer "429 too many requests" from the free node.
            poll_ms: std::env::var("SNIPER_FW_POLL_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(500),
        }
    }
}

enum Msg {
    /// Blocks from one feed frame, received at t (ms since start).
    Feed { t: u64, blocks: Vec<feedtx::FeedBlock> },
    /// Swap logs from the node, received at t (ms since start).
    Logs { t: u64, logs: Vec<Value> },
    Note(String),
}

/// What we remember about a feed transaction.
#[derive(Clone)]
struct Seen {
    t: u64,
    seq: u64,
    to: String,
    sel: String,
}

/// Everything the main loop keeps (separate so it can be unit tested).
#[derive(Default)]
pub struct Matcher {
    seen: HashMap<String, Seen>,
    order: VecDeque<(u64, String)>,
    samples: HashMap<(String, String), usize>,
    pub feed_txs: u64,
    pub swaps: u64,
    pub matched: u64,
    leads: Vec<u64>,
    routers: HashMap<(String, String), u64>,
}

/// Result of matching one swap log.
#[derive(Debug, PartialEq)]
pub struct Match {
    pub tx: String,
    pub lead_ms: Option<u64>,
    pub seq: Option<u64>,
    pub to: Option<String>,
    pub sel: Option<String>,
}

impl Matcher {
    /// Remember a feed transaction. Returns true if this (router, function)
    /// still needs call-data samples (caller stores the sample).
    pub fn add_feed(&mut self, t: u64, seq: u64, tx: &FeedTx) {
        self.feed_txs += 1;
        let to = tx.to.clone().unwrap_or_default();
        self.seen.insert(tx.hash.clone(), Seen { t, seq, to, sel: tx.selector() });
        self.order.push_back((t, tx.hash.clone()));
        while let Some((old, h)) = self.order.front() {
            if t.saturating_sub(*old) <= KEEP_MS {
                break;
            }
            self.seen.remove(h);
            self.order.pop_front();
        }
    }

    /// Match one swap (by its tx hash) seen from the node at time t.
    pub fn on_swap(&mut self, t: u64, tx: &str) -> Match {
        self.swaps += 1;
        match self.seen.get(tx) {
            Some(s) => {
                self.matched += 1;
                let lead = t.saturating_sub(s.t);
                self.leads.push(lead);
                *self.routers.entry((s.to.clone(), s.sel.clone())).or_default() += 1;
                Match { tx: tx.into(), lead_ms: Some(lead), seq: Some(s.seq), to: Some(s.to.clone()), sel: Some(s.sel.clone()) }
            }
            None => Match { tx: tx.into(), lead_ms: None, seq: None, to: None, sel: None },
        }
    }

    /// Should we keep a call-data sample for this router+function? (max 5 each)
    pub fn want_sample(&mut self, to: &str, sel: &str) -> bool {
        let n = self.samples.entry((to.into(), sel.into())).or_default();
        *n += 1;
        *n <= 5
    }

    pub fn summary(&self) -> Value {
        let mut l = self.leads.clone();
        l.sort_unstable();
        let pct = |p: f64| l.get(((l.len() as f64 - 1.0) * p).round() as usize).copied();
        let mut r: Vec<_> = self.routers.iter().collect();
        r.sort_by_key(|x| std::cmp::Reverse(*x.1));
        json!({
            "feed_txs": self.feed_txs, "swaps": self.swaps, "matched": self.matched,
            "lead_ms": {"p10": pct(0.1), "p50": pct(0.5), "p90": pct(0.9)},
            "routers": r.iter().take(15).map(|((to, sel), n)| json!({"to": to, "sel": sel, "n": n})).collect::<Vec<_>>(),
        })
    }
}

fn feed_thread(url: String, clock: Clock, stop: Arc<AtomicBool>, tx: mpsc::Sender<Msg>) {
    let mut backoff = Duration::from_secs(1);
    while !stop.load(Ordering::Relaxed) {
        // Same identifying headers as the official Nitro feed client.
        let req = (|| {
            use tungstenite::client::IntoClientRequest;
            let mut r = url.as_str().into_client_request().ok()?;
            let h = r.headers_mut();
            h.insert("User-Agent", "Mozilla/5.0 (compatible; sniper-feed-watch/0.1)".parse().ok()?);
            h.insert("Arbitrum-Feed-Client-Version", "2".parse().ok()?);
            Some(r)
        })();
        let Some(req) = req else {
            let _ = tx.send(Msg::Note(format!("feed DOWN (bad URL {url})")));
            return;
        };
        match tungstenite::connect(req) {
            Ok((mut ws, _)) => {
                let _ = tx.send(Msg::Note("feed UP".into()));
                backoff = Duration::from_secs(1);
                loop {
                    if stop.load(Ordering::Relaxed) {
                        return;
                    }
                    match ws.read() {
                        Ok(tungstenite::Message::Text(s)) => {
                            let t = clock.now() / 1_000_000;
                            let blocks = feedtx::parse_frame(&s);
                            if !blocks.is_empty() {
                                let _ = tx.send(Msg::Feed { t, blocks });
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
    let topics = vec![sig_v3_swap(), sig_v4_swap()];
    let mut last: Option<u64> = None;
    let mut errors = 0u32;
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(poll);
        let head = match rpc.call("eth_blockNumber", json!([])) {
            Ok(v) => hex_u64(Some(&v)),
            Err(e) => {
                errors += 1;
                if errors % 50 == 1 {
                    let _ = tx.send(Msg::Note(format!("node error ({e})")));
                }
                continue;
            }
        };
        let from = match last {
            None => head,
            Some(l) if head <= l => continue,
            Some(l) => (l + 1).max(head.saturating_sub(50)),
        };
        let params = json!([{"fromBlock": format!("0x{from:x}"), "toBlock": format!("0x{head:x}"), "topics": [topics]}]);
        match rpc.call("eth_getLogs", params) {
            Ok(v) => {
                let t = clock.now() / 1_000_000;
                let _ = tx.send(Msg::Logs { t, logs: v.as_array().cloned().unwrap_or_default() });
                last = Some(head);
                errors = 0;
            }
            Err(e) => {
                errors += 1;
                if errors % 50 == 1 {
                    let _ = tx.send(Msg::Note(format!("node error ({e})")));
                }
            }
        }
    }
}

pub fn run(cfg: Config) -> Result<(), String> {
    fs::create_dir_all(&cfg.out).map_err(|e| e.to_string())?;
    let open = |n: &str| OpenOptions::new().create(true).append(true).open(cfg.out.join(n)).map(BufWriter::new).map_err(|e| e.to_string());
    let (mut f_match, mut f_samp, mut f_meta) = (open("matched.jsonl")?, open("samples.jsonl")?, open("meta.jsonl")?);
    let w = |f: &mut BufWriter<std::fs::File>, v: Value| -> Result<(), String> {
        serde_json::to_writer(&mut *f, &v).map_err(|e| e.to_string())?;
        f.write_all(b"\n").map_err(|e| e.to_string())
    };
    let wall_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    w(&mut f_meta, json!({"event": "start", "wall_ms": wall_ms, "poll_ms": cfg.poll_ms}))?;
    eprintln!("feed-watch: writing to {}", cfg.out.display());

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

    let (v3, v4) = (sig_v3_swap(), sig_v4_swap());
    let mut m = Matcher::default();
    // Full call data of recent feed txs, so we can store samples on match.
    let mut data: HashMap<String, (Vec<u8>, u128)> = HashMap::new();
    let mut data_order: VecDeque<String> = VecDeque::new();
    let started = Instant::now();
    let (mut last_flush, mut last_sum, mut last_beat) = (Instant::now(), Instant::now(), Instant::now());
    loop {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Msg::Feed { t, blocks }) => {
                for b in blocks {
                    for ftx in b.txs {
                        // Only calls with data can be swaps; keep their bytes briefly.
                        if ftx.data.len() >= 4 {
                            data.insert(ftx.hash.clone(), (ftx.data.clone(), ftx.value));
                            data_order.push_back(ftx.hash.clone());
                            if data_order.len() > 50_000 {
                                if let Some(h) = data_order.pop_front() {
                                    data.remove(&h);
                                }
                            }
                        }
                        m.add_feed(t, b.seq, &ftx);
                    }
                }
            }
            Ok(Msg::Logs { t, logs }) => {
                // One line per swap transaction (a tx can hold several swaps).
                let mut done: Vec<String> = Vec::new();
                for log in &logs {
                    let t0 = log["topics"][0].as_str().unwrap_or("").to_ascii_lowercase();
                    let is_v4 = t0 == v4 && log["address"].as_str().is_some_and(|a| a.eq_ignore_ascii_case(V4_POOL_MANAGER));
                    if t0 != v3 && !is_v4 {
                        continue;
                    }
                    let hash = log["transactionHash"].as_str().unwrap_or("").to_ascii_lowercase();
                    if hash.is_empty() || done.contains(&hash) {
                        continue;
                    }
                    done.push(hash.clone());
                    let pool = if is_v4 { log["topics"][1].as_str().unwrap_or("").to_string() } else { log["address"].as_str().unwrap_or("").to_ascii_lowercase() };
                    let r = m.on_swap(t, &hash);
                    w(&mut f_match, json!({
                        "tx": hash, "pool": pool, "v4": is_v4, "block": hex_u64(log.get("blockNumber")),
                        "seq": r.seq, "lead_ms": r.lead_ms, "to": r.to, "sel": r.sel, "t": t,
                    }))?;
                    if let (Some(to), Some(sel)) = (&r.to, &r.sel) {
                        if m.want_sample(to, sel) {
                            if let Some((d, value)) = data.get(&hash) {
                                w(&mut f_samp, json!({"tx": hash, "to": to, "sel": sel, "value": value.to_string(), "data": format!("0x{}", feedtx::hex(d))}))?;
                            }
                        }
                    }
                }
            }
            Ok(Msg::Note(s)) => {
                eprintln!("feed-watch: {s}");
                w(&mut f_meta, json!({"event": "note", "t": clock.now() / 1_000_000, "detail": s}))?;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if last_flush.elapsed() >= Duration::from_secs(2) {
            for f in [&mut f_match, &mut f_samp, &mut f_meta] {
                let _ = f.flush();
            }
            last_flush = Instant::now();
        }
        if last_beat.elapsed() >= Duration::from_secs(60) {
            // Feed health line: how many feed txs we've decoded so far.
            w(&mut f_meta, json!({"event": "beat", "t": clock.now() / 1_000_000, "feed_txs": m.feed_txs, "swaps": m.swaps, "matched": m.matched}))?;
            eprintln!("feed-watch: {}m | feed txs {} | swaps {} | matched {}", started.elapsed().as_secs() / 60, m.feed_txs, m.swaps, m.matched);
            last_beat = Instant::now();
        }
        if last_sum.elapsed() >= Duration::from_secs(600) {
            let s = m.summary();
            eprintln!("feed-watch: {}m | {}", started.elapsed().as_secs() / 60, s);
            w(&mut f_meta, json!({"event": "summary", "t": clock.now() / 1_000_000, "s": s}))?;
            last_sum = Instant::now();
        }
    }
    stop.store(true, Ordering::Relaxed);
    Ok(())
}

/// Plain-English report from matched.jsonl.
pub fn report(dir: &Path) -> String {
    // Feed health from meta.jsonl: last feed UP/DOWN note and decoded tx count.
    let meta: Vec<Value> = fs::read_to_string(dir.join("meta.jsonl")).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let feed_note = meta.iter().rev().filter_map(|m| m["detail"].as_str()).find(|d| d.starts_with("feed ")).unwrap_or("no feed status yet");
    let feed_txs = meta.iter().rev().find_map(|m| m["feed_txs"].as_u64()).unwrap_or(0);
    let health = format!("feed: {feed_note} | feed txs decoded {feed_txs}\n");
    health + &report_rows(dir)
}

fn report_rows(dir: &Path) -> String {
    let rows: Vec<Value> = fs::read_to_string(dir.join("matched.jsonl")).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    if rows.is_empty() {
        return "FEED WATCH: no swaps recorded yet\n".into();
    }
    let n = rows.len();
    let mut leads: Vec<u64> = rows.iter().filter_map(|r| r["lead_ms"].as_u64()).collect();
    leads.sort_unstable();
    let pct = |p: f64| leads.get(((leads.len().max(1) as f64 - 1.0) * p).round() as usize).copied().unwrap_or(0);
    let mut routers: HashMap<(String, String), usize> = HashMap::new();
    for r in &rows {
        if let (Some(to), Some(sel)) = (r["to"].as_str(), r["sel"].as_str()) {
            *routers.entry((to.into(), sel.into())).or_default() += 1;
        }
    }
    let mut rs: Vec<_> = routers.into_iter().collect();
    rs.sort_by_key(|x| std::cmp::Reverse(x.1));
    let mut out = format!(
        "FEED WATCH ({n} swap txs from the node)\n\
         seen first in the feed: {} ({:.0}%)\n\
         head start over the node: p10 {} ms | median {} ms | p90 {} ms\n\
         top routers (contract, function, share of swaps):\n",
        leads.len(),
        100.0 * leads.len() as f64 / n as f64,
        pct(0.1),
        pct(0.5),
        pct(0.9)
    );
    for ((to, sel), c) in rs.iter().take(10) {
        out += &format!("  {to} {sel}  {c} ({:.0}%)\n", 100.0 * *c as f64 / n as f64);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ftx(h: &str, to: &str) -> FeedTx {
        FeedTx { hash: h.into(), to: Some(to.into()), data: vec![0xaa, 0xbb, 0xcc, 0xdd, 1], value: 0 }
    }

    #[test]
    fn matches_and_measures_lead() {
        let mut m = Matcher::default();
        m.add_feed(1_000, 7, &ftx("0x01", "0xrouter"));
        let r = m.on_swap(1_250, "0x01");
        assert_eq!(r.lead_ms, Some(250));
        assert_eq!(r.seq, Some(7));
        assert_eq!(r.sel.as_deref(), Some("0xaabbccdd"));
        // not seen in feed
        assert_eq!(m.on_swap(1_300, "0x02").lead_ms, None);
        assert_eq!((m.swaps, m.matched), (2, 1));
        let s = m.summary();
        assert_eq!(s["routers"][0]["to"], "0xrouter");
    }

    #[test]
    fn forgets_old_feed_txs() {
        let mut m = Matcher::default();
        m.add_feed(0, 1, &ftx("0xold", "0xr"));
        m.add_feed(KEEP_MS + 1, 2, &ftx("0xnew", "0xr"));
        assert_eq!(m.on_swap(KEEP_MS + 2, "0xold").lead_ms, None);
        assert!(m.on_swap(KEEP_MS + 2, "0xnew").lead_ms.is_some());
    }

    #[test]
    fn samples_capped() {
        let mut m = Matcher::default();
        let got: Vec<bool> = (0..7).map(|_| m.want_sample("0xr", "0xs")).collect();
        assert_eq!(got.iter().filter(|x| **x).count(), 5);
    }

    #[test]
    fn report_reads_file() {
        let dir = std::env::temp_dir().join(format!("sniper-fw-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let l = |lead: Option<u64>| json!({"tx": "0x1", "lead_ms": lead, "to": lead.map(|_| "0xr"), "sel": lead.map(|_| "0xs")}).to_string();
        fs::write(dir.join("matched.jsonl"), [l(Some(100)), l(Some(300)), l(None)].join("\n")).unwrap();
        let r = report(&dir);
        assert!(r.contains("3 swap txs"), "{r}");
        assert!(r.contains("seen first in the feed: 2 (67%)"), "{r}");
        assert!(r.contains("0xr 0xs  2 (67%)"), "{r}");
        let _ = fs::remove_dir_all(&dir);
    }
}
