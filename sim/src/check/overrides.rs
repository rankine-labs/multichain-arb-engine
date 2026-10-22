// ============================================================================
// PRETEND-STATE ("state overrides"), exactly like geth's eth_call 3rd param.
//
// Plain English:
//   For one question only, the bot can say "pretend that ...":
//     code       this address runs THIS contract code (our ArbExecutor at a
//                test address, so nothing has to be deployed)
//     balance    this address holds this much ETH
//     nonce      this address has sent this many transactions
//     state      this address's storage is EXACTLY these slots; every other
//                slot of it reads zero (the old storage is ignored entirely)
//     stateDiff  change only these slots; the rest stay as on the chain
//   geth refuses an account that has both `state` and `stateDiff`; so do we.
//   Nothing here is ever written to our copy of the chain.
//
//   Code given as an override is "analysed" (jump table built) once and kept
//   in a small cache keyed by its hash, because the bot sends the same ~20 KB
//   ArbExecutor code with every check.
// ============================================================================
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use revm::primitives::{keccak256, Address, B256, U256};
use revm::state::Bytecode;
use serde_json::Value;

use super::hexutil::{parse_address, parse_bytes, parse_u256, parse_u64};

/// Pretend-state for one account.
#[derive(Clone, Debug, Default)]
pub struct AccountOverride {
    pub balance: Option<U256>,
    pub nonce: Option<u64>,
    /// Replacement code (already analysed) and its hash.
    pub code: Option<(B256, Bytecode)>,
    /// `state`: the account's WHOLE storage (unlisted slots = zero).
    pub state: Option<HashMap<U256, U256>>,
    /// `stateDiff`: only these slots change.
    pub state_diff: HashMap<U256, U256>,
}

impl AccountOverride {
    /// True when this override fully defines the account's basics, so the
    /// real account doesn't need to be looked up at all.
    pub fn defines_basics(&self) -> bool {
        self.balance.is_some() && self.nonce.is_some() && self.code.is_some()
    }
}

/// Pretend-state for all accounts of one request.
#[derive(Clone, Debug, Default)]
pub struct Overrides {
    pub accounts: HashMap<Address, AccountOverride>,
}

impl Overrides {
    pub fn none() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.accounts.is_empty()
    }

    pub fn get(&self, a: &Address) -> Option<&AccountOverride> {
        self.accounts.get(a)
    }

    /// Code given by an override with this hash (so code_by_hash can find it).
    pub fn code_by_hash(&self, h: &B256) -> Option<&Bytecode> {
        self.accounts.values().find_map(|o| match &o.code {
            Some((ch, bc)) if ch == h => Some(bc),
            _ => None,
        })
    }

    /// Read the geth JSON shape: `{ "0xaddr": { "code", "balance", "nonce",
    /// "state", "stateDiff" } }`. `null` / missing = no overrides.
    /// Unknown fields are refused (so a feature we don't support can never be
    /// silently ignored and give a wrong answer).
    pub fn from_json(v: &Value) -> Result<Self, String> {
        let mut out = Overrides::default();
        let obj = match v {
            Value::Null => return Ok(out),
            Value::Object(o) => o,
            _ => return Err("overrides must be an object".into()),
        };
        for (addr_s, acct) in obj {
            let addr = parse_address(addr_s).map_err(|e| format!("override address {addr_s:.12}: {e}"))?;
            let fields = acct.as_object().ok_or_else(|| format!("override for {addr_s:.12} must be an object"))?;
            let mut o = AccountOverride::default();
            for (k, val) in fields {
                // Explicit nulls are treated as "not given" (some clients send them).
                if val.is_null() {
                    continue;
                }
                match k.as_str() {
                    "balance" => o.balance = Some(parse_u256(str_of(val, k)?)?),
                    "nonce" => o.nonce = Some(parse_u64(str_or_num(val, k)?.as_str())?),
                    "code" => {
                        let bytes = parse_bytes(str_of(val, k)?)?;
                        o.code = Some(analysed_code(&bytes));
                    }
                    "state" => o.state = Some(slot_map(val, k)?),
                    "stateDiff" => o.state_diff = slot_map(val, k)?,
                    other => return Err(format!("override field '{other}' not supported")),
                }
            }
            // geth: "account has both 'state' and 'stateDiff'" is an error.
            if o.state.is_some() && !o.state_diff.is_empty() {
                return Err(format!("override for {addr_s:.12} has both state and stateDiff"));
            }
            out.accounts.insert(addr, o);
        }
        Ok(out)
    }
}

fn str_of<'a>(v: &'a Value, k: &str) -> Result<&'a str, String> {
    v.as_str().ok_or_else(|| format!("override field '{k}' must be hex text"))
}

// Nonce may come as hex text or a plain JSON number.
fn str_or_num(v: &Value, k: &str) -> Result<String, String> {
    match v {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => n.as_u64().map(|x| x.to_string()).ok_or_else(|| format!("bad {k}")),
        _ => Err(format!("override field '{k}' must be a number")),
    }
}

fn slot_map(v: &Value, k: &str) -> Result<HashMap<U256, U256>, String> {
    let o = v.as_object().ok_or_else(|| format!("override field '{k}' must be an object"))?;
    let mut m = HashMap::with_capacity(o.len());
    for (slot, val) in o {
        let s = parse_u256(slot).map_err(|e| format!("{k} slot: {e}"))?;
        let x = parse_u256(val.as_str().ok_or_else(|| format!("{k} value must be hex text"))?)
            .map_err(|e| format!("{k} value: {e}"))?;
        m.insert(s, x);
    }
    Ok(m)
}

/// Analysed code for these bytes, from a small cache (same code every check).
pub fn analysed_code(bytes: &[u8]) -> (B256, Bytecode) {
    static CACHE: OnceLock<Mutex<HashMap<B256, Bytecode>>> = OnceLock::new();
    let hash = keccak256(bytes);
    if bytes.is_empty() {
        return (revm::primitives::KECCAK_EMPTY, Bytecode::default());
    }
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(c) = cache.lock() {
        if let Some(bc) = c.get(&hash) {
            return (hash, bc.clone());
        }
    }
    let bc = Bytecode::new_raw(bytes.to_vec().into());
    if let Ok(mut c) = cache.lock() {
        // Memory bound: a handful of different contracts is normal; if many
        // distinct codes show up, just start over.
        if c.len() >= 32 {
            c.clear();
        }
        c.insert(hash, bc.clone());
    }
    (hash, bc)
}
