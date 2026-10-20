// ============================================================================
// DIFFS: "what a transaction changed", from two sources, in one shape.
//
// Plain English:
//   1. OUR replay: revm hands back every account it touched with old and new
//      values; `from_evm_state` keeps only what changed.
//   2. THE NODE: debug_traceBlockByNumber with the prestate tracer in "diff
//      mode" lists, per transaction, `pre` (old values of what changed) and
//      `post` (new values). Geth's documented rules:
//        - an account in `pre` but not in `post`  -> deleted
//        - an account in `post` but not in `pre`  -> created
//        - a slot in `pre` but not in `post`      -> set to zero
//        - only CHANGED fields appear in `post`; unchanged ones are taken
//          from `pre` (which lists the account's full old basics)
//      `from_prestate_diff` turns that into the same StateDiff.
//   Then `merge` folds a block's per-transaction diffs into one, and
//   `compare` checks our replay against the node's diff on the accounts we
//   track (the self-check: replay_match / replay_mismatch).
// ============================================================================
use std::collections::{HashMap, HashSet};

use revm::primitives::{keccak256, Address, KECCAK_EMPTY, U256};
use revm::state::{AccountInfo, Bytecode, EvmState};
use serde_json::Value;

use super::{AccountDiff, Lookup, StateDiff, StateRead};
use crate::check::hexutil::{parse_address, parse_bytes, parse_u256, parse_u64};

/// Turn revm's end-of-transaction state into a diff (changed items only).
/// `inexact_balance`: accounts whose new ETH balance is only approximate
/// (the sender: our replay doesn't charge gas fees). `skip`: accounts whose
/// new state we must not record (a sender we only pretended to know): they
/// get a `forget` entry, so nothing stale about them survives.
pub fn from_evm_state(state: &EvmState, inexact_balance: &[Address], skip: &[Address]) -> StateDiff {
    let mut d = StateDiff::default();
    for (addr, acc) in state.iter() {
        if skip.contains(addr) {
            d.accounts.insert(*addr, AccountDiff { forget: true, ..Default::default() });
            continue;
        }
        if !acc.is_touched() {
            continue;
        }
        let mut ad = AccountDiff::default();
        if acc.is_selfdestructed() {
            ad.info = Some(None);
            ad.storage_cleared = true;
            d.accounts.insert(*addr, ad);
            continue;
        }
        let created = acc.is_created();
        let mut info = acc.info.clone();
        if created {
            if let Some(c) = &info.code {
                if !c.is_empty() {
                    ad.code = Some(c.clone());
                }
            }
        }
        info.code = None;
        info.account_id = None;
        let empty = info.balance.is_zero() && info.nonce == 0 && (info.code_hash == KECCAK_EMPTY || info.code_hash.is_zero());
        ad.info = Some(if empty { None } else { Some(info) });
        ad.storage_cleared = created || empty;
        if !empty {
            for (k, s) in acc.storage.iter() {
                if created || s.is_changed() {
                    ad.storage.insert(*k, s.present_value);
                }
            }
        }
        ad.balance_inexact = inexact_balance.contains(addr);
        d.accounts.insert(*addr, ad);
    }
    d
}

/// One transaction's diff as reported by the node.
#[derive(Clone, Debug, Default)]
pub struct NodeTxDiff {
    pub tx_hash: Option<revm::primitives::B256>,
    pub diff: StateDiff,
    /// Old values (`pre`) of the changed slots (for comparisons).
    pub pre_storage: HashMap<Address, HashMap<U256, U256>>,
}

fn field_u256(v: &Value, k: &str) -> Result<Option<U256>, String> {
    match v.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => parse_u256(s).map(Some),
        Some(Value::Number(n)) => Ok(Some(U256::from(n.as_u64().ok_or("bad number")?))),
        _ => Err(format!("{k}: not a number")),
    }
}
fn field_u64(v: &Value, k: &str) -> Result<Option<u64>, String> {
    match v.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => parse_u64(s).map(Some),
        Some(Value::Number(n)) => Ok(Some(n.as_u64().ok_or("bad number")?)),
        _ => Err(format!("{k}: not a number")),
    }
}
fn field_code(v: &Value) -> Result<Option<Vec<u8>>, String> {
    match v.get("code") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => parse_bytes(s).map(|b| Some(b.to_vec())),
        _ => Err("code: not hex text".into()),
    }
}
fn slots(v: &Value) -> Result<HashMap<U256, U256>, String> {
    let mut m = HashMap::new();
    if let Some(o) = v.get("storage").and_then(|s| s.as_object()) {
        for (k, val) in o {
            let val = val.as_str().ok_or("storage value not text")?;
            m.insert(parse_u256(k)?, parse_u256(val)?);
        }
    }
    Ok(m)
}

/// Parse one transaction's `{pre, post}` (diffMode prestate result).
pub fn from_prestate_diff(result: &Value) -> Result<NodeTxDiff, String> {
    let empty = serde_json::Map::new();
    let pre = result.get("pre").and_then(|v| v.as_object()).unwrap_or(&empty);
    let post = result.get("post").and_then(|v| v.as_object()).unwrap_or(&empty);
    let mut out = NodeTxDiff::default();
    let mut addrs: HashSet<&String> = pre.keys().collect();
    addrs.extend(post.keys());
    for a_s in addrs {
        let addr = parse_address(a_s)?;
        let p = pre.get(a_s);
        let q = post.get(a_s);
        let pre_slots = match p {
            Some(p) => slots(p)?,
            None => HashMap::new(),
        };
        let mut ad = AccountDiff::default();
        match q {
            None => {
                // In pre, not in post: deleted.
                ad.info = Some(None);
                ad.storage_cleared = true;
            }
            Some(q) => {
                let created = p.is_none();
                // Basics: post field if changed, else pre, else default.
                let pick_u256 = |k: &str| -> Result<U256, String> {
                    Ok(field_u256(q, k)?.or(match p {
                        Some(p) => field_u256(p, k)?,
                        None => None,
                    }).unwrap_or(U256::ZERO))
                };
                let balance = pick_u256("balance")?;
                let nonce = field_u64(q, "nonce")?
                    .or(match p {
                        Some(p) => field_u64(p, "nonce")?,
                        None => None,
                    })
                    .unwrap_or(0);
                let new_code = field_code(q)?;
                let code = match &new_code {
                    Some(c) => Some(c.clone()),
                    None => match p {
                        Some(p) => field_code(p)?,
                        None => None,
                    },
                };
                // Code hash: from the code the trace lists. If neither side
                // lists code, B256::ZERO = "not given": the receiver keeps the
                // code hash it already has (geth omits code for plain
                // accounts; we never want to wipe a contract's code because a
                // tracer left it out).
                let code_hash = match &code {
                    Some(c) if !c.is_empty() => keccak256(c),
                    Some(_) => KECCAK_EMPTY,
                    None => revm::primitives::B256::ZERO,
                };
                if let Some(c) = &new_code {
                    if !c.is_empty() {
                        ad.code = Some(Bytecode::new_raw(c.clone().into()));
                    }
                }
                let info = AccountInfo { balance, nonce, code_hash, ..Default::default() };
                let empty = balance.is_zero() && nonce == 0 && (code_hash == KECCAK_EMPTY || code_hash.is_zero() && code.is_none() && created);
                ad.info = Some(if empty { None } else { Some(info) });
                ad.storage_cleared = created || empty;
                let post_slots = slots(q)?;
                for s in pre_slots.keys() {
                    if !post_slots.contains_key(s) {
                        ad.storage.insert(*s, U256::ZERO);
                    }
                }
                for (s, v) in post_slots {
                    ad.storage.insert(s, v);
                }
            }
        }
        if !pre_slots.is_empty() {
            out.pre_storage.insert(addr, pre_slots);
        }
        out.diff.accounts.insert(addr, ad);
    }
    Ok(out)
}

/// Parse a whole debug_traceBlockByNumber answer: one entry per tx, in
/// order, each `{txHash?, result: {pre, post}}`.
pub fn parse_block_trace(v: &Value) -> Result<Vec<NodeTxDiff>, String> {
    let arr = v.as_array().ok_or("block trace is not a list")?;
    let mut out = Vec::with_capacity(arr.len());
    for (i, e) in arr.iter().enumerate() {
        if let Some(err) = e.get("error") {
            return Err(format!("trace of tx #{i} failed: {err}"));
        }
        let r = e.get("result").unwrap_or(e);
        let mut d = from_prestate_diff(r).map_err(|x| format!("tx #{i}: {x}"))?;
        d.tx_hash = e
            .get("txHash")
            .and_then(|h| h.as_str())
            .and_then(|h| parse_u256(h).ok())
            .map(|u| revm::primitives::B256::from(u.to_be_bytes::<32>()));
        out.push(d);
    }
    Ok(out)
}

/// Fold `next` (later) into `acc` (earlier): later values win.
pub fn merge(acc: &mut StateDiff, next: &StateDiff) {
    for (a, n) in &next.accounts {
        let e = acc.accounts.entry(*a).or_default();
        if n.forget {
            *e = AccountDiff { forget: true, ..Default::default() };
            continue;
        }
        if e.forget {
            // Known again from here on only through what `n` says; treat the
            // account as unknown-then-changed: keep forget (conservative).
            continue;
        }
        if n.storage_cleared {
            e.storage.clear();
            e.storage_cleared = true;
        }
        if let Some(i) = &n.info {
            if i.is_none() && !n.storage_cleared {
                e.storage.clear();
                e.storage_cleared = true;
            }
            e.info = Some(i.clone());
        }
        if n.code.is_some() {
            e.code = n.code.clone();
        }
        e.balance_inexact |= n.balance_inexact;
        for (s, v) in &n.storage {
            e.storage.insert(*s, *v);
        }
    }
}

/// Does this diff change this slot (directly, or by clearing the account)?
pub fn touches_slot(d: &StateDiff, a: &Address, s: &U256) -> bool {
    d.accounts.get(a).is_some_and(|x| x.forget || x.storage_cleared || matches!(x.info, Some(None)) || x.storage.contains_key(s))
}

/// Does this diff change this account's basics?
pub fn touches_account(d: &StateDiff, a: &Address) -> bool {
    d.accounts.get(a).is_some_and(|x| x.info.is_some())
}

/// One difference between our replay and the node.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mismatch {
    pub account: Address,
    /// Only the ETH balance differs (typical of gas-fee receivers).
    pub balance_only: bool,
    /// None = basics (balance / nonce / code), Some = this slot.
    pub slot: Option<U256>,
    pub ours: String,
    pub node: String,
}

/// Compare our replay (`ours`, merged over the message) with the node's
/// (`node`, merged over the block) for the items we track. `before` = our
/// state just before the message (to know old values and what we track).
/// `skip_balance`: accounts whose balances can't be compared (senders paid
/// fees we don't replay; fee receivers). Returns (items compared, mismatches).
pub fn compare(before: &dyn StateRead, ours: &StateDiff, node: &StateDiff, skip_balance: &HashSet<Address>, skip_account: &HashSet<Address>) -> (usize, Vec<Mismatch>) {
    let mut compared = 0usize;
    let mut out = Vec::new();
    let mut addrs: HashSet<Address> = node.accounts.keys().copied().collect();
    addrs.extend(ours.accounts.keys().copied());
    for a in addrs {
        if skip_account.contains(&a) {
            continue;
        }
        let o = ours.accounts.get(&a);
        let n = node.accounts.get(&a);
        // --- basics: only if we knew them before the message ---
        let old_info = match before.account(a) {
            Lookup::Known(i) => Some(i),
            Lookup::Missing => None,
        };
        if let Some(old) = old_info {
            let ours_info = o.and_then(|x| x.info.clone()).unwrap_or(old.clone());
            let node_info = match n.and_then(|x| x.info.clone()) {
                Some(i) => Some(i),
                None => None, // node: unchanged
            };
            let mut node_final = node_info.unwrap_or(old.clone());
            if let (Some(n), Some(o)) = (node_final.as_mut(), ours_info.as_ref()) {
                if n.code_hash.is_zero() {
                    n.code_hash = o.code_hash; // node didn't list code: unchanged
                }
            }
            compared += 1;
            let key = |i: &Option<AccountInfo>, with_bal: bool| match i {
                None => "empty".to_string(),
                Some(i) => {
                    let ch = if i.code_hash.is_zero() { KECCAK_EMPTY } else { i.code_hash };
                    if with_bal { format!("bal={} nonce={} code={ch}", i.balance, i.nonce) } else { format!("nonce={} code={ch}", i.nonce) }
                }
            };
            let with_bal = !skip_balance.contains(&a) && before.balance_exact(a);
            let (ko, kn) = (key(&ours_info, with_bal), key(&node_final, with_bal));
            if ko != kn {
                let balance_only = key(&ours_info, false) == key(&node_final, false);
                out.push(Mismatch { account: a, balance_only, slot: None, ours: ko, node: kn });
            }
        }
        // --- storage: every slot either side changed that we track ---
        let mut slots: HashSet<U256> = HashSet::new();
        if let Some(x) = o {
            slots.extend(x.storage.keys().copied());
        }
        if let Some(x) = n {
            slots.extend(x.storage.keys().copied());
        }
        let node_cleared = n.is_some_and(|x| x.storage_cleared);
        let ours_cleared = o.is_some_and(|x| x.storage_cleared);
        for s in slots {
            let old = match before.storage(a, s) {
                Lookup::Known(v) => Some(v),
                Lookup::Missing => None,
            };
            // Only items we track (known before, or set by our own replay).
            let ours_v = match o.and_then(|x| x.storage.get(&s)) {
                Some(v) => Some(*v),
                None if ours_cleared => Some(U256::ZERO),
                None => old,
            };
            let Some(ours_v) = ours_v else { continue };
            let node_v = match n.and_then(|x| x.storage.get(&s)) {
                Some(v) => Some(*v),
                None if node_cleared => Some(U256::ZERO),
                None => old, // node: unchanged
            };
            let Some(node_v) = node_v else { continue };
            compared += 1;
            if ours_v != node_v {
                out.push(Mismatch { account: a, balance_only: false, slot: Some(s), ours: format!("{ours_v:#x}"), node: format!("{node_v:#x}") });
            }
        }
    }
    (compared, out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::snap::{Fact, Snapshot};
    use serde_json::json;

    const A: &str = "0x00000000000000000000000000000000000000aa";
    const B: &str = "0x00000000000000000000000000000000000000bb";
    const C: &str = "0x00000000000000000000000000000000000000cc";

    fn addr(s: &str) -> Address {
        parse_address(s).unwrap()
    }

    // geth diffMode sample (shape from the geth tracer docs).
    fn sample() -> Value {
        json!([{
            "txHash": "0x01",
            "result": {
                "pre": {
                    A: { "balance": "0x100", "nonce": 5, "code": "0x6001", "storage": {
                        "0x01": "0x0000000000000000000000000000000000000000000000000000000000000007",
                        "0x02": "0x0000000000000000000000000000000000000000000000000000000000000009" } },
                    B: { "balance": "0x5" }
                },
                "post": {
                    A: { "storage": { "0x01": "0x000000000000000000000000000000000000000000000000000000000000000b" } },
                    C: { "balance": "0x7", "code": "0x6002", "storage": { "0x05": "0x01" } }
                }
            }
        }])
    }

    #[test]
    fn diff_mode_rules() {
        let t = parse_block_trace(&sample()).unwrap();
        assert_eq!(t.len(), 1);
        let d = &t[0].diff;
        // A: slot 1 changed, slot 2 in pre only -> cleared; basics kept from pre.
        let a = &d.accounts[&addr(A)];
        assert_eq!(a.storage[&U256::from(1)], U256::from(11));
        assert_eq!(a.storage[&U256::from(2)], U256::ZERO);
        let ai = a.info.clone().unwrap().unwrap();
        assert_eq!((ai.balance, ai.nonce), (U256::from(0x100), 5));
        assert_eq!(ai.code_hash, keccak256([0x60, 0x01]));
        // B: in pre only -> deleted.
        assert_eq!(d.accounts[&addr(B)].info, Some(None));
        // C: created with code and storage.
        let c = &d.accounts[&addr(C)];
        assert!(c.storage_cleared && c.code.is_some());
        assert_eq!(c.storage[&U256::from(5)], U256::from(1));
    }

    #[test]
    fn apply_node_diff_including_cleared_slots() {
        let t = parse_block_trace(&sample()).unwrap();
        let mut s = Snapshot::default();
        s.apply_fact(&Fact::Slot(addr(A), U256::from(2), U256::from(9)));
        s.apply_fact(&Fact::Slot(addr(A), U256::from(3), U256::from(4)));
        s.apply_diff(&t[0].diff);
        assert_eq!(s.storage(addr(A), U256::from(2)), Lookup::Known(U256::ZERO));
        assert_eq!(s.storage(addr(A), U256::from(3)), Lookup::Known(U256::from(4))); // untouched
        assert_eq!(s.account(addr(B)), Lookup::Known(None));
        assert_eq!(s.storage(addr(C), U256::from(77)), Lookup::Known(U256::ZERO)); // created: complete
        assert!(matches!(s.code_by_hash(keccak256([0x60, 0x02])), Lookup::Known(_)));
    }

    #[test]
    fn compare_flags_only_tracked_differences() {
        let node = parse_block_trace(&sample()).unwrap().remove(0).diff;
        let mut before = Snapshot::default();
        before.apply_fact(&Fact::Slot(addr(A), U256::from(1), U256::from(7)));
        // Our replay set slot 1 to 12 (node says 11) and didn't touch slot 2.
        let mut ours = StateDiff::default();
        ours.accounts.insert(addr(A), AccountDiff { storage: HashMap::from([(U256::from(1), U256::from(12))]), ..Default::default() });
        let (n, mm) = compare(&before, &ours, &node, &HashSet::new(), &HashSet::new());
        assert_eq!(n, 1); // only slot 1 is tracked
        assert_eq!(mm.len(), 1);
        assert_eq!(mm[0].slot, Some(U256::from(1)));
        // Same value -> match.
        ours.accounts.get_mut(&addr(A)).unwrap().storage.insert(U256::from(1), U256::from(11));
        assert!(compare(&before, &ours, &node, &HashSet::new(), &HashSet::new()).1.is_empty());
    }

    #[test]
    fn merge_later_wins_and_clears() {
        let mut a = StateDiff::default();
        a.accounts.insert(addr(A), AccountDiff { storage: HashMap::from([(U256::from(1), U256::from(1))]), ..Default::default() });
        let mut b = StateDiff::default();
        b.accounts.insert(addr(A), AccountDiff { info: Some(None), ..Default::default() });
        merge(&mut a, &b);
        assert!(a.accounts[&addr(A)].storage.is_empty() && a.accounts[&addr(A)].storage_cleared);
        assert!(touches_slot(&a, &addr(A), &U256::from(99)));
    }
}
