// ============================================================================
// PROBE: the read-only lead-time measurement run.
//
// Plain English:
//   Threads:
//     one per pending feed  -> "tx X seen pending at time T"
//     one block feed        -> new block headers + Four.meme logs
//     main thread           -> the matcher, writes JSONL files, prints a
//                              heartbeat once a minute
//   Nothing here signs, holds keys or sends transactions.
//
// Configuration (environment variables):
//   SNIPER_PENDING_WS   comma list of pending feeds, each "name=wss://..."
//                       (name optional). Required.
//   SNIPER_BLOCK_WS     websocket for heads + logs (default: first pending feed)
//   SNIPER_OUT          output folder (default: probe-out/<unix time>)
//   SNIPER_DURATION_SECS  stop after this long (default 0 = run until killed)
//   SNIPER_PENDING_TTL_SECS  how long a pending hash is remembered (default 180)
//   SNIPER_HASH_ONLY=1  ask for pending hashes only (less bandwidth, but no
//                       "pending direct Four.meme call" records)
// ============================================================================
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::fourmeme::{hex_u64, Topics, TOKEN_MANAGER_1, TOKEN_MANAGER_2};
use crate::matcher::{Event, Matcher, Out};
use crate::ws::{self, Clock, Sub};

#[derive(Clone, Debug)]
pub struct Config {
    pub pending: Vec<(String, String)>,
    pub block_ws: String,
    pub out: PathBuf,
    pub duration: Option<Duration>,
    pub ttl_secs: u64,
    pub hash_only: bool,
    pub contracts: Vec<String>,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let raw = std::env::var("SNIPER_PENDING_WS").map_err(|_| "SNIPER_PENDING_WS is not set".to_string())?;
        let pending = parse_sources(&raw)?;
        let block_ws = std::env::var("SNIPER_BLOCK_WS").unwrap_or_else(|_| pending[0].1.clone());
        let unix = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let out = PathBuf::from(std::env::var("SNIPER_OUT").unwrap_or_else(|_| format!("probe-out/{unix}")));
        let num = |k: &str, d: u64| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        let dur = num("SNIPER_DURATION_SECS", 0);
        Ok(Config {
            pending,
            block_ws,
            out,
            duration: (dur > 0).then(|| Duration::from_secs(dur)),
            ttl_secs: num("SNIPER_PENDING_TTL_SECS", 180),
            hash_only: std::env::var("SNIPER_HASH_ONLY").map(|v| v == "1").unwrap_or(false),
            contracts: vec![TOKEN_MANAGER_2.to_string(), TOKEN_MANAGER_1.to_string()],
        })
    }
}

/// "node=wss://a,paid=wss://b" or just "wss://a" -> [(name, url)].
pub fn parse_sources(raw: &str) -> Result<Vec<(String, String)>, String> {
    let mut v = Vec::new();
    for (i, part) in raw.split(',').map(str::trim).filter(|s| !s.is_empty()).enumerate() {
        let (name, url) = match part.split_once('=') {
            // "=" inside a URL query string must not be taken as a name.
            Some((n, u)) if !n.contains("://") => (n.trim().to_string(), u.trim().to_string()),
            _ => (format!("src{i}"), part.to_string()),
        };
        if !(url.starts_with("ws://") || url.starts_with("wss://")) {
            return Err(format!("not a websocket URL: {url}"));
        }
        v.push((name, url));
    }
    if v.is_empty() {
        return Err("SNIPER_PENDING_WS has no feeds".into());
    }
    Ok(v)
}

/// Host part only, so API keys in URLs never land in output files.
pub fn redact(url: &str) -> String {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let host = rest.split(['/', '?']).next().unwrap_or(rest);
    format!("{}://{}/…", url.split("://").next().unwrap_or("ws"), host)
}

struct Writers {
    dir: PathBuf,
    files: HashMap<&'static str, BufWriter<File>>,
}

impl Writers {
    fn write(&mut self, out: Out, v: &Value) -> std::io::Result<()> {
        let name = out.file();
        if !self.files.contains_key(name) {
            let f = OpenOptions::new().create(true).append(true).open(self.dir.join(name))?;
            self.files.insert(name, BufWriter::new(f));
        }
        let w = self.files.get_mut(name).unwrap();
        serde_json::to_writer(&mut *w, v)?;
        w.write_all(b"\n")
    }
    fn flush(&mut self) {
        for w in self.files.values_mut() {
            let _ = w.flush();
        }
    }
}

/// Turn a pending notification (full tx object or bare hash) into an Event.
pub fn pending_event(source: usize, t: u64, item: &Value) -> Option<Event> {
    if let Some(h) = item.as_str() {
        return Some(Event::Pending { source, t, hash: h.to_string(), to: None, value: None, input: None });
    }
    let hash = item.get("hash")?.as_str()?.to_string();
    let s = |k: &str| item.get(k).and_then(Value::as_str).map(str::to_string);
    Some(Event::Pending { source, t, hash, to: s("to"), value: s("value"), input: s("input") })
}

pub fn run(cfg: Config) -> Result<(), String> {
    fs::create_dir_all(&cfg.out).map_err(|e| format!("create {}: {e}", cfg.out.display()))?;
    let clock = Clock::new();
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<Event>();
    let topics = Topics::new();

    // --- pending feeds ---
    for (i, (name, url)) in cfg.pending.iter().enumerate() {
        let (tx, stop, name, url) = (tx.clone(), stop.clone(), name.clone(), url.clone());
        let sub = if cfg.hash_only {
            Sub { label: "pending", params: json!(["newPendingTransactions"]), fallback: None }
        } else {
            Sub {
                label: "pending",
                params: json!(["newPendingTransactions", true]),
                fallback: Some(json!(["newPendingTransactions"])),
            }
        };
        std::thread::Builder::new()
            .name(format!("pending-{name}"))
            .spawn(move || {
                let tx2 = tx.clone();
                ws::run(
                    &url,
                    &[sub],
                    clock,
                    &stop,
                    |t, _, item| {
                        if let Some(ev) = pending_event(i, t, item) {
                            let _ = tx.send(ev);
                        }
                    },
                    |t, up, detail| {
                        let _ = tx2.send(Event::Link { t, name: format!("pending:{name}"), up, detail });
                    },
                );
            })
            .map_err(|e| e.to_string())?;
    }

    // --- heads + Four.meme logs ---
    {
        let (tx, stop, url) = (tx.clone(), stop.clone(), cfg.block_ws.clone());
        let subs = vec![
            Sub { label: "heads", params: json!(["newHeads"]), fallback: None },
            Sub {
                label: "logs",
                params: json!(["logs", {"address": cfg.contracts, "topics": [topics.all()]}]),
                fallback: None,
            },
        ];
        std::thread::Builder::new()
            .name("blocks".into())
            .spawn(move || {
                let tx2 = tx.clone();
                ws::run(
                    &url,
                    &subs,
                    clock,
                    &stop,
                    |t, label, item| {
                        let ev = if label == "heads" {
                            Event::Head {
                                t,
                                number: hex_u64(item.get("number")),
                                hash: item.get("hash").and_then(Value::as_str).unwrap_or("").to_string(),
                                timestamp: hex_u64(item.get("timestamp")),
                            }
                        } else {
                            Event::Log { t, log: item.clone() }
                        };
                        let _ = tx.send(ev);
                    },
                    |t, up, detail| {
                        let _ = tx2.send(Event::Link { t, name: "blocks".into(), up, detail });
                    },
                );
            })
            .map_err(|e| e.to_string())?;
    }
    drop(tx);

    // --- main loop: match + write ---
    let names: Vec<String> = cfg.pending.iter().map(|(n, _)| n.clone()).collect();
    let mut m = Matcher::new(names.clone(), cfg.contracts.clone(), cfg.ttl_secs);
    let mut w = Writers { dir: cfg.out.clone(), files: HashMap::new() };
    let wall_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    w.write(
        Out::Meta,
        &json!({
            "event": "start", "t": 0, "wall_ms": wall_ms, "sources": names,
            "pending_urls": cfg.pending.iter().map(|(_, u)| redact(u)).collect::<Vec<_>>(),
            "block_url": redact(&cfg.block_ws), "contracts": cfg.contracts,
            "ttl_secs": cfg.ttl_secs, "hash_only": cfg.hash_only,
        }),
    )
    .map_err(|e| e.to_string())?;
    eprintln!("probe: writing to {}", cfg.out.display());

    let started = Instant::now();
    let mut last_flush = Instant::now();
    let mut last_beat = Instant::now();
    loop {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(ev) => {
                if let Event::Link { name, up, detail, .. } = &ev {
                    eprintln!("probe: {name} {} ({detail})", if *up { "UP" } else { "DOWN" });
                }
                for (out, rec) in m.handle(ev) {
                    w.write(out, &rec).map_err(|e| e.to_string())?;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if last_flush.elapsed() >= Duration::from_secs(1) {
            w.flush();
            last_flush = Instant::now();
        }
        if last_beat.elapsed() >= Duration::from_secs(60) {
            let c = &m.counters;
            let pct = if c.trades > 0 { 100.0 * c.trades_seen as f64 / c.trades as f64 } else { 0.0 };
            eprintln!(
                "probe: {}m | pending {} ({} unique, {} in memory) | heads {} | four.meme trades {} | seen pending {} ({pct:.1}%) | late {}",
                started.elapsed().as_secs() / 60,
                c.pending_notices,
                c.pending_unique,
                m.pending_len(),
                c.heads,
                c.trades,
                c.trades_seen,
                c.late
            );
            last_beat = Instant::now();
        }
        if cfg.duration.is_some_and(|d| started.elapsed() >= d) {
            break;
        }
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let t = clock.now();
    w.write(Out::Meta, &json!({"event": "stop", "t": t})).map_err(|e| e.to_string())?;
    w.flush();
    eprintln!("probe: done. Run `sniper report {}`", cfg.out.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_named_and_unnamed_sources() {
        let v = parse_sources("node=ws://127.0.0.1:8546, wss://x.example/key?a=b").unwrap();
        assert_eq!(v[0], ("node".into(), "ws://127.0.0.1:8546".into()));
        assert_eq!(v[1], ("src1".into(), "wss://x.example/key?a=b".into()));
        assert!(parse_sources("http://nope").is_err());
        assert!(parse_sources("").is_err());
    }

    #[test]
    fn redacts_paths_and_keys() {
        assert_eq!(redact("wss://bsc.example.com/abc123secret"), "wss://bsc.example.com/…");
        assert_eq!(redact("ws://10.0.0.5:8546"), "ws://10.0.0.5:8546/…");
    }

    #[test]
    fn pending_event_handles_hash_and_full_forms() {
        match pending_event(0, 5, &json!("0xabc")).unwrap() {
            Event::Pending { hash, to, .. } => {
                assert_eq!(hash, "0xabc");
                assert!(to.is_none());
            }
            _ => panic!(),
        }
        match pending_event(1, 5, &json!({"hash": "0xdef", "to": "0x5c95", "input": "0x12345678"})).unwrap() {
            Event::Pending { source, hash, to, input, .. } => {
                assert_eq!(source, 1);
                assert_eq!(hash, "0xdef");
                assert_eq!(to.as_deref(), Some("0x5c95"));
                assert_eq!(input.as_deref(), Some("0x12345678"));
            }
            _ => panic!(),
        }
    }
}
