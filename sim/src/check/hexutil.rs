// ============================================================================
// Small, STRICT helpers to read "0x..." text from requests.
//
// Plain English:
//   Requests from the bot carry numbers, addresses and byte strings as hex
//   text. These helpers turn that text into values and say clearly when the
//   text is broken (instead of quietly using zero, which could give a
//   confident wrong answer). A broken request is answered "unknown".
// ============================================================================
use revm::primitives::{Address, Bytes, U256};

/// Hex text -> bytes. Accepts "0x" (empty) and an odd number of digits is an error.
pub fn parse_bytes(s: &str) -> Result<Bytes, String> {
    let t = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")).unwrap_or(s);
    if t.len() % 2 != 0 {
        return Err(format!("odd-length hex ({} digits)", t.len()));
    }
    let mut out = Vec::with_capacity(t.len() / 2);
    let b = t.as_bytes();
    for i in (0..b.len()).step_by(2) {
        let hi = nibble(b[i]).ok_or_else(|| "bad hex digit".to_string())?;
        let lo = nibble(b[i + 1]).ok_or_else(|| "bad hex digit".to_string())?;
        out.push(hi << 4 | lo);
    }
    Ok(Bytes::from(out))
}

#[inline]
fn nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Hex text -> 256-bit number ("0x" or "" = 0). Decimal text is also accepted
/// when it has no 0x prefix and only digits (some callers send plain numbers).
pub fn parse_u256(s: &str) -> Result<U256, String> {
    if let Some(t) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        if t.is_empty() {
            return Ok(U256::ZERO);
        }
        if t.len() > 64 {
            // Allow leading zeros (e.g. a 32-byte word written with padding).
            let trimmed = t.trim_start_matches('0');
            if trimmed.len() > 64 {
                return Err("number wider than 256 bits".into());
            }
            return U256::from_str_radix(if trimmed.is_empty() { "0" } else { trimmed }, 16).map_err(|e| e.to_string());
        }
        return U256::from_str_radix(t, 16).map_err(|e| e.to_string());
    }
    if !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()) {
        return U256::from_str_radix(s, 10).map_err(|e| e.to_string());
    }
    Err(format!("not a number: {s:.20}"))
}

/// Hex text -> u64 (errors if it doesn't fit).
pub fn parse_u64(s: &str) -> Result<u64, String> {
    let v = parse_u256(s)?;
    if v > U256::from(u64::MAX) {
        return Err("number too big for 64 bits".into());
    }
    Ok(v.to::<u64>())
}

/// Hex text -> 20-byte address (must be exactly 20 bytes).
pub fn parse_address(s: &str) -> Result<Address, String> {
    let b = parse_bytes(s)?;
    if b.len() != 20 {
        return Err(format!("address must be 20 bytes, got {}", b.len()));
    }
    Ok(Address::from_slice(&b))
}

/// Bytes -> "0x..." lowercase hex.
pub fn to_hex(b: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(2 + b.len() * 2);
    s.push_str("0x");
    for x in b {
        s.push(HEX[(x >> 4) as usize] as char);
        s.push(HEX[(x & 15) as usize] as char);
    }
    s
}

/// Number -> "0x..." (no leading zeros, "0x0" for zero), like node answers.
pub fn quantity(v: U256) -> String {
    format!("{v:#x}")
}

/// u64 -> "0x..." quantity.
pub fn quantity_u64(v: u64) -> String {
    format!("{v:#x}")
}
