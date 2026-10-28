// ============================================================================
// FIRE-FIRST COVERAGE: why a feed transaction could not be judged.
//
// Plain English (Oct 27, owner: "predict trades from the sequencer feed so
// we are ahead of them"): on 300 real blocks the fire-first path asked about
// 5,005 feed transactions and could judge only part of them ("miss" 1,378,
// "unsupported tx" 857, ...). Counting reasons is not enough to know what to
// fix. This file names, for every "unknown":
//
//   WHERE it came from (CheckUnknown.at, check/ordered.rs):
//     trigger        the trigger itself could not be run
//     lag            a transaction in an EARLIER block than the trigger,
//                    replayed only because copy 2's newest version was
//                    older than the trigger's block (copy lag)
//     same_block     another transaction of the trigger's own block (it
//                    would be replayed even with no lag)
//     after_trigger  a transaction in a LATER feed message (already seen,
//                    so our trade lands after it)
//     whole_run      not one transaction (our own calls, the replay as a
//                    whole: provenance, funding overlap, the plan itself)
//   WHAT was missing, by role (the first missing item, the one the run got
//   stuck on; later ones may come from the run going on with a made-up
//   zero): the transaction's target contract / its sender / a pool we
//   follow / a coin of our pools / anything else, and code / account / slot.
//
// Used by the live trigger status (fastlane/trigger.rs) and by the offline
// replay (fastlane/trig_replay.rs), so both count the same way. Bounded:
// at most TALLY_KEYS distinct keys are kept (later new keys are counted as
// "other"), so memory stays small whatever the traffic.
// ============================================================================
use std::collections::BTreeMap;

use revm::primitives::Address;
use serde_json::{json, Value};

use crate::check::TxAt;
use crate::state::MissItem;

/// Most distinct keys a tally keeps.
pub const TALLY_KEYS: usize = 512;

/// Where an "unknown" came from (see the file header).
pub fn origin(at: Option<&TxAt>, trigger_seq: u64) -> &'static str {
    match at {
        None => "whole_run",
        Some(a) if a.trigger => "trigger",
        Some(a) if a.seq < trigger_seq => "lag",
        Some(a) if a.seq == trigger_seq => "same_block",
        Some(_) => "after_trigger",
    }
}

/// The role of a missing item's account. `pool` / `coin`: is this a pool
/// we follow / a coin of our pools (None when not known: live status).
pub fn miss_role(item: &MissItem, at: Option<&TxAt>, pool: &dyn Fn(Address) -> bool, coin: &dyn Fn(Address) -> bool) -> String {
    let (kind, a) = match item {
        MissItem::Code(_) => return "code (of a contract the run called)".into(),
        MissItem::Account(a) => ("account", *a),
        MissItem::Slot(a, _) => ("slot", *a),
    };
    let who = if at.and_then(|t| t.to) == Some(a) {
        "target"
    } else if at.and_then(|t| t.from) == Some(a) {
        "sender"
    } else if pool(a) {
        "our pool"
    } else if coin(a) {
        "coin of our pools"
    } else {
        "other contract"
    };
    format!("{kind} of {who}")
}

/// A bounded counter (see TALLY_KEYS).
#[derive(Clone, Debug, Default)]
pub struct Tally {
    pub map: BTreeMap<String, u64>,
    pub other: u64,
}

impl Tally {
    pub fn add(&mut self, k: impl Into<String>) {
        self.add_n(k, 1);
    }
    pub fn add_n(&mut self, k: impl Into<String>, n: u64) {
        let k = k.into();
        if let Some(c) = self.map.get_mut(&k) {
            *c += n;
        } else if self.map.len() < TALLY_KEYS {
            self.map.insert(k, n);
        } else {
            self.other += n;
        }
    }
    pub fn total(&self) -> u64 {
        self.map.values().sum::<u64>() + self.other
    }
    /// The `n` biggest, biggest first (ties by name).
    pub fn top(&self, n: usize) -> Vec<(String, u64)> {
        let mut v: Vec<(String, u64)> = self.map.iter().map(|(k, c)| (k.clone(), *c)).collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        v.truncate(n);
        v
    }
    pub fn json(&self, n: usize) -> Value {
        let mut o = serde_json::Map::new();
        for (k, c) in self.top(n) {
            o.insert(k, json!(c));
        }
        if self.other > 0 || self.map.len() > n {
            let shown: u64 = o.values().filter_map(|v| v.as_u64()).sum();
            o.insert("(rest)".into(), json!(self.total() - shown));
        }
        Value::Object(o)
    }
}

/// An "unknown" answer's JSON (check/proto_types.rs unknown_json: "unknown",
/// "missing", "at") -> (reason, where, target, first missing item's role).
pub fn attribute_json(a: &Value, trigger_seq: u64) -> (String, &'static str, Option<String>, Option<String>) {
    let reason = a.get("unknown").and_then(|u| u.as_str()).unwrap_or("error").to_string();
    let at = a.get("at").and_then(txat_from_json);
    let first = a.get("missing").and_then(|m| m.as_array()).and_then(|m| m.first()).and_then(miss_from_json).map(|m| miss_role(&m, at.as_ref(), &|_| false, &|_| false));
    (reason, origin(at.as_ref(), trigger_seq), at.and_then(|t| t.to).map(|t| format!("{t:#x}")), first)
}

/// One entry of an answer's "missing" list (proto_types.rs miss_json),
/// code included.
pub fn miss_from_json(m: &Value) -> Option<MissItem> {
    if let Some(h) = m.get("code").and_then(|x| x.as_str()).and_then(|s| s.parse().ok()) {
        return Some(MissItem::Code(h));
    }
    let a = m.get("account").and_then(|x| x.as_str()).and_then(|s| crate::check::hexutil::parse_address(s).ok())?;
    Some(match m.get("slot").and_then(|x| x.as_str()).and_then(|s| crate::check::hexutil::parse_u256(s).ok()) {
        Some(s) => MissItem::Slot(a, s),
        None => MissItem::Account(a),
    })
}

/// TxAt::json read back (status / logs).
pub fn txat_from_json(v: &Value) -> Option<TxAt> {
    let addr = |k: &str| v.get(k).and_then(|x| x.as_str()).and_then(|s| crate::check::hexutil::parse_address(s).ok());
    let hash = v.get("hash").and_then(|x| x.as_str()).and_then(|s| s.parse().ok())?;
    Some(TxAt {
        seq: v.get("seq").and_then(|x| x.as_u64())?,
        hash,
        to: addr("to"),
        from: addr("from"),
        tx_type: v.get("type").and_then(|x| x.as_u64()).map(|x| x as u8),
        trigger: v.get("trigger").and_then(|x| x.as_bool()).unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use revm::primitives::{B256, U256};

    #[test]
    fn origin_and_roles() {
        let t = |seq: u64, trigger: bool| TxAt { seq, hash: B256::ZERO, to: Some(Address::with_last_byte(9)), from: Some(Address::with_last_byte(8)), tx_type: Some(2), trigger };
        assert_eq!(origin(None, 10), "whole_run");
        assert_eq!(origin(Some(&t(10, true)), 10), "trigger");
        assert_eq!(origin(Some(&t(9, false)), 10), "lag");
        assert_eq!(origin(Some(&t(10, false)), 10), "same_block");
        assert_eq!(origin(Some(&t(11, false)), 10), "after_trigger");
        let no = |_: Address| false;
        let at = t(10, true);
        assert_eq!(miss_role(&MissItem::Slot(Address::with_last_byte(9), U256::ZERO), Some(&at), &no, &no), "slot of target");
        assert_eq!(miss_role(&MissItem::Account(Address::with_last_byte(8)), Some(&at), &no, &no), "account of sender");
        assert_eq!(miss_role(&MissItem::Account(Address::with_last_byte(7)), Some(&at), &|a| a == Address::with_last_byte(7), &no), "account of our pool");
        assert!(miss_role(&MissItem::Code(B256::ZERO), Some(&at), &no, &no).starts_with("code"));
        // Read back from an answer.
        let j = json!({"unknown": "miss", "missing": [crate::check::proto_types::miss_json(&MissItem::Slot(Address::with_last_byte(9), U256::from(1u8)))], "at": at.json()});
        let (r, w, to, first) = attribute_json(&j, 10);
        assert_eq!((r.as_str(), w, to.as_deref()), ("miss", "trigger", Some("0x0000000000000000000000000000000000000009")));
        assert_eq!(first.as_deref(), Some("slot of target"), "{j}");
    }

    #[test]
    fn tally_is_bounded() {
        let mut t = Tally::default();
        for i in 0..(TALLY_KEYS + 10) {
            t.add(format!("k{i}"));
        }
        t.add("k0");
        assert_eq!(t.map.len(), TALLY_KEYS);
        assert_eq!(t.other, 10);
        assert_eq!(t.top(1), vec![("k0".to_string(), 2)]);
        assert_eq!(t.total(), TALLY_KEYS as u64 + 11);
    }
}
