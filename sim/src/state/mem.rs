// ============================================================================
// MemState: a simple, fixed state loaded from a test file (fixture).
//
// Plain English:
//   Test files (tests/fixtures/*.json, format in DESIGN.md / the bench's
//   FIXTURE_FORMAT.md) list every account and slot one real check touched.
//   This loads them so checks can be run and compared with the chain's own
//   answer, without any node. Used by tests, `arbsim check-fixture` and the
//   comparison harness.
//
//   `unlisted_is_empty`: fixtures come from prestateTracer, which lists
//   EVERYTHING the check touched, so for a fixture "not listed" really means
//   "empty". For the live mirror that is never true (unlisted = Missing).
// ============================================================================
use std::collections::HashMap;

use revm::primitives::{keccak256, Address, B256, U256};
use revm::state::{AccountInfo, Bytecode};
use serde_json::Value;

use super::{Lookup, StatePosition, StateRead};

#[derive(Default, Clone)]
pub struct MemState {
    pub accounts: HashMap<Address, AccountInfo>,
    pub storage: HashMap<Address, HashMap<U256, U256>>,
    pub codes: HashMap<B256, Bytecode>,
    pub unlisted_is_empty: bool,
    pub pos: StatePosition,
}

/// Parse "0x..." as a number (empty / "0x" = 0).
pub fn hex_u256(v: &Value) -> U256 {
    match v {
        Value::String(s) => {
            let t = s.trim_start_matches("0x");
            if t.is_empty() { U256::ZERO } else { U256::from_str_radix(t, 16).unwrap_or(U256::ZERO) }
        }
        Value::Number(n) => U256::from(n.as_u64().unwrap_or(0)),
        _ => U256::ZERO,
    }
}

/// Parse "0x..." bytes.
pub fn hex_bytes(v: &Value) -> Vec<u8> {
    let s = v.as_str().unwrap_or("0x").trim_start_matches("0x");
    (0..s.len() / 2).filter_map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok()).collect()
}

pub fn parse_addr(s: &str) -> Address {
    let b = hex_bytes(&Value::String(s.to_string()));
    let mut a = [0u8; 20];
    if b.len() == 20 { a.copy_from_slice(&b); }
    Address::from(a)
}

impl MemState {
    /// Load the `prestate` object of a fixture (prestateTracer format).
    pub fn from_prestate(pre: &Value, unlisted_is_empty: bool) -> Self {
        let mut s = MemState { unlisted_is_empty, ..Default::default() };
        if let Some(obj) = pre.as_object() {
            for (addr_s, acct) in obj {
                let addr = parse_addr(addr_s);
                let code_bytes = hex_bytes(acct.get("code").unwrap_or(&Value::Null));
                let (code_hash, code) = if code_bytes.is_empty() {
                    (revm::primitives::KECCAK_EMPTY, None)
                } else {
                    let bc = Bytecode::new_raw(code_bytes.clone().into());
                    (keccak256(&code_bytes), Some(bc))
                };
                if let Some(bc) = &code { s.codes.insert(code_hash, bc.clone()); }
                let info = AccountInfo {
                    balance: hex_u256(acct.get("balance").unwrap_or(&Value::Null)),
                    nonce: acct.get("nonce").map(|n| hex_u256(n).to::<u64>()).unwrap_or(0),
                    code_hash,
                    code,
                    ..Default::default()
                };
                s.accounts.insert(addr, info);
                let st = s.storage.entry(addr).or_default();
                if let Some(slots) = acct.get("storage").and_then(|v| v.as_object()) {
                    for (k, v) in slots {
                        st.insert(hex_u256(&Value::String(k.clone())), hex_u256(v));
                    }
                }
            }
        }
        s
    }
}

impl StateRead for MemState {
    fn account(&self, addr: Address) -> Lookup<Option<AccountInfo>> {
        match self.accounts.get(&addr) {
            Some(a) => Lookup::Known(Some(a.clone())),
            None if self.unlisted_is_empty => Lookup::Known(None),
            None => Lookup::Missing,
        }
    }
    fn storage(&self, addr: Address, slot: U256) -> Lookup<U256> {
        match self.storage.get(&addr).and_then(|m| m.get(&slot)) {
            Some(v) => Lookup::Known(*v),
            None if self.unlisted_is_empty => Lookup::Known(U256::ZERO),
            None => Lookup::Missing,
        }
    }
    fn code_by_hash(&self, hash: B256) -> Lookup<Bytecode> {
        if hash == revm::primitives::KECCAK_EMPTY { return Lookup::Known(Bytecode::default()); }
        match self.codes.get(&hash) {
            Some(c) => Lookup::Known(c.clone()),
            None => Lookup::Missing,
        }
    }
    fn position(&self) -> StatePosition { self.pos }
}
