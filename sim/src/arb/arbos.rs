// ============================================================================
// ArbOS STATE STORAGE: where Nitro keeps its own settings (owner: workstream B)
//
// Plain English:
//   Arbitrum Nitro keeps its "operating system" settings (ArbOS version, L1
//   block number, L1 block hashes, gas prices, ...) as ordinary storage slots
//   of one special account, 0xA4B05FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF. The
//   slot numbers are scrambled with keccak in a fixed way. This file
//   reproduces that scrambling so the simulator can read those settings from
//   its copy of the chain (and report a MISS if it doesn't have them).
//
// Source (OffchainLabs/nitro, master @ ccc5c828, Aug 2026):
//   arbos/storage/storage.go  L72-86   KVStorage/NewGeth: account = ArbosStateAddress, root key = []
//   arbos/storage/storage.go  L119-126 mapAddress: keccak(storageKey ++ key[0..31])[0..31] ++ key[31]
//   arbos/storage/storage.go  L235-252 OpenSubStorage: storageKey = keccak(parentKey ++ id)
//   arbos/arbosState/arbosstate.go L213-242 offsets and subspace ids
//   arbos/l1pricing/l1pricing.go L60-72, arbos/l2pricing/l2pricing.go L35-42 offsets
//   arbos/blockhash/blockhash.go L25-42: slot 0 = next L1 block number, 1+(n%256) = L1 hash of n
//   arbos/storage/storage.go L61: every metered ArbOS storage read costs 800 gas
// ============================================================================
use revm::primitives::{address, keccak256, Address, B256, U256};

/// The account that holds all ArbOS state (go-ethereum core/types/arbitrum_signer.go L10).
pub const ARBOS_STATE_ADDRESS: Address = address!("A4B05FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF");
/// ArbosActs pseudo-precompile ("0xa4b05", core/types/arbitrum_signer.go L9).
pub const ARBOS_ACTS_ADDRESS: Address = address!("00000000000000000000000000000000000a4b05");
/// Address used as "the poster" for messages from the sequencer (arbos/l1pricing/l1pricing.go L53).
/// It is also the block coinbase of sequenced Nitro blocks.
pub const BATCH_POSTER_ADDRESS: Address = address!("A4B000000000000000000073657175656e636572");

/// Gas Nitro charges per metered ArbOS storage read (= SLOAD EIP-2200 = 800).
pub const STORAGE_READ_COST: u64 = 800;
/// Gas per 32-byte word copied in/out of a precompile (params.CopyGas = 3).
pub const COPY_GAS: u64 = 3;

// Top-level offsets (arbosstate.go L213-226).
pub const VERSION_OFFSET: u64 = 0;
pub const CHAIN_ID_OFFSET: u64 = 4;
pub const GENESIS_BLOCK_NUM_OFFSET: u64 = 5;
pub const BROTLI_LEVEL_OFFSET: u64 = 7;
pub const COLLECT_TIPS_OFFSET: u64 = 11;

// Subspace ids (arbosstate.go L229-242).
pub const L1_PRICING_SUBSPACE: u8 = 0;
pub const L2_PRICING_SUBSPACE: u8 = 1;
pub const BLOCKHASHES_SUBSPACE: u8 = 6;
pub const FEATURES_SUBSPACE: u8 = 9;

// L1 pricing offsets (l1pricing.go L60-72).
pub mod l1 {
    pub const PAY_REWARDS_TO: u64 = 0;
    pub const EQUILIBRATION_UNITS: u64 = 1;
    pub const INERTIA: u64 = 2;
    pub const PER_UNIT_REWARD: u64 = 3;
    pub const LAST_UPDATE_TIME: u64 = 4;
    pub const FUNDS_DUE_FOR_REWARDS: u64 = 5;
    pub const UNITS_SINCE: u64 = 6;
    pub const PRICE_PER_UNIT: u64 = 7;
    pub const LAST_SURPLUS: u64 = 8;
    pub const PER_BATCH_GAS_COST: u64 = 9;
    pub const AMORTIZED_COST_CAP_BIPS: u64 = 10;
    pub const L1_FEES_AVAILABLE: u64 = 11;
}

// L2 pricing offsets (l2pricing.go L35-42).
pub mod l2 {
    pub const SPEED_LIMIT_PER_SECOND: u64 = 0;
    pub const PER_BLOCK_GAS_LIMIT: u64 = 1;
    pub const BASE_FEE_WEI: u64 = 2;
    pub const MIN_BASE_FEE_WEI: u64 = 3;
    pub const GAS_BACKLOG: u64 = 4;
    pub const PRICING_INERTIA: u64 = 5;
    pub const BACKLOG_TOLERANCE: u64 = 6;
    pub const PER_TX_GAS_LIMIT: u64 = 7;
}

/// Storage key of a (nested) subspace. `path` = list of subspace ids from the
/// root, e.g. `&[0]` = L1 pricing. Root key is empty.
pub fn subspace_key(path: &[u8]) -> Vec<u8> {
    let mut key: Vec<u8> = Vec::new();
    for id in path {
        let mut buf = key.clone();
        buf.push(*id);
        key = keccak256(&buf).to_vec();
    }
    key
}

/// Nitro's mapAddress(): the real storage slot for `key` inside a subspace.
pub fn map_key(storage_key: &[u8], key: B256) -> U256 {
    let mut buf = Vec::with_capacity(storage_key.len() + 31);
    buf.extend_from_slice(storage_key);
    buf.extend_from_slice(&key[..31]);
    let h = keccak256(&buf);
    let mut out = [0u8; 32];
    out[..31].copy_from_slice(&h[..31]);
    out[31] = key[31];
    U256::from_be_bytes(out)
}

/// Slot of offset `offset` inside the subspace at `path` (empty path = root).
pub fn arbos_slot(path: &[u8], offset: u64) -> U256 {
    map_key(&subspace_key(path), B256::from(U256::from(offset)))
}

/// Slot holding the ArbOS version (root offset 0).
pub fn version_slot() -> U256 {
    arbos_slot(&[], VERSION_OFFSET)
}

/// Slot holding the L1 block hash of parent-chain block `n` (blockhash.go L41).
pub fn l1_block_hash_slot(n: u64) -> U256 {
    arbos_slot(&[BLOCKHASHES_SUBSPACE], 1 + (n % 256))
}

/// Slot holding "next L1 block number" = what NUMBER returns (blockhash.go L29-31).
pub fn l1_block_number_slot() -> U256 {
    arbos_slot(&[BLOCKHASHES_SUBSPACE], 0)
}
