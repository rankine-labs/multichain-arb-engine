// ============================================================================
// revm-bench  —  candidate engine #2 for "run the ArbExecutor check locally"
//
// Plain English:
//   The bot today asks a blockchain node "what would happen if I sent this
//   transaction?" (eth_call). That round trip costs ~100 ms. This program
//   answers the same question itself, using revm (a fast Ethereum "virtual
//   machine" written in Rust) and a copy of the relevant blockchain state
//   held in memory.
//
//   Modes:
//     bench <fixture.json> [--n 5000]
//         Load the saved state once, then replay the same check N times and
//         print timing + correctness as JSON.
//     serve <fixture.json> <socket-path>
//         Stay running as a "sidecar". The Node bot connects over a Unix
//         socket (a local pipe, no network), sends a transaction, gets the
//         answer back. See PROTOCOL below.
//
//   Safety: no private keys, no network calls to any chain. Everything is
//   in memory and read-only; every simulation starts from the same state.
// ============================================================================

use std::{
    io::{Read, Write},
    os::unix::net::{UnixListener, UnixStream},
    str::FromStr,
    time::Instant,
};

use revm::{
    context::{BlockEnv, CfgEnv, Context, Evm, Journal, TxEnv},
    context_interface::{
        block::BlobExcessGasAndPrice,
        result::{ExecutionResult, Output},
        Cfg, ContextTr,
    },
    database::{CacheDB, EmptyDB},
    database_interface::WrapDatabaseRef,
    handler::{
        instructions::EthInstructions, precompile_output_to_interpreter_result, EthFrame,
        EthPrecompiles, PrecompileProvider,
    },
    interpreter::{interpreter::EthInterpreter, CallInputs, InterpreterResult},
    precompile::PrecompileOutput,
    primitives::{
        eip4844::BLOB_BASE_FEE_UPDATE_FRACTION_CANCUN, hardfork::SpecId, Address, AddressSet,
        Bytes, TxKind, B256, U256,
    },
    state::{AccountInfo, Bytecode},
    ExecuteEvm,
};
use serde_json::{json, Value};

// The revm version we compiled against (kept in sync with Cargo.toml by hand).
const REVM_VERSION: &str = "43.0.3";

// ----------------------------------------------------------------------------
// ArbSys (address 0x64) — Arbitrum's built-in "system" contract.
// The ArbExecutor asks it for the L2 block number (arbBlockNumber(),
// selector 0xa3b1b31d). We answer it natively here, like Nitro does.
// ----------------------------------------------------------------------------
const ARBSYS: Address = Address::new([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x64,
]);
const ARB_BLOCK_NUMBER_SELECTOR: [u8; 4] = [0xa3, 0xb1, 0xb3, 0x1d];
// Gas charged for arbBlockNumber(). BEST ESTIMATE of Nitro's precompile
// accounting (800 for opening ArbOS state = one storage read, +3 to copy the
// 32-byte result). NOT verified against a live Robinhood node — override with
// env ARBSYS_GAS=<n> once checked.
const ARBSYS_GAS_DEFAULT: u64 = 803;

/// Our precompile set = the normal Ethereum (Cancun) precompiles + ArbSys.
#[derive(Clone)]
struct ArbPrecompiles {
    eth: EthPrecompiles,        // standard ecrecover, sha256, ... point-eval
    l2_block: Option<U256>,     // what arbBlockNumber() returns; None = no ArbSys
    arbsys_gas: u64,            // gas charged per arbBlockNumber() call
    warm: AddressSet,           // precompile addresses (start "warm", like Nitro)
}

impl ArbPrecompiles {
    fn new(l2_block: Option<U256>, arbsys_gas: u64) -> Self {
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

// ----------------------------------------------------------------------------
// The in-memory "mirror" of chain state, and the EVM built on top of it.
// ----------------------------------------------------------------------------

/// Base state: every account / storage slot the call touches. Read-only after load.
type BaseDb = CacheDB<EmptyDB>;
/// The EVM reads the base through a shared reference => it can never modify it.
type RefDb<'a> = WrapDatabaseRef<&'a BaseDb>;
type Ctx<'a> = Context<BlockEnv, TxEnv, CfgEnv, RefDb<'a>, Journal<RefDb<'a>>, ()>;
type MyEvm<'a> =
    Evm<Ctx<'a>, (), EthInstructions<EthInterpreter, Ctx<'a>>, ArbPrecompiles, EthFrame<EthInterpreter>>;

/// Everything loaded from one fixture file.
struct Fixture {
    name: String,
    chain_id: u64,
    block: BlockEnv,
    l2_block: Option<U256>,
    tx: TxEnv,
    expected: Value,
    base: BaseDb,
    json_parse_ms: f64,
    state_load_ms: f64,
    accounts: usize,
    slots: usize,
}

// --- small helpers to read hex strings / numbers from the JSON ---
fn hex_bytes(v: &Value) -> Bytes {
    let s = v.as_str().unwrap_or("0x");
    Bytes::from_str(if s.is_empty() { "0x" } else { s }).expect("bad hex bytes")
}
fn hex_u256(v: &Value) -> U256 {
    match v {
        Value::Number(n) => U256::from(n.as_u64().expect("bad number")),
        Value::String(s) => {
            let t = s.trim_start_matches("0x");
            if t.is_empty() { U256::ZERO } else { U256::from_str_radix(t, 16).expect("bad hex number") }
        }
        Value::Null => U256::ZERO,
        _ => panic!("bad number {v}"),
    }
}
fn hex_u64(v: &Value) -> u64 {
    hex_u256(v).to::<u64>()
}
fn addr(v: &Value) -> Address {
    Address::from_str(v.as_str().expect("address")).expect("bad address")
}

/// Read the fixture JSON and build the in-memory state. Timed in two parts.
fn load_fixture(path: &str) -> Fixture {
    let t0 = Instant::now();
    let raw = std::fs::read_to_string(path).expect("cannot read fixture");
    let j: Value = serde_json::from_str(&raw).expect("fixture is not valid JSON");
    let json_parse_ms = t0.elapsed().as_secs_f64() * 1e3;

    // Block context (what NUMBER, TIMESTAMP, BASEFEE, ... opcodes return).
    let b = &j["block"];
    let block = BlockEnv {
        number: hex_u256(&b["number"]),
        beneficiary: addr(&b["coinbase"]),
        timestamp: hex_u256(&b["timestamp"]),
        gas_limit: hex_u64(&b["gasLimit"]),
        basefee: hex_u64(&b["baseFee"]),
        difficulty: hex_u256(&b["difficulty"]),
        prevrandao: Some(B256::from(hex_u256(&b["prevrandao"]))),
        blob_excess_gas_and_price: Some(BlobExcessGasAndPrice::new(0, BLOB_BASE_FEE_UPDATE_FRACTION_CANCUN)),
        ..Default::default()
    };
    let l2_block = if j["l2BlockNumber"].is_null() { None } else { Some(hex_u256(&j["l2BlockNumber"])) };
    let chain_id = j["chainId"].as_u64().unwrap_or(1);

    // The transaction (eth_call style: gasPrice 0, no nonce/balance checks).
    let t = &j["tx"];
    let tx = make_tx(
        addr(&t["from"]),
        addr(&t["to"]),
        hex_bytes(&t["data"]),
        hex_u64(&t["gas"]),
        hex_u256(&t["value"]),
        chain_id,
    );

    // Prestate -> in-memory database. Anything not listed reads as empty/zero.
    let t1 = Instant::now();
    let mut base = CacheDB::new(EmptyDB::default());
    let (mut accounts, mut slots) = (0, 0);
    for (a, acc) in j["prestate"].as_object().expect("prestate") {
        let address = Address::from_str(a).expect("bad prestate address");
        let code = hex_bytes(&acc["code"]);
        let mut info = AccountInfo {
            balance: hex_u256(&acc["balance"]),
            nonce: hex_u64(&acc["nonce"]),
            ..Default::default()
        };
        if !code.is_empty() {
            // new_raw also pre-analyses the code (jump table) once, here, not per call.
            let bc = Bytecode::new_raw(code);
            info.code_hash = bc.hash_slow();
            info.code = Some(bc);
        }
        base.insert_account_info(address, info);
        if let Some(st) = acc["storage"].as_object() {
            for (k, v) in st {
                base.insert_account_storage(address, hex_u256(&Value::String(k.clone())), hex_u256(v))
                    .unwrap();
                slots += 1;
            }
        }
        accounts += 1;
    }
    let state_load_ms = t1.elapsed().as_secs_f64() * 1e3;

    Fixture {
        name: j["name"].as_str().unwrap_or("?").to_string(),
        chain_id,
        block,
        l2_block,
        tx,
        expected: j["expected"].clone(),
        base,
        json_parse_ms,
        state_load_ms,
        accounts,
        slots,
    }
}

/// Build a call transaction. Legacy type, gasPrice 0 (like eth_call).
fn make_tx(from: Address, to: Address, data: Bytes, gas: u64, value: U256, chain_id: u64) -> TxEnv {
    TxEnv {
        tx_type: 0,
        caller: from,
        gas_limit: gas,
        gas_price: 0,
        kind: TxKind::Call(to),
        value,
        data,
        nonce: 0,
        chain_id: Some(chain_id),
        ..Default::default()
    }
}

/// Build an EVM that reads (never writes) the base state. Built once, reused.
fn build_evm<'a>(f: &'a Fixture) -> MyEvm<'a> {
    let arbsys_gas = std::env::var("ARBSYS_GAS").ok().and_then(|s| s.parse().ok()).unwrap_or(ARBSYS_GAS_DEFAULT);
    let mut ctx: Ctx<'a> = Context::new(WrapDatabaseRef(&f.base), SpecId::CANCUN);
    ctx.modify_cfg(|c| {
        c.chain_id = f.chain_id;
        c.tx_chain_id_check = false;
        c.disable_nonce_check = true; // eth_call: no nonce check
        c.disable_base_fee = true; // eth_call: gasPrice 0 is fine
        c.disable_balance_check = true; // eth_call: sender needn't pay for gas
        c.disable_block_gas_limit = true;
        c.disable_eip3607 = true; // allow "from" to be a contract
    });
    ctx.block = f.block.clone();
    Evm::new(
        ctx,
        EthInstructions::new_mainnet_with_spec(SpecId::CANCUN),
        ArbPrecompiles::new(f.l2_block, arbsys_gas),
    )
}

/// The simplified answer the bot cares about.
#[derive(Clone, Debug)]
struct SimResult {
    status: u8, // 1 = success, 0 = revert, 2 = halt (out of gas, invalid opcode...), 3 = engine error
    output: Bytes,
    tx_gas: u64,    // gas incl. 21000 + calldata (what a receipt / callTracer shows), after refunds
    spent_gas: u64, // gas incl. intrinsic, before refunds
    halt: String,
}

fn to_sim(r: Result<ExecutionResult, impl std::fmt::Debug>) -> SimResult {
    match r {
        Ok(ExecutionResult::Success { gas, output, .. }) => SimResult {
            status: 1,
            output: match output { Output::Call(b) => b, Output::Create(b, _) => b },
            tx_gas: gas.tx_gas_used(),
            spent_gas: gas.total_gas_spent(),
            halt: String::new(),
        },
        Ok(ExecutionResult::Revert { gas, output, .. }) => SimResult {
            status: 0, output, tx_gas: gas.tx_gas_used(), spent_gas: gas.total_gas_spent(), halt: String::new(),
        },
        Ok(ExecutionResult::Halt { gas, reason, .. }) => SimResult {
            status: 2, output: Bytes::new(), tx_gas: gas.tx_gas_used(), spent_gas: gas.total_gas_spent(),
            halt: format!("{reason:?}"),
        },
        Err(e) => SimResult { status: 3, output: Bytes::new(), tx_gas: 0, spent_gas: 0, halt: format!("{e:?}") },
    }
}

/// Run ONE transaction against the unchanged base state, then throw its changes away.
#[inline]
fn sim_one(evm: &mut MyEvm<'_>, tx: TxEnv) -> SimResult {
    let r = evm.transact_one(tx);
    let _ = evm.finalize(); // discard all state changes -> next call starts clean
    to_sim(r)
}

/// Run several transactions IN ORDER, each seeing the previous one's changes
/// (tx B runs on the state left by tx A). Changes live only inside the EVM's
/// scratch journal; the base state is a read-only reference and never changes.
/// At the end everything is thrown away.
#[inline]
fn sim_chain(evm: &mut MyEvm<'_>, txs: Vec<TxEnv>) -> Vec<SimResult> {
    let mut out = Vec::with_capacity(txs.len());
    for tx in txs {
        out.push(to_sim(evm.transact_one(tx)));
    }
    let _ = evm.finalize();
    out
}

/// Gas charged before any code runs: 21000 + 4 per zero byte + 16 per non-zero calldata byte.
fn intrinsic_gas(data: &[u8]) -> u64 {
    21000 + data.iter().map(|&b| if b == 0 { 4u64 } else { 16 }).sum::<u64>()
}

// ----------------------------------------------------------------------------
// bench mode
// ----------------------------------------------------------------------------
fn pct(sorted: &[f64], p: f64) -> f64 {
    let i = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[i]
}
/// Turn a list of microsecond timings into a summary.
fn stats(mut v: Vec<f64>) -> Value {
    let first = v[0];
    let n = v.len();
    let total: f64 = v.iter().sum();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    json!({
        "n": n,
        "first_us": r2(first),
        "median_us": r2(pct(&v, 0.5)),
        "p90_us": r2(pct(&v, 0.9)),
        "p99_us": r2(pct(&v, 0.99)),
        "max_us": r2(*v.last().unwrap()),
        "min_us": r2(v[0]),
        "throughput_per_sec": (n as f64 / (total / 1e6)).round(),
    })
}
fn r2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}
fn hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(2 + b.len() * 2);
    s.push_str("0x");
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}

/// For the chained test (default tx A): same call, but with minProfit (tuple word 2)
/// set to 1 wei so the arbitrage actually goes through and changes pool/token state.
/// Calldata layout of execute((token,amountIn,minProfit,maxBlock,hops[]),flashPool):
///   [4 selector][32 offset->tuple][32 flashPool][tuple: token, amountIn, minProfit, ...]
fn with_min_profit_one(data: &Bytes) -> Bytes {
    let mut d = data.to_vec();
    let off = 4 + U256::from_be_slice(&d[4..36]).to::<usize>(); // where the tuple starts
    let mp = off + 64; // third word = minProfit
    d[mp..mp + 32].fill(0);
    d[mp + 31] = 1; // minProfit = 1 wei (0 is rejected by the contract with ZeroAmount())
    Bytes::from(d)
}

fn bench(path: &str, n: usize, chain_a: Option<Bytes>) {
    let f = load_fixture(path);
    let mut evm = build_evm(&f);
    let intrinsic = intrinsic_gas(&f.tx.data);

    // Timed runs: every run uses the identical starting state.
    let mut times = Vec::with_capacity(n);
    let mut first: Option<SimResult> = None;
    let mut mismatches = 0usize;
    for _ in 0..n {
        let tx = f.tx.clone();
        let t = Instant::now();
        let r = sim_one(&mut evm, tx);
        times.push(t.elapsed().as_secs_f64() * 1e6);
        match &first {
            None => first = Some(r),
            Some(f0) => {
                if f0.status != r.status || f0.output != r.output || f0.tx_gas != r.tx_gas {
                    mismatches += 1; // determinism check: every run must give the same answer
                }
            }
        }
    }
    let r = first.unwrap();

    // Correctness vs what the reference node said.
    let e = &f.expected;
    let exp_success = e["success"].as_bool().unwrap_or(false);
    let exp_output = e["output"].as_str().unwrap_or("0x").to_lowercase();
    let exp_gas = hex_u64(&e["gasUsed"]);
    let out_hex = hex(&r.output);
    let exec_gas = r.tx_gas.saturating_sub(intrinsic);

    // Chained run: A = a state-changing tx (from --chain-a, default: same trade
    // with minProfit=1 wei), then B = the original check on the post-A state.
    // Compare B with B on the untouched base.
    let a_data = chain_a.unwrap_or_else(|| with_min_profit_one(&f.tx.data));
    let tx_a = TxEnv { data: a_data, ..f.tx.clone() };
    let chain_n = n.min(2000);
    let mut ctimes = Vec::with_capacity(chain_n);
    let mut chain_res = Vec::new();
    for i in 0..chain_n {
        let txs = vec![tx_a.clone(), f.tx.clone()];
        let t = Instant::now();
        let rs = sim_chain(&mut evm, txs);
        ctimes.push(t.elapsed().as_secs_f64() * 1e6);
        if i == 0 {
            chain_res = rs;
        }
    }
    // Prove the base was not modified: B alone on the base must still equal run #1.
    let after = sim_one(&mut evm, f.tx.clone());
    let base_untouched = after.output == r.output && after.tx_gas == r.tx_gas && after.status == r.status;

    let sim_json = |s: &SimResult| {
        let st = ["revert", "success", "halt", "error"][s.status as usize];
        json!({ "status": st, "output": hex(&s.output),
                "txGas": s.tx_gas, "haltReason": s.halt })
    };

    let report = json!({
        "engine": "revm",
        "revm_version": REVM_VERSION,
        "spec": "CANCUN",
        "fixture": f.name,
        "prestate": { "accounts": f.accounts, "slots": f.slots,
                      "json_parse_ms": r2(f.json_parse_ms), "state_load_ms": r2(f.state_load_ms) },
        "arbsys": f.l2_block.map(|n| json!({"l2BlockNumber": n.to_string(), "gasCharged":
            std::env::var("ARBSYS_GAS").ok().and_then(|s| s.parse::<u64>().ok()).unwrap_or(ARBSYS_GAS_DEFAULT)})),
        "correctness": {
            "success": { "revm": r.status == 1, "expected": exp_success, "match": (r.status == 1) == exp_success },
            "output": { "revm": out_hex, "expected": exp_output, "match": out_hex == exp_output },
            "gas": {
                "expected_gasUsed": exp_gas,
                "revm_tx_level_gas": r.tx_gas,
                "revm_tx_level_gas_before_refund": r.spent_gas,
                "revm_execution_only_gas": exec_gas,
                "intrinsic_gas": intrinsic,
                "tx_level_match": r.tx_gas == exp_gas,
                "execution_only_match": exec_gas == exp_gas,
                "diff_tx_level_minus_expected": r.tx_gas as i64 - exp_gas as i64,
            },
            "halt_reason": r.halt,
            "exact_match": (r.status == 1) == exp_success && out_hex == exp_output && r.tx_gas == exp_gas,
            "deterministic_over_runs": mismatches == 0,
        },
        "timing_single_sim": stats(times),
        "chained": {
            "description": "A = same execute() with minProfit=1 wei (state-changing), then B = original call on post-A state; base untouched",
            "A": sim_json(&chain_res[0]),
            "B_after_A": sim_json(&chain_res[1]),
            "B_on_base": sim_json(&r),
            "B_changed_by_A": chain_res[1].output != r.output || chain_res[1].tx_gas != r.tx_gas,
            "base_state_untouched_after": base_untouched,
            "timing_A_plus_B": stats(ctimes),
        }
    });
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}

// ----------------------------------------------------------------------------
// serve mode — PROTOCOL (all integers little-endian):
//
//   Request frame:  u32 body_len | body
//     body = u8 tx_count, then tx_count times:
//            from[20] | to[20] | u64 gas | value[32 big-endian] | u32 data_len | data
//     tx_count = 1 -> a normal check against the base state.
//     tx_count > 1 -> CHAINED: each tx runs on the state left by the previous one.
//
//   Response frame: u32 body_len | body
//     body = u8 result_count, then per result:
//            u8 status (1 success, 0 revert, 2 halt, 3 error) | u64 tx_gas | u32 out_len | output
//            then a trailer: u64 exec_ns (time spent running the EVM inside the sidecar)
//
//   Binary + length prefix = no JSON parsing or hex conversion on the hot path.
// ----------------------------------------------------------------------------
fn serve(path: &str, sock: &str) {
    let f: &'static Fixture = Box::leak(Box::new(load_fixture(path)));
    let _ = std::fs::remove_file(sock);
    let listener = UnixListener::bind(sock).expect("cannot bind socket");
    eprintln!(
        "[revm-sidecar] revm {REVM_VERSION} ready: fixture={} accounts={} slots={} load={:.2}ms socket={sock}",
        f.name, f.accounts, f.slots, f.json_parse_ms + f.state_load_ms
    );
    // One thread per connection; each has its own EVM over the shared read-only base.
    for conn in listener.incoming() {
        let Ok(stream) = conn else { continue };
        std::thread::spawn(move || {
            let _ = handle_conn(stream, f);
        });
    }
}

fn handle_conn(mut s: UnixStream, f: &Fixture) -> std::io::Result<()> {
    let mut evm = build_evm(f);
    let mut len4 = [0u8; 4];
    let mut body = Vec::with_capacity(4096);
    let mut resp = Vec::with_capacity(4096);
    loop {
        if s.read_exact(&mut len4).is_err() {
            return Ok(()); // client went away
        }
        let len = u32::from_le_bytes(len4) as usize;
        body.resize(len, 0);
        s.read_exact(&mut body)?;

        // Decode the transaction(s).
        let mut p = 0usize;
        let count = body[p] as usize;
        p += 1;
        let mut txs = Vec::with_capacity(count);
        for _ in 0..count {
            let from = Address::from_slice(&body[p..p + 20]);
            let to = Address::from_slice(&body[p + 20..p + 40]);
            let gas = u64::from_le_bytes(body[p + 40..p + 48].try_into().unwrap());
            let value = U256::from_be_slice(&body[p + 48..p + 80]);
            let dlen = u32::from_le_bytes(body[p + 80..p + 84].try_into().unwrap()) as usize;
            let data = Bytes::copy_from_slice(&body[p + 84..p + 84 + dlen]);
            p += 84 + dlen;
            txs.push(make_tx(from, to, data, gas, value, f.chain_id));
        }

        // Run (timed inside the sidecar, so the client can split EVM time vs transport time).
        let t_exec = Instant::now();
        let results = if txs.len() == 1 { vec![sim_one(&mut evm, txs.pop().unwrap())] } else { sim_chain(&mut evm, txs) };

        // Encode the answer.
        resp.clear();
        resp.extend_from_slice(&[0, 0, 0, 0]); // length placeholder
        resp.push(results.len() as u8);
        for r in &results {
            resp.push(r.status);
            resp.extend_from_slice(&r.tx_gas.to_le_bytes());
            resp.extend_from_slice(&(r.output.len() as u32).to_le_bytes());
            resp.extend_from_slice(&r.output);
        }
        // Trailer: u64 nanoseconds spent decoding + executing inside the sidecar.
        resp.extend_from_slice(&(t_exec.elapsed().as_nanos() as u64).to_le_bytes());
        let blen = (resp.len() - 4) as u32;
        resp[..4].copy_from_slice(&blen.to_le_bytes());
        s.write_all(&resp)?;
    }
}

// ----------------------------------------------------------------------------
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let usage = "usage:\n  revm-bench bench <fixture.json> [--n 5000] [--chain-a calldata.hex]\n  revm-bench serve <fixture.json> <socket-path>";
    match args.get(1).map(|s| s.as_str()) {
        Some("bench") => {
            let path = args.get(2).expect(usage);
            let n = args.iter().position(|a| a == "--n").and_then(|i| args.get(i + 1)).and_then(|s| s.parse().ok()).unwrap_or(5000);
            // Optional: --chain-a <file with hex calldata> = custom tx A for the chained test.
            let chain_a = args.iter().position(|a| a == "--chain-a").and_then(|i| args.get(i + 1))
                .map(|p| hex_bytes(&Value::String(std::fs::read_to_string(p).expect("chain-a file").trim().to_string())));
            bench(path, n, chain_a);
        }
        Some("serve") => serve(args.get(2).expect(usage), args.get(3).expect(usage)),
        _ => {
            eprintln!("{usage}");
            std::process::exit(2);
        }
    }
}
