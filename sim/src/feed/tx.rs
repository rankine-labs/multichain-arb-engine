// ============================================================================
// FEED TRANSACTIONS: unpack a signed transaction and find out who sent it.
//
// Plain English:
//   The sequencer feed carries each user transaction as its raw signed
//   bytes. To replay it we need its fields (to, value, data, gas, ...) and
//   its SENDER, which is not written anywhere: it is worked out from the
//   signature ("sender recovery", the same maths the chain itself does).
//
//   Kinds handled:
//     legacy (with or without chain id), 0x01 access list, 0x02 EIP-1559,
//     0x04 EIP-7702 (smart-wallet "set code" transactions: their
//     authorizations are recovered too), 0x03 blob (decoded, but marked as
//     not replayable: Arbitrum chains don't run blob transactions).
//   Anything else -> error (the replay then treats the transaction as
//   "can't replay", see feed/replay.rs).
// ============================================================================
use revm::context_interface::either::Either;
use revm::context_interface::transaction::{
    AccessList, AccessListItem, Authorization, RecoveredAuthority, RecoveredAuthorization, SignedAuthorization,
};
use revm::primitives::{alloy_primitives::B512, keccak256, Address, Bytes, TxKind, B256, U256};

use super::rlp::{self, Item};

/// One decoded, sender-recovered transaction from the feed.
#[derive(Clone, Debug)]
pub struct FeedTx {
    /// 0 legacy, 1 access list, 2 EIP-1559, 3 blob, 4 EIP-7702.
    pub tx_type: u8,
    /// keccak256 of the raw signed bytes (= the transaction hash).
    pub hash: B256,
    pub from: Address,
    pub to: Option<Address>,
    pub value: U256,
    pub data: Bytes,
    pub gas_limit: u64,
    pub nonce: u64,
    pub chain_id: Option<u64>,
    /// Legacy/2930: gas price. 1559+: max fee per gas.
    pub gas_price: u128,
    /// 1559+: max priority fee (tip).
    pub priority_fee: Option<u128>,
    pub access_list: Vec<AccessListItem>,
    /// 7702 authorizations with their recovered signer (None = bad signature).
    pub authorizations: Vec<(Authorization, Option<Address>)>,
}

impl FeedTx {
    /// Can our EVM replay this kind of transaction?
    pub fn replayable(&self) -> bool {
        matches!(self.tx_type, 0 | 1 | 2 | 4)
    }

    /// revm transaction for replay: REAL sender, value, gas limit, data,
    /// access list and authorizations. (The tip is capped at the max fee:
    /// Robinhood's sequencer accepts tip > max fee, revm would refuse it;
    /// fees are not charged in replay anyway, see feed/replay.rs.)
    pub fn tx_env(&self) -> revm::context::TxEnv {
        let kind = self.to.map(TxKind::Call).unwrap_or(TxKind::Create);
        revm::context::TxEnv {
            tx_type: self.tx_type,
            caller: self.from,
            gas_limit: self.gas_limit,
            gas_price: self.gas_price,
            kind,
            value: self.value,
            data: self.data.clone(),
            nonce: self.nonce,
            chain_id: self.chain_id,
            access_list: AccessList(self.access_list.clone()),
            gas_priority_fee: self.priority_fee.map(|p| p.min(self.gas_price)),
            authorization_list: self
                .authorizations
                .iter()
                .map(|(a, who)| {
                    let auth = match who {
                        Some(x) => RecoveredAuthority::Valid(*x),
                        None => RecoveredAuthority::Invalid,
                    };
                    Either::<SignedAuthorization, RecoveredAuthorization>::Right(RecoveredAuthorization::new_unchecked(
                        a.clone(),
                        auth,
                    ))
                })
                .collect(),
            ..Default::default()
        }
    }
}

/// Recover the signer of a 32-byte message hash (secp256k1, like the
/// chain's own ecrecover). `y_parity` is 0 or 1.
pub fn recover_signer(msg: B256, y_parity: u8, r: U256, s: U256) -> Result<Address, String> {
    if y_parity > 1 {
        return Err("bad signature parity".into());
    }
    if r.is_zero() || s.is_zero() {
        return Err("zero signature value".into());
    }
    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(&r.to_be_bytes::<32>());
    sig[32..].copy_from_slice(&s.to_be_bytes::<32>());
    let out = revm::precompile::secp256k1::ecrecover(&B512::from(sig), y_parity, &msg)
        .map_err(|e| format!("signature recovery failed: {e}"))?;
    Ok(Address::from_slice(&out[12..]))
}

fn to_field(it: &Item<'_>) -> Result<Option<Address>, String> {
    let b = rlp::bytes(it)?;
    match b.len() {
        0 => Ok(None),
        20 => Ok(Some(Address::from_slice(b))),
        _ => Err("bad 'to' address length".into()),
    }
}

fn u128_of(it: &Item<'_>) -> Result<u128, String> {
    u128::try_from(rlp::uint(it)?).map_err(|_| "fee too large".to_string())
}

fn access_list(it: &Item<'_>) -> Result<Vec<AccessListItem>, String> {
    let Item::List(p) = it else { return Err("access list must be a list".into()) };
    let mut out = Vec::new();
    for (entry, _) in rlp::list_items(p)? {
        let Item::List(ep) = entry else { return Err("access list entry must be a list".into()) };
        let f = rlp::list_items(ep)?;
        if f.len() != 2 {
            return Err("access list entry needs 2 fields".into());
        }
        let a = rlp::bytes(&f[0].0)?;
        if a.len() != 20 {
            return Err("access list address length".into());
        }
        let Item::List(kp) = f[1].0 else { return Err("access list keys must be a list".into()) };
        let mut keys = Vec::new();
        for (k, _) in rlp::list_items(kp)? {
            let kb = rlp::bytes(&k)?;
            if kb.len() != 32 {
                return Err("access list key length".into());
            }
            keys.push(B256::from_slice(kb));
        }
        out.push(AccessListItem { address: Address::from_slice(a), storage_keys: keys });
    }
    Ok(out)
}

// 7702 authorization list: [[chainId, address, nonce, yParity, r, s], ...].
// Signed message = keccak(0x05 || rlp([chainId, address, nonce])).
fn authorizations(it: &Item<'_>) -> Result<Vec<(Authorization, Option<Address>)>, String> {
    let Item::List(p) = it else { return Err("authorization list must be a list".into()) };
    let mut out = Vec::new();
    for (entry, _) in rlp::list_items(p)? {
        let Item::List(ep) = entry else { return Err("authorization must be a list".into()) };
        let f = rlp::list_items(ep)?;
        if f.len() != 6 {
            return Err("authorization needs 6 fields".into());
        }
        let chain_id = rlp::uint(&f[0].0)?;
        let a = rlp::bytes(&f[1].0)?;
        if a.len() != 20 {
            return Err("authorization address length".into());
        }
        let address = Address::from_slice(a);
        let nonce = rlp::u64_of(&f[2].0)?;
        let y = rlp::u64_of(&f[3].0)?;
        let r = rlp::uint(&f[4].0)?;
        let s = rlp::uint(&f[5].0)?;
        let mut m = vec![0x05u8];
        m.extend(rlp::wrap_list(&[f[0].1, f[1].1, f[2].1]));
        // A bad authorization signature doesn't invalidate the tx: that
        // authorization is just skipped by the chain (same in revm: Invalid).
        let who = if y <= 1 { recover_signer(keccak256(&m), y as u8, r, s).ok() } else { None };
        out.push((Authorization { chain_id, address, nonce }, who));
    }
    Ok(out)
}

/// Decode one signed transaction (raw bytes as in the feed / eth_sendRawTransaction).
pub fn decode(raw: &[u8]) -> Result<FeedTx, String> {
    let first = *raw.first().ok_or("empty transaction")?;
    let hash = keccak256(raw);
    if first >= 0xc0 {
        return decode_legacy(raw, hash);
    }
    let ty = first;
    let f = rlp::read_list(&raw[1..])?;
    // Field layouts per type (signature = last 3 fields).
    let n = match ty {
        0x01 => 11,
        0x02 => 12,
        0x03 => 14,
        0x04 => 13,
        t => return Err(format!("unsupported tx type 0x{t:x}")),
    };
    if f.len() != n {
        return Err(format!("tx type {ty}: expected {n} fields, got {}", f.len()));
    }
    let chain_id = rlp::u64_of(&f[0].0)?;
    let nonce = rlp::u64_of(&f[1].0)?;
    let (gas_price, priority_fee, rest) = if ty == 0x01 {
        (u128_of(&f[2].0)?, None, 3)
    } else {
        (u128_of(&f[3].0)?, Some(u128_of(&f[2].0)?), 4)
    };
    let gas_limit = rlp::u64_of(&f[rest].0)?;
    let to = to_field(&f[rest + 1].0)?;
    let value = rlp::uint(&f[rest + 2].0)?;
    let data = Bytes::copy_from_slice(rlp::bytes(&f[rest + 3].0)?);
    let al = access_list(&f[rest + 4].0)?;
    let auths = if ty == 0x04 { authorizations(&f[rest + 5].0)? } else { Vec::new() };
    if (ty == 0x03 || ty == 0x04) && to.is_none() {
        return Err("blob / 7702 tx must have a 'to'".into());
    }
    let y = rlp::u64_of(&f[n - 3].0)?;
    let r = rlp::uint(&f[n - 2].0)?;
    let s = rlp::uint(&f[n - 1].0)?;
    if y > 1 {
        return Err("bad yParity".into());
    }
    // Signed message = keccak(type || rlp(all fields except the signature)).
    let unsigned: Vec<&[u8]> = f[..n - 3].iter().map(|(_, e)| *e).collect();
    let mut m = vec![ty];
    m.extend(rlp::wrap_list(&unsigned));
    let from = recover_signer(keccak256(&m), y as u8, r, s)?;
    Ok(FeedTx {
        tx_type: ty,
        hash,
        from,
        to,
        value,
        data,
        gas_limit,
        nonce,
        chain_id: Some(chain_id),
        gas_price,
        priority_fee,
        access_list: al,
        authorizations: auths,
    })
}

// Legacy: [nonce, gasPrice, gas, to, value, data, v, r, s].
// v = 27/28 (no chain id) or chainId*2 + 35/36 (EIP-155).
fn decode_legacy(raw: &[u8], hash: B256) -> Result<FeedTx, String> {
    let f = rlp::read_list(raw)?;
    if f.len() != 9 {
        return Err(format!("legacy tx: expected 9 fields, got {}", f.len()));
    }
    let v = rlp::u64_of(&f[6].0)?;
    let r = rlp::uint(&f[7].0)?;
    let s = rlp::uint(&f[8].0)?;
    let (chain_id, parity) = match v {
        27 | 28 => (None, (v - 27) as u8),
        v if v >= 35 => (Some((v - 35) / 2), ((v - 35) % 2) as u8),
        _ => return Err(format!("legacy tx: bad v {v}")),
    };
    let mut parts: Vec<Vec<u8>> = f[..6].iter().map(|(_, e)| e.to_vec()).collect();
    if let Some(c) = chain_id {
        parts.push(rlp::enc_uint(U256::from(c)));
        parts.push(vec![0x80]);
        parts.push(vec![0x80]);
    }
    let refs: Vec<&[u8]> = parts.iter().map(|p| p.as_slice()).collect();
    let from = recover_signer(keccak256(rlp::wrap_list(&refs)), parity, r, s)?;
    Ok(FeedTx {
        tx_type: 0,
        hash,
        from,
        to: to_field(&f[3].0)?,
        value: rlp::uint(&f[4].0)?,
        data: Bytes::copy_from_slice(rlp::bytes(&f[5].0)?),
        gas_limit: rlp::u64_of(&f[2].0)?,
        nonce: rlp::u64_of(&f[0].0)?,
        chain_id,
        gas_price: u128_of(&f[1].0)?,
        priority_fee: None,
        access_list: Vec::new(),
        authorizations: Vec::new(),
    })
}
