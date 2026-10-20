// ============================================================================
// ONE-STOP EVM BUILDER WITH NITRO RULES (owner: workstream B)
//
// Plain English:
//   Builds a revm EVM that behaves like a Robinhood Chain (Nitro) node:
//   right EVM rule set for the ArbOS version, Nitro opcode differences,
//   Nitro precompiles with exact gas, block details, eth_call settings.
//   check/ (C), feed replay (A), the tests and tools/gas_trace.rs all use
//   this, so they can't drift apart.
//
//   `ethcall = true`  -> block as a node's eth_call / eth_simulateV1 with gas
//                        price 0 sees it (BASEFEE and GASPRICE read 0)
//   `ethcall = false` -> block as a mined tx sees it (real BASEFEE; GASPRICE
//                        = BASEFEE because Robinhood doesn't collect tips)
// ============================================================================
use revm::{
    context::{BlockEnv, CfgEnv, Context, Evm, Journal, TxEnv},
    handler::{instructions::EthInstructions, EthFrame},
    interpreter::interpreter::EthInterpreter,
    Database,
};

use super::{block_env, block_env_ethcall, configure_cfg, instructions, ArbConfig, ArbPrecompiles, BlockCtx};
use revm::primitives::U256;

/// revm context type used with Nitro rules.
pub type ArbCtx<DB> = Context<BlockEnv, TxEnv, CfgEnv, DB, Journal<DB>, ()>;
/// revm EVM type with Nitro rules (INSP = inspector, `()` for none).
pub type ArbEvm<DB, INSP = ()> =
    Evm<ArbCtx<DB>, INSP, EthInstructions<EthInterpreter, ArbCtx<DB>>, ArbPrecompiles, EthFrame<EthInterpreter>>;

/// Build an EVM on `db` for block `ctx` with chain config `cfg`.
pub fn build_evm<DB: Database>(db: DB, ctx: &BlockCtx, cfg: &ArbConfig, arbsys_gas: u64, ethcall: bool) -> ArbEvm<DB> {
    build_evm_with_inspector(db, ctx, cfg, arbsys_gas, ethcall, ())
}

/// Same, with an inspector (tracing).
pub fn build_evm_with_inspector<DB: Database, INSP>(
    db: DB,
    ctx: &BlockCtx,
    cfg: &ArbConfig,
    arbsys_gas: u64,
    ethcall: bool,
    inspector: INSP,
) -> ArbEvm<DB, INSP> {
    let spec = cfg.spec();
    let mut c: ArbCtx<DB> = Context::new(db, spec);
    let chain_id = cfg.chain_id;
    c.modify_cfg(|x| {
        configure_cfg(x);
        x.chain_id = chain_id;
    });
    c.block = if ethcall { block_env_ethcall(ctx) } else { block_env(ctx) };
    let pre = ArbPrecompiles::with_config(ctx.l2_block_number.map(U256::from), arbsys_gas, cfg);
    Evm::new_with_inspector(c, inspector, instructions::<ArbCtx<DB>>(cfg), pre)
}
