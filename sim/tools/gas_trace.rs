// ============================================================================
// gas_trace: per-call-frame gas of one fixture, as arbsim (revm) computes it.
//
// Plain English:
//   Runs a saved fixture (the real trade's state + call) in our simulator
//   with a tracer attached, and prints ONE LINE PER CALL FRAME with how much
//   gas that frame used. tools/gas-diff.js prints the SAME format from the
//   real node, so the two outputs can be compared line by line
//   (`diff` or `node tools/gas-diff.js --compare`) to find the exact call
//   where the numbers start to differ.
//
// Run:  cargo run --release --example gas_trace -- <fixture.json> [--json]
//       [--arbsys-gas N] [--arbos N] [--ethcall] [--ops]
//   --ethcall : block as eth_call sees it (BASEFEE 0). Default: as the mined
//               tx saw it (real BASEFEE), which matches debug_traceTransaction.
//   --ops     : also print every opcode with gas (big; for one fixture only)
//
// Output line format (shared with gas-diff.js):
//   F <path> <TYPE> <to> in=<input bytes> gas=<gas given> used=<gas used> <ok|revert|halt:...> out=<first 4 bytes of output>
//   path = frame position, "0" top, "0.2" = 3rd child of top, ...
//   Last line: "T tx gasUsed=<tx gas> intrinsic=<21000+calldata> exec=<top frame used> refund=<refund>"
// ============================================================================
use std::str::FromStr;

use arbsim::arb::{self, evm::build_evm_with_inspector, ArbConfig, BlockCtx};
use arbsim::check::fixture::Fixture;
use revm::{
    context::TxEnv,
    context_interface::{result::ExecutionResult, ContextTr},
    interpreter::{interpreter_types::Jumps, CallInputs, CallOutcome, CallScheme, CreateInputs, CreateOutcome, Interpreter},
    primitives::{Address, TxKind},
    database::{CacheDB, EmptyDB},
    state::AccountInfo,
    InspectEvm, Inspector,
};

/// One open call frame.
struct Open {
    path: String,
    kind: &'static str,
    to: Address,
    input_len: usize,
    gas: u64,
    children: usize,
    line_idx: usize,
}

/// Collects one line per call frame.
#[derive(Default)]
struct FrameTracer {
    stack: Vec<Open>,
    lines: Vec<String>,
    top_children: usize,
    ops: bool,
}

impl FrameTracer {
    fn enter(&mut self, kind: &'static str, to: Address, input_len: usize, gas: u64) {
        let path = match self.stack.last_mut() {
            Some(p) => {
                let i = p.children;
                p.children += 1;
                format!("{}.{}", p.path, i)
            }
            None => {
                self.top_children += 1;
                "0".to_string()
            }
        };
        let line_idx = self.lines.len();
        self.lines.push(String::new()); // filled at exit (keeps call order)
        self.stack.push(Open { path, kind, to, input_len, gas, children: 0, line_idx });
    }
    fn exit(&mut self, used: u64, status: String, out: &[u8]) {
        if let Some(o) = self.stack.pop() {
            let out4: String = out.iter().take(4).map(|b| format!("{b:02x}")).collect();
            self.lines[o.line_idx] = format!(
                "F {} {} {:?} in={} gas={} used={} {} out=0x{}",
                o.path, o.kind, o.to, o.input_len, o.gas, used, status, out4
            );
        }
    }
}

fn status_of(r: &revm::interpreter::InstructionResult) -> String {
    if r.is_ok() {
        "ok".into()
    } else if r.is_revert() {
        "revert".into()
    } else {
        format!("halt:{r:?}")
    }
}

impl<CTX: ContextTr> Inspector<CTX> for FrameTracer {
    fn step(&mut self, interp: &mut Interpreter, _context: &mut CTX) {
        if self.ops {
            let op = interp.bytecode.opcode();
            let name = revm::bytecode::OpCode::name_by_op(op);
            let depth = self.stack.len();
            // Remaining gas BEFORE the opcode (geth structLog "gas" field).
            println!("O {} pc={} {} gas={}", depth, interp.bytecode.pc(), name, interp.gas.remaining());
        }
    }
    fn call(&mut self, _context: &mut CTX, inputs: &mut CallInputs) -> Option<CallOutcome> {
        let kind = match inputs.scheme {
            CallScheme::Call => "CALL",
            CallScheme::CallCode => "CALLCODE",
            CallScheme::DelegateCall => "DELEGATECALL",
            CallScheme::StaticCall => "STATICCALL",
        };
        self.enter(kind, inputs.target_address, inputs.input.len(), inputs.gas_limit);
        None
    }
    fn call_end(&mut self, _context: &mut CTX, _inputs: &CallInputs, outcome: &mut CallOutcome) {
        let g = outcome.gas();
        let used = g.limit().saturating_sub(g.remaining());
        let st = status_of(outcome.instruction_result());
        self.exit(used, st, outcome.output());
    }
    fn create(&mut self, _context: &mut CTX, inputs: &mut CreateInputs) -> Option<CreateOutcome> {
        self.enter("CREATE", Address::ZERO, inputs.init_code().len(), inputs.gas_limit());
        None
    }
    fn create_end(&mut self, _context: &mut CTX, _inputs: &CreateInputs, outcome: &mut CreateOutcome) {
        let g = outcome.gas();
        let used = g.limit().saturating_sub(g.remaining());
        let st = status_of(outcome.instruction_result());
        self.exit(used, st, outcome.output());
    }
}

/// 21000 + 4/zero byte + 16/non-zero calldata byte (no access list in fixtures).
fn intrinsic(data: &[u8]) -> u64 {
    21_000 + data.iter().map(|b| if *b == 0 { 4 } else { 16 }).sum::<u64>()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(path) = args.get(1).filter(|a| !a.starts_with("--")) else {
        eprintln!("usage: gas_trace <fixture.json> [--json] [--arbsys-gas N] [--arbos N] [--ethcall] [--ops]");
        std::process::exit(2);
    };
    let flag = |n: &str| args.iter().any(|a| a == n);
    let num = |n: &str| args.iter().position(|a| a == n).and_then(|i| args.get(i + 1)).and_then(|s| s.parse::<u64>().ok());

    let f = Fixture::load(path).unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(2)
    });
    let mut cfg = ArbConfig::default();
    if let Some(v) = num("--arbos") {
        cfg.arbos_version = v;
    }
    let arbsys_gas = num("--arbsys-gas").unwrap_or(arb::ARBSYS_GAS_DEFAULT);
    let ctx: BlockCtx = f.ctx.clone();

    // Fixture state -> revm in-memory DB (unlisted = empty, like the fixture rules).
    let mut db = CacheDB::new(EmptyDB::default());
    for (a, info) in &f.state.accounts {
        let mut i: AccountInfo = info.clone();
        if i.code.is_none() {
            i.code = f.state.codes.get(&i.code_hash).cloned();
        }
        db.insert_account_info(*a, i);
    }
    for (a, slots) in &f.state.storage {
        for (k, v) in slots {
            db.insert_account_storage(*a, *k, *v).unwrap();
        }
    }

    let tracer = FrameTracer { ops: flag("--ops"), ..Default::default() };
    let mut evm = build_evm_with_inspector(db, &ctx, &cfg, arbsys_gas, flag("--ethcall"), tracer);
    let tx = TxEnv {
        tx_type: 0,
        caller: f.call.from,
        gas_limit: f.call.gas.unwrap_or(30_000_000),
        gas_price: 0,
        kind: f.call.to.map(TxKind::Call).unwrap_or(TxKind::Create),
        value: f.call.value,
        data: f.call.data.clone(),
        nonce: 0,
        chain_id: Some(cfg.chain_id),
        ..Default::default()
    };
    let r = evm.inspect_one_tx(tx);
    let unsupported = evm.precompiles.unsupported().map(|u| u.to_string());
    let tr = std::mem::take(&mut evm.inspector);

    let (tx_gas, refund, status) = match &r {
        Ok(ExecutionResult::Success { gas, .. }) => (gas.tx_gas_used(), gas.final_refunded(), "ok".to_string()),
        Ok(ExecutionResult::Revert { gas, .. }) => (gas.tx_gas_used(), gas.final_refunded(), "revert".to_string()),
        Ok(ExecutionResult::Halt { gas, reason, .. }) => (gas.tx_gas_used(), gas.final_refunded(), format!("halt:{reason:?}")),
        Err(e) => (0, 0, format!("error:{e:?}")),
    };
    let intr = intrinsic(&f.call.data);
    let top_used = tr.lines.first().and_then(|l| l.split(" used=").nth(1)).and_then(|s| s.split(' ').next()).and_then(|s| u64::from_str(s).ok()).unwrap_or(0);

    if flag("--json") {
        let frames: Vec<&String> = tr.lines.iter().collect();
        println!(
            "{}",
            serde_json::json!({
                "fixture": f.name, "engine": "arbsim", "arbosVersion": cfg.arbos_version, "spec": format!("{:?}", cfg.spec()),
                "status": status, "txGasUsed": tx_gas, "intrinsic": intr, "topFrameUsed": top_used, "refund": refund,
                "expectedGasUsed": f.expected.gas_used, "diff": tx_gas as i64 - f.expected.gas_used as i64,
                "unsupported": unsupported, "frames": frames,
            })
        );
    } else {
        println!("# arbsim {} arbos={} spec={:?} arbsysGas={}", f.name, cfg.arbos_version, cfg.spec(), arbsys_gas);
        for l in &tr.lines {
            println!("{l}");
        }
        println!("T tx gasUsed={tx_gas} intrinsic={intr} exec={top_used} refund={refund} status={status}");
        println!(
            "# expected(node callTracer)={} diff(arbsim-node)={}{}",
            f.expected.gas_used,
            tx_gas as i64 - f.expected.gas_used as i64,
            unsupported.map(|u| format!(" UNSUPPORTED: {u}")).unwrap_or_default()
        );
    }
}
