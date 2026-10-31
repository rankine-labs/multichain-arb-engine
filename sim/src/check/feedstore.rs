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

// ---------------------------------------------------------------------------
// FEED TIP (Oct 31): the newest block the sequencer feed has told us about.
//
// Plain English: the fast lane's "is this decision about an old block?"
// gate (fastlane/safety.rs, FASTLANE_MAX_BLOCKS_BEHIND) needs the newest
// block the CHAIN is at. The feed is our fastest view of that (one message
// = one finished block, ~100 ms each). This keeps the newest sequence number
// ever handed to us and WHEN it first arrived, so the gate can also tell a
// stalled feed (old tip) from a live one. Kept apart from the store itself:
// it works even with the store off (ARBSIM_FEED_STORE_MSGS=0) and is never
// lowered by a reconnect's backlog repeats (only a NEWER number moves it).
// ---------------------------------------------------------------------------
static FEED_TIP: std::sync::Mutex<Option<(u64, Instant)>> = std::sync::Mutex::new(None);

/// A feed message with sequence number `seq` reached us: the tip moves if
/// it is newer than any seen so far (its arrival time is kept).
pub fn note_feed_tip(seq: u64) {
    note_feed_tip_at(seq, Instant::now());
}

fn note_feed_tip_at(seq: u64, now: Instant) {
    let mut g = FEED_TIP.lock().unwrap_or_else(|e| e.into_inner());
    if g.map_or(true, |(s, _)| seq > s) {
        *g = Some((seq, now));
    }
}

/// The newest feed sequence number and how long ago it arrived (None = no
/// feed message seen yet). Block number = sequence number + L2 offset.
pub fn feed_tip() -> Option<(u64, std::time::Duration)> {
    FEED_TIP.lock().unwrap_or_else(|e| e.into_inner()).map(|(s, at)| (s, at.elapsed()))
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
        // FEED TIP (see above): noted for every message, store on or off.
        for m in list {
            note_feed_tip(m.seq);
        }
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
            // Copy-2 lag clock (copy2/lag.rs): when this block's feed message came.
            crate::copy2::lag::feed_arrived(m.seq);
            added.push(b);
        }
        // FAST LANE A (copy2/ahead.rs): the predicted copy applies each new
        // message. Does nothing unless FASTLANE is practice / live.
        crate::copy2::ahead::feed_hook(&added);
        // FAST LANE TRIGGER (fastlane/trigger.rs): fire-first decided inside
        // Rust the moment the message is here. Nothing unless FASTLANE is
        // practice / live and the trigger path runs.
        crate::fastlane::trigger::feed_hook(&added);
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

    /// The newest sequence number held (None = empty).
    pub fn newest(&self) -> Option<u64> {
        self.msgs.read().unwrap_or_else(|e| e.into_inner()).keys().next_back().copied()
    }

    /// FAST LANE TRIGGER (fastlane/trigger.rs): the names ([sequence number,
    /// transaction count]) of the held messages `from..=to`, oldest first,
    /// the same names the bot's questions carry (`feed.refs`). Stops at the
    /// first one not held (a gap): the plan then answers feed_gap itself if
    /// it needed more, exactly as for the bot.
    pub fn refs_range(&self, from: u64, to: u64) -> Vec<(u64, usize)> {
        let g = self.msgs.read().unwrap_or_else(|e| e.into_inner());
        let mut out = Vec::new();
        let mut want = from;
        for (seq, m) in g.range(from..=to) {
            if *seq != want {
                // A gap before `seq`: keep only the newest unbroken run.
                out.clear();
            }
            if m.bad.is_some() {
                // (never named: the bot would send it inline and get bad_request)
                out.clear();
                want = seq + 1;
                continue;
            }
            out.push((*seq, m.txs.len()));
            want = seq + 1;
        }
        out
    }

    /// One held message (None = not held).
    pub fn get(&self, seq: u64) -> Option<Arc<BinMsg>> {
        self.msgs.read().unwrap_or_else(|e| e.into_inner()).get(&seq).cloned()
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

#[cfg(test)]
mod feed_tip_tests {
    use super::*;

    #[test]
    fn feed_tip_only_moves_forward_and_ages() {
        // Huge numbers so other tests' feed messages (small sequence
        // numbers) running at the same time can't move this tip.
        let base = u64::MAX / 2;
        let t0 = Instant::now() - std::time::Duration::from_millis(500);
        note_feed_tip_at(base + 10, t0);
        let (s, age) = feed_tip().unwrap();
        assert_eq!(s, base + 10);
        assert!(age >= std::time::Duration::from_millis(500), "age is counted from the first arrival");
        // A reconnect's backlog repeat (older number) never lowers it.
        note_feed_tip(base + 3);
        assert_eq!(feed_tip().unwrap().0, base + 10);
        // The same number again keeps the first arrival time.
        note_feed_tip(base + 10);
        assert!(feed_tip().unwrap().1 >= std::time::Duration::from_millis(500));
        // A newer one moves it, with a fresh time.
        note_feed_tip(base + 11);
        let (s, age) = feed_tip().unwrap();
        assert_eq!(s, base + 11);
        assert!(age < std::time::Duration::from_millis(400));
    }
}
