// ============================================================================
// SCAN: the live token scanner (read-only).
//
// Plain English:
//   Listens to Four.meme events on the block feed, keeps the registry up to
//   date, and prints / records every signal the moment it happens:
//     NEW     a token appeared
//     BURST   a token got N buys from N wallets in one block
//     DUMP    the token's creator sold
//     GRAD    the token graduated to PancakeSwap
//   Every 30 s it prints the most active tokens. Each signal line carries
//   the local time it was raised, so later we can measure how fast we react.
//
//   Config: SNIPER_BLOCK_WS (required), SNIPER_OUT (default scan-out/<time>),
//   SNIPER_BURST_BUYS (default 3), SNIPER_DURATION_SECS (0 = until killed).
// ============================================================================
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::fourmeme::{decode_log, Topics, TOKEN_MANAGER_1, TOKEN_MANAGER_2};
use crate::registry::{Registry, Signal};
use crate::ws::{self, Clock, Sub};

pub struct Config {
    pub block_ws: String,
    pub out: PathBuf,
    pub burst_buys: u64,
    pub duration: Option<Duration>,
    pub contracts: Vec<String>,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let block_ws = std::env::var("SNIPER_BLOCK_WS").map_err(|_| "SNIPER_BLOCK_WS is not set".to_string())?;
        let unix = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let num = |k: &str, d: u64| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        let dur = num("SNIPER_DURATION_SECS", 0);
        Ok(Config {
            block_ws,
            out: PathBuf::from(std::env::var("SNIPER_OUT").unwrap_or_else(|_| format!("scan-out/{unix}"))),
            burst_buys: num("SNIPER_BURST_BUYS", 3),
            duration: (dur > 0).then(|| Duration::from_secs(dur)),
            contracts: vec![TOKEN_MANAGER_2.to_string(), TOKEN_MANAGER_1.to_string()],
        })
    }
}

enum Msg {
    Log(u64, Value),
    Link(bool, String),
}

/// One-line human description of a signal.
pub fn describe(sig: &Signal) -> String {
    match sig {
        Signal::NewToken { token, block, .. } => format!("NEW   {token} (block {block})"),
        Signal::Burst { token, block, buys, buyers, net_bought, .. } => {
            format!("BURST {token} block {block}: {buys} buys / {buyers} wallets, net {:.3} in", f64::from(*net_bought) / 1e18)
        }
        Signal::CreatorSold { token, block, .. } => format!("DUMP  {token} creator sold (block {block})"),
        Signal::Graduated { token, block } => format!("GRAD  {token} graduated (block {block})"),
    }
}

pub fn run(cfg: Config) -> Result<(), String> {
    fs::create_dir_all(&cfg.out).map_err(|e| e.to_string())?;
    let file = OpenOptions::new().create(true).append(true).open(cfg.out.join("signals.jsonl")).map_err(|e| e.to_string())?;
    let mut w = BufWriter::new(file);
    let clock = Clock::new();
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<Msg>();
    let topics = Topics::new();

    {
        let (stop, url) = (stop.clone(), cfg.block_ws.clone());
        let subs = vec![Sub { label: "logs", params: json!(["logs", {"address": cfg.contracts, "topics": [topics.all()]}]), fallback: None }];
        std::thread::spawn(move || {
            let tx2 = tx.clone();
            ws::run(
                &url,
                &subs,
                clock,
                &stop,
                |t, _, item| {
                    let _ = tx.send(Msg::Log(t, item.clone()));
                },
                |_, up, detail| {
                    let _ = tx2.send(Msg::Link(up, detail));
                },
            );
        });
    }

    let mut reg = Registry::new(cfg.burst_buys, 3600);
    let started = Instant::now();
    let mut last_beat = Instant::now();
    let mut last_flush = Instant::now();
    eprintln!("scan: writing to {}", cfg.out.display());
    loop {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Msg::Log(t, log)) => {
                if let Some((_, rec)) = decode_log(&topics, &log) {
                    for sig in reg.on_event(&rec, t) {
                        eprintln!("scan: {}", describe(&sig));
                        let mut j = sig.json();
                        j["t"] = json!(t);
                        serde_json::to_writer(&mut w, &j).map_err(|e| e.to_string())?;
                        w.write_all(b"\n").map_err(|e| e.to_string())?;
                    }
                }
            }
            Ok(Msg::Link(up, detail)) => eprintln!("scan: block feed {} ({detail})", if up { "UP" } else { "DOWN" }),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if last_flush.elapsed() >= Duration::from_secs(1) {
            let _ = w.flush();
            last_flush = Instant::now();
        }
        if last_beat.elapsed() >= Duration::from_secs(30) {
            let now = clock.now();
            reg.prune(now);
            let hot: Vec<String> = reg
                .hottest(now, 300_000_000_000, 5)
                .iter()
                .map(|e| format!("{} ({} buys, {} wallets{})", e.token, e.buys, e.buyers.len(), if e.creator_sold { ", creator sold" } else { "" }))
                .collect();
            eprintln!("scan: {} tokens tracked | hottest 5 min: {}", reg.tokens.len(), hot.join(" | "));
            last_beat = Instant::now();
        }
        if cfg.duration.is_some_and(|d| started.elapsed() >= d) {
            break;
        }
    }
    stop.store(true, Ordering::Relaxed);
    let _ = w.flush();
    Ok(())
}
