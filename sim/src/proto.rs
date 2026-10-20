// ============================================================================
// SOCKET PROTOCOL (shared shapes), see DESIGN.md "Socket protocol".
//
// Plain English:
//   Every message on the Unix socket = 4-byte big-endian length + UTF-8
//   JSON. Requests carry an `id`; answers echo it. Several requests may be
//   in flight on one connection; answers can come back in any order.
//
//   Request types:
//     feed          a raw sequencer-feed frame (no answer)
//     warm          accounts / slots the bot will ask about -> {ok}
//     call          run calls (check engine: check::proto_types::CallRequest)
//     size_search   find the best trade size (check::proto_types::SizeSearchRequest)
//     status        counters and health
//
//   `at` (which state a call / size_search is about):
//     {"after":"head"}          newest replayed block (default)
//     {"afterSeq":N}            right after feed message N
//     {"afterTx":"0xhash"}      right after that transaction (in its block)
//     {"block":"0xN"}           right after L2 block N
//     {"pinned":"0xN","env":"next"|"same"}
//                               separate exact view of confirmed block N
//                               filled from the node (for the comparison
//                               harness); waits for fills instead of "miss".
//
//   The call / size_search request and answer shapes are owned by the check
//   engine (workstream C) and re-exported here.
// ============================================================================
use std::io::{Read, Write};

use revm::primitives::B256;
use serde_json::{json, Value};

pub use crate::check::proto_types::{CallRequest, SizeSearchRequest, WireCall, WireOutcome};
use crate::check::hexutil::{parse_address, parse_u256, parse_u64};
use crate::state::mirror::At;
use crate::state::MissItem;

/// Biggest message accepted (a feed frame is a few KB; a call a few KB).
pub const MAX_MESSAGE: usize = 8 * 1024 * 1024;

/// Read one length-prefixed message. Ok(None) = the other side closed.
pub fn read_msg(r: &mut impl Read) -> std::io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = u32::from_be_bytes(len) as usize;
    if n > MAX_MESSAGE {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, format!("message too large ({n} bytes)")));
    }
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf)?;
    Ok(Some(buf))
}

/// Write one length-prefixed message.
pub fn write_msg(w: &mut impl Write, body: &[u8]) -> std::io::Result<()> {
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(body);
    w.write_all(&out)
}

/// Parse a request's `at` (missing / null = head).
pub fn parse_at(v: &Value) -> Result<At, String> {
    let Value::Object(m) = v else {
        return if v.is_null() { Ok(At::Head) } else { Err("at must be an object".into()) };
    };
    if let Some(p) = m.get("pinned") {
        let block = crate::state::pinned::parse_block(p).ok_or("at.pinned: bad block number")?;
        let next = match m.get("env").and_then(|e| e.as_str()) {
            None | Some("same") => false,
            Some("next") => true,
            Some(o) => return Err(format!("at.env: '{o}' (use 'next' or 'same')")),
        };
        return Ok(At::Pinned { block, next });
    }
    if let Some(a) = m.get("after") {
        return match a.as_str() {
            Some("head") => Ok(At::Head),
            _ => Err("at.after: only 'head' is supported".into()),
        };
    }
    if let Some(s) = m.get("afterSeq") {
        let n = match s {
            Value::Number(n) => n.as_u64(),
            Value::String(t) => parse_u64(t).ok(),
            _ => None,
        };
        return n.map(At::AfterSeq).ok_or_else(|| "at.afterSeq: bad number".to_string());
    }
    if let Some(h) = m.get("afterTx") {
        let h = h.as_str().ok_or("at.afterTx must be hex text")?;
        let u = parse_u256(h).map_err(|e| format!("at.afterTx: {e}"))?;
        return Ok(At::AfterTx(B256::from(u.to_be_bytes::<32>())));
    }
    if let Some(b) = m.get("block") {
        let n = match b {
            Value::Number(n) => n.as_u64(),
            Value::String(t) => parse_u64(t).ok(),
            _ => None,
        };
        return n.map(At::Block).ok_or_else(|| "at.block: bad number".to_string());
    }
    if m.is_empty() {
        return Ok(At::Head);
    }
    Err("at: give one of after / afterSeq / afterTx / block / pinned".into())
}

/// `warm` request -> items to fetch.
pub fn parse_warm(v: &Value) -> Result<Vec<MissItem>, String> {
    let mut out = Vec::new();
    if let Some(a) = v.get("accounts").and_then(|x| x.as_array()) {
        for x in a {
            let s = x.as_str().ok_or("accounts: must be hex text")?;
            out.push(MissItem::Account(parse_address(s)?));
        }
    }
    if let Some(m) = v.get("slots").and_then(|x| x.as_object()) {
        for (acct, slots) in m {
            let a = parse_address(acct)?;
            for s in slots.as_array().ok_or("slots: lists of slots expected")? {
                let s = s.as_str().ok_or("slots: hex text expected")?;
                out.push(MissItem::Slot(a, parse_u256(s)?));
            }
        }
    }
    Ok(out)
}

/// Missing-item list from a check answer (`missing: [{account, slot?}]`).
pub fn parse_missing(v: &Value) -> Vec<MissItem> {
    let mut out = Vec::new();
    if let Some(arr) = v.get("missing").and_then(|m| m.as_array()) {
        for m in arr {
            let Some(a) = m.get("account").and_then(|x| x.as_str()).and_then(|s| parse_address(s).ok()) else { continue };
            match m.get("slot").and_then(|x| x.as_str()).and_then(|s| parse_u256(s).ok()) {
                Some(s) => out.push(MissItem::Slot(a, s)),
                None => out.push(MissItem::Account(a)),
            }
        }
    }
    out
}

/// "Can't be sure" answer (live views).
pub fn unknown(id: &Value, reason: &str, detail: &str, us: u64) -> Value {
    json!({ "id": id, "ok": false, "unknown": reason, "detail": detail, "missing": [], "us": us })
}

/// Error answer for a malformed request.
pub fn bad_request(id: &Value, detail: &str) -> Value {
    json!({ "id": id, "ok": false, "unknown": "bad_request", "detail": detail, "missing": [], "us": 0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn at_forms() {
        assert_eq!(parse_at(&Value::Null).unwrap(), At::Head);
        assert_eq!(parse_at(&json!({"after":"head"})).unwrap(), At::Head);
        assert_eq!(parse_at(&json!({"afterSeq": 12})).unwrap(), At::AfterSeq(12));
        assert_eq!(parse_at(&json!({"block": "0x10"})).unwrap(), At::Block(16));
        assert_eq!(parse_at(&json!({"pinned": "0x10", "env": "next"})).unwrap(), At::Pinned { block: 16, next: true });
        assert_eq!(parse_at(&json!({"pinned": 7})).unwrap(), At::Pinned { block: 7, next: false });
        assert!(parse_at(&json!({"pinned": "0x1", "env": "later"})).is_err());
        assert!(matches!(parse_at(&json!({"afterTx": "0x01"})).unwrap(), At::AfterTx(_)));
    }

    #[test]
    fn framing_round_trip() {
        let mut buf = Vec::new();
        write_msg(&mut buf, b"{\"a\":1}").unwrap();
        let mut r = &buf[..];
        assert_eq!(read_msg(&mut r).unwrap().unwrap(), b"{\"a\":1}");
        assert!(read_msg(&mut r).unwrap().is_none());
    }
}
