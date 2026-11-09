// ============================================================================
// MATCHER: joins "we saw this tx pending" with "this tx traded on Four.meme".
//
// Plain English:
//   The pending feed is huge (every transaction on BSC that reaches our
//   node), so we cannot write it all to disk for days. Instead we keep the
//   first time each pending tx hash was seen in memory for a few minutes.
//   When a confirmed Four.meme trade arrives, we look its tx hash up:
//     found     -> we saw it early; lead time = now - first seen
//     not found -> it was private (or our feed missed it)
//   Only the small Four.meme slice gets written out.
//
//   Pure logic, no network: every event carries its own timestamp, so the
//   tests can drive it with made-up events.
// ============================================================================
use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::fourmeme::{decode_log, Kind, Topics};

/// Something that happened, with the local time (ns since probe start) at
/// which our process received it.
#[derive(Clone, Debug)]
pub enum Event {
    /// A pending tx notice from pending source `source`.
    Pending { source: usize, t: u64, hash: String, to: Option<String>, value: Option<String>, input: Option<String> },
    /// A new block header arrived.
    Head { t: u64, number: u64, hash: String, timestamp: u64 },
    /// A log matching our Four.meme filter arrived.
    Log { t: u64, log: Value },
    /// A source connected (true) or disconnected (false).
    Link { t: u64, name: String, up: bool, detail: String },
}

/// Which output file a record goes to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Out {
    Trades,
    Creates,
    Heads,
    PendingDirect,
    Late,
    Meta,
}

impl Out {
    pub fn file(self) -> &'static str {
        match self {
            Out::Trades => "trades.jsonl",
            Out::Creates => "creates.jsonl",
            Out::Heads => "heads.jsonl",
            Out::PendingDirect => "pending_direct.jsonl",
            Out::Late => "late.jsonl",
            Out::Meta => "meta.jsonl",
        }
    }
}

struct Seen {
    /// First-seen time per source (index = source number).
    per_source: Vec<Option<u64>>,
    first_any: u64,
}

/// Running counters, printed as a heartbeat while the probe runs.
#[derive(Default, Debug, Clone)]
pub struct Counters {
    pub pending_notices: u64,
    pub pending_unique: u64,
    pub trades: u64,
    pub trades_seen: u64,
    pub late: u64,
    pub heads: u64,
}

pub struct Matcher {
    topics: Topics,
    sources: Vec<String>,
    /// Lowercase Four.meme contract addresses (for spotting direct calls).
    contracts: Vec<String>,
    ttl_ns: u64,
    pending: HashMap<String, Seen>,
    /// Four.meme trades confirmed recently, to catch pending notices that
    /// arrive AFTER the trade (useless to us, but worth counting).
    confirmed: HashMap<String, (u64, u64)>,
    last_prune: u64,
    pub counters: Counters,
}

impl Matcher {
    /// `sources`: names of the pending feeds, in index order.
    /// `ttl_secs`: how long a pending hash is remembered.
    pub fn new(sources: Vec<String>, contracts: Vec<String>, ttl_secs: u64) -> Self {
        Matcher {
            topics: Topics::new(),
            sources,
            contracts: contracts.into_iter().map(|c| c.to_ascii_lowercase()).collect(),
            ttl_ns: ttl_secs * 1_000_000_000,
            pending: HashMap::new(),
            confirmed: HashMap::new(),
            last_prune: 0,
            counters: Counters::default(),
        }
    }

    /// Process one event; returns the records to write.
    pub fn handle(&mut self, ev: Event) -> Vec<(Out, Value)> {
        let mut out = Vec::new();
        match ev {
            Event::Pending { source, t, hash, to, value, input } => {
                self.counters.pending_notices += 1;
                let hash = hash.to_ascii_lowercase();
                // Arrived after the trade was already confirmed?
                if let Some((t_conf, block)) = self.confirmed.get(&hash) {
                    self.counters.late += 1;
                    out.push((
                        Out::Late,
                        json!({"tx": hash, "source": self.sources[source], "t_pending": t, "t_confirmed": t_conf, "block": block}),
                    ));
                    return out;
                }
                let n = self.sources.len();
                let entry = self.pending.entry(hash.clone()).or_insert_with(|| Seen { per_source: vec![None; n], first_any: t });
                let is_new = entry.per_source.iter().all(Option::is_none);
                if entry.per_source[source].is_none() {
                    entry.per_source[source] = Some(t);
                }
                if is_new {
                    self.counters.pending_unique += 1;
                    // Direct call to a Four.meme contract: record it, so we
                    // can later count pending buys that never confirmed.
                    if let Some(to) = to.as_deref() {
                        if self.contracts.iter().any(|c| c.eq_ignore_ascii_case(to)) {
                            let sel = input.as_deref().map(|i| i.chars().take(10).collect::<String>());
                            out.push((
                                Out::PendingDirect,
                                json!({"tx": hash, "t": t, "source": self.sources[source], "to": to.to_ascii_lowercase(), "value": value, "selector": sel}),
                            ));
                        }
                    }
                }
                self.prune(t);
            }
            Event::Head { t, number, hash, timestamp } => {
                self.counters.heads += 1;
                out.push((Out::Heads, json!({"block": number, "hash": hash, "t": t, "ts": timestamp})));
                self.prune(t);
            }
            Event::Log { t, log } => {
                if let Some((kind, mut rec)) = decode_log(&self.topics, &log) {
                    let tx = rec["tx"].as_str().unwrap_or("").to_string();
                    let block = rec["block"].as_u64().unwrap_or(0);
                    let removed = rec["removed"].as_bool().unwrap_or(false);
                    let o = rec.as_object_mut().unwrap();
                    o.insert("t_log".into(), json!(t));
                    // Attach what we knew about this tx before it confirmed.
                    let mut seen = Map::new();
                    let mut first_any = Value::Null;
                    if let Some(s) = self.pending.get(&tx) {
                        for (i, ts) in s.per_source.iter().enumerate() {
                            if let Some(ts) = ts {
                                seen.insert(self.sources[i].clone(), json!(ts));
                            }
                        }
                        first_any = json!(s.first_any);
                    }
                    let was_seen = !seen.is_empty();
                    o.insert("seen".into(), Value::Object(seen));
                    o.insert("first_seen".into(), first_any);
                    match kind {
                        Kind::Buy | Kind::Sell => {
                            if !removed {
                                self.counters.trades += 1;
                                if was_seen {
                                    self.counters.trades_seen += 1;
                                }
                                self.confirmed.insert(tx.clone(), (t, block));
                            }
                            out.push((Out::Trades, rec));
                        }
                        Kind::Create | Kind::Graduate => out.push((Out::Creates, rec)),
                    }
                }
                self.prune(t);
            }
            Event::Link { t, name, up, detail } => {
                out.push((Out::Meta, json!({"event": if up {"up"} else {"down"}, "source": name, "t": t, "detail": detail})));
            }
        }
        out
    }

    /// Forget pending hashes older than the TTL (and old confirmations).
    /// Runs at most once a second of event time.
    fn prune(&mut self, now: u64) {
        if now < self.last_prune + 1_000_000_000 {
            return;
        }
        self.last_prune = now;
        let ttl = self.ttl_ns;
        self.pending.retain(|_, s| now.saturating_sub(s.first_any) <= ttl);
        self.confirmed.retain(|_, (t, _)| now.saturating_sub(*t) <= 30_000_000_000);
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fourmeme::TOKEN_MANAGER_2;

    fn buy_log(tx: &str, block: u64) -> Value {
        let t = Topics::new();
        let mut data = String::from("0x");
        for v in 1u64..=8 {
            data.push_str(&format!("{v:064x}"));
        }
        json!({"address": TOKEN_MANAGER_2, "topics": [t.purchase], "data": data,
               "transactionHash": tx, "blockNumber": format!("0x{block:x}"), "logIndex": "0x0", "removed": false})
    }

    fn pending(source: usize, t: u64, hash: &str) -> Event {
        Event::Pending { source, t, hash: hash.into(), to: None, value: None, input: None }
    }

    #[test]
    fn seen_trade_carries_first_seen_per_source() {
        let mut m = Matcher::new(vec!["node".into(), "paid".into()], vec![TOKEN_MANAGER_2.into()], 180);
        m.handle(pending(1, 100, "0xAA"));
        m.handle(pending(0, 250, "0xaa"));
        m.handle(pending(0, 400, "0xaa")); // repeat: keeps the first time
        let out = m.handle(Event::Log { t: 1_000, log: buy_log("0xaa", 7) });
        assert_eq!(out.len(), 1);
        let (f, r) = &out[0];
        assert_eq!(*f, Out::Trades);
        assert_eq!(r["seen"]["node"], 250);
        assert_eq!(r["seen"]["paid"], 100);
        assert_eq!(r["first_seen"], 100);
        assert_eq!(m.counters.trades_seen, 1);
    }

    #[test]
    fn unseen_trade_has_empty_seen() {
        let mut m = Matcher::new(vec!["node".into()], vec![], 180);
        let out = m.handle(Event::Log { t: 5, log: buy_log("0xbb", 1) });
        assert_eq!(out[0].1["seen"], json!({}));
        assert_eq!(out[0].1["first_seen"], Value::Null);
        assert_eq!(m.counters.trades, 1);
        assert_eq!(m.counters.trades_seen, 0);
    }

    #[test]
    fn pending_after_confirmation_is_late() {
        let mut m = Matcher::new(vec!["node".into()], vec![], 180);
        m.handle(Event::Log { t: 10, log: buy_log("0xcc", 3) });
        let out = m.handle(pending(0, 20, "0xcc"));
        assert_eq!(out[0].0, Out::Late);
        assert_eq!(m.counters.late, 1);
    }

    #[test]
    fn old_pending_hashes_expire() {
        let mut m = Matcher::new(vec!["node".into()], vec![], 1);
        m.handle(pending(0, 0, "0xdd"));
        // 3 s later something else arrives and triggers the prune.
        m.handle(pending(0, 3_000_000_000, "0xee"));
        assert_eq!(m.pending_len(), 1);
        let out = m.handle(Event::Log { t: 3_000_000_001, log: buy_log("0xdd", 9) });
        assert_eq!(out[0].1["first_seen"], Value::Null);
    }

    #[test]
    fn direct_calls_are_recorded_once() {
        let mut m = Matcher::new(vec!["a".into(), "b".into()], vec![TOKEN_MANAGER_2.into()], 180);
        let ev = |s| Event::Pending {
            source: s,
            t: 1,
            hash: "0xff".into(),
            to: Some("0x5C952063c7fc8610FFDB798152D69F0B9550762b".into()),
            value: Some("0x1".into()),
            input: Some("0x87f27655deadbeef".into()),
        };
        assert_eq!(m.handle(ev(0)).len(), 1);
        assert_eq!(m.handle(ev(1)).len(), 0);
    }
}
