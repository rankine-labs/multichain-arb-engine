// ============================================================================
// TRIG-REPLAY --fetch: fetch what the recording didn't hold, and ask again.
//
// Plain English:
//   `arbsim trig-replay` replays a recording offline, so a feed transaction
//   that needs a value copy 2 didn't hold answers "unknown: miss" (live
//   fetches some of these; offline nothing was fetched). With --fetch the
//   replay asks a node for exactly those values, AT THE BLOCK OF THE COPY
//   VERSION the question was asked on (so the value is exact for that
//   version, never "today's" value), puts them into a private copy of that
//   version, and asks the same question again (a few rounds: a run that got
//   further may need more values). Answers are then compared with what the
//   chain says the transaction did (labels only, as everywhere in
//   trig-replay).
//
//   It also fetches the values we only ASSUMED for a reverting
//   transaction's sender ("sender_funds_revert": e.g. a bot's
//   whitelist[sender] flag, which our made-up amount read as "no"), so the
//   report shows whether the real values fix those answers.
//
//   Which node (the URL is a secret: never printed, never logged):
//     1. the FREE public node first (ARBSIM_PUBLIC_URL, or the setting named
//        by --fetch-url-env NAME, default Robinhood's public node),
//     2. the paid node (ARBSIM_NODE_URL / CHAINSTACK_RPC_ROBINHOOD /
//        ARBSIM_NODE_URL_2) ONLY for values the free node couldn't give
//        (old state it doesn't keep, an error), and only up to
//        --fetch-paid-max calls; --fetch-paid off = never.
//   Hard cap: --fetch-max calls in total (default 3000; one slot = 1 call,
//   one account = 3: balance, nonce, code). Each value is fetched once per
//   block (cached for the run). The live daily-allowance file is never
//   touched (this run keeps its own count in memory).
//
//   SELF-ONLY TARGETS (the "doesn't touch us" question): a transaction
//   whose target contract's code has no opcode that can reach another
//   contract (no CALL / DELEGATECALL / CALLCODE / CREATE / CREATE2 /
//   SELFDESTRUCT; check/ordered.rs writes_only_itself) can only change that
//   contract's own storage and the two ETH balances. Unless that contract
//   IS one of our pools / their coins, it provably can't move our pools,
//   whatever its storage holds. `target_code` reads that verdict.
// ============================================================================
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use revm::primitives::{Address, U256};
use serde_json::{json, Value};

use crate::check::ordered::Provenance;
use crate::check::rawtx::DecodedTx;
use crate::node::{fetch_items, Class, Fetched, ItemErr, NodeApi, NodeClient};
use crate::state::snap::{Fact, Snapshot};
use crate::state::{Lookup, MissItem, StateRead};

use super::coverage::Tally;

/// --fetch settings.
#[derive(Clone, Debug)]
pub struct FetchOpts {
    /// Hard cap: calls in total (both nodes).
    pub max_calls: u64,
    /// Hard cap: calls on the paid node (0 = never use it).
    pub max_paid: u64,
    /// Rounds of "fetch, ask again" per question.
    pub rounds: usize,
    /// Only questions about transactions the chain says moved our pools
    /// (spends the cap on "the prize" first).
    pub moved_only: bool,
    /// AT ITS OWN POSITION (trig_replay.rs): besides every WRONG answer, this
    /// many correct ones are asked again that way too (a control).
    pub own_control: usize,
}

impl Default for FetchOpts {
    fn default() -> Self {
        FetchOpts { max_calls: 3000, max_paid: 3000, rounds: 6, moved_only: false, own_control: 10 }
    }
}

fn calls_for(m: &MissItem) -> u64 {
    match m {
        MissItem::Slot(..) => 1,
        MissItem::Account(_) => 3,
        MissItem::Code(_) => 3, // fetched as the account holding that code
    }
}

/// Node error text with anything that looks like a link cut out (a node
/// URL holds the API key).
pub fn scrub(s: &str) -> String {
    s.split_whitespace()
        .map(|w| if w.contains("://") || w.contains("http") { "<url>" } else { w })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(80)
        .collect()
}

/// Fetches values for the replay (see the file header).
pub struct ReplayFetcher {
    public: Option<Box<dyn NodeApi>>,
    paid: Option<Box<dyn NodeApi>>,
    pub opts: FetchOpts,
    /// (block, item) -> the value (None = couldn't be fetched).
    cache: HashMap<(u64, MissItem), Option<Fetched>>,
    pub calls_public: u64,
    pub calls_paid: u64,
    pub items_ok: u64,
    pub items_failed: u64,
    pub items_capped: u64,
    pub cache_hits: u64,
    pub code_not_found: u64,
    pub http_errors: u64,
    errors: Tally,
}

impl ReplayFetcher {
    pub fn new(public: Option<Box<dyn NodeApi>>, paid: Option<Box<dyn NodeApi>>, opts: FetchOpts) -> Self {
        let paid = if opts.max_paid == 0 { None } else { paid };
        ReplayFetcher {
            public,
            paid,
            opts,
            cache: HashMap::new(),
            calls_public: 0,
            calls_paid: 0,
            items_ok: 0,
            items_failed: 0,
            items_capped: 0,
            cache_hits: 0,
            code_not_found: 0,
            http_errors: 0,
            errors: Tally::default(),
        }
    }

    /// From the environment (main only: changes process settings before any
    /// thread starts). `url_env`: the setting that holds the free node's
    /// URL (None = ARBSIM_PUBLIC_URL / Robinhood's public node).
    pub fn from_env(url_env: Option<&str>, opts: FetchOpts) -> Result<Self, String> {
        crate::bench_node::load_dotenv();
        // Never touch the live daily-allowance file; never refuse below our own cap.
        std::env::set_var("ARBSIM_BUDGET_FILE", "");
        std::env::set_var("ARBSIM_NODE_DAILY_CAP", (opts.max_calls + 100).to_string());
        if let Some(name) = url_env {
            match std::env::var(name) {
                Ok(v) if !v.trim().is_empty() => std::env::set_var("ARBSIM_PUBLIC_URL", v.trim()),
                _ => return Err(format!("--fetch-url-env: setting {name} is not set (environment or ./.env)")),
            }
        }
        let saved: Vec<(&str, Option<String>)> = ["ARBSIM_NODE_URL", "CHAINSTACK_RPC_ROBINHOOD", "ARBSIM_NODE_URL_2", "ARBSIM_PUBLIC_URL"]
            .iter()
            .map(|k| (*k, std::env::var(k).ok()))
            .collect();
        let get = |k: &str| saved.iter().find(|(n, _)| *n == k).and_then(|(_, v)| v.clone());
        // Free node only.
        for k in ["ARBSIM_NODE_URL", "CHAINSTACK_RPC_ROBINHOOD", "ARBSIM_NODE_URL_2"] {
            std::env::set_var(k, "");
        }
        let public = NodeClient::from_env().map(|c| Box::new(c) as Box<dyn NodeApi>);
        // Paid node(s) only.
        std::env::set_var("ARBSIM_PUBLIC_URL", "off");
        std::env::set_var("ARBSIM_BG_PUBLIC", "0");
        for k in ["ARBSIM_NODE_URL", "CHAINSTACK_RPC_ROBINHOOD", "ARBSIM_NODE_URL_2"] {
            std::env::set_var(k, get(k).unwrap_or_default());
        }
        let paid = NodeClient::from_env().map(|c| Box::new(c) as Box<dyn NodeApi>);
        match get("ARBSIM_PUBLIC_URL") {
            Some(v) => std::env::set_var("ARBSIM_PUBLIC_URL", v),
            None => std::env::remove_var("ARBSIM_PUBLIC_URL"),
        }
        if public.is_none() && paid.is_none() {
            return Err("--fetch: no node (free node switched off and no paid node set)".into());
        }
        Ok(Self::new(public, paid, opts))
    }

    /// A value already fetched at `block` (None = not fetched / failed).
    pub fn cached(&self, block: u64, item: &MissItem) -> Option<&Fetched> {
        self.cache.get(&(block, item.clone())).and_then(|x| x.as_ref())
    }

    pub fn calls(&self) -> u64 {
        self.calls_public + self.calls_paid
    }

    pub fn capped(&self) -> bool {
        self.calls() >= self.opts.max_calls
    }

    fn ask(&mut self, paid: bool, block: u64, items: &[MissItem]) -> Vec<(MissItem, Result<Fetched, ItemErr>)> {
        let node = if paid { self.paid.as_deref() } else { self.public.as_deref() };
        let Some(node) = node else { return Vec::new() };
        let n: u64 = items.iter().map(calls_for).sum();
        if paid {
            self.calls_paid += n;
        } else {
            self.calls_public += n;
        }
        match fetch_items(node, Class::Fill, block, items) {
            Ok(v) => v,
            Err(e) => {
                self.http_errors += 1;
                self.errors.add(format!("{} | {}", if paid { "paid" } else { "free" }, scrub(&e.to_string())));
                items.iter().map(|m| (m.clone(), Err(ItemErr::Other("request failed".into())))).collect()
            }
        }
    }

    /// The values of `items` at `block` (from the cache or the nodes, within
    /// the caps). A Code(hash) item is fetched as an account of `snap`
    /// holding that code. Returns the facts fetched (and cached) OK.
    pub fn fetch(&mut self, block: u64, items: &[MissItem], snap: &Snapshot) -> Vec<Fetched> {
        let mut out = Vec::new();
        let mut todo: Vec<MissItem> = Vec::new();
        for m in items {
            let m = match m {
                MissItem::Code(h) => match snap.accounts.iter().find(|(_, a)| matches!(&a.basics, crate::state::snap::Basics::Known(Some(i)) if i.code_hash == *h)) {
                    Some((a, _)) => MissItem::Account(*a),
                    None => {
                        self.code_not_found += 1;
                        continue;
                    }
                },
                x => x.clone(),
            };
            match self.cache.get(&(block, m.clone())) {
                Some(Some(f)) => {
                    self.cache_hits += 1;
                    out.push(f.clone());
                }
                Some(None) => self.cache_hits += 1,
                None if !todo.contains(&m) => todo.push(m),
                None => {}
            }
        }
        // Within the total cap.
        let mut room = self.opts.max_calls.saturating_sub(self.calls());
        let mut send = Vec::new();
        for m in todo {
            let c = calls_for(&m);
            if c <= room {
                room -= c;
                send.push(m);
            } else {
                self.items_capped += 1;
            }
        }
        if send.is_empty() {
            return out;
        }
        // 1. The free node.
        let mut again: Vec<MissItem> = Vec::new();
        let first = if self.public.is_some() { self.ask(false, block, &send) } else { send.iter().map(|m| (m.clone(), Err(ItemErr::Other("no free node".into())))).collect() };
        for (m, r) in first {
            match r {
                Ok(f) => {
                    self.items_ok += 1;
                    self.cache.insert((block, m), Some(f.clone()));
                    out.push(f);
                }
                Err(e) => {
                    self.errors.add(format!("free | {}", item_err(&e)));
                    again.push(m);
                }
            }
        }
        // 2. The paid node, for what the free node couldn't give.
        if !again.is_empty() && self.paid.is_some() {
            let mut room_paid = self.opts.max_paid.saturating_sub(self.calls_paid).min(self.opts.max_calls.saturating_sub(self.calls()));
            let mut send2 = Vec::new();
            let mut left = Vec::new();
            for m in again {
                let c = calls_for(&m);
                if c <= room_paid {
                    room_paid -= c;
                    send2.push(m);
                } else {
                    left.push(m);
                }
            }
            for m in left {
                self.items_capped += 1;
                // Not cached: a later run with more room may fetch it.
                let _ = m;
            }
            for (m, r) in self.ask(true, block, &send2) {
                match r {
                    Ok(f) => {
                        self.items_ok += 1;
                        self.cache.insert((block, m), Some(f.clone()));
                        out.push(f);
                    }
                    Err(e) => {
                        self.items_failed += 1;
                        self.errors.add(format!("paid | {}", item_err(&e)));
                        self.cache.insert((block, m), None);
                    }
                }
            }
        } else {
            for m in again {
                self.items_failed += 1;
                self.cache.insert((block, m), None);
            }
        }
        out
    }

    pub fn json(&self) -> Value {
        json!({
            "callsTotal": self.calls(), "callsFreeNode": self.calls_public, "callsPaidNode": self.calls_paid,
            "maxCalls": self.opts.max_calls, "maxPaidCalls": if self.paid.is_some() { json!(self.opts.max_paid) } else { json!("off / no paid node") },
            "freeNode": self.public.is_some(), "capReached": self.capped(),
            "valuesFetched": self.items_ok, "valuesFailed": self.items_failed, "valuesOverCap": self.items_capped, "cacheHits": self.cache_hits,
            "codeOwnerNotFound": self.code_not_found, "requestsFailed": self.http_errors, "errors": self.errors.json(8),
            "note": "1 call = 1 JSON-RPC method call inside a batch (a slot = 1, an account = 3); free node first, paid node only for what the free node couldn't give",
        })
    }
}

fn item_err(e: &ItemErr) -> String {
    match e {
        ItemErr::BlockUnavailable => "state of that block not available".into(),
        ItemErr::Unsupported => "can't be asked for".into(),
        ItemErr::Other(s) => scrub(s),
    }
}

/// A copy version plus the values fetched for it (all exact at its block).
pub struct Overlay {
    pub seq: u64,
    pub snap: Arc<Snapshot>,
    slots: HashSet<(Address, U256)>,
    accts: HashSet<Address>,
}

impl Overlay {
    pub fn new(seq: u64, base: Arc<Snapshot>) -> Self {
        Overlay { seq, snap: base, slots: HashSet::new(), accts: HashSet::new() }
    }

    /// Put fetched values in (exact at this version's block).
    pub fn add(&mut self, facts: &[Fetched]) {
        if facts.is_empty() {
            return;
        }
        let mut s = (*self.snap).clone();
        for f in facts {
            match f {
                Fetched::Slot(a, k, v) => {
                    s.apply_fact(&Fact::Slot(*a, *k, *v));
                    self.slots.insert((*a, *k));
                }
                Fetched::Account(a, acc) => {
                    let (info, code) = crate::state::fill::account_info(acc.as_ref());
                    s.apply_fact(&Fact::Basics { addr: *a, info, code });
                    self.accts.insert(*a);
                }
            }
        }
        self.snap = Arc::new(s);
    }

    pub fn len(&self) -> usize {
        self.slots.len() + self.accts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Copy 2's provenance, plus "every fetched value is exact".
pub struct OverlayProv<'a> {
    pub inner: &'a dyn Provenance,
    pub o: &'a Overlay,
}

impl Provenance for OverlayProv<'_> {
    fn slot_exact(&self, a: Address, s: U256) -> bool {
        self.inner.slot_exact(a, s) || self.o.slots.contains(&(a, s))
    }
    fn balance_exact(&self, a: Address) -> bool {
        self.inner.balance_exact(a) || self.o.accts.contains(&a)
    }
}

/// What a transaction's target contract can do (see SELF-ONLY TARGETS).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum TargetCode {
    /// Code with no opcode that can reach another contract.
    SelfOnly,
    /// Code that can call / create / delegate (a router, a bot, a proxy...).
    CallsOut,
    /// An account with no code (a wallet).
    NoCode,
    /// EIP-7702 delegation (another contract's code runs).
    Delegated,
    /// A precompile / Nitro built-in.
    Builtin,
    /// Not in this copy.
    NotHeld,
}

impl TargetCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            TargetCode::SelfOnly => "self-only code (can't reach other contracts)",
            TargetCode::CallsOut => "code that calls out",
            TargetCode::NoCode => "no code (wallet)",
            TargetCode::Delegated => "EIP-7702 delegated wallet",
            TargetCode::Builtin => "built-in",
            TargetCode::NotHeld => "code not held",
        }
    }
}

/// The target's code, as `view` holds it.
pub fn target_code(view: &dyn StateRead, to: Address) -> TargetCode {
    if crate::check::ordered::system_address(to) {
        return TargetCode::Builtin;
    }
    let info = match view.account(to) {
        Lookup::Known(Some(i)) => i,
        Lookup::Known(None) => return TargetCode::NoCode,
        Lookup::Missing => return TargetCode::NotHeld,
    };
    let code = match &info.code {
        Some(c) => c.original_bytes(),
        None if info.code_hash == revm::primitives::KECCAK_EMPTY || info.code_hash.is_zero() => return TargetCode::NoCode,
        None => match view.code_by_hash(info.code_hash) {
            Lookup::Known(c) => c.original_bytes(),
            Lookup::Missing => return TargetCode::NotHeld,
        },
    };
    if code.is_empty() {
        TargetCode::NoCode
    } else if code.first() == Some(&0xef) {
        TargetCode::Delegated
    } else if crate::check::ordered::writes_only_itself(&code) {
        TargetCode::SelfOnly
    } else {
        TargetCode::CallsOut
    }
}

/// PROVEN "doesn't touch us": the transaction calls a contract whose code
/// can't reach any other contract (and that contract isn't ours: not one
/// of our pools, their coins, a PoolManager). Not for EIP-7702 transactions
/// (their authorizations change other accounts' code). Nothing about the
/// contract's storage or balances is needed.
pub fn proven_untouching(view: &dyn StateRead, d: &DecodedTx, is_ours: &dyn Fn(Address) -> bool) -> bool {
    if d.tx_type == 4 {
        return false;
    }
    match d.to {
        Some(t) => !is_ours(t) && target_code(view, t) == TargetCode::SelfOnly,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::{CallResult, NodeErr, RpcErr};
    use revm::bytecode::Bytecode;
    use revm::state::AccountInfo;
    use std::sync::Mutex;

    /// A fake node: answers eth_getStorageAt with the slot number + 1,
    /// accounts as a contract with `code`; `fail`: every call fails with
    /// "missing trie node" (old state not kept).
    struct Fake {
        fail: bool,
        code: Vec<u8>,
        calls: Mutex<u64>,
    }

    impl NodeApi for Fake {
        fn call_batch(&self, _c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
            *self.calls.lock().unwrap() += calls.len() as u64;
            Ok(calls
                .iter()
                .map(|(m, p)| {
                    if self.fail {
                        return Err(RpcErr { code: -32000, message: "missing trie node https://secret.example/key".into() });
                    }
                    Ok(match *m {
                        "eth_getStorageAt" => {
                            let s = crate::check::hexutil::parse_u256(p[1].as_str().unwrap()).unwrap();
                            json!(format!("{:#x}", s + U256::from(1u8)))
                        }
                        "eth_getBalance" => json!("0x5"),
                        "eth_getTransactionCount" => json!("0x1"),
                        "eth_getCode" => json!(crate::check::hexutil::to_hex(&self.code)),
                        _ => Value::Null,
                    })
                })
                .collect())
        }
    }

    fn fake(fail: bool, code: &[u8]) -> Box<dyn NodeApi> {
        Box::new(Fake { fail, code: code.to_vec(), calls: Mutex::new(0) })
    }

    #[test]
    fn free_node_first_paid_only_for_the_rest_within_caps() {
        let a = Address::with_last_byte(7);
        let snap = Snapshot::default();
        // Free node answers: paid node never asked.
        let mut f = ReplayFetcher::new(Some(fake(false, &[0x00])), Some(fake(false, &[0x00])), FetchOpts { max_calls: 10, max_paid: 10, ..Default::default() });
        let got = f.fetch(100, &[MissItem::Slot(a, U256::from(1u8)), MissItem::Account(a)], &snap);
        assert_eq!(got.len(), 2);
        assert_eq!((f.calls_public, f.calls_paid), (4, 0));
        // Cached per block: no new calls; another block asks again.
        f.fetch(100, &[MissItem::Slot(a, U256::from(1u8))], &snap);
        assert_eq!(f.calls(), 4);
        f.fetch(101, &[MissItem::Slot(a, U256::from(1u8))], &snap);
        assert_eq!(f.calls(), 5);
        // Hard cap: 5 used of 10, an account (3) fits, a second one doesn't.
        let b = Address::with_last_byte(8);
        let c = Address::with_last_byte(9);
        let got = f.fetch(100, &[MissItem::Account(b), MissItem::Account(c)], &snap);
        assert_eq!(got.len(), 1);
        assert_eq!((f.calls(), f.items_capped), (8, 1));
        // Free node can't (old state): paid node answers, counted apart.
        let mut g = ReplayFetcher::new(Some(fake(true, &[])), Some(fake(false, &[0x00])), FetchOpts { max_calls: 10, max_paid: 2, ..Default::default() });
        let got = g.fetch(100, &[MissItem::Slot(a, U256::from(1u8)), MissItem::Slot(a, U256::from(2u8)), MissItem::Slot(a, U256::from(3u8))], &snap);
        assert_eq!(got.len(), 2, "paid cap 2");
        assert_eq!((g.calls_public, g.calls_paid, g.items_capped), (3, 2, 1));
        // The node's error text never carries its link.
        let j = g.json().to_string();
        assert!(!j.contains("secret.example"), "{j}");
        // Paid off.
        let mut h = ReplayFetcher::new(Some(fake(true, &[])), Some(fake(false, &[0x00])), FetchOpts { max_paid: 0, ..Default::default() });
        assert!(h.fetch(100, &[MissItem::Slot(a, U256::from(1u8))], &snap).is_empty());
        assert_eq!((h.calls_paid, h.items_failed), (0, 1));
    }

    #[test]
    fn overlay_values_are_exact_and_target_code_verdicts() {
        let a = Address::repeat_byte(0x42);
        let mut o = Overlay::new(1, Arc::new(Snapshot::default()));
        // SSTORE-only contract: PUSH1 1 PUSH1 0 SSTORE STOP.
        let self_only = vec![0x60, 0x01, 0x60, 0x00, 0x55, 0x00];
        o.add(&[Fetched::Slot(a, U256::from(3u8), U256::from(9u8)), Fetched::Account(a, Some(crate::node::FetchedAccount { balance: U256::from(1u8), nonce: 1, code: self_only.clone().into() }))]);
        assert!(matches!(o.snap.storage(a, U256::from(3u8)), Lookup::Known(v) if v == U256::from(9u8)));
        let p = OverlayProv { inner: &crate::copy2::ahead_capture::ProvSets::default(), o: &o };
        assert!(p.slot_exact(a, U256::from(3u8)) && p.balance_exact(a) && !p.slot_exact(a, U256::from(4u8)));
        let view = crate::state::snap::View::new(o.snap.clone());
        assert_eq!(target_code(&view, a), TargetCode::SelfOnly);
        assert_eq!(target_code(&view, Address::repeat_byte(0x43)), TargetCode::NotHeld);
        assert_eq!(target_code(&view, Address::with_last_byte(0x64)), TargetCode::Builtin);
        // A PUSH whose data merely contains 0xf1 is still self-only; a real CALL isn't.
        let mut s = (*o.snap).clone();
        let caller = Address::repeat_byte(0x44);
        let call_code = vec![0x60, 0xf1, 0x50, 0xf1, 0x00];
        let info = AccountInfo { balance: U256::ZERO, nonce: 1, code_hash: revm::primitives::keccak256(&call_code), code: None, ..Default::default() };
        s.apply_fact(&Fact::Basics { addr: caller, info: Some(info), code: Some(Bytecode::new_raw(call_code.into())) });
        let deleg = Address::repeat_byte(0x45);
        let d_code = [vec![0xef, 0x01, 0x00], vec![0x11; 20]].concat();
        let info = AccountInfo { balance: U256::ZERO, nonce: 1, code_hash: revm::primitives::keccak256(&d_code), code: None, ..Default::default() };
        s.apply_fact(&Fact::Basics { addr: deleg, info: Some(info), code: Some(Bytecode::new_raw(d_code.into())) });
        let view = crate::state::snap::View::new(Arc::new(s));
        assert_eq!(target_code(&view, caller), TargetCode::CallsOut);
        assert_eq!(target_code(&view, deleg), TargetCode::Delegated);
        // proven_untouching: self-only and not ours; never for type 4 or ours.
        let mut d = DecodedTx { tx_type: 2, hash: Default::default(), from: Address::with_last_byte(1), to: Some(a), value: U256::ZERO, data: Default::default(), gas: 0, nonce: 0, chain_id: None, access_list: vec![], auth: vec![] };
        assert!(proven_untouching(&view, &d, &|_| false));
        assert!(!proven_untouching(&view, &d, &|x| x == a));
        d.tx_type = 4;
        assert!(!proven_untouching(&view, &d, &|_| false));
        d.tx_type = 2;
        d.to = Some(caller);
        assert!(!proven_untouching(&view, &d, &|_| false));
    }
}

/// The item a fetched value answers.
pub fn item_of(f: &Fetched) -> MissItem {
    match f {
        Fetched::Slot(a, s, _) => MissItem::Slot(*a, *s),
        Fetched::Account(a, _) => MissItem::Account(*a),
    }
}

/// The contract an item belongs to.
pub fn owner_of(m: &MissItem) -> Option<Address> {
    match m {
        MissItem::Slot(a, _) | MissItem::Account(a) => Some(*a),
        MissItem::Code(_) => None,
    }
}

/// A fetched value, as text (equal text = equal value).
pub fn value_text(f: &Fetched) -> String {
    match f {
        Fetched::Slot(_, _, v) => format!("{v:#x}"),
        Fetched::Account(_, None) => "empty".into(),
        Fetched::Account(_, Some(a)) => format!("bal {:#x} nonce {} code {:#x}", a.balance, a.nonce, revm::primitives::keccak256(&a.code)),
    }
}

/// The calls one item costs (see calls_for).
pub fn item_calls(m: &MissItem) -> u64 {
    calls_for(m)
}
