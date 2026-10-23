// ============================================================================
// CheckDb: how the EVM reads chain state during a check.
//
// Plain English:
//   revm asks a "database" for accounts, storage slots and contract code.
//   This adapter answers from three places, highest priority first:
//     1. per-try patches (size search: "the contract holds <this size>")
//     2. the request's pretend-state (overrides.rs)
//     3. our copy of the chain (a StateRead view)
//   It NEVER writes anything back: all changes made while running live only
//   inside revm's scratch journal and are thrown away afterwards.
//
//   When the view says "Missing" (we never loaded it), the item is written
//   down. Two modes:
//     - collect (default): note it, answer zero/empty, keep running, so ONE
//       check discovers many missing items at once (faster warm-up). The
//       final answer is still "unknown" (never a result built on a guess).
//     - stop: abort at the first missing item.
//   Collect mode is capped (MAX_COLLECT) so a run that went off the rails on
//   a guessed zero stops early.
//
//   Trigger-first checks (check/ordered.rs) add two things:
//     - "pretend" accounts: the SENDER of a transaction we replay from the
//       feed is usually a wallet our copy has never loaded. The sequencer
//       accepted its transaction, so its nonce and balance were fine; the
//       run pretends them (code: none) instead of answering "missing".
//       ordered.rs watches the run: if anything else LOOKS at that wallet
//       (its balance, its code, calls it) the answer is "unknown".
//     - read recording: while the replayed transactions run, every account
//       and slot they read is written down, so ordered.rs can prove that our
//       own pretend-state (the test contract's funding) never changed how
//       those transactions ran.
//
//   Worker A is building state/db.rs `ViewDb` (same idea, without overrides);
//   this one adds overrides + per-try patches and can be merged with it later.
// ============================================================================
use revm::database_interface::{DBErrorMarker, Database};
use revm::primitives::{Address, StorageKey, StorageValue, B256, U256};
use revm::state::{AccountInfo, Bytecode};

use super::overrides::Overrides;
use crate::state::{Lookup, MissItem, StateRead};

/// Stop collecting misses after this many (and abort the run).
pub const MAX_COLLECT: usize = 64;

/// Why a database read failed (aborts the current transaction).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DbErr {
    /// Stop mode: this item is missing.
    Miss(MissItem),
    /// Collect mode: too many missing items, gave up early.
    TooManyMisses,
    /// The run touched an Arbitrum built-in contract we don't imitate.
    UnsupportedBuiltin(Address),
    /// Something we can't serve at all (e.g. BLOCKHASH).
    Unsupported(&'static str),
}

impl std::fmt::Display for DbErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DbErr::Miss(m) => write!(f, "missing {m:?}"),
            DbErr::TooManyMisses => write!(f, "too many missing items"),
            DbErr::UnsupportedBuiltin(a) => write!(f, "Arbitrum built-in {a} not imitated"),
            DbErr::Unsupported(w) => write!(f, "unsupported: {w}"),
        }
    }
}
impl std::error::Error for DbErr {}
impl DBErrorMarker for DbErr {}

/// The database revm runs on during one check.
pub struct CheckDb<'a> {
    view: &'a dyn StateRead,
    ov: &'a Overrides,
    /// Size-search patches: (account, slot) -> value, checked before everything.
    patches: Vec<(Address, U256, U256)>,
    /// Missing items seen so far (in the order first seen, no duplicates).
    pub missing: Vec<MissItem>,
    /// true = collect mode, false = stop at the first miss.
    collect: bool,
    /// Arbitrum built-in addresses we don't imitate: touching one = unknown.
    unsupported_builtins: Vec<Address>,
    /// Trigger-first: wallets whose basics are pretended (see file header),
    /// used only when our copy doesn't know them (Missing).
    pretend: Vec<(Address, AccountInfo)>,
    /// Trigger-first: reads written down while `recording` is on.
    pub reads: ReadLog,
    recording: bool,
    /// Trigger-first (best effort): counts every time a read found nothing
    /// in our copy. ordered.rs's watcher compares it before / after a
    /// transaction touches our route, to tell "touched our route, THEN
    /// missed something" from "missed something before ever touching it".
    pub miss_calls: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

/// Every account / slot read from the database while recording was on
/// (trigger-first: what the replayed transactions looked at).
#[derive(Clone, Debug, Default)]
pub struct ReadLog {
    pub accounts: std::collections::HashSet<Address>,
    pub slots: std::collections::HashSet<(Address, U256)>,
    /// The slots whose value came from OUR COPY (not from the request's
    /// pretend-state): ordered.rs checks each one's provenance.
    pub view_slots: std::collections::HashSet<(Address, U256)>,
}

impl<'a> CheckDb<'a> {
    pub fn new(view: &'a dyn StateRead, ov: &'a Overrides, collect: bool) -> Self {
        CheckDb { view, ov, patches: Vec::new(), missing: Vec::new(), collect, unsupported_builtins: Vec::new(), pretend: Vec::new(), reads: ReadLog::default(), recording: false, miss_calls: Default::default() }
    }

    /// Trigger-first: pretend this wallet's basics when our copy doesn't
    /// know it (see file header). The first pretend for an address wins.
    pub fn add_pretend(&mut self, a: Address, info: AccountInfo) {
        if !self.pretend.iter().any(|(x, _)| *x == a) {
            self.pretend.push((a, info));
        }
    }

    /// Trigger-first: start / stop writing down every read (ReadLog).
    pub fn set_recording(&mut self, on: bool) {
        self.recording = on;
    }

    /// Addresses whose use makes the answer unsure (Nitro built-ins we
    /// don't imitate). Only set in Arbitrum mode (see run.rs).
    pub fn set_unsupported_builtins(&mut self, a: Vec<Address>) {
        self.unsupported_builtins = a;
    }

    /// Set the per-try patches (size search). Replaces any previous ones.
    pub fn set_patches(&mut self, p: Vec<(Address, U256, U256)>) {
        self.patches = p;
    }

    /// Note a missing item; in stop mode (or past the cap) abort the run.
    fn miss(&mut self, m: MissItem) -> Result<(), DbErr> {
        self.miss_calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if !self.missing.contains(&m) {
            self.missing.push(m.clone());
        }
        if !self.collect {
            return Err(DbErr::Miss(m));
        }
        if self.missing.len() >= MAX_COLLECT {
            return Err(DbErr::TooManyMisses);
        }
        Ok(())
    }
}

impl Database for CheckDb<'_> {
    type Error = DbErr;

    fn basic(&mut self, address: Address) -> Result<Option<AccountInfo>, DbErr> {
        // Any use of a Nitro built-in we don't imitate (call, balance, code
        // size...) loads its account first, so this catches all of them.
        if self.unsupported_builtins.contains(&address) {
            return Err(DbErr::UnsupportedBuiltin(address));
        }
        if self.recording {
            self.reads.accounts.insert(address);
        }
        let ov = self.ov.get(&address);
        // Fully overridden account: no need to know the real one.
        let base: Option<AccountInfo> = match ov {
            Some(o) if o.defines_basics() => None,
            _ => match self.view.account(address) {
                Lookup::Known(a) => a,
                Lookup::Missing => match self.pretend.iter().find(|(a, _)| *a == address) {
                    // Trigger-first: a replayed tx's unknown sender (watched).
                    Some((_, info)) => Some(info.clone()),
                    None => {
                        self.miss(MissItem::Account(address))?;
                        None // collect mode: guess "empty" (the answer will be unknown anyway)
                    }
                },
            },
        };
        let Some(o) = ov else { return Ok(base) };
        // Apply pretend basics on top of the real account (or an empty one).
        let mut info = base.unwrap_or_default();
        if let Some(b) = o.balance {
            info.balance = b;
        }
        if let Some(n) = o.nonce {
            info.nonce = n;
        }
        if let Some((h, bc)) = &o.code {
            info.code_hash = *h;
            info.code = Some(bc.clone());
        }
        Ok(Some(info))
    }

    fn code_by_hash(&mut self, code_hash: B256) -> Result<Bytecode, DbErr> {
        if code_hash == revm::primitives::KECCAK_EMPTY {
            return Ok(Bytecode::default());
        }
        if let Some(bc) = self.ov.code_by_hash(&code_hash) {
            return Ok(bc.clone());
        }
        match self.view.code_by_hash(code_hash) {
            Lookup::Known(c) => Ok(c),
            Lookup::Missing => {
                self.miss(MissItem::Code(code_hash))?;
                Ok(Bytecode::default())
            }
        }
    }

    fn storage(&mut self, address: Address, index: StorageKey) -> Result<StorageValue, DbErr> {
        if self.recording {
            self.reads.slots.insert((address, index));
        }
        for (a, s, v) in &self.patches {
            if *a == address && *s == index {
                return Ok(*v);
            }
        }
        if let Some(o) = self.ov.get(&address) {
            // `state`: the account's whole storage; anything not listed is zero
            // (geth semantics: the real storage is ignored entirely).
            if let Some(full) = &o.state {
                return Ok(full.get(&index).copied().unwrap_or(U256::ZERO));
            }
            if let Some(v) = o.state_diff.get(&index) {
                return Ok(*v);
            }
        }
        match self.view.storage(address, index) {
            Lookup::Known(v) => {
                if self.recording {
                    self.reads.view_slots.insert((address, index));
                }
                Ok(v)
            }
            Lookup::Missing => {
                self.miss(MissItem::Slot(address, index))?;
                Ok(U256::ZERO)
            }
        }
    }

    fn block_hash(&mut self, _number: u64) -> Result<B256, DbErr> {
        // We keep no block hashes. Nothing in our trades uses BLOCKHASH; if
        // something does, say "unknown" rather than invent a hash.
        Err(DbErr::Unsupported("BLOCKHASH"))
    }
}
