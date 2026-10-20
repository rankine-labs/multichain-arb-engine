// ============================================================================
// Shared helpers for the arb (workstream B) tests.
//
// Plain English:
//   A tiny in-memory chain (revm CacheDB), a few hand-assembled contracts
//   whose exact gas we can reason about, and a one-line "run this call" that
//   uses the same Nitro-rules EVM builder as the real checker.
// ============================================================================
#![allow(dead_code)]
use arbsim::arb::{evm::build_evm, ArbConfig, BlockCtx, ARBSYS_GAS_DEFAULT};
use revm::{
    context::TxEnv,
    context_interface::result::{EVMError, ExecutionResult},
    database::{CacheDB, EmptyDB},
    primitives::{Address, Bytes, TxKind, B256, U256},
    state::{AccountInfo, Bytecode},
    ExecuteEvm,
};

pub type Db = CacheDB<EmptyDB>;

pub const USER: Address = Address::new([0x11; 20]);

pub fn addr(n: u64) -> Address {
    let mut a = [0u8; 20];
    a[12..].copy_from_slice(&n.to_be_bytes());
    Address::from(a)
}

/// Block in "Arbitrum mode" (L2 block known => Nitro precompiles active).
pub fn arb_ctx() -> BlockCtx {
    BlockCtx {
        l1_block_number: 1000,
        l2_block_number: Some(123_456_789),
        timestamp: 1_760_000_000,
        basefee: 7,
        coinbase: addr(0xc0ffee),
        gas_limit: 1 << 50,
        prevrandao: B256::repeat_byte(0xab),
    }
}

/// Same block in plain-EVM mode (no ArbSys; like a local anvil chain).
pub fn plain_ctx() -> BlockCtx {
    BlockCtx { l2_block_number: None, ..arb_ctx() }
}

pub fn put_code(db: &mut Db, a: Address, code: Vec<u8>) {
    let bc = Bytecode::new_raw(code.into());
    db.insert_account_info(a, AccountInfo { code_hash: bc.hash_slow(), code: Some(bc), ..Default::default() });
}

/// Result of one call: (status, output, tx-level gas, error text).
#[derive(Debug)]
pub struct Out {
    pub status: &'static str, // "ok" | "revert" | "halt" | "error"
    pub output: Bytes,
    pub gas: u64,
    pub error: String,
    pub unsupported: Option<String>,
}

impl Out {
    pub fn word(&self) -> U256 {
        U256::from_be_slice(&self.output[..32])
    }
}

/// Run one call with Nitro rules.
pub fn run(db: &Db, ctx: &BlockCtx, cfg: &ArbConfig, ethcall: bool, to: Address, data: Vec<u8>, gas: u64) -> Out {
    let mut evm = build_evm(db.clone(), ctx, cfg, ARBSYS_GAS_DEFAULT, ethcall);
    let tx = TxEnv {
        tx_type: 0,
        caller: USER,
        gas_limit: gas,
        gas_price: 0,
        kind: TxKind::Call(to),
        data: data.into(),
        chain_id: Some(cfg.chain_id),
        ..Default::default()
    };
    let r = evm.transact_one(tx);
    let unsupported = evm.precompiles.unsupported().map(|u| u.to_string());
    match r {
        Ok(ExecutionResult::Success { gas, output, .. }) => {
            Out { status: "ok", output: output.into_data(), gas: gas.tx_gas_used(), error: String::new(), unsupported }
        }
        Ok(ExecutionResult::Revert { gas, output, .. }) => Out { status: "revert", output, gas: gas.tx_gas_used(), error: String::new(), unsupported },
        Ok(ExecutionResult::Halt { gas, reason, .. }) => {
            Out { status: "halt", output: Bytes::new(), gas: gas.tx_gas_used(), error: format!("{reason:?}"), unsupported }
        }
        Err(EVMError::Custom(e)) => Out { status: "error", output: Bytes::new(), gas: 0, error: e, unsupported },
        Err(e) => Out { status: "error", output: Bytes::new(), gas: 0, error: format!("{e:?}"), unsupported },
    }
}

pub fn cfg() -> ArbConfig {
    ArbConfig { chain_id: 4663, arbos_version: 51, collect_tips: false }
}

/// 21000 + 4 per zero byte + 16 per non-zero byte.
pub fn intrinsic(data: &[u8]) -> u64 {
    21_000 + data.iter().map(|b| if *b == 0 { 4 } else { 16 }).sum::<u64>()
}

/// "Forwarder": copies its calldata, STATICCALLs `target` with it (all gas),
/// returns the callee's return data, or reverts with it if the callee failed.
/// Same opcodes whatever the target, so two runs differ ONLY by the call.
pub fn forwarder(target: Address) -> Vec<u8> {
    let mut c = vec![0x36, 0x5f, 0x5f, 0x37]; // CALLDATACOPY(0, 0, CALLDATASIZE)
    c.extend([0x5f, 0x5f, 0x36, 0x5f]); // retSize 0, retOff 0, argsSize, argsOff 0
    c.push(0x73); // PUSH20 target
    c.extend_from_slice(target.as_slice());
    c.extend([0x5a, 0xfa]); // GAS, STATICCALL
    c.extend([0x3d, 0x5f, 0x5f, 0x3e]); // RETURNDATACOPY(0, 0, RETURNDATASIZE)
    let jd = c.len() + 6;
    c.extend([0x60, jd as u8, 0x57]); // PUSH1 ok; JUMPI
    c.extend([0x3d, 0x5f, 0xfd]); // REVERT(0, RETURNDATASIZE)
    c.extend([0x5b, 0x3d, 0x5f, 0xf3]); // JUMPDEST; RETURN(0, RETURNDATASIZE)
    assert_eq!(c[jd], 0x5b);
    c
}

/// Contract running `ops` that leave ONE word on the stack, then returns it.
pub fn returns_word(ops: &[u8]) -> Vec<u8> {
    let mut c = ops.to_vec();
    c.extend([0x5f, 0x52, 0x60, 0x20, 0x5f, 0xf3]); // MSTORE(0); RETURN(0, 32)
    c
}

pub fn sel(s: [u8; 4]) -> Vec<u8> {
    s.to_vec()
}
