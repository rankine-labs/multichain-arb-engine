// ============================================================================
// SIGNED TRANSACTIONS: decode them and work out who sent them.
//
// Plain English:
//   Sometimes the bot wants a check to run "right after trade X", where X is
//   a real signed transaction we saw but that isn't in our copy of the chain
//   yet. The bot sends X's raw bytes; this file unpacks them (to, value,
//   data, gas, access list) and recovers the sender from the signature, so X
//   can be replayed first, exactly as the chain would run it.
//
//   Supported kinds: legacy (type 0, with or without chain id), 2930 (type 1)
//   and 1559 (type 2) - what users and routers send on Robinhood Chain.
//   Anything else (blob, 7702, Arbitrum system/retryable types) is refused,
//   and the check answers "unknown" instead of guessing.
//
//   The decoder is deliberately small and strict (RLP = Ethereum's packing
//   format): any malformed input is an error, never a guess.
// ============================================================================
use revm::context_interface::transaction::AccessListItem;
use revm::primitives::{alloy_primitives::B512, keccak256, Address, Bytes, B256, U256};

/// A decoded, sender-recovered transaction (what we need to replay it).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodedTx {
    pub tx_type: u8,
    pub hash: B256,
    pub from: Address,
    pub to: Option<Address>,
    pub value: U256,
    pub data: Bytes,
    pub gas: u64,
    pub nonce: u64,
    pub chain_id: Option<u64>,
    pub access_list: Vec<AccessListItem>,
}

// ---------------------------------------------------------------------------
// Minimal RLP reader.
// ---------------------------------------------------------------------------

/// One RLP item: either a byte string or a list (its payload, still packed).
#[derive(Clone, Copy, Debug)]
enum Item<'a> {
    Str(&'a [u8]),
    List(&'a [u8]),
}

/// Reads one item from the front of `b`. Returns (item, whole encoded item, rest).
fn read_item(b: &[u8]) -> Result<(Item<'_>, &[u8], &[u8]), String> {
    let first = *b.first().ok_or("rlp: empty input")?;
    let (is_list, header, len) = match first {
        0x00..=0x7f => return Ok((Item::Str(&b[..1]), &b[..1], &b[1..])),
        0x80..=0xb7 => (false, 1usize, (first - 0x80) as usize),
        0xb8..=0xbf => {
            let ll = (first - 0xb7) as usize;
            (false, 1 + ll, be_len(b.get(1..1 + ll).ok_or("rlp: short length")?)?)
        }
        0xc0..=0xf7 => (true, 1usize, (first - 0xc0) as usize),
        0xf8..=0xff => {
            let ll = (first - 0xf7) as usize;
            (true, 1 + ll, be_len(b.get(1..1 + ll).ok_or("rlp: short length")?)?)
        }
    };
    let end = header.checked_add(len).ok_or("rlp: length overflow")?;
    let payload = b.get(header..end).ok_or("rlp: item runs past the end")?;
    // Canonical form: a single byte < 0x80 must not be wrapped in a header.
    if !is_list && header == 1 && len == 1 && payload[0] < 0x80 {
        return Err("rlp: non-canonical single byte".into());
    }
    let item = if is_list { Item::List(payload) } else { Item::Str(payload) };
    Ok((item, &b[..end], &b[end..]))
}

fn be_len(b: &[u8]) -> Result<usize, String> {
    if b.is_empty() || b[0] == 0 || b.len() > 4 {
        return Err("rlp: bad length prefix".into());
    }
    Ok(b.iter().fold(0usize, |acc, x| (acc << 8) | *x as usize))
}

/// Splits a list payload into its items (and each item's full encoding).
fn list_items(payload: &[u8]) -> Result<Vec<(Item<'_>, &[u8])>, String> {
    let mut out = Vec::new();
    let mut rest = payload;
    while !rest.is_empty() {
        let (it, raw, r) = read_item(rest)?;
        out.push((it, raw));
        rest = r;
    }
    Ok(out)
}

fn as_str<'a>(it: &Item<'a>, what: &str) -> Result<&'a [u8], String> {
    match it {
        Item::Str(s) => Ok(s),
        Item::List(_) => Err(format!("rlp: {what} should be a string")),
    }
}

fn as_u256(it: &Item<'_>, what: &str) -> Result<U256, String> {
    let s = as_str(it, what)?;
    if s.len() > 32 {
        return Err(format!("rlp: {what} too long"));
    }
    if !s.is_empty() && s[0] == 0 {
        return Err(format!("rlp: {what} has leading zero"));
    }
    Ok(U256::from_be_slice(s))
}

fn as_u64(it: &Item<'_>, what: &str) -> Result<u64, String> {
    let v = as_u256(it, what)?;
    if v > U256::from(u64::MAX) {
        return Err(format!("rlp: {what} too big"));
    }
    Ok(v.to::<u64>())
}

fn as_to(it: &Item<'_>) -> Result<Option<Address>, String> {
    let s = as_str(it, "to")?;
    match s.len() {
        0 => Ok(None),
        20 => Ok(Some(Address::from_slice(s))),
        _ => Err("rlp: 'to' must be 20 bytes or empty".into()),
    }
}

fn as_access_list(it: &Item<'_>) -> Result<Vec<AccessListItem>, String> {
    let Item::List(p) = it else { return Err("rlp: access list should be a list".into()) };
    let mut out = Vec::new();
    for (entry, _) in list_items(p)? {
        let Item::List(ep) = entry else { return Err("rlp: access list entry".into()) };
        let parts = list_items(ep)?;
        if parts.len() != 2 {
            return Err("rlp: access list entry needs 2 parts".into());
        }
        let a = as_str(&parts[0].0, "access address")?;
        if a.len() != 20 {
            return Err("rlp: access address".into());
        }
        let Item::List(kp) = parts[1].0 else { return Err("rlp: access keys".into()) };
        let mut keys = Vec::new();
        for (k, _) in list_items(kp)? {
            let k = as_str(&k, "access key")?;
            if k.len() != 32 {
                return Err("rlp: access key must be 32 bytes".into());
            }
            keys.push(B256::from_slice(k));
        }
        out.push(AccessListItem { address: Address::from_slice(a), storage_keys: keys });
    }
    Ok(out)
}

/// RLP header for a list whose payload is `len` bytes long.
fn list_header(len: usize) -> Vec<u8> {
    if len < 56 {
        vec![0xc0 + len as u8]
    } else {
        let lb: Vec<u8> = (len as u64).to_be_bytes().iter().copied().skip_while(|b| *b == 0).collect();
        let mut h = vec![0xf7 + lb.len() as u8];
        h.extend(lb);
        h
    }
}

/// RLP encoding of a number (for the legacy EIP-155 signing payload).
fn rlp_u64(v: u64) -> Vec<u8> {
    if v == 0 {
        return vec![0x80];
    }
    if v < 0x80 {
        return vec![v as u8];
    }
    let b: Vec<u8> = v.to_be_bytes().iter().copied().skip_while(|b| *b == 0).collect();
    let mut out = vec![0x80 + b.len() as u8];
    out.extend(b);
    out
}

// ---------------------------------------------------------------------------
// Signature recovery (uses the same secp256k1 code revm's ecrecover uses).
// ---------------------------------------------------------------------------
fn recover(sighash: &B256, r: U256, s: U256, parity: u8) -> Result<Address, String> {
    if parity > 1 {
        return Err("bad signature parity".into());
    }
    if r.is_zero() || s.is_zero() {
        return Err("bad signature (zero r or s)".into());
    }
    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(&r.to_be_bytes::<32>());
    sig[32..].copy_from_slice(&s.to_be_bytes::<32>());
    let out = revm::precompile::secp256k1::bitcoin_secp256k1::ecrecover(&B512::from(sig), parity, sighash)
        .map_err(|e| format!("signature recovery failed: {e}"))?;
    Ok(Address::from_slice(&out[12..]))
}

/// Error text that marks "a kind of transaction we don't replay" (vs. broken bytes).
pub const UNSUPPORTED_TX_PREFIX: &str = "unsupported tx type";

/// Decode a signed transaction and recover its sender.
pub fn decode_signed_tx(raw: &[u8]) -> Result<DecodedTx, String> {
    let first = *raw.first().ok_or("empty transaction")?;
    let hash = keccak256(raw);
    if first >= 0xc0 {
        return decode_legacy(raw, hash);
    }
    match first {
        0x01 | 0x02 => decode_typed(first, &raw[1..], hash),
        t => Err(format!("{UNSUPPORTED_TX_PREFIX} 0x{t:x}")),
    }
}

fn decode_legacy(raw: &[u8], hash: B256) -> Result<DecodedTx, String> {
    let (Item::List(p), _, rest) = read_item(raw)? else { return Err("legacy tx must be a list".into()) };
    if !rest.is_empty() {
        return Err("trailing bytes after transaction".into());
    }
    let f = list_items(p)?;
    if f.len() != 9 {
        return Err(format!("legacy tx needs 9 fields, got {}", f.len()));
    }
    let nonce = as_u64(&f[0].0, "nonce")?;
    let gas = as_u64(&f[2].0, "gas")?;
    let to = as_to(&f[3].0)?;
    let value = as_u256(&f[4].0, "value")?;
    let data = Bytes::copy_from_slice(as_str(&f[5].0, "data")?);
    let v = as_u64(&f[6].0, "v")?;
    let r = as_u256(&f[7].0, "r")?;
    let s = as_u256(&f[8].0, "s")?;
    // Signing payload: the first 6 fields, plus (EIP-155) chainId, 0, 0.
    let (parity, chain_id) = match v {
        27 | 28 => ((v - 27) as u8, None),
        v if v >= 35 => (((v - 35) % 2) as u8, Some((v - 35) / 2)),
        _ => return Err(format!("bad legacy v {v}")),
    };
    let mut payload: Vec<u8> = f[..6].iter().flat_map(|(_, raw)| raw.iter().copied()).collect();
    if let Some(c) = chain_id {
        payload.extend(rlp_u64(c));
        payload.extend([0x80, 0x80]);
    }
    let mut enc = list_header(payload.len());
    enc.extend(payload);
    let from = recover(&keccak256(&enc), r, s, parity)?;
    Ok(DecodedTx { tx_type: 0, hash, from, to, value, data, gas, nonce, chain_id, access_list: Vec::new() })
}

fn decode_typed(ty: u8, body: &[u8], hash: B256) -> Result<DecodedTx, String> {
    let (Item::List(p), _, rest) = read_item(body)? else { return Err("typed tx must be a list".into()) };
    if !rest.is_empty() {
        return Err("trailing bytes after transaction".into());
    }
    let f = list_items(p)?;
    // Type 1: chainId, nonce, gasPrice, gas, to, value, data, accessList, y, r, s
    // Type 2: chainId, nonce, maxPrio, maxFee, gas, to, value, data, accessList, y, r, s
    let n = if ty == 1 { 11 } else { 12 };
    if f.len() != n {
        return Err(format!("type {ty} tx needs {n} fields, got {}", f.len()));
    }
    let o = if ty == 1 { 0 } else { 1 }; // field shift for the extra fee field
    let chain_id = as_u64(&f[0].0, "chainId")?;
    let nonce = as_u64(&f[1].0, "nonce")?;
    let gas = as_u64(&f[3 + o].0, "gas")?;
    let to = as_to(&f[4 + o].0)?;
    let value = as_u256(&f[5 + o].0, "value")?;
    let data = Bytes::copy_from_slice(as_str(&f[6 + o].0, "data")?);
    let access_list = as_access_list(&f[7 + o].0)?;
    let y = as_u64(&f[8 + o].0, "yParity")?;
    let r = as_u256(&f[9 + o].0, "r")?;
    let s = as_u256(&f[10 + o].0, "s")?;
    if y > 1 {
        return Err("bad yParity".into());
    }
    // Signing payload: type byte || rlp(all fields except the signature).
    let payload: Vec<u8> = f[..8 + o].iter().flat_map(|(_, raw)| raw.iter().copied()).collect();
    let mut enc = vec![ty];
    enc.extend(list_header(payload.len()));
    enc.extend(payload);
    let from = recover(&keccak256(&enc), r, s, y as u8)?;
    Ok(DecodedTx { tx_type: ty, hash, from, to, value, data, gas, nonce, chain_id: Some(chain_id), access_list })
}
