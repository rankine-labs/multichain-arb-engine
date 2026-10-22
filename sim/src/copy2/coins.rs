// ============================================================================
// COPY 2 COINS: where each coin keeps its balances, and keeping our pools'
// coin balances current from the coins' Transfer events.
//
// Plain English:
//   A pool's swap asks its coins "how much of you do I hold?" (balanceOf).
//   The coin answers from a storage slot. To answer that ourselves we need
//   to know WHICH slot holds "balance of address X" for that coin. Most
//   coins use a Solidity mapping at some slot number N (slot =
//   keccak(X . N)); some (Vyper) use keccak(N . X).
//
//   Finding N (once per coin, then remembered): the same trick the bot uses
//   (src/execution/simulator.ts findBalanceSlot). Ask the node to run
//   balanceOf(probe) while pretending each candidate slot (0..60, both
//   layouts = 122 places) holds a different marker number; the marker that
//   comes back says which place the coin read. A second call confirms it.
//   Two node requests per coin, ever. The bot can also hand us its own
//   answers in `track` (coinSlots), which costs nothing.
//
//   Before we rely on it for a pool, intake.rs also checks that the slot
//   really equals balanceOf(pool) at the same block. That catches coins
//   whose "balance" is computed (rebasing coins keep shares, not amounts):
//   such a coin makes its pools UNSURE, never guessed.
//
//   Keeping balances current: every coin Transfer(from, to, amount) where
//   from or to is a pool we follow changes that pool's balance slot by the
//   amount (if we hold the slot; an unknown slot stays unknown). The OTHER
//   side (a wallet, the bot's contract) is not followed: if we hold its
//   slot we forget it, because other transfers of that wallet never reach
//   us (it is fetched again when a check needs it).
// ============================================================================
use revm::primitives::{keccak256, Address, U256};
use serde_json::{json, Value};

use crate::check::hexutil::{parse_u256, to_hex};
use crate::node::{tag, Class, NodeApi, NodeErr};

/// Where a coin keeps balances.
///   solidity  keccak(holder . slot)          (most coins; slot 0..60, or a
///             big "namespaced" base such as OpenZeppelin v5's ERC20 storage)
///   vyper     keccak(slot . holder)
///   solady    keccak(holder . 8 zero bytes . 4-byte seed)   (Solady ERC20,
///             `slot` holds the seed)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct BalanceLayout {
    pub vyper: bool,
    pub slot: U256,
    pub solady: bool,
}

/// OpenZeppelin Contracts v5 upgradeable ERC20: balances mapping at this
/// namespaced base (keccak256(abi.encode(uint256(keccak256(
/// "openzeppelin.storage.ERC20")) - 1)) & ~0xff).
pub const OZ5_ERC20_BASE: U256 =
    U256::from_be_bytes(hex_literal_32("52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00"));
/// Solady ERC20's balance seed.
pub const SOLADY_BALANCE_SEED: u64 = 0x87a211a2;

const fn hex_literal_32(h: &str) -> [u8; 32] {
    let b = h.as_bytes();
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        let hi = hexval(b[2 * i]);
        let lo = hexval(b[2 * i + 1]);
        out[i] = hi * 16 + lo;
        i += 1;
    }
    out
}

const fn hexval(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        _ => c - b'A' + 10,
    }
}

impl BalanceLayout {
    pub fn solidity(slot: u64) -> Self {
        BalanceLayout { vyper: false, slot: U256::from(slot), solady: false }
    }
    pub fn vyper(slot: u64) -> Self {
        BalanceLayout { vyper: true, slot: U256::from(slot), solady: false }
    }

    /// The 64 bytes hashed for `holder`'s balance slot (None: Solady's
    /// 32-byte layout). Lets callers keep the result (checkview::memo_slot).
    pub fn preimage(&self, holder: Address) -> Option<[u8; 64]> {
        if self.solady {
            return None;
        }
        let mut buf = [0u8; 64];
        let s = self.slot.to_be_bytes::<32>();
        if self.vyper {
            buf[..32].copy_from_slice(&s);
            buf[44..64].copy_from_slice(holder.as_slice());
        } else {
            buf[12..32].copy_from_slice(holder.as_slice());
            buf[32..].copy_from_slice(&s);
        }
        Some(buf)
    }

    /// Storage slot holding `holder`'s balance.
    pub fn key(&self, holder: Address) -> U256 {
        if self.solady {
            let mut buf = [0u8; 32];
            buf[..20].copy_from_slice(holder.as_slice());
            buf[28..].copy_from_slice(&self.slot.to_be_bytes::<32>()[28..]);
            return U256::from_be_bytes(keccak256(buf).0);
        }
        let mut buf = [0u8; 64];
        let s = self.slot.to_be_bytes::<32>();
        if self.vyper {
            buf[..32].copy_from_slice(&s);
            buf[44..64].copy_from_slice(holder.as_slice());
        } else {
            buf[12..32].copy_from_slice(holder.as_slice());
            buf[32..].copy_from_slice(&s);
        }
        U256::from_be_bytes(keccak256(buf).0)
    }

    /// From the bot's JSON ({"layout":"solidity"|"vyper"|"solady","slot":N or "0x.."}).
    pub fn from_json(v: &Value) -> Option<Self> {
        let (vyper, solady) = match v.get("layout").and_then(|x| x.as_str()) {
            Some("solidity") => (false, false),
            Some("vyper") => (true, false),
            Some("solady") => (false, true),
            _ => return None,
        };
        let slot = match v.get("slot")? {
            Value::Number(n) => U256::from(n.as_u64()?),
            Value::String(t) => parse_u256(t).ok()?,
            _ => return None,
        };
        Some(BalanceLayout { vyper, slot, solady })
    }

    pub fn to_json(&self) -> Value {
        let name = if self.solady { "solady" } else if self.vyper { "vyper" } else { "solidity" };
        let slot = if self.slot < U256::from(1u64 << 53) { json!(self.slot.to::<u64>()) } else { json!(format!("{:#x}", self.slot)) };
        json!({ "layout": name, "slot": slot })
    }

    /// Given one holder's balance slot (found by a trace), the standard
    /// layout it comes from, if any: then every other holder of the coin is
    /// known without another trace.
    pub fn guess(holder: Address, slot: U256) -> Option<Self> {
        let mut cands: Vec<BalanceLayout> = Vec::new();
        for n in 0..=200u64 {
            cands.push(BalanceLayout::solidity(n));
            cands.push(BalanceLayout::vyper(n));
        }
        for off in 0..4u64 {
            cands.push(BalanceLayout { vyper: false, slot: OZ5_ERC20_BASE + U256::from(off), solady: false });
        }
        cands.push(BalanceLayout { vyper: false, slot: U256::from(SOLADY_BALANCE_SEED), solady: true });
        cands.into_iter().find(|c| c.key(holder) == slot)
    }
}

/// Highest mapping slot number tried (same as the bot).
pub const MAX_SLOT: u64 = 60;
/// Address whose balance the probe asks for (any address works: the layout
/// is per coin). A fixed made-up address nobody holds coins at.
pub const PROBE_HOLDER: Address = Address::new([0x5e, 0x1f, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x01]);
/// Marker values: BASE + i never look like a real balance.
const BASE: u64 = 0x1234_5678_90ab_0000;
const MAGIC: u64 = 0x1234_5678_90ab_cdef;

/// balanceOf(holder) call data.
pub fn balance_of_data(holder: Address) -> String {
    let mut d = vec![0x70, 0xa0, 0x82, 0x31];
    d.extend_from_slice(&[0u8; 12]);
    d.extend_from_slice(holder.as_slice());
    to_hex(&d)
}

/// All candidate layouts, in a fixed order (index i = marker BASE + i).
fn candidates() -> Vec<BalanceLayout> {
    let mut v = Vec::new();
    for slot in 0..=MAX_SLOT {
        v.push(BalanceLayout::solidity(slot));
        v.push(BalanceLayout::vyper(slot));
    }
    v
}

fn slot_hex(s: U256) -> String {
    format!("{s:#066x}")
}

/// eth_call balanceOf(PROBE_HOLDER) on `coin` at `block`, once per
/// override set, all in ONE node batch (paid node first). Ok(None) = that
/// call came back with an error object (unknown block, rate limit, revert,
/// overrides refused...): NOT an answer, see probe_layout.
fn probe_calls(node: &dyn NodeApi, coin: Address, block: u64, diffs: Vec<serde_json::Map<String, Value>>) -> Result<Vec<Option<U256>>, NodeErr> {
    let c = to_hex(coin.as_slice());
    let calls: Vec<(&str, Value)> = diffs
        .into_iter()
        .map(|d| ("eth_call", json!([{ "to": c, "data": balance_of_data(PROBE_HOLDER) }, tag(block), { c.clone(): { "stateDiff": Value::Object(d) } }])))
        .collect();
    // Bulk class: never falls back to the public node (copy 2 paces itself).
    let r = node.call_batch_paid(Class::Bulk, &calls)?;
    Ok(r.into_iter()
        .map(|x| match x {
            Ok(Value::String(s)) => parse_u256(&s).ok(),
            _ => None,
        })
        .collect())
}

fn one(c: &BalanceLayout, v: u64) -> serde_json::Map<String, Value> {
    let mut d = serde_json::Map::new();
    d.insert(slot_hex(c.key(PROBE_HOLDER)), json!(slot_hex(U256::from(v))));
    d
}

/// Find where `coin` keeps balances: 2 node requests (all places at once,
/// then a confirmation); odd coins that also read another per-account flag
/// take one extra batch of 31 single-place calls.
/// Ok(None) = "not found", ONLY when every answer was a clean number that
/// didn't match. Any error object from the node = Err (asked again later):
/// a node that doesn't have the block yet must never condemn a coin.
pub fn probe_layout(node: &dyn NodeApi, coin: Address, block: u64) -> Result<Option<BalanceLayout>, NodeErr> {
    let err = || NodeErr::BadResponse(format!("probe of coin {coin}: the node answered with an error (will ask again)"));
    let cands = candidates();
    let mut diff = serde_json::Map::new();
    for (i, c) in cands.iter().enumerate() {
        diff.insert(slot_hex(c.key(PROBE_HOLDER)), json!(slot_hex(U256::from(BASE + i as u64))));
    }
    let mut found = None;
    match probe_calls(node, coin, block, vec![diff])?.into_iter().next().flatten() {
        Some(v) => {
            if v >= U256::from(BASE) && v < U256::from(BASE + cands.len() as u64) {
                found = Some(cands[(v - U256::from(BASE)).to::<usize>()]);
            }
        }
        None => return Err(err()),
    }
    if found.is_none() {
        // One place per call (slots 0..30), like the bot, but in one batch.
        let few: Vec<BalanceLayout> = cands.iter().filter(|c| c.slot <= U256::from(30)).copied().collect();
        let r = probe_calls(node, coin, block, few.iter().map(|c| one(c, MAGIC)).collect())?;
        let any_error = r.iter().any(|v| v.is_none());
        found = few.iter().zip(r).find(|(_, v)| *v == Some(U256::from(MAGIC))).map(|(c, _)| *c);
        if found.is_none() && any_error {
            return Err(err());
        }
    }
    let Some(l) = found else { return Ok(None) };
    // Confirm with that one place alone.
    match probe_calls(node, coin, block, vec![one(&l, MAGIC)])?.into_iter().next().flatten() {
        Some(v) => Ok((v == U256::from(MAGIC)).then_some(l)),
        None => Err(err()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::CallResult;
    use std::sync::Mutex;

    #[test]
    fn keys_match_solidity_and_vyper_encoding() {
        let h = Address::with_last_byte(0x42);
        // Solidity: keccak(pad(h) . pad(3)) - same as fields::map_slot.
        assert_eq!(BalanceLayout::solidity(3).key(h), crate::copy2::fields::map_slot(h, 3));
        let mut b = [0u8; 64];
        b[31] = 3;
        b[63] = 0x42;
        assert_eq!(BalanceLayout::vyper(3).key(h), U256::from_be_bytes(keccak256(b).0));
        assert_eq!(BalanceLayout::from_json(&json!({"layout":"vyper","slot":3})), Some(BalanceLayout::vyper(3)));
        assert_eq!(BalanceLayout::from_json(&json!({"layout":"x","slot":3})), None);
    }

    /// A fake coin that keeps balances at mapping slot 9 (Solidity layout).
    struct FakeCoin {
        calls: Mutex<usize>,
    }
    impl NodeApi for FakeCoin {
        fn call_batch(&self, _c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
            *self.calls.lock().unwrap() += calls.len();
            let want = slot_hex(BalanceLayout::solidity(9).key(PROBE_HOLDER));
            Ok(calls
                .iter()
                .map(|(_, p)| {
                    let diff = p[2].as_object().unwrap().values().next().unwrap()["stateDiff"].as_object().unwrap();
                    Ok(json!(diff.get(&want).cloned().unwrap_or(json!(slot_hex(U256::ZERO)))))
                })
                .collect())
        }
    }

    #[test]
    fn guess_recognises_namespaced_and_solady_layouts() {
        let h = Address::with_last_byte(0x42);
        let oz = BalanceLayout { vyper: false, slot: OZ5_ERC20_BASE, solady: false };
        assert_eq!(BalanceLayout::guess(h, oz.key(h)), Some(oz));
        let sol = BalanceLayout { vyper: false, slot: U256::from(SOLADY_BALANCE_SEED), solady: true };
        assert_eq!(BalanceLayout::guess(h, sol.key(h)), Some(sol));
        assert_eq!(BalanceLayout::guess(h, BalanceLayout::solidity(150).key(h)), Some(BalanceLayout::solidity(150)));
        assert_eq!(BalanceLayout::guess(h, U256::from(12345)), None);
        // OZ v5 base as published.
        assert_eq!(format!("{:#x}", OZ5_ERC20_BASE), "0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00");
        let j = oz.to_json();
        assert_eq!(BalanceLayout::from_json(&j), Some(oz));
    }

    #[test]
    fn probe_finds_the_slot_in_two_requests() {
        let n = FakeCoin { calls: Mutex::new(0) };
        let l = probe_layout(&n, Address::with_last_byte(7), 100).unwrap();
        assert_eq!(l, Some(BalanceLayout::solidity(9)));
        assert_eq!(*n.calls.lock().unwrap(), 2);
    }
}
