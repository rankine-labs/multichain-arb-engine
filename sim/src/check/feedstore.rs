// ============================================================================
// FEED STORE: the sequencer feed's messages, kept INSIDE the sidecar
// (speed-3, Oct 24).
//
// Plain English (live Oct 24: the "which pools does it move?" question took
// ~18 ms of sidecar work; the bench said ~0.01 ms):
//   Every trigger-first question used to carry up to 48 feed messages with
//   ALL their signed transactions as hex text (~10 transactions x ~1 KB
//   each: about half a megabyte per question). For every question, and
//   again for every candidate check of the same trigger, the bot turned
//   that into text, and the sidecar read the text, copied it twice, turned
//   the hex back into bytes, hashed every transaction and looked each one
//   up in a shared cache.
//
//   Now the bot sends each feed message ONCE, the moment it arrives
//   (`feed_put`, no answer, same socket, so it is always stored before any
//   question that names it). The sidecar keeps the message ready to use:
//   bytes, hash of every transaction, and (worked out by a background
//   thread, or by the first question that needs it) the decoded
//   transaction with its sender. A question then names the messages it
//   means (`feed.refs`: [[sequence number, transaction count], ...], a few
//   hundred bytes) instead of carrying them.
//
//   SAME ANSWERS: the question is rebuilt from exactly the messages the bot
//   holds (the bot only names messages it has handed over on this
//   connection; each one is checked here by sequence number AND transaction
//   count). If any named message is missing (the sidecar restarted, the
//   store dropped it, a put was lost) the answer is "feed_ref_missing" and
//   the bot asks again with the messages themselves, exactly as before.
//   check/ordered.rs build_plan treats both forms identically (tested).
//
//   Bounded: at most ARBSIM_FEED_STORE_MSGS messages (default 2048, ~3.5
//   min at ~10 messages/s), oldest dropped first. The first copy of a
//   sequence number is kept (a reconnect's backlog repeats are ignored),
//   like the bot's own order buffer.
// ============================================================================
use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Instant;

use revm::primitives::{keccak256, Bytes, B256};
use serde_json::Value;

use super::hexutil::parse_bytes;
use super::ordered::WireFeedMsg;
use super::rawtx::{decode_signed_tx, DecodedTx};

/// One feed transaction, ready to use.
#[derive(Debug)]
pub struct BinTx {
    /// keccak256 of the exact signed bytes (the transaction hash).
    pub hash: B256,
    pub raw: Bytes,
    /// Decoded (sender recovered), worked out once.
    decoded: OnceLock<Result<DecodedTx, String>>,
    /// true = kept in the store (decode it here, once); false = made for one
    /// question only (decode through ordered.rs' shared cache, as before).
    stored: bool,
}

impl BinTx {
    pub fn new(raw: Bytes, stored: bool) -> Self {
        BinTx {
            hash: keccak256(&raw),
            raw,
            decoded: OnceLock::new(),
            stored,
        }
    }

    /// The decoded transaction (same result as decode_signed_tx).
    pub fn decoded(&self) -> Result<DecodedTx, String> {
        if let Some(r) = self.decoded.get() {
            crate::timing::ph_count("decodeHit", 1);
            return r.clone();
        }
        // Not decoded in THIS copy yet: a stored message decodes it now
        // (once); a one-question copy asks ordered.rs' shared cache.
        crate::timing::ph_count(if self.stored { "decodeMiss" } else { "decodeShared" }, 1);
        let t = Instant::now();
        let r = self
            .decoded
            .get_or_init(|| {
                if self.stored {
                    decode_signed_tx(&self.raw)
                } else {
                    super::ordered::decode_cached(self.hash, &self.raw)
                }
            })
            .clone();
        crate::timing::ph_add("decode", t.elapsed().as_micros() as u64);
        r
    }

    /// Decode now if nobody has yet (background thread).
    fn warm(&self) {
        let _ = self.decoded.get_or_init(|| decode_signed_tx(&self.raw));
    }
}

/// One feed message, ready to use (the same fields as WireFeedMsg).
#[derive(Debug)]
pub struct BinMsg {
    pub seq: u64,
    pub ts: u64,
    pub l1: u64,
    pub complete: bool,
    pub why: Option<String>,
    pub txs: Vec<Arc<BinTx>>,
    /// The first transaction whose hex could not be read: (index, error).
    /// A question naming this message answers exactly what sending it
    /// inline would (bad_request "feed message N tx i: ...").
    pub bad: Option<(usize, String)>,
}

impl BinMsg {
    /// From the bot's message (hex). `stored`: kept in the store.
    pub fn from_wire(m: &WireFeedMsg, stored: bool) -> BinMsg {
        let mut txs = Vec::with_capacity(m.txs.len());
        let mut bad = None;
        for (i, t) in m.txs.iter().enumerate() {
            match parse_bytes(t) {
                Ok(raw) => txs.push(Arc::new(BinTx::new(raw, stored))),
                Err(e) => {
                    // Same as build_plan: the first bad transaction decides.
                    bad = Some((i, e));
                    break;
                }
            }
        }
        BinMsg {
            seq: m.seq,
            ts: m.ts,
            l1: m.l1,
            complete: m.complete,
            why: m.why.clone(),
            txs,
            bad,
        }
    }

    /// How many transactions the bot gave (the bot's ref check).
    pub fn tx_count(&self) -> usize {
        match &self.bad {
            // (a message with a bad transaction keeps its first good ones;
            // the bot's count is of all of them, so it never matches: the
            // bot then sends it inline and gets the very same bad_request)
            Some(_) => usize::MAX,
            None => self.txs.len(),
        }
    }
}

/// The store (see the file header).
pub struct FeedStore {
    msgs: RwLock<BTreeMap<u64, Arc<BinMsg>>>,
    cap: usize,
    warm_tx: std::sync::Mutex<Option<std::sync::mpsc::SyncSender<Arc<BinMsg>>>>,
    pub stats: StoreStats,
}

#[derive(Default)]
pub struct StoreStats {
    pub puts: std::sync::atomic::AtomicU64,
    pub repeats: std::sync::atomic::AtomicU64,
    pub resolved: std::sync::atomic::AtomicU64,
    pub missing: std::sync::atomic::AtomicU64,
}

/// Messages kept [ARBSIM_FEED_STORE_MSGS, 2048; 0 = store off: every
/// question naming messages answers feed_ref_missing, i.e. the old way].
pub fn store_cap() -> usize {
    static C: OnceLock<usize> = OnceLock::new();
    *C.get_or_init(|| crate::node::env_u64("ARBSIM_FEED_STORE_MSGS", 2048).min(100_000) as usize)
}

/// The process-wide store.
pub fn store() -> &'static FeedStore {
    static S: OnceLock<FeedStore> = OnceLock::new();
    S.get_or_init(|| FeedStore::new(store_cap()))
}

impl FeedStore {
    pub fn new(cap: usize) -> Self {
        FeedStore {
            msgs: RwLock::new(BTreeMap::new()),
            cap,
            warm_tx: std::sync::Mutex::new(None),
            stats: StoreStats::default(),
        }
    }

    /// `feed_put` {msgs:[...same shape as a question's feed.msgs...]}:
    /// keep each message not held yet. Never blocks on a question (the
    /// write lock is held only to insert). Returns how many were new.
    pub fn put_json(&self, req: &Value) -> usize {
        use serde::Deserialize;
        let Some(arr) = req.get("msgs").and_then(|m| m.as_array()) else {
            return 0;
        };
        let mut fresh = Vec::new();
        for v in arr {
            let Ok(m) = WireFeedMsg::deserialize(v) else {
                continue;
            };
            fresh.push(m);
        }
        self.put(&fresh)
    }

    pub fn put(&self, list: &[WireFeedMsg]) -> usize {
        use std::sync::atomic::Ordering::Relaxed;
        if self.cap == 0 {
            return 0;
        }
        let mut added = Vec::new();
        for m in list {
            if self
                .msgs
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(&m.seq)
            {
                self.stats.repeats.fetch_add(1, Relaxed);
                continue;
            }
            // Hex + hashes outside the lock.
            let b = Arc::new(BinMsg::from_wire(m, true));
            let mut g = self.msgs.write().unwrap_or_else(|e| e.into_inner());
            if g.contains_key(&m.seq) {
                continue;
            }
            g.insert(m.seq, b.clone());
            while g.len() > self.cap {
                let Some(k) = g.keys().next().copied() else {
                    break;
                };
                g.remove(&k);
            }
            drop(g);
            self.stats.puts.fetch_add(1, Relaxed);
            added.push(b);
        }
        // FAST LANE A (copy2/ahead.rs): the predicted copy applies each new
        // message. Does nothing unless FASTLANE is practice / live.
        crate::copy2::ahead::feed_hook(&added);
        // Decode (recover senders) in the background, so questions find
        // them ready. Bounded queue; when full, the question decodes itself.
        for b in &added {
            if let Some(tx) = self.warmer() {
                let _ = tx.try_send(b.clone());
            }
        }
        added.len()
    }

    fn warmer(&self) -> Option<std::sync::mpsc::SyncSender<Arc<BinMsg>>> {
        let mut g = self.warm_tx.lock().unwrap_or_else(|e| e.into_inner());
        if g.is_none() {
            let (tx, rx) = std::sync::mpsc::sync_channel::<Arc<BinMsg>>(256);
            let ok = std::thread::Builder::new()
                .name("arbsim-feed-decode".into())
                .spawn(move || {
                    while let Ok(m) = rx.recv() {
                        for t in &m.txs {
                            t.warm();
                        }
                    }
                })
                .is_ok();
            if ok {
                *g = Some(tx);
            }
        }
        g.clone()
    }

    /// The messages a question names, in its order. Err(detail) = one is
    /// not held (or has a different transaction count): feed_ref_missing.
    pub fn resolve(&self, refs: &[(u64, usize)]) -> Result<Vec<Arc<BinMsg>>, String> {
        use std::sync::atomic::Ordering::Relaxed;
        let g = self.msgs.read().unwrap_or_else(|e| e.into_inner());
        let mut out = Vec::with_capacity(refs.len());
        for (seq, n) in refs {
            match g.get(seq) {
                Some(m) if m.tx_count() == *n => out.push(m.clone()),
                Some(m) => {
                    self.stats.missing.fetch_add(1, Relaxed);
                    return Err(format!("feed message {seq}: the sidecar holds {} transactions, the question says {n}", m.txs.len()));
                }
                None => {
                    self.stats.missing.fetch_add(1, Relaxed);
                    return Err(format!(
                        "feed message {seq} not held by the sidecar (store keeps {}, from {:?})",
                        g.len(),
                        g.keys().next()
                    ));
                }
            }
        }
        self.stats.resolved.fetch_add(1, Relaxed);
        Ok(out)
    }

    pub fn len(&self) -> usize {
        self.msgs.read().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Forget everything (tests).
    pub fn clear(&self) {
        self.msgs.write().unwrap_or_else(|e| e.into_inner()).clear();
    }

    /// status "feedStore".
    pub fn status_json(&self) -> Value {
        use std::sync::atomic::Ordering::Relaxed;
        let g = self.msgs.read().unwrap_or_else(|e| e.into_inner());
        serde_json::json!({
            "msgs": g.len(), "cap": self.cap, "from": g.keys().next(), "to": g.keys().next_back(),
            "puts": self.stats.puts.load(Relaxed), "repeats": self.stats.repeats.load(Relaxed),
            "resolved": self.stats.resolved.load(Relaxed), "missing": self.stats.missing.load(Relaxed),
        })
    }
}
