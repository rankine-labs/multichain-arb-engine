// ============================================================================
// ARBITRUM / ROBINHOOD SPECIFICS (owner: workstream B)
//
// Plain English:
//   Robinhood Chain runs Arbitrum Nitro, which differs from plain Ethereum in
//   a few ways that change what a contract sees:
//     - NUMBER opcode = the PARENT chain's block number; the chain's own block
//       comes from ArbSys (address 0x64) arbBlockNumber().
//     - Built-in "precompile" contracts at low addresses (0x64 ArbSys, ...).
//   This module builds the block context and the precompile set so revm
//   behaves like Nitro for the calls we make. First version copied from the
//   go/no-go #1 bench (50/50 real trades exact); workstream B makes it exact
//   (gas per Nitro source, other precompiles, explained gas mismatches).
//
// SHARED CONTRACT (used by check/ and feed/): BlockCtx, block_env(),
// ArbPrecompiles::new(), configure_cfg(). Extend, don't break.
// ============================================================================
use revm::{
    context::{BlockEnv, CfgEnv},
    context_interface::{block::BlobExcessGasAndPrice, Cfg, ContextTr},
    handler::{precompile_output_to_interpreter_result, EthPrecompiles, PrecompileProvider},
    interpreter::{CallInputs, InterpreterResult},
    precompile::PrecompileOutput,
    primitives::{eip4844::BLOB_BASE_FEE_UPDATE_FRACTION_CANCUN, hardfork::SpecId, Address, AddressSet, Bytes, B256, U256},
};

/// Robinhood Chain mainnet chain id.
pub const CHAIN_ID: u64 = 4663;

/// Everything about "which block are we in" that a call can observe.
#[derive(Clone, Debug, Default)]
pub struct BlockCtx {
    /// What the NUMBER opcode returns (on Nitro: the parent-chain block number).
    pub l1_block_number: u64,
    /// The chain's own block number (ArbSys.arbBlockNumber()). None = no ArbSys.
    pub l2_block_number: Option<u64>,
    pub timestamp: u64,
    pub basefee: u64,
    pub coinbase: Address,
    pub gas_limit: u64,
    pub prevrandao: B256,
}

/// revm block environment for a BlockCtx.
pub fn block_env(c: &BlockCtx) -> BlockEnv {
    BlockEnv {
        number: U256::from(c.l1_block_number),
        beneficiary: c.coinbase,
        timestamp: U256::from(c.timestamp),
        gas_limit: c.gas_limit,
        basefee: c.basefee,
        difficulty: U256::from(1u64),
        prevrandao: Some(c.prevrandao),
        blob_excess_gas_and_price: Some(BlobExcessGasAndPrice::new(0, BLOB_BASE_FEE_UPDATE_FRACTION_CANCUN)),
        ..Default::default()
    }
}

/// eth_call-style settings: no nonce / balance / base-fee / block-gas checks,
/// calls may come "from" a contract.
pub fn configure_cfg(c: &mut CfgEnv) {
    c.chain_id = CHAIN_ID;
    c.tx_chain_id_check = false;
    c.disable_nonce_check = true;
    c.disable_base_fee = true;
    c.disable_balance_check = true;
    c.disable_block_gas_limit = true;
    c.disable_eip3607 = true;
}

pub const ARBSYS: Address = Address::new([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x64,
]);
const ARB_BLOCK_NUMBER_SELECTOR: [u8; 4] = [0xa3, 0xb1, 0xb3, 0x1d];
// Gas charged for arbBlockNumber(). BEST ESTIMATE of Nitro's precompile
// accounting (800 for opening ArbOS state = one storage read, +3 to copy the
// 32-byte result). NOT verified against a live Robinhood node — override with
// env ARBSYS_GAS=<n> once checked.
pub const ARBSYS_GAS_DEFAULT: u64 = 803;

/// Our precompile set = the normal Ethereum (Cancun) precompiles + ArbSys.
#[derive(Clone)]
pub struct ArbPrecompiles {
    eth: EthPrecompiles,        // standard ecrecover, sha256, ... point-eval
    l2_block: Option<U256>,     // what arbBlockNumber() returns; None = no ArbSys
    arbsys_gas: u64,            // gas charged per arbBlockNumber() call
    warm: AddressSet,           // precompile addresses (start "warm", like Nitro)
}

impl ArbPrecompiles {
    pub fn new(l2_block: Option<U256>, arbsys_gas: u64) -> Self {
        let eth = EthPrecompiles::new(SpecId::CANCUN);
        let mut p = Self { eth, l2_block, arbsys_gas, warm: AddressSet::default() };
        p.rebuild_warm();
        p
    }
    // Precompile addresses are pre-warmed (cheap 100-gas access instead of 2600).
    // Nitro treats its own precompiles (incl. 0x64) the same way.
    fn rebuild_warm(&mut self) {
        let mut w = self.eth.warm_addresses().clone();
        if self.l2_block.is_some() {
            w.insert(ARBSYS);
        }
        self.warm = w;
    }
}

impl<CTX: ContextTr> PrecompileProvider<CTX> for ArbPrecompiles {
    type Output = InterpreterResult;

    fn set_spec(&mut self, spec: <CTX::Cfg as Cfg>::Spec) -> bool {
        let changed = <EthPrecompiles as PrecompileProvider<CTX>>::set_spec(&mut self.eth, spec);
        if changed {
            self.rebuild_warm();
        }
        changed
    }

    fn run(
        &mut self,
        context: &mut CTX,
        inputs: &CallInputs,
    ) -> Result<Option<InterpreterResult>, String> {
        // Our ArbSys: only when the fixture says ArbSys exists.
        if let Some(n) = self.l2_block {
            if inputs.bytecode_address == ARBSYS {
                let input = inputs.input.as_bytes(context);
                let out = if input.len() >= 4 && input[..4] == ARB_BLOCK_NUMBER_SELECTOR {
                    // Success: return the L2 block number as a 32-byte number.
                    PrecompileOutput::new(
                        self.arbsys_gas,
                        Bytes::copy_from_slice(&n.to_be_bytes::<32>()),
                        inputs.reservoir,
                    )
                } else {
                    // Any other method: revert with no data.
                    PrecompileOutput::revert(0, Bytes::new(), inputs.reservoir)
                };
                return Ok(Some(precompile_output_to_interpreter_result(out, inputs.gas_limit)));
            }
        }
        // Everything else: the normal Ethereum precompiles.
        <EthPrecompiles as PrecompileProvider<CTX>>::run(&mut self.eth, context, inputs)
    }

    fn warm_addresses(&self) -> &AddressSet {
        &self.warm
    }
    fn contains(&self, address: &Address) -> bool {
        self.warm.contains(address)
    }
}

