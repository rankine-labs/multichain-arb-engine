// ============================================================================
// Shared helpers for the check tests (workstream C).
//
// Plain English:
//   Tiny hand-written contracts (a few bytes of EVM code each) whose behaviour
//   we know exactly, a way to build an in-memory chain state holding them,
//   and a way to sign test transactions with a known test key.
// ============================================================================
#![allow(dead_code)]
use std::collections::HashMap;

use arbsim::arb::BlockCtx;
use arbsim::state::mem::MemState;
use revm::primitives::{keccak256, Address, Bytes, B256, U256};
use revm::state::{AccountInfo, Bytecode};

pub const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

pub fn fixture_path(name: &str) -> String {
    format!("{FIXTURES}/{name}.json")
}

pub fn addr(n: u64) -> Address {
    let mut a = [0u8; 20];
    a[12..].copy_from_slice(&n.to_be_bytes());
    Address::from(a)
}

pub fn ctx() -> BlockCtx {
    BlockCtx { l1_block_number: 100, l2_block_number: None, timestamp: 1_700_000_000, basefee: 0, coinbase: Address::ZERO, gas_limit: 1_000_000_000, prevrandao: B256::ZERO }
}

/// Word (32 bytes, big-endian) of a number.
pub fn word(v: U256) -> [u8; 32] {
    v.to_be_bytes::<32>()
}

/// A MemState holding these contracts (address, code, storage).
/// `strict`: unlisted accounts/slots are Missing (live-mirror behaviour).
pub fn state_with(contracts: &[(Address, Vec<u8>, Vec<(U256, U256)>)], strict: bool) -> MemState {
    let mut s = MemState { unlisted_is_empty: !strict, ..Default::default() };
    for (a, code, slots) in contracts {
        add_contract(&mut s, *a, code.clone(), slots);
    }
    s
}

pub fn add_contract(s: &mut MemState, a: Address, code: Vec<u8>, slots: &[(U256, U256)]) {
    let (hash, bc) = if code.is_empty() {
        (revm::primitives::KECCAK_EMPTY, None)
    } else {
        let bc = Bytecode::new_raw(code.clone().into());
        (keccak256(&code), Some(bc))
    };
    if let Some(bc) = &bc {
        s.codes.insert(hash, bc.clone());
    }
    s.accounts.insert(a, AccountInfo { balance: U256::ZERO, nonce: 1, code_hash: hash, code: bc, ..Default::default() });
    let st: &mut HashMap<U256, U256> = s.storage.entry(a).or_default();
    for (k, v) in slots {
        st.insert(*k, *v);
    }
}

/// Plain account with ETH (no code).
pub fn add_eoa(s: &mut MemState, a: Address, balance: U256) {
    s.accounts.insert(a, AccountInfo { balance, nonce: 0, code_hash: revm::primitives::KECCAK_EMPTY, code: None, ..Default::default() });
    s.storage.entry(a).or_default();
}

// ---------------------------------------------------------------------------
// Tiny contracts.
// ---------------------------------------------------------------------------

/// Returns SLOAD(calldata word 0).
pub fn code_sload_arg() -> Vec<u8> {
    // PUSH1 0 CALLDATALOAD SLOAD PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN
    hex("600035546000526020 6000f3")
}

/// Returns BALANCE(calldata word 0 as address).
pub fn code_balance_of_arg() -> Vec<u8> {
    hex("600035 31 600052 602060 00f3")
}

/// slot0 += 1, returns the new value.
pub fn code_counter() -> Vec<u8> {
    // PUSH1 0 SLOAD PUSH1 1 ADD DUP1 PUSH1 0 SSTORE PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN
    hex("600054600101 80 600055 600052 6020 6000 f3")
}

/// STATICCALLs address `target` (no data) and stops.
pub fn code_staticcall(target: u8) -> Vec<u8> {
    // PUSH1 0 PUSH1 0 PUSH1 0 PUSH1 0 PUSH1 target GAS STATICCALL STOP
    let mut v = hex("6000600060006000 60");
    v.push(target);
    v.extend(hex("5a fa 00"));
    v
}

/// Synthetic "trade": x = calldata word at byte 4 (amountIn, after a 4-byte
/// selector), or SLOAD(slot) when `from_slot` is Some(slot).
/// profit(x) = x*(k-x)/scale for x < k, else 0 (one hill, peak at k/2).
/// Always reverts InsufficientProfit(profit, MAX).
pub fn code_profit_curve(k: U256, scale: U256, from_slot: Option<u8>) -> Vec<u8> {
    let mut c: Vec<u8> = Vec::new();
    match from_slot {
        None => c.extend(hex("600435")), // PUSH1 4 CALLDATALOAD
        Some(s) => {
            c.extend([0x60, s, 0x54]); // PUSH1 s SLOAD
        }
    }
    // DUP1 PUSH32 k GT  -> (k > x)
    c.push(0x80);
    c.push(0x7f);
    c.extend(word(k));
    c.push(0x11);
    // PUSH1 calc JUMPI
    let calc_patch = c.len() + 1;
    c.extend([0x60, 0x00, 0x57]);
    // x >= k: POP PUSH1 0 PUSH1 rev JUMP
    c.extend([0x50, 0x60, 0x00]);
    let rev_patch = c.len() + 1;
    c.extend([0x60, 0x00, 0x56]);
    // calc: JUMPDEST DUP1 PUSH32 k SUB MUL PUSH32 scale SWAP1 DIV
    let calc = c.len();
    c.push(0x5b);
    c.push(0x80);
    c.push(0x7f);
    c.extend(word(k));
    c.extend([0x03, 0x02]);
    c.push(0x7f);
    c.extend(word(scale));
    c.extend([0x90, 0x04]);
    // rev: JUMPDEST; mem = selector | profit | MAX; REVERT(0, 68)
    let rev = c.len();
    c.push(0x5b);
    c.extend(hex("634e88422a 60e0 1b 6000 52")); // selector << 224 at 0
    c.extend(hex("6004 52")); // profit at 4
    c.extend(hex("6000 19 6024 52")); // MAX at 36
    c.extend(hex("6044 6000 fd"));
    c[calc_patch] = calc as u8;
    c[rev_patch] = rev as u8;
    assert!(rev < 256);
    c
}

/// Test helper: profit of the synthetic curve (same math as the contract).
pub fn curve(x: U256, k: U256, scale: U256) -> U256 {
    if x >= k { U256::ZERO } else { x * (k - x) / scale }
}

pub fn hex(s: &str) -> Vec<u8> {
    let t: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    let t = t.trim_start_matches("0x");
    (0..t.len() / 2).map(|i| u8::from_str_radix(&t[2 * i..2 * i + 2], 16).unwrap()).collect()
}

// ---------------------------------------------------------------------------
// Signing test transactions (RLP + secp256k1), test key only.
// ---------------------------------------------------------------------------
pub fn rlp_bytes(b: &[u8]) -> Vec<u8> {
    if b.len() == 1 && b[0] < 0x80 {
        return b.to_vec();
    }
    let mut out = rlp_len(b.len(), 0x80);
    out.extend_from_slice(b);
    out
}
fn rlp_len(len: usize, base: u8) -> Vec<u8> {
    if len < 56 {
        vec![base + len as u8]
    } else {
        let lb: Vec<u8> = (len as u64).to_be_bytes().iter().copied().skip_while(|x| *x == 0).collect();
        let mut v = vec![base + 55 + lb.len() as u8];
        v.extend(lb);
        v
    }
}
pub fn rlp_uint(v: U256) -> Vec<u8> {
    let b = v.to_be_bytes::<32>();
    let t: Vec<u8> = b.iter().copied().skip_while(|x| *x == 0).collect();
    rlp_bytes(&t)
}
pub fn rlp_u64(v: u64) -> Vec<u8> {
    rlp_uint(U256::from(v))
}
pub fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload: Vec<u8> = items.iter().flatten().copied().collect();
    let mut out = rlp_len(payload.len(), 0xc0);
    out.extend(payload);
    out
}

pub struct TestTx {
    pub nonce: u64,
    pub gas: u64,
    pub to: Option<Address>,
    pub value: U256,
    pub data: Vec<u8>,
    pub access_list: Vec<(Address, Vec<B256>)>,
}

fn sign(key: &[u8; 32], hash: B256) -> (u8, U256, U256) {
    use secp256k1::{Message, SecretKey, SECP256K1};
    let sk = SecretKey::from_byte_array(*key).unwrap();
    let sig = SECP256K1.sign_ecdsa_recoverable(Message::from_digest(hash.0), &sk);
    let (rid, compact) = sig.serialize_compact();
    (i32::from(rid) as u8, U256::from_be_slice(&compact[..32]), U256::from_be_slice(&compact[32..]))
}

/// Address for a private key.
pub fn key_address(key: &[u8; 32]) -> Address {
    use secp256k1::{PublicKey, SecretKey, SECP256K1};
    let pk = PublicKey::from_secret_key(SECP256K1, &SecretKey::from_byte_array(*key).unwrap());
    let h = keccak256(&pk.serialize_uncompressed()[1..]);
    Address::from_slice(&h[12..])
}

fn to_field(to: Option<Address>) -> Vec<u8> {
    match to {
        Some(a) => rlp_bytes(a.as_slice()),
        None => vec![0x80],
    }
}

fn access_list_rlp(al: &[(Address, Vec<B256>)]) -> Vec<u8> {
    let items: Vec<Vec<u8>> = al
        .iter()
        .map(|(a, keys)| rlp_list(&[rlp_bytes(a.as_slice()), rlp_list(&keys.iter().map(|k| rlp_bytes(k.as_slice())).collect::<Vec<_>>())]))
        .collect();
    rlp_list(&items)
}

/// Signed legacy tx; chain_id Some = EIP-155.
pub fn sign_legacy(key: &[u8; 32], t: &TestTx, gas_price: u64, chain_id: Option<u64>) -> Vec<u8> {
    let mut f = vec![rlp_u64(t.nonce), rlp_u64(gas_price), rlp_u64(t.gas), to_field(t.to), rlp_uint(t.value), rlp_bytes(&t.data)];
    let mut sf = f.clone();
    if let Some(c) = chain_id {
        sf.extend([rlp_u64(c), vec![0x80], vec![0x80]]);
    }
    let (p, r, s) = sign(key, keccak256(rlp_list(&sf)));
    let v = match chain_id {
        Some(c) => 35 + 2 * c + p as u64,
        None => 27 + p as u64,
    };
    f.extend([rlp_u64(v), rlp_uint(r), rlp_uint(s)]);
    rlp_list(&f)
}

/// Signed type-1 (2930) or type-2 (1559) tx.
pub fn sign_typed(key: &[u8; 32], ty: u8, t: &TestTx, chain_id: u64) -> Vec<u8> {
    let mut f = vec![rlp_u64(chain_id), rlp_u64(t.nonce)];
    if ty == 2 {
        f.extend([rlp_u64(1), rlp_u64(1_000_000_000)]);
    } else {
        f.push(rlp_u64(1_000_000_000));
    }
    f.extend([rlp_u64(t.gas), to_field(t.to), rlp_uint(t.value), rlp_bytes(&t.data), access_list_rlp(&t.access_list)]);
    let mut pre = vec![ty];
    pre.extend(rlp_list(&f));
    let (p, r, s) = sign(key, keccak256(&pre));
    f.extend([rlp_u64(p as u64), rlp_uint(r), rlp_uint(s)]);
    let mut out = vec![ty];
    out.extend(rlp_list(&f));
    out
}

pub fn bytes(v: Vec<u8>) -> Bytes {
    Bytes::from(v)
}
