// ============================================================================
// GUN: NONCE TRACKER
//
// Plain English:
//   Every transaction from our wallet carries a number, the nonce: 0, 1, 2...
//   The chain accepts each number exactly once, in order. Asking the node for
//   it at fire time would cost a round trip, so (like the Node sender) we
//   read it ONCE at start (eth_getTransactionCount "pending") and then count
//   locally: each send takes the next number.
//
//   Rules (same as src/execution/fastSender.ts parallel mode):
//     - take(): hands out the next number instantly, under a lock, so two
//       fires can never get the same one, and they get them in call order.
//     - accepted(n): the sequencer took it.
//     - failed(n, msg): the send failed. "nonce too low" / "already known"
//       mean n is used up for good: never use it again. Any other failure
//       means n is free again. Either way new fires PAUSE ("nonce re-sync
//       pending") until every send already on its way has answered; then
//       resync() re-reads the chain and picks the next number:
//         * the LOWEST failed number, if nothing says it is used (no hole);
//         * else the highest of: chain's pending count, one past the highest
//           accepted, one past any number reported as used.
//     - dropped(): a sent trade was never mined (the receipt tracker says
//       so): its number is free again; trust the chain's count.
//   resync() is called by the sender thread / gas thread, never on the fire
//   path, so a fire never waits for the network.
// ============================================================================
use std::collections::BTreeSet;
use std::sync::Mutex;

/// Why no nonce could be handed out.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NonceErr {
    /// Never loaded from the chain yet (start-up read failed).
    NotLoaded,
    /// A send failed; waiting for the re-sync.
    ResyncPending,
}

impl std::fmt::Display for NonceErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NonceErr::NotLoaded => write!(f, "nonce not loaded"),
            NonceErr::ResyncPending => write!(f, "nonce re-sync pending"),
        }
    }
}

#[derive(Debug, Default)]
struct State {
    next: Option<u64>,
    /// Taken and not answered yet.
    in_flight: BTreeSet<u64>,
    /// Failed with a reason that leaves the nonce unused.
    failed: BTreeSet<u64>,
    /// Accepted numbers not yet passed by the counter (skipped when handing
    /// out: matters right after re-signing a hole below them).
    accepted_ahead: BTreeSet<u64>,
    max_accepted: Option<u64>,
    /// One past a number reported as already used.
    used_floor: u64,
    needs_resync: bool,
    /// A dropped trade: next resync trusts the chain's count.
    dropped: bool,
    resyncs: u64,
}

/// Thread-safe local nonce counter (see file header).
#[derive(Debug, Default)]
pub struct NonceTracker {
    s: Mutex<State>,
}

/// Is this send error one that means "that nonce is already used"?
pub fn means_used(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("nonce too low") || m.contains("already known")
}

impl NonceTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start from a known value (start-up read, or practice mode's 0).
    pub fn load(&self, next: u64) {
        let mut s = self.s.lock().unwrap();
        s.next = Some(next);
        s.max_accepted = next.checked_sub(1);
        s.needs_resync = false;
    }

    /// Next nonce to use (and count it as on its way).
    pub fn take(&self) -> Result<u64, NonceErr> {
        let mut s = self.s.lock().unwrap();
        if s.needs_resync {
            return Err(NonceErr::ResyncPending);
        }
        let mut n = s.next.ok_or(NonceErr::NotLoaded)?;
        while s.accepted_ahead.remove(&n) {
            n += 1;
        }
        s.accepted_ahead.retain(|a| *a > n);
        s.next = Some(n + 1);
        s.in_flight.insert(n);
        Ok(n)
    }

    /// A taken nonce that was never sent (signing or queueing failed): free it.
    pub fn unused(&self, n: u64) {
        let mut s = self.s.lock().unwrap();
        s.in_flight.remove(&n);
        s.failed.insert(n);
        s.needs_resync = true;
    }

    /// The sequencer accepted n.
    pub fn accepted(&self, n: u64) {
        let mut s = self.s.lock().unwrap();
        s.in_flight.remove(&n);
        s.max_accepted = Some(s.max_accepted.map_or(n, |m| m.max(n)));
        // Remembered until handed-out numbers pass it (pruned in take /
        // resync), so a hole re-signed below it never re-uses it.
        s.accepted_ahead.insert(n);
    }

    /// The send of n failed with this message.
    pub fn failed(&self, n: u64, msg: &str) {
        let mut s = self.s.lock().unwrap();
        s.in_flight.remove(&n);
        if means_used(msg) {
            s.used_floor = s.used_floor.max(n + 1);
        } else {
            s.failed.insert(n);
        }
        s.needs_resync = true;
    }

    /// A sent trade was never mined: its nonce is free again.
    pub fn dropped(&self) {
        let mut s = self.s.lock().unwrap();
        s.dropped = true;
        s.needs_resync = true;
    }

    /// True when a re-sync should run now (wanted, nothing on its way).
    pub fn wants_resync(&self) -> bool {
        let s = self.s.lock().unwrap();
        (s.needs_resync || s.next.is_none()) && s.in_flight.is_empty()
    }

    /// Sends on their way.
    pub fn in_flight(&self) -> usize {
        self.s.lock().unwrap().in_flight.len()
    }

    /// Re-syncs done (status).
    pub fn resyncs(&self) -> u64 {
        self.s.lock().unwrap().resyncs
    }

    /// Current next nonce (status / tests).
    pub fn peek(&self) -> Option<u64> {
        self.s.lock().unwrap().next
    }

    /// Pick the next nonce from the chain's pending count (`remote`, None =
    /// unreadable). Returns a log line when something changed, or None when
    /// it must wait (sends still on their way, or the chain unreadable at
    /// first load).
    pub fn resync(&self, remote: Option<u64>) -> Option<String> {
        let mut s = self.s.lock().unwrap();
        if !s.in_flight.is_empty() {
            return None;
        }
        let before = s.next;
        let next = match before {
            // First load: only the chain can say.
            None => remote?,
            Some(b) => {
                if s.dropped {
                    let n = remote.unwrap_or(b);
                    s.max_accepted = s.max_accepted.map(|m| m.min(n.saturating_sub(1))).filter(|_| n > 0);
                    s.used_floor = s.used_floor.min(n);
                    s.accepted_ahead.clear();
                    n
                } else {
                    let used_below = remote.unwrap_or(0).max(s.used_floor);
                    match s.failed.first().copied() {
                        Some(lf) if lf >= used_below && !s.accepted_ahead.contains(&lf) => lf,
                        _ => remote.unwrap_or(0).max(s.max_accepted.map_or(0, |m| m + 1)).max(s.used_floor),
                    }
                }
            }
        };
        s.failed.clear();
        s.dropped = false;
        s.accepted_ahead.retain(|a| *a >= next);
        s.next = Some(next);
        s.needs_resync = false;
        s.resyncs += 1;
        Some(format!(
            "[fastlane] nonce re-sync: next nonce {next} (was {}; chain says {}, highest accepted {})",
            before.map_or("unset".into(), |b| b.to_string()),
            remote.map_or("unreadable".into(), |r| r.to_string()),
            s.max_accepted.map_or("none".into(), |m| m.to_string())
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_up_and_never_repeats() {
        let t = NonceTracker::new();
        assert_eq!(t.take(), Err(NonceErr::NotLoaded));
        t.load(5);
        assert_eq!(t.take(), Ok(5));
        assert_eq!(t.take(), Ok(6));
        t.accepted(5);
        t.accepted(6);
        assert_eq!(t.take(), Ok(7));
    }

    #[test]
    fn too_low_moves_past_and_waits_for_in_flight() {
        let t = NonceTracker::new();
        t.load(10);
        let a = t.take().unwrap();
        let b = t.take().unwrap();
        t.failed(a, "nonce too low: next nonce 11");
        assert_eq!(t.take(), Err(NonceErr::ResyncPending));
        assert!(!t.wants_resync()); // b still on its way
        assert!(t.resync(Some(10)).is_none());
        t.accepted(b);
        assert!(t.wants_resync());
        // Chain lags (says 10) but 10 is used and 11 accepted: next is 12.
        t.resync(Some(10)).unwrap();
        assert_eq!(t.take(), Ok(12));
    }

    #[test]
    fn failed_hole_is_reused() {
        let t = NonceTracker::new();
        t.load(3);
        let a = t.take().unwrap(); // 3
        t.failed(a, "connection reset");
        t.resync(Some(3)).unwrap();
        assert_eq!(t.take(), Ok(3));
    }

    #[test]
    fn hole_then_later_accepted_is_skipped() {
        let t = NonceTracker::new();
        t.load(0);
        let a = t.take().unwrap(); // 0
        let b = t.take().unwrap(); // 1
        t.failed(a, "timeout");
        t.accepted(b); // the sequencer queued 1 behind the gap
        t.resync(Some(0)).unwrap();
        // 1 waits behind the hole at 0: re-sign 0 (else 1 never mines), then
        // skip 1 (already accepted) and go on at 2.
        assert_eq!(t.take(), Ok(0));
        assert_eq!(t.take(), Ok(2));
    }

    #[test]
    fn dropped_trusts_chain() {
        let t = NonceTracker::new();
        t.load(0);
        let a = t.take().unwrap();
        t.accepted(a);
        t.dropped();
        t.resync(Some(0)).unwrap();
        assert_eq!(t.take(), Ok(0));
    }

    #[test]
    fn threads_never_share_a_nonce() {
        use std::sync::Arc;
        let t = Arc::new(NonceTracker::new());
        t.load(100);
        let hs: Vec<_> = (0..8)
            .map(|_| {
                let t = t.clone();
                std::thread::spawn(move || (0..500).map(|_| t.take().unwrap()).collect::<Vec<_>>())
            })
            .collect();
        let mut all: Vec<u64> = hs.into_iter().flat_map(|h| h.join().unwrap()).collect();
        all.sort();
        all.dedup();
        assert_eq!(all.len(), 4000);
        assert_eq!(all[0], 100);
        assert_eq!(*all.last().unwrap(), 4099);
    }
}
