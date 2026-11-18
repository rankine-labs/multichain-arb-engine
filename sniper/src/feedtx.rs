// ============================================================================
// FEED TRANSACTIONS (light version): read user transactions straight out of
// Robinhood Chain's sequencer feed.
//
// Plain English:
//   Every feed frame carries whole L2 blocks before the node publishes them.
//   Inside each block are the users' raw signed transactions. This file
//   unpacks them just far enough to know, for each transaction:
//     - its hash (so we can match it to the swap the node shows later),
//     - which contract it calls ("to", e.g. a router) and with what data,
//     - how much ETH it sends.
//   We do NOT work out the sender (that needs signature maths) and we do NOT
//   run the transaction. That keeps this tiny, fast and dependency-free.
//
//   Unpacking rules are the same as the arb bot's sim/src/feed/frame.rs and
//   src/chains/nitroFeed.ts:
//     header kind 3 = L2 message (user transactions);
//     l2Msg first byte 4 = one signed tx, 3 = batch of
//       [8-byte big-endian length][nested l2Msg] (nested up to 16 deep);
//     anything malformed is skipped, never a crash.
// ============================================================================
use serde_json::Value;

use crate::fourmeme::keccak;

const MAX_DEPTH: usize = 16;

/// One user transaction seen in the feed.
#[derive(Clone, Debug, PartialEq)]
pub struct FeedTx {
    /// 0x-prefixed lowercase tx hash.
    pub hash: String,
    /// Called contract (lowercase 0x...), None for contract creation.
    pub to: Option<String>,
    /// Call data (may be empty).
    pub data: Vec<u8>,
    /// ETH sent, in wei (saturates at u128::MAX; plenty for our use).
    pub value: u128,
}

impl FeedTx {
    /// First 4 bytes of the call data as 0x-hex ("" if none).
    pub fn selector(&self) -> String {
        if self.data.len() >= 4 {
            format!("0x{}", hex(&self.data[..4]))
        } else {
            String::new()
        }
    }
}

/// One feed message (= one L2 block).
#[derive(Clone, Debug)]
pub struct FeedBlock {
    pub seq: u64,
    /// L2 header timestamp (unix seconds).
    pub ts: u64,
    pub txs: Vec<FeedTx>,
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---------------------------------------------------------------- base64 ---

/// Decode base64 leniently (padding optional, URL-safe letters ok).
pub fn base64(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

// ------------------------------------------------------------------- rlp ---

/// One RLP item: Ok((is_list, payload, rest)).
fn rlp_item(b: &[u8]) -> Option<(bool, &[u8], &[u8])> {
    let p = *b.first()?;
    let (list, off, len) = match p {
        0x00..=0x7f => return Some((false, &b[..1], &b[1..])),
        0x80..=0xb7 => (false, 1, (p - 0x80) as usize),
        0xb8..=0xbf => {
            let n = (p - 0xb7) as usize;
            (false, 1 + n, be_len(b.get(1..1 + n)?)?)
        }
        0xc0..=0xf7 => (true, 1, (p - 0xc0) as usize),
        _ => {
            let n = (p - 0xf7) as usize;
            (true, 1 + n, be_len(b.get(1..1 + n)?)?)
        }
    };
    let end = off.checked_add(len)?;
    Some((list, b.get(off..end)?, b.get(end..)?))
}

fn be_len(b: &[u8]) -> Option<usize> {
    if b.len() > 8 {
        return None;
    }
    Some(b.iter().fold(0usize, |a, x| (a << 8) | *x as usize))
}

/// Items of an RLP list (payload of each; nested lists stay raw).
fn rlp_list(b: &[u8]) -> Option<Vec<&[u8]>> {
    let (is_list, mut payload, _) = rlp_item(b)?;
    if !is_list {
        return None;
    }
    let mut out = Vec::new();
    while !payload.is_empty() {
        let (_, item, rest) = rlp_item(payload)?;
        out.push(item);
        payload = rest;
    }
    Some(out)
}

fn to_u128(b: &[u8]) -> u128 {
    if b.len() > 16 {
        return u128::MAX;
    }
    b.iter().fold(0u128, |a, x| (a << 8) | *x as u128)
}

// -------------------------------------------------------------------- tx ---

/// Decode one raw signed transaction. None = not a kind we understand.
pub fn decode_tx(raw: &[u8]) -> Option<FeedTx> {
    let first = *raw.first()?;
    let hash = format!("0x{}", hex(&keccak(raw)));
    // Position of the `to` field per type; value and data follow it.
    let (fields, to_i) = if first >= 0xc0 {
        // legacy: nonce, gasPrice, gas, to, value, data, v, r, s
        (rlp_list(raw)?, 3)
    } else {
        let f = rlp_list(&raw[1..])?;
        match first {
            0x01 => (f, 4), // chainId, nonce, gasPrice, gas, to, ...
            0x02..=0x04 => (f, 5), // chainId, nonce, tip, maxFee, gas, to, ...
            _ => return None,
        }
    };
    let to_b = fields.get(to_i)?;
    let to = match to_b.len() {
        0 => None,
        20 => Some(format!("0x{}", hex(to_b))),
        _ => return None,
    };
    Some(FeedTx { hash, to, value: to_u128(fields.get(to_i + 1)?), data: fields.get(to_i + 2)?.to_vec() })
}

// ---------------------------------------------------------------- sender --
//
// Who signed a transaction (speed step 3, feed wake-up). The signature
// (yParity/v, r, s) is the last 3 fields; the signed message is
//   typed tx:  keccak(type byte || rlp(all fields except the signature))
//   legacy:    keccak(rlp(first 6 fields [+ chainId, 0, 0 for EIP-155]))
// Same maths as the arb bot's sim/src/feed/tx.rs (copied, not shared, so the
// sniper keeps its own small build). Uses the secp256k1 library the live
// sender already depends on.

/// Items of an RLP list, each as its FULL encoding (header included), so
/// they can be re-wrapped into the signed message unchanged.
fn rlp_list_raw(b: &[u8]) -> Option<Vec<&[u8]>> {
    let (is_list, mut payload, _) = rlp_item(b)?;
    if !is_list {
        return None;
    }
    let mut out = Vec::new();
    while !payload.is_empty() {
        let (_, _, rest) = rlp_item(payload)?;
        let used = payload.len() - rest.len();
        out.push(&payload[..used]);
        payload = rest;
    }
    Some(out)
}

/// RLP list header + the given already-encoded items.
fn wrap_list(items: &[&[u8]]) -> Vec<u8> {
    let len: usize = items.iter().map(|i| i.len()).sum();
    let mut out = Vec::with_capacity(len + 9);
    if len < 56 {
        out.push(0xc0 + len as u8);
    } else {
        let be = (len as u64).to_be_bytes();
        let skip = be.iter().take_while(|x| **x == 0).count();
        out.push(0xf7 + (8 - skip) as u8);
        out.extend_from_slice(&be[skip..]);
    }
    for i in items {
        out.extend_from_slice(i);
    }
    out
}

/// RLP encoding of a small unsigned number.
fn rlp_u64(v: u64) -> Vec<u8> {
    if v == 0 {
        return vec![0x80];
    }
    if v < 0x80 {
        return vec![v as u8];
    }
    let be = v.to_be_bytes();
    let skip = be.iter().take_while(|x| **x == 0).count();
    let mut out = vec![0x80 + (8 - skip) as u8];
    out.extend_from_slice(&be[skip..]);
    out
}

/// A 32-byte big-endian number from an RLP payload (None if longer).
fn word32(b: &[u8]) -> Option<[u8; 32]> {
    if b.len() > 32 {
        return None;
    }
    let mut w = [0u8; 32];
    w[32 - b.len()..].copy_from_slice(b);
    Some(w)
}

/// ecrecover: the address that signed `msg` (lowercase 0x...).
fn recover(msg: [u8; 32], parity: u8, r: &[u8], s: &[u8]) -> Option<String> {
    use secp256k1::ecdsa::{RecoverableSignature, RecoveryId};
    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(&word32(r)?);
    sig[32..].copy_from_slice(&word32(s)?);
    let id = RecoveryId::try_from(parity as i32).ok()?;
    let rs = RecoverableSignature::from_compact(&sig, id).ok()?;
    let pk = secp256k1::SECP256K1.recover_ecdsa(secp256k1::Message::from_digest(msg), &rs).ok()?;
    let un = pk.serialize_uncompressed();
    Some(format!("0x{}", hex(&keccak(&un[1..])[12..])))
}

/// The wallet that signed this raw transaction. None = a kind we don't
/// read or a bad signature (the caller then knows the tx only by hash).
pub fn recover_sender(raw: &[u8]) -> Option<String> {
    let first = *raw.first()?;
    if first >= 0xc0 {
        // legacy: nonce, gasPrice, gas, to, value, data, v, r, s
        let f = rlp_list_raw(raw)?;
        let p = rlp_list(raw)?;
        if f.len() != 9 {
            return None;
        }
        let v = to_u128(p[6]) as u64;
        let (chain, parity) = match v {
            27 | 28 => (None, (v - 27) as u8),
            v if v >= 35 => (Some((v - 35) / 2), ((v - 35) % 2) as u8),
            _ => return None,
        };
        let mut parts: Vec<Vec<u8>> = f[..6].iter().map(|x| x.to_vec()).collect();
        if let Some(c) = chain {
            parts.push(rlp_u64(c));
            parts.push(vec![0x80]);
            parts.push(vec![0x80]);
        }
        let refs: Vec<&[u8]> = parts.iter().map(|x| x.as_slice()).collect();
        return recover(keccak(&wrap_list(&refs)), parity, p[7], p[8]);
    }
    // typed: 0x01 (11 fields), 0x02 (12), 0x04 (13). Blob (0x03) never
    // runs on Arbitrum chains, so it is not read.
    let n = match first {
        0x01 => 11,
        0x02 => 12,
        0x04 => 13,
        _ => return None,
    };
    let f = rlp_list_raw(&raw[1..])?;
    let p = rlp_list(&raw[1..])?;
    if f.len() != n {
        return None;
    }
    let y = to_u128(p[n - 3]);
    if y > 1 {
        return None;
    }
    let mut m = vec![first];
    m.extend(wrap_list(&f[..n - 3]));
    recover(keccak(&m), y as u8, p[n - 2], p[n - 1])
}

// ------------------------------------------------------------------ frame --

/// Raw signed transaction bytes inside one l2Msg (same walk as `walk`).
fn walk_raw<'a>(bytes: &'a [u8], depth: usize, out: &mut Vec<&'a [u8]>) {
    if bytes.is_empty() || depth > MAX_DEPTH {
        return;
    }
    let body = &bytes[1..];
    match bytes[0] {
        4 => out.push(body),
        3 => {
            let mut i = 0usize;
            while i + 8 <= body.len() {
                let len = u64::from_be_bytes(body[i..i + 8].try_into().unwrap()) as usize;
                i += 8;
                if len == 0 || len > body.len() - i {
                    break;
                }
                walk_raw(&body[i..i + len], depth + 1, out);
                i += len;
            }
        }
        _ => {}
    }
}

/// One feed block with each user transaction's signer (feed wake-up).
#[derive(Clone, Debug)]
pub struct SignedBlock {
    pub seq: u64,
    /// (transaction, signer if it could be recovered), in block order.
    pub txs: Vec<(FeedTx, Option<String>)>,
}

/// Like `parse_frame`, plus the signer of every transaction.
pub fn parse_frame_signed(text: &str) -> Vec<SignedBlock> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return vec![] };
    let Some(arr) = v.get("messages").and_then(|m| m.as_array()) else { return vec![] };
    arr.iter()
        .filter_map(|m| {
            let seq = num(m.get("sequenceNumber")?)?;
            let inner = &m["message"]["message"];
            let mut txs = Vec::new();
            if num(&inner["header"]["kind"]) == Some(3) {
                if let Some(b) = inner["l2Msg"].as_str().and_then(base64) {
                    let mut raws = Vec::new();
                    walk_raw(&b, 0, &mut raws);
                    for r in raws {
                        if let Some(t) = decode_tx(r) {
                            txs.push((t, recover_sender(r)));
                        }
                    }
                }
            }
            Some(SignedBlock { seq, txs })
        })
        .collect()
}

fn walk(bytes: &[u8], depth: usize, out: &mut Vec<FeedTx>) {
    if bytes.is_empty() || depth > MAX_DEPTH {
        return;
    }
    let body = &bytes[1..];
    match bytes[0] {
        4 => {
            if let Some(t) = decode_tx(body) {
                out.push(t);
            }
        }
        3 => {
            let mut i = 0usize;
            while i + 8 <= body.len() {
                let len = u64::from_be_bytes(body[i..i + 8].try_into().unwrap()) as usize;
                i += 8;
                if len == 0 || len > body.len() - i {
                    break;
                }
                walk(&body[i..i + len], depth + 1, out);
                i += len;
            }
        }
        _ => {}
    }
}

fn num(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) if s.starts_with("0x") => u64::from_str_radix(&s[2..], 16).ok(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

/// All blocks (with their user transactions) in one feed websocket frame.
pub fn parse_frame(text: &str) -> Vec<FeedBlock> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return vec![] };
    let Some(arr) = v.get("messages").and_then(|m| m.as_array()) else { return vec![] };
    arr.iter()
        .filter_map(|m| {
            let seq = num(m.get("sequenceNumber")?)?;
            let inner = &m["message"]["message"];
            let ts = num(&inner["header"]["timestamp"]).unwrap_or(0);
            let mut txs = Vec::new();
            if num(&inner["header"]["kind"]) == Some(3) {
                if let Some(b) = inner["l2Msg"].as_str().and_then(base64) {
                    walk(&b, 0, &mut txs);
                }
            }
            Some(FeedBlock { seq, ts, txs })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // A real EIP-1559 transfer (from the Ethereum docs test vectors style):
    // built here by hand so the test needs no network.
    fn sample_1559() -> Vec<u8> {
        // fields: chainId 1, nonce 0, tip 1, maxFee 2, gas 21000,
        // to 0x11..11, value 5, data 0xabcdef01, accessList [], y 0, r 1, s 1
        let to = [0x94u8].iter().chain([0x11u8; 20].iter()).copied().collect::<Vec<u8>>();
        let mut items: Vec<u8> = vec![0x01, 0x80, 0x01, 0x02, 0x82, 0x52, 0x08];
        items.extend(&to);
        items.extend([0x05, 0x84, 0xab, 0xcd, 0xef, 0x01, 0xc0, 0x80, 0x01, 0x01]);
        let mut raw = vec![0x02, 0xc0 + items.len() as u8];
        raw.extend(items);
        raw
    }

    #[test]
    fn decodes_1559_fields() {
        let raw = sample_1559();
        let t = decode_tx(&raw).expect("decodes");
        assert_eq!(t.to.as_deref(), Some("0x1111111111111111111111111111111111111111"));
        assert_eq!(t.value, 5);
        assert_eq!(t.selector(), "0xabcdef01");
        assert_eq!(t.hash, format!("0x{}", hex(&keccak(&raw))));
    }

    #[test]
    fn legacy_and_creation() {
        // legacy: nonce 0, gasPrice 1, gas 1, to empty (creation), value 0, data 0x00, v 27, r 1, s 1
        let items = [0x80u8, 0x01, 0x01, 0x80, 0x80, 0x00, 0x1b, 0x01, 0x01];
        let mut raw = vec![0xc0 + items.len() as u8];
        raw.extend(items);
        let t = decode_tx(&raw).expect("decodes");
        assert_eq!(t.to, None);
        assert_eq!(t.data, vec![0x00]);
    }

    #[test]
    fn frame_with_batch() {
        // l2Msg = batch(3) of one signed tx(4)
        let tx = sample_1559();
        let mut inner = vec![4u8];
        inner.extend(&tx);
        let mut l2 = vec![3u8];
        l2.extend((inner.len() as u64).to_be_bytes());
        l2.extend(&inner);
        let b64 = encode_b64(&l2);
        let frame = format!(
            r#"{{"version":1,"messages":[{{"sequenceNumber":42,"message":{{"message":{{"header":{{"kind":3,"timestamp":1700000000}},"l2Msg":"{b64}"}}}}}}]}}"#
        );
        let blocks = parse_frame(&frame);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].seq, 42);
        assert_eq!(blocks[0].ts, 1700000000);
        assert_eq!(blocks[0].txs.len(), 1);
        assert_eq!(blocks[0].txs[0].value, 5);
        // junk never panics
        assert!(parse_frame("nope").is_empty());
        assert!(parse_frame(r#"{"messages":[{"sequenceNumber":1,"message":{"message":{"header":{"kind":3},"l2Msg":"!!"}}}]}"#)[0].txs.is_empty());
    }

    #[test]
    fn sender_recovered_from_a_real_signature() {
        // Signed by the live sender's own (independent) signing code.
        let s = crate::live::Signer::random().unwrap();
        let f = crate::live::TxFields { nonce: 3, max_priority_fee: 0, max_fee: 20_000_000, gas_limit: 300_000, to: crate::live::SWAP_ROUTER_02.into(), value: ruint::aliases::U256::from(5u64), data: vec![0x04, 0xe4, 0x5a, 0xaf, 1, 2, 3] };
        let tx = s.sign(&f).unwrap();
        assert_eq!(recover_sender(&tx.raw).as_deref(), Some(s.address()));
        // A damaged signature gives someone else (or nothing), never the signer.
        let mut bad = tx.raw.clone();
        let n = bad.len();
        bad[n - 1] ^= 0x01;
        assert_ne!(recover_sender(&bad).as_deref(), Some(s.address()));
        // Inside a real-shaped frame: batch(3) of [signed tx(4), unsigned junk(4)].
        let mut l2 = vec![3u8];
        for body in [tx.raw.clone(), sample_1559()] {
            let mut inner = vec![4u8];
            inner.extend(&body);
            l2.extend((inner.len() as u64).to_be_bytes());
            l2.extend(inner);
        }
        let frame = format!(r#"{{"version":1,"messages":[{{"sequenceNumber":7,"message":{{"message":{{"header":{{"kind":3}},"l2Msg":"{}"}}}}}}]}}"#, encode_b64(&l2));
        let b = parse_frame_signed(&frame);
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].seq, 7);
        assert_eq!(b[0].txs.len(), 2);
        assert_eq!(b[0].txs[0].0.hash, tx.hash);
        assert_eq!(b[0].txs[0].1.as_deref(), Some(s.address()));
        // the hand-built tx has r = s = 1: not a valid signature for anyone useful
        assert_ne!(b[0].txs[1].1.as_deref(), Some(s.address()));
        // same txs as the plain parser
        assert_eq!(parse_frame(&frame)[0].txs, b[0].txs.iter().map(|t| t.0.clone()).collect::<Vec<_>>());
    }

    #[test]
    fn legacy_eip155_sender() {
        // Ethereum's EIP-155 example: key 0x4646..46, chain 1, nonce 9,
        // gasPrice 20 gwei, gas 21000, to 0x3535..35, value 1 ether.
        let raw = decode_hex("f86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83");
        assert_eq!(recover_sender(&raw).as_deref(), Some("0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f"));
    }

    fn decode_hex(h: &str) -> Vec<u8> {
        (0..h.len() / 2).map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn base64_lenient() {
        assert_eq!(base64("aGVsbG8").unwrap(), b"hello");
        assert_eq!(base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(base64(&encode_b64(&[0xfb, 0xff])).unwrap(), vec![0xfb, 0xff]);
    }

    fn encode_b64(b: &[u8]) -> String {
        const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut s = String::new();
        for c in b.chunks(3) {
            let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
            for i in 0..=c.len() {
                s.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            }
        }
        s
    }
}
