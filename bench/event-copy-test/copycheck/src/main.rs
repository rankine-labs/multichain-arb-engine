// ============================================================================
// copycheck: run one ArbExecutor check per input line with the bot's real
// simulator engine (the arbsim library in the repo's sim/ folder), and print
// one JSON answer per line.
//
// Plain English:
//   Input  = one fixture per line, same format as `arbsim check-fixture`.
//   Without the extra field "copyMode" it behaves exactly like arbsim:
//   anything not listed is empty/zero.
//
//   With "copyMode" (used for our EVENT-ONLY copy) the rules are stricter,
//   so a check can never silently read a zero that we never really knew:
//     - "complete": accounts whose storage we hold IN FULL. A slot of such an
//        account that is not listed really is zero (we know that).
//     - "unknown": {account: [slots]}  slots our copy knows it does NOT know.
//        Reading one = "needs node" (the check stops and lists it).
//     - every other account: an unlisted slot is UNKNOWN (needs node).
//     - an account that is not listed at all is UNKNOWN (needs node).
//   Output = success, output bytes, gas, and the list of missing items.
// ============================================================================
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};

use arbsim::check::fixture::{fixture_opts, Fixture};
use arbsim::check::hexutil::{parse_address, parse_u256, to_hex};
use arbsim::check::overrides::Overrides;
use arbsim::check::proto_types::miss_json;
use arbsim::check::run_calls_opts;
use arbsim::state::mem::MemState;
use arbsim::state::{Lookup, StatePosition, StateRead};
use revm::primitives::{Address, B256, U256};
use revm::state::{AccountInfo, Bytecode};
use serde_json::{json, Value};

const ARBSYS: Address = Address::new([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x64]);

/// The event-only copy as the engine sees it (see the rules above).
struct CopyState {
    mem: MemState,
    complete: HashSet<Address>,
    unknown: HashMap<Address, HashSet<U256>>,
}

impl StateRead for CopyState {
    fn account(&self, addr: Address) -> Lookup<Option<AccountInfo>> {
        match self.mem.accounts.get(&addr) {
            Some(a) => Lookup::Known(Some(a.clone())),
            // Address 0x64 (ArbSys) is handled by the engine itself on the
            // real chain; in these plain-EVM fixtures it is an empty account,
            // which the bot knows without asking a node.
            None if addr == ARBSYS => Lookup::Known(None),
            None => Lookup::Missing, // never listed = we don't know it
        }
    }
    fn storage(&self, addr: Address, slot: U256) -> Lookup<U256> {
        if self.unknown.get(&addr).map_or(false, |s| s.contains(&slot)) {
            return Lookup::Missing; // our copy can't vouch for this slot
        }
        match self.mem.storage.get(&addr).and_then(|m| m.get(&slot)) {
            Some(v) => Lookup::Known(*v),
            None if self.complete.contains(&addr) => Lookup::Known(U256::ZERO),
            None => Lookup::Missing,
        }
    }
    fn code_by_hash(&self, hash: B256) -> Lookup<Bytecode> {
        self.mem.code_by_hash(hash)
    }
    fn position(&self) -> StatePosition {
        self.mem.position()
    }
}

fn run_one(line: &str) -> Value {
    let j: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return json!({ "error": e.to_string() }),
    };
    let f = match Fixture::from_json(j) {
        Ok(f) => f,
        Err(e) => return json!({ "error": e }),
    };
    let ov = Overrides::none();
    let call = std::slice::from_ref(&f.call);
    let result = match f.raw.get("copyMode") {
        // Plain fixture: identical to `arbsim check-fixture` (unlisted = empty).
        None => run_calls_opts(&f.state, &f.ctx, &ov, &[], call, fixture_opts()),
        Some(cm) => {
            let mem = MemState::from_prestate(f.raw.get("prestate").unwrap(), false);
            let complete = cm.get("complete").and_then(|v| v.as_array()).map(|a| {
                a.iter().filter_map(|x| x.as_str()).filter_map(|s| parse_address(s).ok()).collect()
            }).unwrap_or_default();
            let mut unknown: HashMap<Address, HashSet<U256>> = HashMap::new();
            if let Some(obj) = cm.get("unknown").and_then(|v| v.as_object()) {
                for (a, slots) in obj {
                    let Ok(addr) = parse_address(a) else { continue };
                    let set = unknown.entry(addr).or_default();
                    for s in slots.as_array().into_iter().flatten() {
                        if let Some(Ok(u)) = s.as_str().map(parse_u256) { set.insert(u); }
                    }
                }
            }
            let cs = CopyState { mem, complete, unknown };
            run_calls_opts(&cs, &f.ctx, &ov, &[], call, fixture_opts())
        }
    };
    match result {
        Ok(out) => {
            let o = &out[0];
            json!({ "fixture": f.name, "success": o.success, "output": to_hex(&o.output),
                    "gasUsed": format!("{:#x}", o.gas_used), "halt": o.halt, "missing": [] })
        }
        Err(u) => json!({ "fixture": f.name, "unknown": u.reason.as_str(), "detail": u.detail,
                          "missing": u.missing.iter().map(miss_json).collect::<Vec<_>>() }),
    }
}

fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let _ = writeln!(out, "{}", run_one(&line));
        let _ = out.flush();
    }
}
