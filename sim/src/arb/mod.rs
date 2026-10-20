// ============================================================================
// ARBITRUM / ROBINHOOD SPECIFICS (owner: workstream B)
//
// Plain English:
//   Robinhood Chain runs Arbitrum Nitro, which differs from plain Ethereum in
//   a few ways that change what a contract sees. This module makes revm
//   behave like Nitro for the calls we make:
//     - block details (NUMBER = parent-chain block, PREVRANDAO = 1, ...)
//     - Nitro's built-in contracts (ArbSys 0x64, ArbGasInfo 0x6c) with exact
//       gas; anything else Nitro-specific -> "unsupported", never a guess
//     - which Ethereum upgrade's rules apply (decided by the ArbOS version)
//   Findings and sources: sim/ARBITRUM_NOTES.md.
//
// SHARED CONTRACT (used by check/ and feed/): BlockCtx, block_env(),
// ArbPrecompiles::new(), configure_cfg(). Extended (never broken) with:
//   ArbConfig, spec_id(), instructions(), block_env_ethcall(),
//   HeaderInfo, l2_block_for_seq(), ARBSYS_GAS_DEFAULT & friends.
//
// Nitro source references are to OffchainLabs/nitro master @ ccc5c828
// (2026-08-28) and OffchainLabs/go-ethereum master @ 260bc5dc (2026-06-16).
// ============================================================================
pub mod arbos;
pub mod evm;
pub mod precompiles;

use revm::{
    context::{BlockEnv, CfgEnv},
    context_interface::{block::BlobExcessGasAndPrice, Block, ContextError, ContextTr, Host, JournalTr},
    handler::instructions::EthInstructions,
    interpreter::{
        instructions::gas_table_spec, interpreter::EthInterpreter, interpreter_types::StackTr, Instruction,
        InstructionContext, InstructionResult, InterpreterTypes,
    },
    primitives::{eip4844::BLOB_BASE_FEE_UPDATE_FRACTION_CANCUN, hardfork::SpecId, Address, B256, U256},
    Database,
};

pub use precompiles::{
    arbitrum_builtin_addresses, is_stylus_code, nitro_precompile_addresses, ArbPrecompiles, UnsupportedHit,
    ARBGASINFO_ONE_READ_GAS, ARBOS_OPEN_GAS, ARBSYS, ARBSYS_VIEW_GAS, ARB_GAS_INFO, UNSUPPORTED_PRECOMPILE_PREFIX,
};

/// Robinhood Chain mainnet chain id.
pub const CHAIN_ID: u64 = 4663;

/// Gas charged for ArbSys.arbBlockNumber(). EXACT Nitro charge, from source:
/// 800 (open ArbOS state = one metered storage read) + 0 (no arguments)
/// + 3 (copy one 32-byte result word) = 803. See precompiles.rs header.
/// The caller additionally pays 100 for a warm STATICCALL (precompiles are
/// always warm on Nitro). `ARBSYS_GAS` env (read by check/) may override it.
pub const ARBSYS_GAS_DEFAULT: u64 = ARBSYS_VIEW_GAS; // 803

/// Block gas limit in every Nitro header (arbos/l2pricing/l2pricing.go L49,
/// arbos/block_processor.go L227): 2^50.
pub const NITRO_BLOCK_GAS_LIMIT: u64 = 1 << 50;

/// ArbOS version we assume for Robinhood Chain when nothing better is known.
/// ArbOS 51 "Dia" (Fusaka/Osaka EVM) was the current release when Robinhood
/// mainnet launched (2026-07-01); ArbOS 61 "Elara" (Aug 2026) has the same
/// EVM rules for our purposes. VERIFY on the server: tools/gas-diff.js prints
/// the real version (from the block header and the ArbOS state).
/// Override with env ARBSIM_ARBOS_VERSION.
pub const DEFAULT_ARBOS_VERSION: u64 = 51;

/// Chain settings that change EVM behaviour.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArbConfig {
    pub chain_id: u64,
    /// ArbOS version (= header mixHash bytes 16..24; ArbSys.arbOSVersion() - 55).
    pub arbos_version: u64,
    /// ArbOS >= 60 chains may collect priority fees ("tips"). When false,
    /// GASPRICE returns the block base fee, not the tx's price
    /// (arbos/tx_processor.go L995-1035). Header mixHash byte 25 bit 0.
    pub collect_tips: bool,
}

impl Default for ArbConfig {
    fn default() -> Self {
        let v = std::env::var("ARBSIM_ARBOS_VERSION").ok().and_then(|s| s.parse().ok()).unwrap_or(DEFAULT_ARBOS_VERSION);
        ArbConfig { chain_id: CHAIN_ID, arbos_version: v, collect_tips: false }
    }
}

impl ArbConfig {
    /// Ethereum rule set Nitro applies at this ArbOS version
    /// (go-ethereum params/config.go L838-866):
    ///   ArbOS >= 50 Osaka (CLZ, P256 6,900 gas, EIP-7702)
    ///   ArbOS >= 40 Prague (EIP-7702; EIP-7623 floor only if the chain turned it on)
    ///   ArbOS >= 20 Cancun, >= 11 Shanghai, else London.
    pub fn spec(&self) -> SpecId {
        match self.arbos_version {
            v if v >= 50 => SpecId::OSAKA,
            v if v >= 40 => SpecId::PRAGUE,
            v if v >= 20 => SpecId::CANCUN,
            v if v >= 11 => SpecId::SHANGHAI,
            _ => SpecId::LONDON,
        }
    }
}

/// revm spec for the default config (use this instead of a hard-coded CANCUN).
pub fn spec_id() -> SpecId {
    ArbConfig::default().spec()
}

/// Everything about "which block are we in" that a call can observe.
#[derive(Clone, Debug, Default)]
pub struct BlockCtx {
    /// What the NUMBER opcode returns (on Nitro: the parent-chain block number,
    /// = header field l1BlockNumber = mixHash bytes 8..16).
    pub l1_block_number: u64,
    /// The chain's own block number (ArbSys.arbBlockNumber()). None = plain
    /// EVM mode (no Nitro precompiles; used by offline anvil fixtures).
    pub l2_block_number: Option<u64>,
    pub timestamp: u64,
    pub basefee: u64,
    pub coinbase: Address,
    pub gas_limit: u64,
    /// Only used in plain-EVM mode. On Nitro PREVRANDAO is ALWAYS 1 (the
    /// header difficulty), never the mixHash (which holds ArbOS info).
    pub prevrandao: B256,
}

/// PREVRANDAO / DIFFICULTY on Nitro: header difficulty = 1, and
/// NewEVMBlockContext sets Random = difficulty for ArbOS blocks
/// (go-ethereum core/evm.go L61-68; arbos/block_processor.go L225).
pub const NITRO_PREVRANDAO: B256 = B256::with_last_byte(1);

/// revm block environment for a BlockCtx, as in a REAL block (debug_trace of
/// a mined tx, feed replay): BASEFEE = the block's base fee.
pub fn block_env(c: &BlockCtx) -> BlockEnv {
    let arbitrum = c.l2_block_number.is_some();
    BlockEnv {
        number: U256::from(c.l1_block_number),
        beneficiary: c.coinbase,
        timestamp: U256::from(c.timestamp),
        gas_limit: c.gas_limit,
        basefee: c.basefee,
        difficulty: U256::from(1u64),
        prevrandao: Some(if arbitrum { NITRO_PREVRANDAO } else { c.prevrandao }),
        // BLOBBASEFEE is an error on Nitro (see instructions()); value unused there.
        blob_excess_gas_and_price: Some(BlobExcessGasAndPrice::new(0, BLOB_BASE_FEE_UPDATE_FRACTION_CANCUN)),
        ..Default::default()
    }
}

/// Block environment as a Nitro node's eth_call / debug_traceCall with gas
/// price 0 sees it: BASEFEE reads 0 (go-ethereum internal/ethapi/api.go
/// L782-786, eth/tracers/api.go L1007-1011; eth_simulateV1 without a
/// baseFeePerGas override also uses 0, internal/ethapi/simulate.go L212-222).
pub fn block_env_ethcall(c: &BlockCtx) -> BlockEnv {
    BlockEnv { basefee: 0, ..block_env(c) }
}

/// eth_call-style settings: no nonce / balance / base-fee / block-gas checks,
/// calls may come "from" a contract. Plus Nitro rules that differ from the
/// Ethereum spec revm would otherwise apply:
///   - no EIP-7825 per-tx gas cap (Nitro skips it, go-ethereum
///     core/state_transition.go L538-541; its own cap is ArbOS state, and
///     never applies to eth_call / simulate)
///   - no EIP-7623 calldata floor (only if the chain enabled the feature,
///     arbos/tx_processor.go L1053-1063; off by default)
pub fn configure_cfg(c: &mut CfgEnv) {
    c.chain_id = CHAIN_ID;
    c.tx_chain_id_check = false;
    c.disable_nonce_check = true;
    c.disable_base_fee = true;
    c.disable_balance_check = true;
    c.disable_block_gas_limit = true;
    c.disable_eip3607 = true;
    c.tx_gas_limit_cap = Some(u64::MAX);
    c.disable_eip7623 = true;
}

/// Instruction table with Nitro's opcode differences (EVM rules of `cfg`):
///   GASPRICE    -> block base fee unless the chain collects tips
///   BLOCKHASH   -> PARENT-chain block hashes from ArbOS state (range = last
///                  256 parent blocks below NUMBER); missing = MISS, never 0
///   BLOBBASEFEE -> error ("not supported on Arbitrum"): frame fails, all gas
/// NUMBER needs no change: block_env() already puts the parent block there.
pub fn instructions<CTX>(cfg: &ArbConfig) -> EthInstructions<EthInterpreter, CTX>
where
    CTX: ContextTr + Host,
{
    let spec = cfg.spec();
    let mut i = EthInstructions::new(revm::interpreter::instruction_table(), gas_table_spec(spec), spec);
    let gt = gas_table_spec(spec);
    if !cfg.collect_tips {
        i.insert_instruction(0x3a, Instruction::new(nitro_gasprice::<CTX, EthInterpreter>), gt[0x3a]);
    }
    i.insert_instruction(0x40, Instruction::new(nitro_blockhash::<CTX, EthInterpreter>), gt[0x40]);
    i.insert_instruction(0x4a, Instruction::new(nitro_blobbasefee::<CTX, EthInterpreter>), gt[0x4a]);
    i
}

// GASPRICE on Nitro (core/vm/instructions.go L423-430 -> GasPriceOp ->
// GetPaidGasPrice, arbos/tx_processor.go L1022-1035): the base fee in the EVM
// context when tips are not collected. (eth_call with price 0: base fee is
// lowered to 0, so this is 0 as well.)
fn nitro_gasprice<CTX: ContextTr + Host, W: InterpreterTypes>(c: InstructionContext<'_, CTX, W>) -> Result<(), InstructionResult> {
    let bf = U256::from(c.host.block().basefee());
    if !c.interpreter.stack.push(bf) {
        return Err(InstructionResult::StackOverflow);
    }
    Ok(())
}

// BLOCKHASH on Nitro (core/vm/instructions.go L432-466): window is the 256
// parent-chain blocks below the current parent-chain block number; hash comes
// from ArbOS state (arbos/blockhash/blockhash.go L33-42). Read straight from
// the database (Nitro reads it with an unmetered system burner, no access-list
// effect), so overrides / misses behave as for any other slot.
fn nitro_blockhash<CTX: ContextTr + Host, W: InterpreterTypes>(c: InstructionContext<'_, CTX, W>) -> Result<(), InstructionResult> {
    let Some([n]) = c.interpreter.stack.popn::<1>() else {
        return Err(InstructionResult::StackUnderflow);
    };
    let upper: u64 = c.host.block().number().saturating_to();
    let lower = if upper < 257 { 0 } else { upper - 256 };
    let out = match u64::try_from(n) {
        Ok(n64) if n64 >= lower && n64 < upper => {
            let slot = arbos::l1_block_hash_slot(n64);
            match c.host.journal_mut().db_mut().storage(arbos::ARBOS_STATE_ADDRESS, slot) {
                Ok(v) => v,
                Err(e) => {
                    *c.host.error() = Err(ContextError::Db(e));
                    return Err(InstructionResult::FatalExternalError);
                }
            }
        }
        _ => U256::ZERO,
    };
    if !c.interpreter.stack.push(out) {
        return Err(InstructionResult::StackOverflow);
    }
    Ok(())
}

// BLOBBASEFEE on Nitro: core/vm/eips.go L293-296 returns an error.
fn nitro_blobbasefee<CTX: ContextTr + Host, W: InterpreterTypes>(_c: InstructionContext<'_, CTX, W>) -> Result<(), InstructionResult> {
    Err(InstructionResult::NotActivated)
}

// ---------------------------------------------------------------------------
// Header info (what Nitro packs into a block header)
// ---------------------------------------------------------------------------
/// Decoded Nitro header extras (go-ethereum core/types/arb_types.go L667-691).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HeaderInfo {
    pub send_count: u64,
    /// = NUMBER for every tx of this block.
    pub l1_block_number: u64,
    pub arbos_version: u64,
    pub collect_tips: bool,
}

impl HeaderInfo {
    /// From the header's mixHash (eth_getBlockByNumber `mixHash`).
    pub fn from_mix_hash(mix: B256) -> Self {
        let u = |r: std::ops::Range<usize>| u64::from_be_bytes(mix[r].try_into().unwrap());
        let arbos_version = u(16..24);
        HeaderInfo {
            send_count: u(0..8),
            l1_block_number: u(8..16),
            arbos_version,
            collect_tips: arbos_version == 9 || mix[25] & 1 == 1,
        }
    }
    /// Chain config implied by this header.
    pub fn config(&self) -> ArbConfig {
        ArbConfig { chain_id: CHAIN_ID, arbos_version: self.arbos_version, collect_tips: self.collect_tips }
    }
}

// ---------------------------------------------------------------------------
// Sequencer feed message -> L2 block number
// ---------------------------------------------------------------------------
/// Robinhood Chain's genesis block number for message indexing. Orbit chains
/// start at 0 (only Arbitrum One has 22,207,817, from its classic era). VERIFY:
/// tools/gas-diff.js reads ArbOS state slot `genesisBlockNum`.
pub const ROBINHOOD_GENESIS_BLOCK_NUM: u64 = 0;

/// Each feed message (sequenceNumber N) produces exactly one L2 block:
/// block = N + genesis (nitro arbutil/block_message_relation.go L11-20).
pub fn l2_block_for_seq(seq: u64, genesis_block_num: u64) -> u64 {
    seq + genesis_block_num
}

/// Inverse of l2_block_for_seq (None before genesis).
pub fn seq_for_l2_block(block: u64, genesis_block_num: u64) -> Option<u64> {
    block.checked_sub(genesis_block_num)
}
