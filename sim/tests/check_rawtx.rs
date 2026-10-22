// ============================================================================
// Signed transaction tests (workstream C): decode legacy / 2930 / 1559
// transactions, recover the sender (signed here with a known test key), and
// run them first in a check with their real sender and fields.
// ============================================================================
mod check_util;

use arbsim::check::rawtx::decode_signed_tx;
use arbsim::check::{run_calls, CallReq, Overrides, UnknownReason};
use check_util::*;
use revm::primitives::{keccak256, Bytes, B256, U256};

// Well-known test key (anvil/hardhat account #0). Never holds real funds.
const KEY: [u8; 32] = [
    0xac, 0x09, 0x74, 0xbe, 0xc3, 0x9a, 0x17, 0xe3, 0x6b, 0xa4, 0xa6, 0xb4, 0xd2, 0x38, 0xff, 0x94, 0x4b, 0xac, 0xb4,
    0x78, 0xcb, 0xed, 0x5e, 0xfc, 0xae, 0x78, 0x4d, 0x7b, 0xf4, 0xf2, 0xff, 0x80,
];

fn tx(data: Vec<u8>) -> TestTx {
    TestTx { nonce: 7, gas: 90_000, to: Some(addr(0xc0de)), value: U256::from(3u64), data, access_list: vec![] }
}

#[test]
fn test_key_address_is_the_known_one() {
    assert_eq!(format!("{:?}", key_address(&KEY)), "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
}

#[test]
fn legacy_eip155_and_pre155() {
    let me = key_address(&KEY);
    for chain in [Some(4663u64), None] {
        let raw = sign_legacy(&KEY, &tx(vec![1, 2, 3]), 1_000_000_000, chain);
        let d = decode_signed_tx(&raw).unwrap();
        assert_eq!(d.from, me, "chain {chain:?}");
        assert_eq!((d.tx_type, d.nonce, d.gas, d.to, d.value, d.chain_id), (0, 7, 90_000, Some(addr(0xc0de)), U256::from(3u64), chain));
        assert_eq!(d.data, Bytes::from(vec![1u8, 2, 3]));
        assert_eq!(d.hash, keccak256(&raw));
    }
}

#[test]
fn typed_2930_and_1559_with_access_list() {
    let me = key_address(&KEY);
    let mut t = tx(vec![0xaa; 100]); // long data: multi-byte RLP lengths
    t.access_list = vec![(addr(0xc0de), vec![B256::from(U256::from(1)), B256::from(U256::from(2))])];
    for ty in [1u8, 2] {
        let raw = sign_typed(&KEY, ty, &t, 4663);
        let d = decode_signed_tx(&raw).unwrap();
        assert_eq!(d.from, me, "type {ty}");
        assert_eq!(d.tx_type, ty);
        assert_eq!(d.chain_id, Some(4663));
        assert_eq!(d.access_list.len(), 1);
        assert_eq!(d.access_list[0].storage_keys.len(), 2);
        assert_eq!(d.data.len(), 100);
    }
}

#[test]
fn contract_creation_has_no_to() {
    let mut t = tx(vec![0x00]);
    t.to = None;
    let d = decode_signed_tx(&sign_typed(&KEY, 2, &t, 4663)).unwrap();
    assert_eq!(d.to, None);
}

#[test]
fn tampered_or_unsupported_refused() {
    let raw = sign_typed(&KEY, 2, &tx(vec![1]), 4663);
    // Flip a data byte: decodes, but recovers a DIFFERENT sender (that's how
    // signatures work), never ours.
    let mut bad = raw.clone();
    let n = bad.len();
    bad[n - 70] ^= 1;
    if let Ok(d) = decode_signed_tx(&bad) {
        assert_ne!(d.from, key_address(&KEY));
    }
    // Truncated = error.
    assert!(decode_signed_tx(&raw[..raw.len() - 3]).is_err());
    // Trailing junk = error.
    let mut long = raw.clone();
    long.push(0);
    assert!(decode_signed_tx(&long).is_err());
    // Blob (3), 7702 (4), Arbitrum system (0x6a) = unsupported.
    for t in [0x03u8, 0x04, 0x6a] {
        assert!(decode_signed_tx(&[t, 0xc0]).unwrap_err().starts_with("unsupported tx type"));
    }
}

// A raw tx runs first, with its real sender: a counter contract bumped by the
// raw tx, then read by our call. And a raw tx from an address we don't know
// is "unknown" on a strict view (never assumed empty).
#[test]
fn raw_tx_applied_before_calls() {
    let me = key_address(&KEY);
    let mut s = state_with(&[(addr(0xc0de), code_counter(), vec![(U256::ZERO, U256::from(10))])], true);
    add_eoa(&mut s, addr(0xabc), U256::ZERO);
    let mut t = tx(vec![]);
    t.value = U256::ZERO;
    let raw = Bytes::from(sign_typed(&KEY, 2, &t, 4663));
    let call = CallReq { from: addr(0xabc), to: Some(addr(0xc0de)), data: Bytes::new(), gas: Some(100_000), value: U256::ZERO };

    let e = run_calls(&s, &ctx(), &Overrides::none(), std::slice::from_ref(&raw), std::slice::from_ref(&call)).unwrap_err();
    assert_eq!(e.reason, UnknownReason::Miss);
    assert!(e.missing.contains(&arbsim::state::MissItem::Account(me)));

    add_eoa(&mut s, me, U256::from(10u64).pow(U256::from(18)));
    let r = run_calls(&s, &ctx(), &Overrides::none(), std::slice::from_ref(&raw), &[call]).unwrap();
    assert_eq!(U256::from_be_slice(&r[0].output), U256::from(12), "raw tx bumped 10->11, our call 11->12");

    // Garbage raw tx = bad request (not a miss, not a verdict).
    let e = run_calls(&s, &ctx(), &Overrides::none(), &[Bytes::from(vec![0x02, 0x01])], &[]).unwrap_err();
    assert_eq!(e.reason, UnknownReason::BadRequest);
}
