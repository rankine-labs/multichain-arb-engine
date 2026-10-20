// ============================================================================
// RLP: Ethereum's packing format for transactions (tiny strict reader/writer).
//
// Plain English:
//   A signed transaction is a list of fields packed with RLP. This reads
//   that packing (and writes the little bit we need to rebuild the "message
//   that was signed" for sender recovery). Any malformed input is an error,
//   never a guess.
// ============================================================================

/// One RLP item: a byte string or a list (its packed contents).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Item<'a> {
    Str(&'a [u8]),
    List(&'a [u8]),
}

/// Reads one item from the front of `b`: (item, its full encoding, rest).
pub fn read(b: &[u8]) -> Result<(Item<'_>, &[u8], &[u8]), String> {
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
    if end > b.len() {
        return Err("rlp: item runs past the end".into());
    }
    let payload = &b[header..end];
    // Canonical form: a single byte < 0x80 must not be wrapped.
    if !is_list && header == 1 && len == 1 && payload[0] < 0x80 {
        return Err("rlp: non-canonical single byte".into());
    }
    let item = if is_list { Item::List(payload) } else { Item::Str(payload) };
    Ok((item, &b[..end], &b[end..]))
}

fn be_len(b: &[u8]) -> Result<usize, String> {
    if b.is_empty() || b[0] == 0 || b.len() > 8 {
        return Err("rlp: bad length prefix".into());
    }
    let mut n: usize = 0;
    for &x in b {
        n = n.checked_mul(256).ok_or("rlp: length overflow")? + x as usize;
    }
    Ok(n)
}

/// Splits a list's packed contents into (item, full encoding) pairs.
pub fn list_items(payload: &[u8]) -> Result<Vec<(Item<'_>, &[u8])>, String> {
    let mut out = Vec::new();
    let mut rest = payload;
    while !rest.is_empty() {
        let (it, enc, r) = read(rest)?;
        out.push((it, enc));
        rest = r;
    }
    Ok(out)
}

/// Reads exactly one top-level list (nothing may follow it).
pub fn read_list(b: &[u8]) -> Result<Vec<(Item<'_>, &[u8])>, String> {
    let (it, _, rest) = read(b)?;
    if !rest.is_empty() {
        return Err("rlp: trailing bytes after transaction".into());
    }
    match it {
        Item::List(p) => list_items(p),
        Item::Str(_) => Err("rlp: expected a list".into()),
    }
}

/// Byte string field.
pub fn bytes<'a>(it: &Item<'a>) -> Result<&'a [u8], String> {
    match it {
        Item::Str(s) => Ok(s),
        Item::List(_) => Err("rlp: expected bytes, got a list".into()),
    }
}

/// Number field (big-endian, no leading zeros), up to 32 bytes.
pub fn uint(it: &Item<'_>) -> Result<revm::primitives::U256, String> {
    let s = bytes(it)?;
    if s.len() > 32 {
        return Err("rlp: number longer than 32 bytes".into());
    }
    if !s.is_empty() && s[0] == 0 {
        return Err("rlp: number with leading zero".into());
    }
    Ok(revm::primitives::U256::from_be_slice(s))
}

/// Number field that must fit in 64 bits.
pub fn u64_of(it: &Item<'_>) -> Result<u64, String> {
    let v = uint(it)?;
    u64::try_from(v).map_err(|_| "rlp: number too large".to_string())
}

/// Header for a list or string of `len` bytes.
pub fn header(is_list: bool, len: usize) -> Vec<u8> {
    let (short, long) = if is_list { (0xc0u8, 0xf7u8) } else { (0x80u8, 0xb7u8) };
    if len <= 55 {
        vec![short + len as u8]
    } else {
        let be = (len as u64).to_be_bytes();
        let skip = be.iter().take_while(|b| **b == 0).count();
        let mut v = vec![long + (8 - skip) as u8];
        v.extend_from_slice(&be[skip..]);
        v
    }
}

/// Wrap already-encoded items into a list.
pub fn wrap_list(items: &[&[u8]]) -> Vec<u8> {
    let len: usize = items.iter().map(|i| i.len()).sum();
    let mut v = header(true, len);
    for i in items {
        v.extend_from_slice(i);
    }
    v
}

/// Encode a number (no leading zeros; 0 = empty string).
pub fn enc_uint(v: revm::primitives::U256) -> Vec<u8> {
    let b = v.to_be_bytes::<32>();
    let skip = b.iter().take_while(|x| **x == 0).count();
    enc_bytes(&b[skip..])
}

/// Encode a byte string.
pub fn enc_bytes(b: &[u8]) -> Vec<u8> {
    if b.len() == 1 && b[0] < 0x80 {
        return vec![b[0]];
    }
    let mut v = header(false, b.len());
    v.extend_from_slice(b);
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use revm::primitives::U256;

    #[test]
    fn round_trip_numbers_and_lists() {
        for n in [0u64, 1, 0x7f, 0x80, 0xff, 0x1234, u64::MAX] {
            let e = enc_uint(U256::from(n));
            let (it, _, rest) = read(&e).unwrap();
            assert!(rest.is_empty());
            assert_eq!(u64_of(&it).unwrap(), n);
        }
        let long = vec![7u8; 100];
        let a = enc_bytes(&long);
        let b = enc_uint(U256::from(5u64));
        let l = wrap_list(&[&a, &b]);
        let items = read_list(&l).unwrap();
        assert_eq!(bytes(&items[0].0).unwrap(), &long[..]);
        assert_eq!(u64_of(&items[1].0).unwrap(), 5);
    }

    #[test]
    fn rejects_malformed() {
        assert!(read(&[0x83, 1, 2]).is_err()); // runs past the end
        assert!(read(&[0x81, 0x05]).is_err()); // non-canonical
        assert!(read_list(&[0xc1, 0x01, 0x02]).is_err()); // trailing bytes
        assert!(u64_of(&Item::Str(&[0, 1])).is_err()); // leading zero
    }
}
