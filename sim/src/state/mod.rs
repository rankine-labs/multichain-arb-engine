// ============================================================================
// STATE: what the simulator knows about the chain (owner: workstream A)
//
// Plain English:
//   Every question the EVM asks ("what's in this storage slot?") goes through
//   the `StateRead` trait below. The answer is either KNOWN (with the value)
//   or MISSING (we never loaded it). Missing is NOT zero: guessing zero would
//   give confident wrong answers, which is the one thing we must never do.
//   A check that hits a missing item answers "unknown" and the bot falls back
//   to the node.
//
// SHARED CONTRACT (used by check/, implemented by state/): keep these names
// and meanings stable; extend, don't change.
// ============================================================================
use std::collections::HashMap;

use revm::primitives::{Address, B256, U256};
use revm::state::{AccountInfo, Bytecode};

pub mod db;
pub mod diff;
pub mod fill;
pub mod mem;
pub mod mirror;
pub mod pinned;
pub mod snap;
pub mod updater;

/// Result of looking something up in our copy of the chain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Lookup<T> {
    /// We know the exact value at this state.
    Known(T),
    /// We never loaded it. The caller must NOT treat this as zero.
    Missing,
}

/// One item the state didn't have (what to fetch from the node).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum MissItem {
    /// Account basics (balance, nonce, code hash) unknown.
    Account(Address),
    /// One storage slot of an account unknown.
    Slot(Address, U256),
    /// Contract code for this hash unknown.
    Code(B256),
}

/// Read-only view of chain state at one point (a block, or a block plus some
/// replayed feed messages). Must be cheap to share between threads.
pub trait StateRead: Send + Sync {
    /// Account basics. `Known(None)` = the account definitely does not exist
    /// (empty). `Known(Some(info))`: `info.code` may be `None`; then the code
    /// is looked up with `code_by_hash(info.code_hash)`.
    fn account(&self, addr: Address) -> Lookup<Option<AccountInfo>>;
    /// One storage slot.
    fn storage(&self, addr: Address, slot: U256) -> Lookup<U256>;
    /// Contract code by its hash.
    fn code_by_hash(&self, hash: B256) -> Lookup<Bytecode>;
    /// Where this view sits: (L2 block number of the base, last feed message
    /// sequence number applied on top, if any). For logging and answers.
    fn position(&self) -> StatePosition;
    /// Is this account's ETH balance exact? (Extension, default yes.)
    /// The live mirror replays feed transactions WITHOUT charging gas fees
    /// (Nitro's fee includes an L1 part we can't compute), so the balance of
    /// an account that paid fees is only approximately right. Code that READS
    /// such a balance (BALANCE / SELFBALANCE opcodes) must treat the answer
    /// as unsure. Contract balances and token balances are always exact.
    fn balance_exact(&self, _addr: Address) -> bool {
        true
    }
}

/// Where a state view sits on the chain.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StatePosition {
    /// Confirmed block the base layer is at.
    pub base_block: u64,
    /// Highest sequencer-feed message replayed on top (None = base only).
    pub after_seq: Option<u64>,
}

/// Changes made by running something (a feed message's txs, a trigger):
/// per account, the new basics (if changed) and new slot values.
/// Used by the overlay layers; also what a block diff turns into.
#[derive(Clone, Debug, Default)]
pub struct StateDiff {
    pub accounts: HashMap<Address, AccountDiff>,
}

#[derive(Clone, Debug, Default)]
pub struct AccountDiff {
    /// New basics; None = unchanged. `Some(None)` = account deleted/emptied.
    pub info: Option<Option<AccountInfo>>,
    /// New code (with its hash in `info`), when a contract was created.
    pub code: Option<Bytecode>,
    /// Slot -> new value (U256::ZERO = cleared).
    pub storage: HashMap<U256, U256>,
    /// (Extension) true = ALL old storage is gone before `storage` applies
    /// (account newly created or destroyed): unlisted slots are now zero.
    pub storage_cleared: bool,
    /// (Extension) true = after this change the ETH balance is only
    /// approximately known (see StateRead::balance_exact).
    pub balance_inexact: bool,
    /// (Extension) true = after this change NOTHING about this account is
    /// known any more (e.g. a sender we only pretended to know). All other
    /// fields are ignored.
    pub forget: bool,
}
