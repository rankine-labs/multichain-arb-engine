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
use std::sync::Arc;
use std::time::Instant;

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
    /// Accounts created / destroyed inside the capture: values not derived
    /// (left unknown, never guessed).
    unreliable: HashSet<Address>,
    code_of: HashMap<Address, B256>,
    codes: HashMap<B256, Bytecode>,
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
            // Changes: one Write per changed slot / account.
            for (i, d) in diffs.iter().enumerate() {
                for (a, ad) in &d.diff.accounts {
                    if ad.storage_cleared {
                        t.unreliable.insert(*a);
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
                        }
                    }
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
        if !learned.is_empty() {
            self.learned_all.push(learned.clone());
        }
        self.core.learn(&learned);
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
        if let Some(v) = self.core.version_at(block) {
            a.on_kept(v);
        }
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
}
