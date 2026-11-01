// ============================================================================
// FAST LANE A: THE KEEPER, OFFLINE (`arbsim ahead-replay <capture> --keeper
// <truth file>`, Oct 31).
//
// Plain English:
//   The live keeper (copy2/keeper.rs) reads values from the node once and
//   then follows every block's changes. To measure what it would have done
//   on an OLD capture, we need the chain's values back then; the node no
//   longer answers eth_getProof that far back (its old state is pruned),
//   but it can still RE-RUN old blocks. So a small server script records,
//   for every block of the capture:
//     - "diff": what each transaction changed (prestate tracer, diff mode:
//       exactly what the live keeper fetches every block), and
//     - "pre":  every value each transaction READ, as it was before it ran
//       (prestate tracer, normal mode), with contract code moved to one
//       shared table.
//   From these two, the value of any slot / account that the capture's
//   blocks touched is known at any block of the capture (the TRUTH):
//     - after the last change at or before block H, it is that change's
//       new value;
//     - with no change at or before H, it is whatever the next read or
//       change after H saw "before".
//   A value the capture never touched is unknown (never guessed).
//
//   The replay then runs the REAL keeper core (KeeperCore) next to the
//   predicted copy:
//     - every copy-2 version of block N: the keeper first applies the
//       recorded diffs of every block up to N (the live fetch), then
//       answers the waiting seeds from the truth at N (the live
//       eth_getProof at its head), then hands its version to the predicted
//       copy, which merges it (exactly as live);
//     - after every block, EVERY value the keeper holds is checked against
//       the truth (the live audit, on everything): this proves the diff
//       apply on real chain data.
//   Seeds are paced like live (no limit there: about 2 per block, the time
//   left between block diffs; `--keep-seeds-per-h N` models an hourly
//   limit instead), so a cold start is cold. `--keeper-warm`
//   first runs the capture once to learn which contracts are hot, then
//   starts the measured run with those already seeded (a keeper that has
//   been running for a while; an upper bound, said so in the report).
// ============================================================================
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use revm::primitives::{keccak256, Address, B256, KECCAK_EMPTY, U256};
use revm::state::{AccountInfo, Bytecode};
use serde_json::{json, Value};

use super::ahead::Ahead;
use super::keeper::{KeeperCfg, KeeperCore, SeedAnswer};
use crate::check::hexutil::{parse_address, parse_bytes, parse_u256, parse_u64};
use crate::state::snap::{normalize, Basics};
use crate::state::{MissItem, StateDiff};

/// One event in a value's life inside the capture: a read (its value
/// before transaction `tx` of `block`) or a change (old and new value).
#[derive(Clone, Copy, Debug)]
enum SlotEv {
    Read(U256),
    Write(U256, U256),
}

/// Basics events: (balance, nonce) read before / changed by a transaction.
#[derive(Clone, Copy, Debug)]
enum AcctEv {
    Read(U256, u64),
    Write(U256, u64),
}

/// The chain's values over the capture (see the file header).
#[derive(Default)]
pub struct Truth {
    /// Per block, each transaction's change (what the live keeper fetches).
    pub blocks: BTreeMap<u64, Vec<StateDiff>>,
    slots: HashMap<(Address, U256), Vec<(u64, u32, u8, SlotEv)>>,
    accts: HashMap<Address, Vec<(u64, u32, u8, AcctEv)>>,
    /// Accounts destroyed (or wiped without a creation) inside the capture:
    /// values not derived (left unknown, never guessed).
    unreliable: HashSet<Address>,
    /// Accounts CREATED inside the capture (block, tx): every slot starts
    /// at zero there, and each one's later values follow from the changes
    /// (a new token launched and traded seconds later). Their values before
    /// the creation are left unknown.
    created: HashMap<Address, (u64, u32)>,
    code_of: HashMap<Address, B256>,
    codes: HashMap<B256, Bytecode>,
    /// ORACLE (diagnostics only, see `Oracle`): where each transaction sits
    /// in its block, and back.
    tx_pos: HashMap<B256, (u64, u32)>,
    tx_at: HashMap<(u64, u32), B256>,
    /// Transactions that changed any storage (a reverted one changes only
    /// the sender's / fee accounts' balances and nonce).
    tx_wrote: HashSet<B256>,
    /// Every value each transaction read, as it was before it ran.
    pre: HashMap<(u64, u32), Vec<PreAcct>>,
}

/// One account as a transaction saw it before it ran (prestate tracer).
#[derive(Clone, Debug)]
pub struct PreAcct {
    pub addr: Address,
    pub balance: U256,
    pub nonce: u64,
    pub storage: Vec<(U256, U256)>,
}

impl Truth {
    /// Read the truth file (JSON lines, see the file header).
    pub fn load(path: &str) -> Result<Truth, String> {
        let txt = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
        let mut t = Truth::default();
        let mut code_ids: HashMap<String, B256> = HashMap::new();
        let mut pending_code: Vec<(Address, String)> = Vec::new();
        for (n, line) in txt.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let v: Value = serde_json::from_str(line).map_err(|e| format!("line {}: {e}", n + 1))?;
            if let Some(tbl) = v.get("codes").and_then(|x| x.as_object()) {
                for (id, c) in tbl {
                    let b = parse_bytes(c.as_str().ok_or("code not text")?)?;
                    let h = keccak256(&b);
                    t.codes.insert(h, Bytecode::new_raw(b));
                    code_ids.insert(id.clone(), h);
                }
                continue;
            }
            let b = v.get("b").and_then(|x| x.as_u64()).ok_or(format!("line {}: no block", n + 1))?;
            let diffs = crate::state::diff::parse_block_trace(v.get("diff").ok_or("no diff")?).map_err(|e| format!("block {b}: {e}"))?;
            for (i, d) in diffs.iter().enumerate() {
                if let Some(h) = d.tx_hash {
                    t.tx_pos.insert(h, (b, i as u32));
                    t.tx_at.insert((b, i as u32), h);
                    // ArbOS's own state is written by every transaction
                    // (gas pricing), reverted or not: not counted.
                    let arbos = super::keeper::arbos_state();
                    if d.diff.accounts.iter().any(|(a, ad)| *a != arbos && (!ad.storage.is_empty() || ad.storage_cleared)) {
                        t.tx_wrote.insert(h);
                    }
                }
            }
            // Changes: one Write per changed slot / account.
            for (i, d) in diffs.iter().enumerate() {
                for (a, ad) in &d.diff.accounts {
                    if ad.storage_cleared {
                        match &ad.info {
                            // Created here: its storage starts empty.
                            Some(Some(_)) if !t.created.contains_key(a) => {
                                t.created.insert(*a, (b, i as u32));
                            }
                            _ => {
                                t.unreliable.insert(*a);
                            }
                        }
                    }
                    let pre = d.pre_storage.get(a);
                    for (s, new) in &ad.storage {
                        let old = pre.and_then(|p| p.get(s)).copied().unwrap_or(U256::ZERO);
                        t.slots.entry((*a, *s)).or_default().push((b, i as u32, 1, SlotEv::Write(old, *new)));
                    }
                    match &ad.info {
                        Some(Some(info)) => t.accts.entry(*a).or_default().push((b, i as u32, 1, AcctEv::Write(info.balance, info.nonce))),
                        Some(None) => {
                            t.unreliable.insert(*a);
                        }
                        None => {}
                    }
                }
            }
            // Reads: every value each transaction saw before it ran.
            for (i, e) in v.get("pre").and_then(|x| x.as_array()).ok_or("no pre")?.iter().enumerate() {
                let r = e.get("result").unwrap_or(e);
                let Some(o) = r.as_object() else { continue };
                for (a_s, x) in o {
                    let a = parse_address(a_s)?;
                    let bal = x.get("balance").and_then(|y| y.as_str()).map(parse_u256).transpose()?.unwrap_or(U256::ZERO);
                    let nonce = match x.get("nonce") {
                        Some(Value::Number(k)) => k.as_u64().unwrap_or(0),
                        Some(Value::String(k)) => parse_u64(k)?,
                        _ => 0,
                    };
                    t.accts.entry(a).or_default().push((b, i as u32, 0, AcctEv::Read(bal, nonce)));
                    let mut pa = PreAcct { addr: a, balance: bal, nonce, storage: Vec::new() };
                    if let Some(id) = x.get("codeId") {
                        pending_code.push((a, id.to_string().trim_matches('"').to_string()));
                    } else {
                        t.code_of.entry(a).or_insert(KECCAK_EMPTY);
                    }
                    if let Some(st) = x.get("storage").and_then(|y| y.as_object()) {
                        for (k, val) in st {
                            let s = parse_u256(k)?;
                            let val = parse_u256(val.as_str().ok_or("storage value not text")?)?;
                            t.slots.entry((a, s)).or_default().push((b, i as u32, 0, SlotEv::Read(val)));
                            pa.storage.push((s, val));
                        }
                    }
                    t.pre.entry((b, i as u32)).or_default().push(pa);
                }
            }
            t.blocks.insert(b, diffs.into_iter().map(|d| d.diff).collect());
        }
        for (a, id) in pending_code {
            if let Some(h) = code_ids.get(&id) {
                t.code_of.insert(a, *h);
            }
        }
        for v in t.slots.values_mut() {
            v.sort_by_key(|x| (x.0, x.1, x.2));
        }
        for v in t.accts.values_mut() {
            v.sort_by_key(|x| (x.0, x.1, x.2));
        }
        Ok(t)
    }

    /// The value of (a, s) after block `h` (None = not known from the capture).
    pub fn slot_at(&self, a: &Address, s: &U256, h: u64) -> Option<U256> {
        if self.unreliable.contains(a) {
            return None;
        }
        if let Some((cb, _)) = self.created.get(a) {
            // Created inside the capture: the last change at or before h,
            // else zero from the creation on (unknown before it).
            let ev = self.slots.get(&(*a, *s));
            let last = ev.and_then(|ev| ev[..ev.partition_point(|x| x.0 <= h)].iter().rev().find(|x| matches!(x.3, SlotEv::Write(..))));
            return match last {
                Some(x) => match x.3 {
                    SlotEv::Write(_, new) => Some(new),
                    SlotEv::Read(v) => Some(v),
                },
                None if h >= *cb => Some(U256::ZERO),
                None => None,
            };
        }
        let ev = self.slots.get(&(*a, *s))?;
        // Last event at or before the end of block h.
        let i = ev.partition_point(|x| x.0 <= h);
        if i > 0 {
            match ev[i - 1].3 {
                SlotEv::Write(_, new) => return Some(new),
                SlotEv::Read(v) => return Some(v),
            }
        }
        // Else the first event after h saw it "before".
        ev.first().map(|x| match x.3 {
            SlotEv::Write(old, _) => old,
            SlotEv::Read(v) => v,
        })
    }

    /// An account's basics after block `h` (Some(None) = does not exist).
    pub fn basics_at(&self, a: &Address, h: u64) -> Option<Option<AccountInfo>> {
        if self.unreliable.contains(a) {
            return None;
        }
        let ev = self.accts.get(a)?;
        let code_hash = *self.code_of.get(a)?;
        let i = ev.partition_point(|x| x.0 <= h);
        // Created inside the capture: unknown before its creation.
        if self.created.get(a).is_some_and(|(cb, _)| h < *cb) && i == 0 {
            return None;
        }
        let (bal, nonce) = if i > 0 {
            match ev[i - 1].3 {
                AcctEv::Write(b, n) | AcctEv::Read(b, n) => (b, n),
            }
        } else {
            match ev.first()?.3 {
                // A change's old basics aren't recorded: unknown.
                AcctEv::Write(..) => return None,
                AcctEv::Read(b, n) => (b, n),
            }
        };
        Some(normalize(Some(AccountInfo { balance: bal, nonce, code_hash, ..Default::default() })))
    }

    pub fn code(&self, h: &B256) -> Option<Bytecode> {
        self.codes.get(h).cloned()
    }

    /// ORACLE: (block, index) of a transaction in the recorded blocks.
    pub fn tx_pos(&self, h: &B256) -> Option<(u64, u32)> {
        self.tx_pos.get(h).copied()
    }

    /// ORACLE: the transaction at (block, index).
    pub fn tx_at(&self, b: u64, i: u32) -> Option<B256> {
        self.tx_at.get(&(b, i)).copied()
    }

    /// ORACLE: did the real transaction change any storage (= it did not
    /// revert; a reverted one only pays its fee)?
    pub fn wrote(&self, h: &B256) -> bool {
        self.tx_wrote.contains(h)
    }

    /// ORACLE: what the transaction at (block, index) read, before it ran.
    pub fn pre(&self, b: u64, i: u32) -> Option<&[PreAcct]> {
        self.pre.get(&(b, i)).map(|v| v.as_slice())
    }

    /// ORACLE: the exact state the transaction at (block, index) saw, as a
    /// change to lay over a copy (basics with code, every value read).
    pub fn pre_diff(&self, b: u64, i: u32) -> Option<StateDiff> {
        let mut d = StateDiff::default();
        for pa in self.pre(b, i)? {
            let code_hash = self.code_of.get(&pa.addr).copied().unwrap_or(KECCAK_EMPTY);
            let code = (code_hash != KECCAK_EMPTY).then(|| self.codes.get(&code_hash).cloned()).flatten();
            let info = normalize(Some(AccountInfo { balance: pa.balance, nonce: pa.nonce, code_hash, ..Default::default() }));
            d.accounts.insert(
                pa.addr,
                crate::state::AccountDiff { info: Some(info), code, storage: pa.storage.iter().copied().collect(), ..Default::default() },
            );
        }
        Some(d)
    }

    /// ORACLE: the last transaction that changed (a, s) after block
    /// `after_block` and before transaction `i` of block `b` (None = none).
    pub fn last_slot_writer(&self, a: &Address, s: &U256, after_block: u64, b: u64, i: u32) -> Option<(u64, u32)> {
        let ev = self.slots.get(&(*a, *s))?;
        ev.iter().rev().find(|x| matches!(x.3, SlotEv::Write(..)) && x.0 > after_block && (x.0, x.1) < (b, i)).map(|x| (x.0, x.1))
    }

    /// ORACLE: the same for an account's balance / nonce.
    pub fn last_basics_writer(&self, a: &Address, after_block: u64, b: u64, i: u32) -> Option<(u64, u32)> {
        let ev = self.accts.get(a)?;
        ev.iter().rev().find(|x| matches!(x.3, AcctEv::Write(..)) && x.0 > after_block && (x.0, x.1) < (b, i)).map(|x| (x.0, x.1))
    }
}

// ---------------------------------------------------------------------------
// ORACLE: why did our re-run revert? (offline diagnostics, `--oracle`)
// ---------------------------------------------------------------------------
//
// Plain English: the truth file also holds, for every real transaction,
// every value it read before it ran (its exact starting state) and whether
// it changed any storage (a reverted transaction changes none). So when our
// re-run of a feed transaction reverts, the replay asks:
//   1. Did the chain revert it too?        -> "chain reverted too"
//   2. Re-run it on the EXACT starting state (our copy with every value the
//      real one read laid over it). Succeeds? -> one of OUR values differs;
//      the first one is named: whose (target / sender / pool / coin / ...),
//      and why (an earlier transaction since the base changed it and we
//      skipped / failed / ran it, or our base value itself was wrong).
//   3. Still reverts on the exact state?   -> the block details / gas /
//      something outside state.
// Nothing here runs live.

/// The oracle's counts (see above).
pub struct Oracle {
    pub truth: Arc<Truth>,
    /// cause -> (runs, pools marked unsure by those runs)
    pub causes: BTreeMap<String, (u64, u64)>,
    pub samples: Vec<Value>,
    /// What the prediction did with each feed transaction (last time).
    pub fates: HashMap<B256, &'static str>,
    /// Transactions already explained (a rebuild re-runs the same ones:
    /// each is counted in `txs` once).
    seen: HashSet<B256>,
    /// cause -> distinct transactions
    pub txs: BTreeMap<String, u64>,
    /// Reverted runs split by what is known at prediction time (our revert
    /// reason, the assumptions our run made) against the chain's answer:
    /// "could a rule trust this revert?" (distinct transactions).
    pub split: BTreeMap<String, u64>,
}

/// One value our copy had different from the exact starting state.
struct Differ {
    addr: Address,
    slot: Option<U256>,
    ours: String,
    truth: String,
    /// The exact value (slot) / basics (balance, nonce).
    val: U256,
    nonce: u64,
}

/// What one exact-state check needs from the prediction (borrowed).
pub struct OracleCtx<'a> {
    pub ov: &'a super::overlay::Overlay,
    pub plan: &'a crate::check::ordered::OrderedPlan,
    pub prov: &'a dyn crate::check::ordered::Provenance,
    pub assume: &'a crate::check::ordered::Assume,
    pub t: &'a crate::check::rawtx::DecodedTx,
    /// L2 block of the prediction's base (values exact after it).
    pub base_block: u64,
    /// Names an address by its role (target / a pool / a coin / ...).
    pub role: &'a dyn Fn(&Address) -> &'static str,
    /// Where our base value came from (keeper / copy 2 exact / approximate).
    pub src: &'a dyn Fn(&Address, Option<&U256>) -> &'static str,
    /// Our pools a run moved (check/moved.rs rules).
    pub moved: &'a dyn Fn(&crate::check::ordered::OrderedOut) -> Vec<String>,
}

type RunRes = Result<crate::check::ordered::OrderedOut, crate::check::CheckUnknown>;

impl Oracle {
    pub fn new(truth: Arc<Truth>) -> Self {
        Oracle { truth, causes: BTreeMap::new(), samples: Vec::new(), fates: HashMap::new(), seen: HashSet::new(), txs: BTreeMap::new(), split: BTreeMap::new() }
    }

    /// Our values that differ from the exact starting state of the real
    /// transaction at (b, i) (only values we hold: a missing one is a miss).
    fn differs(&self, ov: &super::overlay::Overlay, b: u64, i: u32) -> Vec<Differ> {
        use crate::state::{Lookup, StateRead};
        let mut out = Vec::new();
        for pa in self.truth.pre(b, i).unwrap_or(&[]) {
            let basics = |ours: String| Differ { addr: pa.addr, slot: None, ours, truth: format!("bal {} nonce {}", pa.balance, pa.nonce), val: pa.balance, nonce: pa.nonce };
            match ov.account(pa.addr) {
                Lookup::Known(Some(info)) if info.balance != pa.balance || info.nonce != pa.nonce => out.push(basics(format!("bal {} nonce {}", info.balance, info.nonce))),
                Lookup::Known(None) if !pa.balance.is_zero() || pa.nonce > 0 => out.push(basics("none".into())),
                _ => {}
            }
            for (sl, v) in &pa.storage {
                if let Lookup::Known(x) = ov.storage(pa.addr, *sl) {
                    if x != *v {
                        out.push(Differ { addr: pa.addr, slot: Some(*sl), ours: format!("{x:#x}"), truth: format!("{v:#x}"), val: *v, nonce: 0 });
                    }
                }
            }
        }
        out
    }

    /// Run on our copy with `fix` corrected to the exact values.
    fn run_fixed(&self, c: &OracleCtx, fix: &[&Differ]) -> RunRes {
        let mut d = StateDiff::default();
        for x in fix {
            let e = d.accounts.entry(x.addr).or_default();
            match x.slot {
                Some(sl) => {
                    e.storage.insert(sl, x.val);
                }
                None => {
                    let code_hash = self.truth.code_of.get(&x.addr).copied().unwrap_or(KECCAK_EMPTY);
                    e.info = Some(normalize(Some(AccountInfo { balance: x.val, nonce: x.nonce, code_hash, ..Default::default() })));
                    e.code = (code_hash != KECCAK_EMPTY).then(|| self.truth.codes.get(&code_hash).cloned()).flatten();
                }
            }
        }
        let mut oo = c.ov.fork();
        oo.commit(&d);
        crate::check::ordered::run_ordered_keep(&oo, c.plan, c.prov, c.assume).map(|x| x.0)
    }

    /// Run on our copy with EVERY value the real transaction read laid over it.
    fn run_exact(&self, c: &OracleCtx, b: u64, i: u32) -> Option<RunRes> {
        let pre = self.truth.pre_diff(b, i)?;
        let mut oo = c.ov.fork();
        oo.commit(&pre);
        Some(crate::check::ordered::run_ordered_keep(&oo, c.plan, c.prov, c.assume).map(|x| x.0))
    }

    /// Which differing value turns our answer into the exact one (`good`)?
    /// Corrects one group at a time (other contracts' values, their
    /// balances / nonces, the sender's), then one value inside the group.
    /// Returns the cause in words and a sample.
    fn blame(&self, c: &OracleCtx, b: u64, i: u32, differs: &[Differ], good: &dyn Fn(&RunRes) -> bool) -> (String, Option<Value>) {
        let t = c.t;
        let groups: [(&str, Vec<&Differ>); 3] = [
            ("value", differs.iter().filter(|d| d.slot.is_some() && d.addr != t.from).collect()),
            ("balance/nonce", differs.iter().filter(|d| d.slot.is_none() && d.addr != t.from).collect()),
            ("sender", differs.iter().filter(|d| d.addr == t.from).collect()),
        ];
        let mut found: Option<&Differ> = None;
        let mut group_hit: Option<&str> = None;
        for (name, g) in &groups {
            if g.is_empty() || !good(&self.run_fixed(c, g)) {
                continue;
            }
            group_hit = Some(name);
            found = g.iter().take(16).find(|d| good(&self.run_fixed(c, &[**d]))).copied();
            break;
        }
        let Some(gname) = group_hit else {
            if differs.is_empty() {
                return ("no differing value found".to_string(), None);
            }
            // Two groups together?
            let list: Vec<Value> = differs
                .iter()
                .take(8)
                .map(|d| {
                    let since = match d.slot {
                        Some(sl) => self.truth.last_slot_writer(&d.addr, &sl, c.base_block, b, i),
                        None => self.truth.last_basics_writer(&d.addr, c.base_block, b, i),
                    };
                    let since = match since {
                        Some((wb, wi)) => format!("changed by a {} tx", self.truth.tx_at(wb, wi).and_then(|h| self.fates.get(&h).copied()).unwrap_or("unseen")),
                        None => format!("base: {}", (c.src)(&d.addr, d.slot.as_ref())),
                    };
                    // The truth's value right after the base block (debug).
                    let at_base = match d.slot {
                        Some(sl) => format!("{:?}", self.truth.slot_at(&d.addr, &sl, c.base_block)),
                        None => format!("{:?}", self.truth.basics_at(&d.addr, c.base_block).map(|o| o.map(|i| (i.balance, i.nonce)))),
                    };
                    let created = self.truth.created.get(&d.addr).map(|x| format!("{x:?}"));
                    json!({"who": if d.addr == t.from { "the sender" } else { (c.role)(&d.addr) }, "addr": format!("{:#x}", d.addr), "slot": d.slot.map(|x| format!("{x:#x}")), "ours": d.ours, "truth": d.truth, "since": since, "truthAtBase": at_base, "created": created, "txAt": format!("{b}/{i}"), "base": c.base_block})
                })
                .collect();
            let sample = json!({"tx": format!("{:#x}", t.hash), "to": t.to.map(|a| format!("{a:#x}")), "differs": list, "differing": differs.len()});
            for (x, y) in [(0usize, 1usize), (0, 2), (1, 2)] {
                let both: Vec<&Differ> = groups[x].1.iter().chain(groups[y].1.iter()).copied().collect();
                if !groups[x].1.is_empty() && !groups[y].1.is_empty() && good(&self.run_fixed(c, &both)) {
                    return (format!("{} + {} together", groups[x].0, groups[y].0), Some(sample));
                }
            }
            return ("all three groups together".to_string(), Some(sample));
        };
        let Some(d) = found else { return (format!("several {gname} values together"), None) };
        let who = if d.addr == t.from { "the sender" } else { (c.role)(&d.addr) };
        let what = if d.slot.is_some() { "value" } else { "balance/nonce" };
        let since = match d.slot {
            Some(sl) => self.truth.last_slot_writer(&d.addr, &sl, c.base_block, b, i),
            None => self.truth.last_basics_writer(&d.addr, c.base_block, b, i),
        };
        let why = match since {
            Some((wb, wi)) => {
                let fate = self.truth.tx_at(wb, wi).and_then(|h| self.fates.get(&h).copied()).unwrap_or("unseen");
                let same = if wb == b { "same block" } else { "earlier block" };
                format!("changed since the base by a {fate} tx ({same})")
            }
            None => format!("wrong at the base ({})", (c.src)(&d.addr, d.slot.as_ref())),
        };
        let sample = json!({"tx": format!("{:#x}", t.hash), "to": t.to.map(|a| format!("{a:#x}")),
            "first": {"addr": format!("{:#x}", d.addr), "slot": d.slot.map(|x| format!("{x:#x}")), "ours": d.ours, "truth": d.truth},
            "differing": differs.len()});
        (format!("{who} {what} {why}"), Some(sample))
    }

    /// Count one explained case (`kind`: reverted / ran / failed).
    fn note(&mut self, kind: &str, t: &crate::check::rawtx::DecodedTx, cause: (String, Option<Value>), pools: u64, extra: Value) -> String {
        let key = format!("{kind}: {}", cause.0);
        let e = self.causes.entry(key.clone()).or_default();
        e.0 += 1;
        e.1 += pools;
        let first = self.seen.insert(t.hash);
        if first {
            *self.txs.entry(key.clone()).or_default() += 1;
            if self.samples.len() < 3000 {
                let mut sm = cause.1.unwrap_or_else(|| json!({"tx": format!("{:#x}", t.hash), "to": t.to.map(|a| format!("{a:#x}"))}));
                sm["cause"] = json!(key);
                if let (Some(o), Some(x)) = (sm.as_object_mut(), extra.as_object()) {
                    for (k, v) in x {
                        o.insert(k.clone(), v.clone());
                    }
                }
                self.samples.push(sm);
            }
        }
        key
    }

    /// Our run of `c.t` REVERTED: why (see the section header)?
    pub fn revert_cause(&mut self, c: &OracleCtx, our_why: &str, assumed: &str, pools_hit: u64) -> String {
        let t = c.t;
        let extra = json!({"ourWhy": our_why, "assumed": assumed});
        if !self.seen.contains(&t.hash) {
            let chain = match self.truth.tx_pos(&t.hash) {
                None => "?",
                Some(_) if self.truth.wrote(&t.hash) => "chain OK",
                Some(_) => "chain REVERTED",
            };
            let w: String = our_why.chars().take(40).collect();
            *self.split.entry(format!("{chain} | assumed [{assumed}] | {w}")).or_default() += 1;
        }
        let Some((b, i)) = self.truth.tx_pos(&t.hash) else { return self.note("reverted", t, ("not in the recorded blocks".into(), None), pools_hit, extra) };
        if !self.truth.wrote(&t.hash) {
            return self.note("reverted", t, ("chain reverted too".into(), None), pools_hit, extra);
        }
        let differs = self.differs(c.ov, b, i);
        let ok = |r: &RunRes| matches!(r, Ok(o) if o.replayed.first().is_some_and(|x| x.outcome.success));
        let cause = match self.run_exact(c, b, i) {
            Some(r) if ok(&r) => {
                let (w, s) = self.blame(c, b, i, &differs, &ok);
                (format!("chain ok; exact state ok; {w}"), s)
            }
            Some(Ok(o)) => {
                let w = o.replayed.first().map(|r| super::ahead::revert_text(&r.outcome)).unwrap_or_default();
                ("chain ok; exact state reverts too (block details / gas / outside state)".to_string(), Some(json!({"exactWhy": w, "differing": differs.len()})))
            }
            Some(Err(u)) => (format!("chain ok; exact state can't run ({})", u.reason.as_str()), None),
            None => ("no recorded starting state".to_string(), None),
        };
        self.note("reverted", t, cause, pools_hit, extra)
    }

    /// Our run of `c.t` finished and moved `ours`: does the exact run move
    /// the same pools? If not, which of our values made the difference?
    pub fn ran_check(&mut self, c: &OracleCtx, ours: &[String]) {
        let t = c.t;
        let Some((b, i)) = self.truth.tx_pos(&t.hash) else { return };
        let Some(Ok(o)) = self.run_exact(c, b, i) else { return };
        let mut want = (c.moved)(&o);
        let mut have = ours.to_vec();
        want.sort();
        have.sort();
        if want == have {
            return;
        }
        let differs = self.differs(c.ov, b, i);
        let good = |r: &RunRes| match r {
            Ok(x) => {
                let mut m = (c.moved)(x);
                m.sort();
                m == want
            }
            Err(_) => false,
        };
        let (w, s) = self.blame(c, b, i, &differs, &good);
        let missing: Vec<&String> = want.iter().filter(|k| !have.contains(k)).collect();
        let kind = if missing.is_empty() { "ran (moved extra pools)" } else { "ran (missed pools it moves)" };
        self.note(kind, t, (w, s), missing.len() as u64, json!({"missing": missing, "exactMoved": want, "ourMoved": have}));
    }

    /// Our run of `c.t` could not run (`why`) and we marked `hit` unsure:
    /// does the exact run move a pool we did NOT mark?
    pub fn failed_check(&mut self, c: &OracleCtx, why: &str, hit: &[String]) {
        let t = c.t;
        let Some((b, i)) = self.truth.tx_pos(&t.hash) else { return };
        let Some(Ok(o)) = self.run_exact(c, b, i) else { return };
        let want = (c.moved)(&o);
        let missing: Vec<&String> = want.iter().filter(|k| !hit.contains(k)).collect();
        if missing.is_empty() {
            return;
        }
        let w = format!("guess missed {} pool(s); {}", if hit.is_empty() { "all" } else { "some" }, why);
        self.note("failed", t, (w, None), missing.len() as u64, json!({"missing": missing, "exactMoved": want, "guessed": hit}));
    }

    /// The revert split, most common first.
    fn split_top(&self, n: usize) -> Vec<Value> {
        let mut v: Vec<(&String, &u64)> = self.split.iter().collect();
        v.sort_by(|a, b| b.1.cmp(a.1));
        v.into_iter().take(n).map(|(k, c)| json!({"what": k, "txs": c})).collect()
    }

    pub fn report(&self) -> Value {
        let mut v: Vec<(&String, &(u64, u64))> = self.causes.iter().collect();
        v.sort_by(|a, b| b.1 .1.cmp(&a.1 .1).then(b.1 .0.cmp(&a.1 .0)));
        json!({
            "revertCauses": v.into_iter().map(|(k, (r, p))| json!({"what": k, "runs": r, "pools": p, "txs": self.txs.get(k).copied().unwrap_or(0)})).collect::<Vec<_>>(),
            "revertSplit": self.split_top(60),
            "samples": self.samples,
        })
    }
}

/// The keeper as the replay runs it (see the file header).
pub struct ReplayKeeper {
    pub truth: Arc<Truth>,
    pub core: KeeperCore,
    /// Node calls the live keeper would have made: block diffs / seeds.
    pub diff_calls: u64,
    pub seed_calls: u64,
    pub seed_unknown: u64,
    pub missing_blocks: u64,
    /// Audit of EVERY held value after every block, against the truth.
    pub audit_ok: u64,
    pub audit_bad: u64,
    pub audit_unknown: u64,
    pub audit_samples: Vec<Value>,
    pub first_block: Option<u64>,
    pub last_block: u64,
    /// Seed calls allowed so far (live pace, or `--keep-seeds-per-h` scaled
    /// to the capture's blocks; `blocks_per_s` from the feed's timestamps).
    pub blocks_per_s: f64,
    pub apply_us: Vec<u64>,
    /// Every batch learned in this run, in order (the warm start replays
    /// them into the next run's keeper, so the scores come out the same).
    pub learned_all: Vec<Vec<MissItem>>,
}

impl ReplayKeeper {
    pub fn new(truth: Arc<Truth>, cfg: KeeperCfg) -> Self {
        ReplayKeeper {
            truth,
            core: KeeperCore::new(cfg),
            diff_calls: 0,
            seed_calls: 0,
            seed_unknown: 0,
            missing_blocks: 0,
            audit_ok: 0,
            audit_bad: 0,
            audit_unknown: 0,
            audit_samples: Vec::new(),
            first_block: None,
            last_block: 0,
            blocks_per_s: 9.3,
            apply_us: Vec::new(),
            learned_all: Vec::new(),
        }
    }

    /// Seeds still allowed (hourly limit, scaled to the blocks so far).
    fn seeds_allowed(&self) -> u64 {
        let span = self.last_block.saturating_sub(self.first_block.unwrap_or(self.last_block)) as f64 / self.blocks_per_s.max(0.1);
        // At least one hour's worth at the start would be live's first hour:
        // the limit grows with time, never all at once.
        if self.core.cfg.seeds_per_hour == 0 {
            // No limit (live): seeds are paced only by the node's answer
            // time while the keeper is caught up. One block every ~107 ms,
            // its diff takes ~31 ms, a seed ~35 ms: about 2 seeds a block.
            let blocks = self.last_block.saturating_sub(self.first_block.unwrap_or(self.last_block));
            return 2 * blocks + 2;
        }
        ((self.core.cfg.seeds_per_hour as f64) * (span / 3600.0)).ceil() as u64 + 1
    }

    /// Learn, follow the blocks up to `block`, answer seeds, audit; then
    /// hand the version of `block` to the predicted copy. `unlimited`
    /// answers every seed at once (the warm start).
    pub fn advance(&mut self, block: u64, a: &mut Ahead, unlimited: bool) {
        let learned = std::mem::take(&mut a.learned);
        if let Some(v) = self.advance_to(block, &learned, unlimited) {
            a.on_kept(v);
        }
    }

    /// The same without a predicted copy (trig-replay --keeper): learn
    /// `learned`, follow the blocks up to `block`, answer seeds, audit, and
    /// return the keeper's version of exactly `block` (None = not held).
    pub fn advance_to(&mut self, block: u64, learned: &[MissItem], unlimited: bool) -> Option<Arc<super::keeper::KeptVersion>> {
        if !learned.is_empty() {
            self.learned_all.push(learned.to_vec());
        }
        self.core.learn(learned);
        self.first_block.get_or_insert(block);
        self.last_block = self.last_block.max(block);
        match self.core.head() {
            None => self.core.start_at(block),
            Some(h) if block < h => {
                self.core.reset(block, "copy2_backwards");
            }
            _ => {}
        }
        while let Some(h) = self.core.head().filter(|h| *h < block) {
            let Some(txs) = self.truth.blocks.get(&(h + 1)) else {
                self.missing_blocks += 1;
                self.core.reset(block, "missing_block");
                break;
            };
            self.diff_calls += 1;
            let t0 = Instant::now();
            let _ = self.core.apply_block(h + 1, txs);
            self.apply_us.push(t0.elapsed().as_micros() as u64);
            self.audit(h + 1);
        }
        let head = self.core.head().unwrap_or(block);
        while unlimited || self.seed_calls < self.seeds_allowed() {
            let Some(job) = self.core.take_job() else { break };
            self.seed_calls += 1;
            let mut slots = Vec::new();
            for s in &job.slots {
                match self.truth.slot_at(&job.addr, s, head) {
                    Some(v) => slots.push((*s, v)),
                    None => self.seed_unknown += 1,
                }
            }
            let basics = if job.basics {
                let b = self.truth.basics_at(&job.addr, head);
                if b.is_none() {
                    self.seed_unknown += 1;
                }
                b
            } else {
                None
            };
            let code = basics.as_ref().and_then(|b| b.as_ref()).and_then(|i| self.truth.code(&i.code_hash));
            let ans = SeedAnswer { addr: job.addr, at: head, basics, code, slots };
            self.core.on_seed(&job, Some(ans));
        }
        self.core.version_at(block)
    }

    /// Every held value against the truth after block `h`.
    fn audit(&mut self, h: u64) {
        let Some(v) = self.core.version_at(h) else { return };
        for (a, acct) in v.accounts.iter() {
            for (s, val) in acct.storage.iter() {
                match self.truth.slot_at(a, s, h) {
                    Some(t) if t == *val => self.audit_ok += 1,
                    Some(t) => {
                        self.audit_bad += 1;
                        if self.audit_samples.len() < 10 {
                            self.audit_samples.push(json!({"block": h, "contract": format!("{a:#x}"), "slot": format!("{s:#x}"), "ours": format!("{val:#x}"), "truth": format!("{t:#x}")}));
                        }
                    }
                    None => self.audit_unknown += 1,
                }
            }
            if let Basics::Known(b) = &acct.basics {
                match self.truth.basics_at(a, h) {
                    Some(t) => {
                        let same = match (&t, b) {
                            (None, None) => true,
                            (Some(x), Some(y)) => x.balance == y.balance && x.nonce == y.nonce,
                            _ => false,
                        };
                        if same {
                            self.audit_ok += 1;
                        } else {
                            self.audit_bad += 1;
                            if self.audit_samples.len() < 10 {
                                self.audit_samples.push(json!({"block": h, "contract": format!("{a:#x}"), "basics": "differ"}));
                            }
                        }
                    }
                    None => self.audit_unknown += 1,
                }
            }
        }
    }

    pub fn report(&self) -> Value {
        let mut t = self.apply_us.clone();
        let blocks = self.last_block.saturating_sub(self.first_block.unwrap_or(self.last_block)).max(1);
        let secs = blocks as f64 / self.blocks_per_s.max(0.1);
        let (held, accts, vals) = self.core.held_counts();
        json!({
            "blocksFollowed": self.diff_calls, "missingBlocks": self.missing_blocks,
            "calls": {"diffs": self.diff_calls, "seeds": self.seed_calls,
                "perS": ((self.diff_calls + self.seed_calls) as f64 / secs * 100.0).round() / 100.0,
                "diffsPerS": (self.diff_calls as f64 / secs * 100.0).round() / 100.0},
            "seedValuesUnknown": self.seed_unknown,
            "held": {"contracts": held, "accounts": accts, "values": vals},
            "audit": {"ok": self.audit_ok, "bad": self.audit_bad, "unknown": self.audit_unknown, "samples": self.audit_samples},
            "applyUsThisMachine": crate::timing::pct_of(&mut t),
            "core": self.core.stats.json(),
        })
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    fn a(n: u64) -> Address {
        Address::from_word(B256::from(U256::from(n).to_be_bytes::<32>()))
    }

    /// The truth: last change at or before H, else what the next event saw.
    #[test]
    fn truth_values_over_time() {
        let dir = std::env::temp_dir().join(format!("keeper-truth-{}", std::process::id()));
        let addr = format!("{:#x}", a(0x77777));
        let line = |b: u64, diff: Value, pre: Value| json!({"b": b, "diff": diff, "pre": pre}).to_string();
        let txt = [
            // Block 10: tx 0 reads slot 1 = 5.
            line(10, json!([{"result": {"pre": {}, "post": {}}}]), json!([{"result": {addr.clone(): {"balance": "0x1", "nonce": 1, "storage": {"0x1": "0x5"}}}}])),
            // Block 12: tx 0 changes slot 1 from 5 to 9.
            line(12, json!([{"result": {"pre": {addr.clone(): {"balance": "0x1", "nonce": 1, "storage": {"0x1": "0x5"}}}, "post": {addr.clone(): {"storage": {"0x1": "0x9"}}}}}]),
                json!([{"result": {addr.clone(): {"balance": "0x1", "nonce": 1, "storage": {"0x1": "0x5"}}}}])),
        ]
        .join("\n");
        std::fs::write(&dir, txt).unwrap();
        let t = Truth::load(dir.to_str().unwrap()).unwrap();
        let one = U256::from(1u64);
        assert_eq!(t.slot_at(&a(0x77777), &one, 9), Some(U256::from(5u64)), "before any event: what the first one saw");
        assert_eq!(t.slot_at(&a(0x77777), &one, 11), Some(U256::from(5u64)));
        assert_eq!(t.slot_at(&a(0x77777), &one, 12), Some(U256::from(9u64)), "after the change");
        assert_eq!(t.slot_at(&a(0x77777), &one, 99), Some(U256::from(9u64)));
        assert_eq!(t.slot_at(&a(0x77777), &U256::from(2u64), 12), None, "never touched: unknown");
        assert_eq!(t.basics_at(&a(0x77777), 12).unwrap().unwrap().balance, one);
        // The keeper core on the same blocks agrees with the truth.
        let mut k = KeeperCore::new(KeeperCfg { on: true, ..KeeperCfg::default() });
        k.start_at(10);
        k.learn(&[MissItem::Slot(a(0x77777), one)]);
        let j = k.take_job().unwrap();
        k.on_seed(&j, Some(SeedAnswer { addr: a(0x77777), at: 10, basics: None, code: None, slots: vec![(one, t.slot_at(&a(0x77777), &one, 10).unwrap())] }));
        for b in 11..=12 {
            let txs = t.blocks.get(&b).cloned().unwrap_or_default();
            k.apply_block(b, &txs).unwrap();
        }
        assert_eq!(k.account(&a(0x77777)).unwrap().storage.get(&one), Some(&U256::from(9u64)));
        let _ = std::fs::remove_file(&dir);
    }

    /// ahead3: an account CREATED inside the capture: zero from its creation
    /// on (unless written), unknown before it; a transaction that only
    /// touched ArbOS's own state counts as "changed no storage" (reverted).
    #[test]
    fn created_accounts_and_reverted_transactions() {
        let dir = std::env::temp_dir().join(format!("keeper-truth-created-{}", std::process::id()));
        let new = format!("{:#x}", a(0x88888));
        let arbos = format!("{:#x}", crate::copy2::keeper::arbos_state());
        let txt = [
            // Block 20, tx 0x01: creates 0x88888 (no pre entry) writing slot 5 = 3.
            json!({"b": 20, "diff": [{"txHash": format!("{:#066x}", 1), "result": {"pre": {}, "post": {new.clone(): {"nonce": 1, "storage": {"0x5": "0x3"}}}}}], "pre": [{"result": {}}]}).to_string(),
            // Block 21, tx 0x02: touches only ArbOS's state (a reverted tx).
            json!({"b": 21, "diff": [{"txHash": format!("{:#066x}", 2), "result": {"pre": {arbos.clone(): {"storage": {"0x1": "0x1"}}}, "post": {arbos.clone(): {"storage": {"0x1": "0x2"}}}}}], "pre": [{"result": {}}]}).to_string(),
        ]
        .join("\n");
        std::fs::write(&dir, txt).unwrap();
        let t = Truth::load(dir.to_str().unwrap()).unwrap();
        assert_eq!(t.slot_at(&a(0x88888), &U256::from(5u64), 20), Some(U256::from(3u64)));
        assert_eq!(t.slot_at(&a(0x88888), &U256::from(6u64), 21), Some(U256::ZERO), "never written since its creation: zero");
        assert_eq!(t.slot_at(&a(0x88888), &U256::from(6u64), 19), None, "before its creation: unknown");
        let h = |n: u64| B256::from(U256::from(n).to_be_bytes::<32>());
        assert!(t.wrote(&h(1)), "the creation wrote storage");
        assert!(!t.wrote(&h(2)), "ArbOS's own writes don't count");
        assert_eq!(t.tx_pos(&h(2)), Some((21, 0)));
        let _ = std::fs::remove_file(&dir);
    }
}

// ---------------------------------------------------------------------------
// LIVE-TIMING NODE MODEL (`ahead-replay --live-timing`, Oct 31 night)
// ---------------------------------------------------------------------------

/// The node as the live keeper sees it, built from the recorded truth:
///   - every answer takes a real wait (latency drawn around a median and a
///     90th percentile, like the paid node's measured answer times),
///   - a block exists on the node only once the feed has announced it and
///     `node_lag` has passed (a block asked for earlier is "not there yet"),
///   - seeds / audits answer the recorded values at the asked block
///     (unknown recorded basics = an error, never a guess),
///   - copy 2's head and the feed's head are set by the replay as it goes.
/// So the keeper's REAL runtime (`keeper::drive`) runs against it in real
/// time, with the same threads and the same pacing as live.
pub struct TruthIo {
    pub truth: Arc<Truth>,
    /// Median / 90th percentile answer time.
    pub p50: Duration,
    pub p90: Duration,
    /// How long after the feed announced a block the node has it.
    pub node_lag: Duration,
    copy2: std::sync::atomic::AtomicU64,
    feed: std::sync::atomic::AtomicU64,
    announced: Mutex<HashMap<u64, Instant>>,
    rng: Mutex<u64>,
    /// Calls answered (blocks, proofs) and "not there yet".
    pub calls: std::sync::atomic::AtomicU64,
    pub not_yet: std::sync::atomic::AtomicU64,
}

impl TruthIo {
    pub fn new(truth: Arc<Truth>, p50: Duration, p90: Duration, node_lag: Duration) -> TruthIo {
        TruthIo { truth, p50, p90, node_lag, copy2: Default::default(), feed: Default::default(), announced: Default::default(), rng: Mutex::new(0x9e37_79b9_7f4a_7c15), calls: Default::default(), not_yet: Default::default() }
    }
    /// The feed announced block `b` now.
    pub fn announce(&self, b: u64) {
        self.announced.lock().unwrap_or_else(|e| e.into_inner()).entry(b).or_insert_with(Instant::now);
        self.feed.fetch_max(b, std::sync::atomic::Ordering::Relaxed);
    }
    /// Copy 2 published block `b`.
    pub fn set_copy2(&self, b: u64) {
        self.copy2.store(b, std::sync::atomic::Ordering::Relaxed);
    }
    /// One answer time: log-normal through (p50, p90), capped at 10 x p90.
    fn wait(&self) {
        let u = {
            let mut g = self.rng.lock().unwrap_or_else(|e| e.into_inner());
            // xorshift64*: deterministic, no extra crate.
            let mut x = *g;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            *g = x;
            let a = (x.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 11) as f64 / (1u64 << 53) as f64;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            *g = x;
            let b = (x >> 11) as f64 / (1u64 << 53) as f64;
            (a.max(1e-12), b)
        };
        // Box-Muller normal, then log-normal with the given p50 / p90.
        let z = (-2.0 * u.0.ln()).sqrt() * (2.0 * std::f64::consts::PI * u.1).cos();
        let p50 = self.p50.as_secs_f64().max(1e-6);
        let sigma = (self.p90.as_secs_f64().max(p50) / p50).ln() / 1.2816;
        let t = (p50 * (sigma * z).exp()).min(self.p90.as_secs_f64() * 10.0);
        std::thread::sleep(Duration::from_secs_f64(t));
    }
}

impl super::keeper::KeeperIo for TruthIo {
    fn block(&self, b: u64) -> Result<Option<Vec<StateDiff>>, String> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.wait();
        let have = self.announced.lock().unwrap_or_else(|e| e.into_inner()).get(&b).is_some_and(|t| t.elapsed() >= self.node_lag);
        if !have {
            self.not_yet.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return Ok(None);
        }
        match self.truth.blocks.get(&b) {
            Some(t) => Ok(Some(t.clone())),
            // Past the recorded blocks: "not there" (the replay ends soon).
            None => Ok(None),
        }
    }
    fn proof(&self, addr: Address, slots: &[U256], at: u64, code: bool) -> Result<super::keeper::ProofAnswer, String> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.wait();
        let vals: Vec<(U256, U256)> = slots.iter().filter_map(|s| self.truth.slot_at(&addr, s, at).map(|v| (*s, v))).collect();
        let info = match self.truth.basics_at(&addr, at) {
            Some(i) => i,
            None if code => return Err("basics not recorded".into()),
            None => None,
        };
        let c = if code { info.as_ref().and_then(|i| self.truth.code(&i.code_hash)) } else { None };
        Ok((info, c, vals))
    }
    fn copy2_head(&self) -> Option<u64> {
        Some(self.copy2.load(std::sync::atomic::Ordering::Relaxed)).filter(|b| *b > 0)
    }
    fn feed_head(&self) -> Option<u64> {
        Some(self.feed.load(std::sync::atomic::Ordering::Relaxed)).filter(|b| *b > 0)
    }
}
