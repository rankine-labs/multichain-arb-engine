// ============================================================================
// GUN: EIP-1559 (type 2) TRANSACTION BUILD + SIGN
//
// Plain English:
//   A trade is sent as a signed "type 2" transaction, exactly the one the
//   Node sender (src/execution/fastSender.ts) builds with ethers:
//     type 2, chainId 4663, nonce, maxPriorityFeePerGas 0 (Robinhood orders
//     first come, first served: a tip buys nothing), maxFeePerGas (2x base
//     fee + 1, see gas.rs), gasLimit, to = ArbExecutor, value 0, data =
//     calldata, empty access list.
//   Packed as 0x02 || RLP([...fields, yParity, r, s]); the signature is over
//   keccak(0x02 || RLP([...fields])). Signing uses libsecp256k1 (the same
//   library revm already builds) with RFC 6979 deterministic nonces and
//   low-s signatures, which is what ethers does too, so the bytes are
//   IDENTICAL to ethers' for the same fields (proved by sim/tests/gun_vectors.rs
//   against transactions signed by ethers).
//
// The private key:
//   Held only inside `Signer`. Its Debug output shows the address, never the
//   key. The secret is wiped from memory when the Signer is dropped
//   (best effort: SecretKey::non_secure_erase). Live mode reads it from
//   BOT_PRIVATE_KEY (gun.rs); practice mode makes a random throwaway key.
// ============================================================================
use revm::primitives::{keccak256, Address, B256, U256};
use secp256k1::ecdsa::RecoverableSignature;
use secp256k1::{Message, PublicKey, SecretKey, SECP256K1};
use zeroize::Zeroize;

use crate::feed::rlp;

/// The fields of one transaction (everything except the signature).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TxFields {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: u128,
    pub max_fee_per_gas: u128,
    pub gas_limit: u64,
    pub to: Address,
    pub value: U256,
    pub data: Vec<u8>,
}

/// A signed transaction: raw bytes to send and its hash (known before sending).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedTx {
    pub raw: Vec<u8>,
    pub hash: B256,
}

/// RLP of the fields (without the outer list header), into `out`.
fn encode_fields(f: &TxFields, out: &mut Vec<u8>) {
    out.extend(rlp::enc_uint(U256::from(f.chain_id)));
    out.extend(rlp::enc_uint(U256::from(f.nonce)));
    out.extend(rlp::enc_uint(U256::from(f.max_priority_fee_per_gas)));
    out.extend(rlp::enc_uint(U256::from(f.max_fee_per_gas)));
    out.extend(rlp::enc_uint(U256::from(f.gas_limit)));
    out.extend(rlp::enc_bytes(f.to.as_slice()));
    out.extend(rlp::enc_uint(f.value));
    out.extend(rlp::enc_bytes(&f.data));
    out.push(0xc0); // empty access list
}

/// keccak(0x02 || rlp(fields)): the message that gets signed.
pub fn signing_hash(f: &TxFields) -> B256 {
    let mut body = Vec::with_capacity(f.data.len() + 96);
    encode_fields(f, &mut body);
    let mut m = Vec::with_capacity(body.len() + 8);
    m.push(0x02);
    m.extend(rlp::header(true, body.len()));
    m.extend(body);
    keccak256(&m)
}

/// The account that holds a key, and signs with it.
pub struct Signer {
    key: SecretKey,
    address: Address,
}

impl std::fmt::Debug for Signer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Signer({:#x})", self.address)
    }
}

impl Drop for Signer {
    fn drop(&mut self) {
        self.key.non_secure_erase();
    }
}

/// Ethereum address of a public key (last 20 bytes of keccak of x||y).
pub fn address_of(pk: &PublicKey) -> Address {
    let un = pk.serialize_uncompressed();
    let h = keccak256(&un[1..]);
    Address::from_slice(&h[12..])
}

impl Signer {
    /// From 32 key bytes. The caller's buffer is wiped.
    pub fn from_bytes(bytes: &mut [u8; 32]) -> Result<Signer, String> {
        let key = SecretKey::from_byte_array(*bytes).map_err(|_| "not a valid secp256k1 private key".to_string());
        bytes.zeroize();
        let key = key?;
        let address = address_of(&PublicKey::from_secret_key(SECP256K1, &key));
        Ok(Signer { key, address })
    }

    /// From hex text ("0x" optional, surrounding spaces ignored). The error
    /// text never contains the input.
    pub fn from_hex(text: &str) -> Result<Signer, String> {
        let t = text.trim();
        let t = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")).unwrap_or(t);
        if t.len() != 64 {
            return Err("private key must be 32 bytes of hex".into());
        }
        let mut b = [0u8; 32];
        for i in 0..32 {
            match u8::from_str_radix(&t[2 * i..2 * i + 2], 16) {
                Ok(v) => b[i] = v,
                Err(_) => {
                    b.zeroize();
                    return Err("private key is not hex".into());
                }
            }
        }
        Signer::from_bytes(&mut b)
    }

    /// A fresh random throwaway key (practice mode): from the OS random source.
    pub fn random() -> Result<Signer, String> {
        use std::io::Read;
        for _ in 0..8 {
            let mut b = [0u8; 32];
            std::fs::File::open("/dev/urandom")
                .and_then(|mut f| f.read_exact(&mut b))
                .map_err(|e| format!("no random source: {}", e.kind()))?;
            if let Ok(s) = Signer::from_bytes(&mut b) {
                return Ok(s);
            }
        }
        Err("could not make a random key".into())
    }

    pub fn address(&self) -> Address {
        self.address
    }

    /// Sign a 32-byte hash: (yParity, r, s).
    pub fn sign_hash(&self, h: B256) -> (u8, [u8; 32], [u8; 32]) {
        let sig: RecoverableSignature = SECP256K1.sign_ecdsa_recoverable(Message::from_digest(h.0), &self.key);
        let (rec, compact) = sig.serialize_compact();
        let mut r = [0u8; 32];
        let mut s = [0u8; 32];
        r.copy_from_slice(&compact[..32]);
        s.copy_from_slice(&compact[32..]);
        (i32::from(rec) as u8, r, s)
    }

    /// Build and sign a type 2 transaction.
    pub fn sign_tx(&self, f: &TxFields) -> SignedTx {
        let mut body = Vec::with_capacity(f.data.len() + 180);
        encode_fields(f, &mut body);
        // Signing message: 0x02 || rlp_list(fields)
        let mut m = Vec::with_capacity(body.len() + 8);
        m.push(0x02);
        m.extend(rlp::header(true, body.len()));
        m.extend_from_slice(&body);
        let (y, r, s) = self.sign_hash(keccak256(&m));
        // Signed: 0x02 || rlp_list(fields, yParity, r, s)
        body.extend(rlp::enc_uint(U256::from(y)));
        body.extend(rlp::enc_uint(U256::from_be_bytes(r)));
        body.extend(rlp::enc_uint(U256::from_be_bytes(s)));
        let mut raw = Vec::with_capacity(body.len() + 8);
        raw.push(0x02);
        raw.extend(rlp::header(true, body.len()));
        raw.extend(body);
        let hash = keccak256(&raw);
        SignedTx { raw, hash }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields() -> TxFields {
        TxFields {
            chain_id: 4663,
            nonce: 7,
            max_priority_fee_per_gas: 0,
            max_fee_per_gas: 20_000_001,
            gas_limit: 1_500_000,
            to: Address::repeat_byte(0x11),
            value: U256::ZERO,
            data: vec![0x8d, 0xa2, 0xb3, 0x2d, 0, 1, 2],
        }
    }

    #[test]
    fn our_tx_decodes_and_recovers_our_address() {
        let s = Signer::random().unwrap();
        let f = fields();
        let tx = s.sign_tx(&f);
        let d = crate::feed::tx::decode(&tx.raw).unwrap();
        assert_eq!(d.tx_type, 2);
        assert_eq!(d.from, s.address());
        assert_eq!(d.hash, tx.hash);
        assert_eq!(d.nonce, 7);
        assert_eq!(d.chain_id, Some(4663));
        assert_eq!(d.gas_limit, 1_500_000);
        assert_eq!(d.gas_price, 20_000_001);
        assert_eq!(d.priority_fee, Some(0));
        assert_eq!(d.to, Some(f.to));
        assert_eq!(&d.data[..], &f.data[..]);
        // The signature is over signing_hash: recovering from it gives our address.
        let (y, r, s2) = s.sign_hash(signing_hash(&f));
        let who = crate::feed::tx::recover_signer(signing_hash(&f), y, U256::from_be_bytes(r), U256::from_be_bytes(s2)).unwrap();
        assert_eq!(who, s.address());
    }

    #[test]
    fn key_one_has_the_known_address() {
        let s = Signer::from_hex("0x0000000000000000000000000000000000000000000000000000000000000001").unwrap();
        assert_eq!(format!("{:#x}", s.address()), "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
        // Debug never shows the key.
        assert!(!format!("{s:?}").contains("0000000000000001"));
    }

    #[test]
    fn bad_keys_refused_without_echo() {
        for bad in ["", "0x12", "zz00000000000000000000000000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000000000000000000000000000000"] {
            let e = Signer::from_hex(bad).unwrap_err();
            assert!(!e.contains("zz") && !e.contains("0000"), "{e}");
        }
    }
}
