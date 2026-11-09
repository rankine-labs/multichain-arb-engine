// ============================================================================
// FOUR.MEME: contract addresses, event ids and log decoding.
//
// Plain English:
//   Every Four.meme bonding-curve trade, no matter which bot, router or
//   wallet app sent it, ends with the TokenManager contract emitting a
//   TokenPurchase or TokenSale event. So instead of trying to understand
//   every router's calldata, the probe watches those events and matches
//   them back to the transaction hash.
//
// Source of truth: the verified TokenManager2 ABI (BscScan, proxy
// 0x5c952063c7fc8610ffdb798152d69f0b9550762b). All event parameters are
// NON-indexed, so the only topic is the event id and everything else is in
// the data field as 32-byte words.
// ============================================================================
use serde_json::{json, Value};
use tiny_keccak::{Hasher, Keccak};

/// TokenManager2 (current, "V2") proxy on BSC. Lowercase hex.
pub const TOKEN_MANAGER_2: &str = "0x5c952063c7fc8610ffdb798152d69f0b9550762b";
/// TokenManager (original, "V1") on BSC. Older tokens still trade here.
pub const TOKEN_MANAGER_1: &str = "0xec4549cadce5da21df6e6422d448034b5233bfbc";

/// Event signatures exactly as in the verified ABI.
pub const SIG_PURCHASE: &str = "TokenPurchase(address,address,uint256,uint256,uint256,uint256,uint256,uint256)";
pub const SIG_SALE: &str = "TokenSale(address,address,uint256,uint256,uint256,uint256,uint256,uint256)";
pub const SIG_CREATE: &str = "TokenCreate(address,address,uint256,string,string,uint256,uint256,uint256)";
pub const SIG_LIQUIDITY: &str = "LiquidityAdded(address,uint256,address,uint256)";

/// keccak256 of raw bytes.
pub fn keccak(bytes: &[u8]) -> [u8; 32] {
    let mut k = Keccak::v256();
    let mut out = [0u8; 32];
    k.update(bytes);
    k.finalize(&mut out);
    out
}

/// Event id (topic0) of a signature, as 0x-prefixed lowercase hex.
pub fn topic0(sig: &str) -> String {
    format!("0x{}", hex(&keccak(sig.as_bytes())))
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// What kind of Four.meme event a log is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Buy,
    Sell,
    Create,
    Graduate,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Buy => "buy",
            Kind::Sell => "sell",
            Kind::Create => "create",
            Kind::Graduate => "graduate",
        }
    }
}

/// Precomputed event ids, so matching a log is a string compare.
#[derive(Clone, Debug)]
pub struct Topics {
    pub purchase: String,
    pub sale: String,
    pub create: String,
    pub liquidity: String,
}

impl Topics {
    pub fn new() -> Self {
        Topics {
            purchase: topic0(SIG_PURCHASE),
            sale: topic0(SIG_SALE),
            create: topic0(SIG_CREATE),
            liquidity: topic0(SIG_LIQUIDITY),
        }
    }

    pub fn kind_of(&self, t0: &str) -> Option<Kind> {
        let t = t0.to_ascii_lowercase();
        if t == self.purchase {
            Some(Kind::Buy)
        } else if t == self.sale {
            Some(Kind::Sell)
        } else if t == self.create {
            Some(Kind::Create)
        } else if t == self.liquidity {
            Some(Kind::Graduate)
        } else {
            None
        }
    }

    /// All ids, for the eth_subscribe "logs" filter.
    pub fn all(&self) -> Vec<String> {
        vec![self.purchase.clone(), self.sale.clone(), self.create.clone(), self.liquidity.clone()]
    }
}

impl Default for Topics {
    fn default() -> Self {
        Self::new()
    }
}

/// Split a 0x-hex data field into 32-byte words (each kept as hex text).
fn words(data: &str) -> Vec<&str> {
    let d = data.strip_prefix("0x").unwrap_or(data);
    (0..d.len() / 64).map(|i| &d[i * 64..i * 64 + 64]).collect()
}

/// A 32-byte word holding an address -> 0x + last 20 bytes.
fn word_addr(w: &str) -> String {
    format!("0x{}", w[24..].to_ascii_lowercase())
}

/// A 32-byte word holding a uint256 -> decimal string (u128 is too small for
/// raw token amounts in the worst case, so do it by hand, exactly).
pub fn word_dec(w: &str) -> String {
    // Big number as base-1e9 limbs (little-endian).
    let mut limbs: Vec<u64> = vec![0];
    for c in w.chars() {
        let d = c.to_digit(16).unwrap_or(0) as u64;
        let mut carry = d;
        for l in limbs.iter_mut() {
            let v = *l * 16 + carry;
            *l = v % 1_000_000_000;
            carry = v / 1_000_000_000;
        }
        while carry > 0 {
            limbs.push(carry % 1_000_000_000);
            carry /= 1_000_000_000;
        }
    }
    let mut s = limbs.last().unwrap().to_string();
    for l in limbs.iter().rev().skip(1) {
        s.push_str(&format!("{l:09}"));
    }
    s
}

/// Decode a Four.meme log (as delivered by eth_subscribe "logs") into a flat
/// JSON record. Returns None if it is not one of our events or malformed.
pub fn decode_log(topics: &Topics, log: &Value) -> Option<(Kind, Value)> {
    let t0 = log.get("topics")?.as_array()?.first()?.as_str()?;
    let kind = topics.kind_of(t0)?;
    let data = log.get("data")?.as_str()?;
    let w = words(data);
    let base = json!({
        "kind": kind.as_str(),
        "contract": log.get("address").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase(),
        "tx": log.get("transactionHash").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase(),
        "block": hex_u64(log.get("blockNumber")),
        "log_index": hex_u64(log.get("logIndex")),
        "tx_index": hex_u64(log.get("transactionIndex")),
        "removed": log.get("removed").and_then(Value::as_bool).unwrap_or(false),
    });
    let mut rec = base;
    let o = rec.as_object_mut()?;
    match kind {
        Kind::Buy | Kind::Sell => {
            if w.len() < 8 {
                return None;
            }
            // token, account, price, amount, cost, fee, offers, funds
            o.insert("token".into(), json!(word_addr(w[0])));
            o.insert("account".into(), json!(word_addr(w[1])));
            o.insert("price".into(), json!(word_dec(w[2])));
            o.insert("amount".into(), json!(word_dec(w[3])));
            o.insert("cost".into(), json!(word_dec(w[4])));
            o.insert("fee".into(), json!(word_dec(w[5])));
            o.insert("offers".into(), json!(word_dec(w[6])));
            o.insert("funds".into(), json!(word_dec(w[7])));
        }
        Kind::Create => {
            // creator, token, requestId, name(offset), symbol(offset), totalSupply, launchTime, launchFee
            if w.len() < 8 {
                return None;
            }
            o.insert("creator".into(), json!(word_addr(w[0])));
            o.insert("token".into(), json!(word_addr(w[1])));
            o.insert("total_supply".into(), json!(word_dec(w[5])));
            o.insert("launch_time".into(), json!(word_dec(w[6])));
        }
        Kind::Graduate => {
            // base, offers, quote, funds
            if w.len() < 4 {
                return None;
            }
            o.insert("token".into(), json!(word_addr(w[0])));
            o.insert("quote".into(), json!(word_addr(w[2])));
            o.insert("funds".into(), json!(word_dec(w[3])));
        }
    }
    Some((kind, rec))
}

/// "0x1a" -> 26 (None/garbage -> 0).
pub fn hex_u64(v: Option<&Value>) -> u64 {
    v.and_then(Value::as_str)
        .and_then(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16).ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keccak_matches_known_erc20_transfer_id() {
        // Well-known: Transfer(address,address,uint256)
        assert_eq!(
            topic0("Transfer(address,address,uint256)"),
            "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
        );
    }

    #[test]
    fn decimal_conversion_is_exact() {
        let w = format!("{:064x}", 1_234_567_890_123_456_789_012u128);
        assert_eq!(word_dec(&w), "1234567890123456789012");
        assert_eq!(word_dec(&"0".repeat(64)), "0");
        // 2^256 - 1
        assert_eq!(
            word_dec(&"f".repeat(64)),
            "115792089237316195423570985008687907853269984665640564039457584007913129639935"
        );
    }

    #[test]
    fn decodes_purchase_log() {
        let t = Topics::new();
        let token = "4444aaaabbbbccccddddeeeeffff000011112222";
        let acct = "1111222233334444555566667777888899990000";
        let mut data = String::from("0x");
        data.push_str(&format!("{:0>64}", token));
        data.push_str(&format!("{:0>64}", acct));
        for v in [5u64, 1000, 200, 2, 777, 999] {
            data.push_str(&format!("{v:064x}"));
        }
        let log = json!({
            "address": "0x5C952063c7fc8610FFDB798152D69F0B9550762b",
            "topics": [t.purchase],
            "data": data,
            "transactionHash": "0xABCD",
            "blockNumber": "0x10",
            "logIndex": "0x3",
            "transactionIndex": "0x1",
            "removed": false
        });
        let (k, r) = decode_log(&t, &log).unwrap();
        assert_eq!(k, Kind::Buy);
        assert_eq!(r["token"], format!("0x{token}"));
        assert_eq!(r["account"], format!("0x{acct}"));
        assert_eq!(r["price"], "5");
        assert_eq!(r["cost"], "200");
        assert_eq!(r["fee"], "2");
        assert_eq!(r["block"], 16);
        assert_eq!(r["tx"], "0xabcd");
        assert_eq!(r["contract"], TOKEN_MANAGER_2);
    }

    #[test]
    fn ignores_unknown_events() {
        let t = Topics::new();
        let log = json!({"topics": ["0xdeadbeef"], "data": "0x"});
        assert!(decode_log(&t, &log).is_none());
    }
}
