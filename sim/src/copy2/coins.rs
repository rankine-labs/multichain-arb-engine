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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct BalanceLayout {
    /// false = Solidity mapping keccak(holder . slot); true = Vyper keccak(slot . holder).
    pub vyper: bool,
    pub slot: u64,
}

impl BalanceLayout {
    /// Storage slot holding `holder`'s balance.
    pub fn key(&self, holder: Address) -> U256 {
        let mut buf = [0u8; 64];
        let s = U256::from(self.slot).to_be_bytes::<32>();
        if self.vyper {
            buf[..32].copy_from_slice(&s);
            buf[44..64].copy_from_slice(holder.as_slice());
        } else {
            buf[12..32].copy_from_slice(holder.as_slice());
            buf[32..].copy_from_slice(&s);
        }
        U256::from_be_bytes(keccak256(buf).0)
    }

    /// From the bot's JSON ({"layout":"solidity"|"vyper","slot":N}).
    pub fn from_json(v: &Value) -> Option<Self> {
        let vyper = match v.get("layout").and_then(|x| x.as_str()) {
            Some("solidity") => false,
            Some("vyper") => true,
            _ => return None,
        };
        let slot = v.get("slot").and_then(|x| x.as_u64())?;
        (slot <= 1000).then_some(BalanceLayout { vyper, slot })
    }

    pub fn to_json(&self) -> Value {
        json!({ "layout": if self.vyper { "vyper" } else { "solidity" }, "slot": self.slot })
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
        v.push(BalanceLayout { vyper: false, slot });
        v.push(BalanceLayout { vyper: true, slot });
    }
    v
}

fn slot_hex(s: U256) -> String {
    format!("{s:#066x}")
}

/// One eth_call balanceOf(PROBE_HOLDER) on `coin` at `block` with storage
/// overrides. Ok(None) = the call failed (revert, unsupported overrides).
fn probe_call(node: &dyn NodeApi, coin: Address, block: u64, diff: serde_json::Map<String, Value>) -> Result<Option<U256>, NodeErr> {
    let c = to_hex(coin.as_slice());
    let params = json!([{ "to": c, "data": balance_of_data(PROBE_HOLDER) }, tag(block), { c.clone(): { "stateDiff": Value::Object(diff) } }]);
    let r = node.call_batch(Class::Fill, &[("eth_call", params)])?;
    Ok(match r.into_iter().next() {
        Some(Ok(Value::String(s))) => parse_u256(&s).ok(),
        _ => None,
    })
}

/// Find where `coin` keeps balances (2 node requests; up to 2 + 62 for odd
/// coins that also read another per-account flag). Ok(None) = not found.
pub fn probe_layout(node: &dyn NodeApi, coin: Address, block: u64) -> Result<Option<BalanceLayout>, NodeErr> {
    let cands = candidates();
    let mut diff = serde_json::Map::new();
    for (i, c) in cands.iter().enumerate() {
        diff.insert(slot_hex(c.key(PROBE_HOLDER)), json!(slot_hex(U256::from(BASE + i as u64))));
    }
    let mut found = None;
    if let Some(v) = probe_call(node, coin, block, diff)? {
        if v >= U256::from(BASE) && v < U256::from(BASE + cands.len() as u64) {
            found = Some(cands[(v - U256::from(BASE)).to::<usize>()]);
        }
    }
    if found.is_none() {
        // One place at a time (slots 0..30), like the bot.
        for c in cands.iter().filter(|c| c.slot <= 30) {
            let mut d = serde_json::Map::new();
            d.insert(slot_hex(c.key(PROBE_HOLDER)), json!(slot_hex(U256::from(MAGIC))));
            if probe_call(node, coin, block, d)? == Some(U256::from(MAGIC)) {
                found = Some(*c);
                break;
            }
        }
    }
    let Some(l) = found else { return Ok(None) };
    // Confirm with that one place alone.
    let mut d = serde_json::Map::new();
    d.insert(slot_hex(l.key(PROBE_HOLDER)), json!(slot_hex(U256::from(MAGIC))));
    Ok((probe_call(node, coin, block, d)? == Some(U256::from(MAGIC))).then_some(l))
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
        assert_eq!(BalanceLayout { vyper: false, slot: 3 }.key(h), crate::copy2::fields::map_slot(h, 3));
        let mut b = [0u8; 64];
        b[31] = 3;
        b[63] = 0x42;
        assert_eq!(BalanceLayout { vyper: true, slot: 3 }.key(h), U256::from_be_bytes(keccak256(b).0));
        assert_eq!(BalanceLayout::from_json(&json!({"layout":"vyper","slot":3})), Some(BalanceLayout { vyper: true, slot: 3 }));
        assert_eq!(BalanceLayout::from_json(&json!({"layout":"x","slot":3})), None);
    }

    /// A fake coin that keeps balances at mapping slot 9 (Solidity layout).
    struct FakeCoin {
        calls: Mutex<usize>,
    }
    impl NodeApi for FakeCoin {
        fn call_batch(&self, _c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
            *self.calls.lock().unwrap() += calls.len();
            let want = slot_hex(BalanceLayout { vyper: false, slot: 9 }.key(PROBE_HOLDER));
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
    fn probe_finds_the_slot_in_two_requests() {
        let n = FakeCoin { calls: Mutex::new(0) };
        let l = probe_layout(&n, Address::with_last_byte(7), 100).unwrap();
        assert_eq!(l, Some(BalanceLayout { vyper: false, slot: 9 }));
        assert_eq!(*n.calls.lock().unwrap(), 2);
    }
}
