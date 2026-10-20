// ============================================================================
// FEED FRAMES: unpack one sequencer-feed websocket text frame.
//
// Plain English:
//   The bot forwards every raw websocket text frame from Robinhood's
//   sequencer feed. A frame looks like:
//     { "version": 1, "messages": [ { "sequenceNumber": N,
//         "message": { "message": { "header": { "kind": 3, "sender": "0x..",
//              "blockNumber": <L1 block>, "timestamp": <unix s>, ... },
//           "l2Msg": "<base64>" }, "delayedMessagesRead": D }, ... } ] }
//   Each message = exactly one L2 block (block number = N + genesis offset).
//
//   Unpacking rules are the SAME as the bot's src/chains/nitroFeed.ts:
//     header kind 3 = L2 message (user transactions);
//     l2Msg first byte: 4 = one signed tx, 3 = batch of
//       [8-byte big-endian length][nested l2Msg] (nested up to 16 deep);
//     malformed pieces are skipped, never a crash.
//   Differences (we need the whole block, not just swaps):
//     - plain ETH transfers and contract creations are kept too;
//     - anything we can't replay (other header kinds such as deposits, other
//       l2Msg kinds, undecodable bytes) is reported, so the mirror knows its
//       copy may be incomplete for this block (see state/mirror.rs).
// ============================================================================
use base64::Engine;
use revm::primitives::{Address, B256};
use serde_json::Value;

use super::tx::{decode, FeedTx};
use crate::check::hexutil::{parse_address, parse_u256};

pub const HEADER_KIND_L2_MESSAGE: u8 = 3;
/// Header kinds that change nothing outside ArbOS's own bookkeeping
/// (EndOfBlock 6, BatchPostingReport 13): harmless for our copy.
pub const HARMLESS_HEADER_KINDS: [u8; 2] = [6, 13];
pub const L2_KIND_BATCH: u8 = 3;
pub const L2_KIND_SIGNED_TX: u8 = 4;
/// l2Msg kind "heartbeat": carries nothing.
pub const L2_KIND_HEARTBEAT: u8 = 6;
pub const MAX_BATCH_DEPTH: usize = 16;

/// One feed message (= one L2 block).
#[derive(Clone, Debug)]
pub struct FeedMessage {
    pub seq: u64,
    /// Header kind (3 = user transactions).
    pub kind: u8,
    /// Parent-chain (L1) block number from the header (what NUMBER returns).
    pub l1_block: u64,
    pub timestamp: u64,
    /// Header sender (the poster; becomes the block's coinbase).
    pub sender: Option<Address>,
    /// Some feeds include the resulting L2 block hash.
    pub block_hash: Option<B256>,
    /// Transactions in order (decoded + sender recovered).
    pub txs: Vec<FeedTx>,
    /// Pieces we could not turn into a transaction (text = why). Non-empty
    /// means our replay of this block is incomplete.
    pub unreplayable: Vec<String>,
}

impl FeedMessage {
    /// Can this whole message be replayed by us (nothing unknown inside)?
    pub fn complete(&self) -> bool {
        (self.kind == HEADER_KIND_L2_MESSAGE || HARMLESS_HEADER_KINDS.contains(&self.kind)) && self.unreplayable.is_empty()
    }
}

/// Decode base64 like Node's Buffer.from(s, 'base64'): padding optional,
/// URL-safe letters accepted, whitespace ignored.
pub fn lenient_base64(s: &str) -> Option<Vec<u8>> {
    let clean: String = s.chars().filter(|c| !c.is_whitespace()).map(|c| match c {
        '-' => '+',
        '_' => '/',
        c => c,
    }).collect();
    let trimmed = clean.trim_end_matches('=');
    base64::engine::general_purpose::STANDARD_NO_PAD.decode(trimmed).ok()
}

/// Walk one l2Msg: push signed txs (raw bytes) or "can't replay" notes.
fn walk_l2(bytes: &[u8], depth: usize, raws: &mut Vec<Vec<u8>>, bad: &mut Vec<String>) {
    if bytes.is_empty() || depth > MAX_BATCH_DEPTH {
        if depth > MAX_BATCH_DEPTH {
            bad.push("batch nested too deep".into());
        }
        return;
    }
    let kind = bytes[0];
    let body = &bytes[1..];
    match kind {
        L2_KIND_SIGNED_TX => raws.push(body.to_vec()),
        L2_KIND_BATCH => {
            let mut i = 0usize;
            while i + 8 <= body.len() {
                let len = u64::from_be_bytes(body[i..i + 8].try_into().unwrap());
                i += 8;
                if len == 0 || (len as u128) > (body.len() - i) as u128 {
                    bad.push("truncated batch".into());
                    break;
                }
                let len = len as usize;
                walk_l2(&body[i..i + len], depth + 1, raws, bad);
                i += len;
            }
        }
        L2_KIND_HEARTBEAT => {}
        k => bad.push(format!("l2Msg kind {k} not replayed")),
    }
}

/// Number field that may be a JSON number or a hex/decimal string.
fn num(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) if s.starts_with("0x") => u64::from_str_radix(&s[2..], 16).ok(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

/// Parse one message object of a frame. None = no sequence number.
pub fn parse_message(m: &Value) -> Option<FeedMessage> {
    let seq = num(m.get("sequenceNumber")?)?;
    let inner = m.get("message").and_then(|x| x.get("message"));
    let header = inner.and_then(|x| x.get("header"));
    let kind = header.and_then(|h| h.get("kind")).and_then(num).unwrap_or(255) as u8;
    let mut msg = FeedMessage {
        seq,
        kind,
        l1_block: header.and_then(|h| h.get("blockNumber")).and_then(num).unwrap_or(0),
        timestamp: header.and_then(|h| h.get("timestamp")).and_then(num).unwrap_or(0),
        sender: header.and_then(|h| h.get("sender")).and_then(|s| s.as_str()).and_then(|s| parse_address(s).ok()),
        block_hash: m
            .get("blockHash")
            .and_then(|h| h.as_str())
            .and_then(|h| parse_u256(h).ok())
            .map(|u| B256::from(u.to_be_bytes::<32>())),
        txs: Vec::new(),
        unreplayable: Vec::new(),
    };
    if kind != HEADER_KIND_L2_MESSAGE {
        if !HARMLESS_HEADER_KINDS.contains(&kind) {
            msg.unreplayable.push(format!("header kind {kind} (delayed/L1 message) not replayed"));
        }
        return Some(msg);
    }
    let Some(b64) = inner.and_then(|x| x.get("l2Msg")).and_then(|x| x.as_str()) else {
        msg.unreplayable.push("l2Msg missing".into());
        return Some(msg);
    };
    let Some(bytes) = lenient_base64(b64) else {
        msg.unreplayable.push("l2Msg is not base64".into());
        return Some(msg);
    };
    let mut raws = Vec::new();
    walk_l2(&bytes, 0, &mut raws, &mut msg.unreplayable);
    for raw in raws {
        match decode(&raw) {
            Ok(t) => {
                if !t.replayable() {
                    msg.unreplayable.push(format!("tx type {} not replayable ({})", t.tx_type, t.hash));
                }
                msg.txs.push(t);
            }
            Err(e) => msg.unreplayable.push(format!("undecodable tx: {e}")),
        }
    }
    Some(msg)
}

/// Parse a whole websocket text frame. Frames without messages (e.g. the
/// feed's confirmation frames) give an empty list. Never panics.
pub fn parse_frame(text: &str) -> Result<Vec<FeedMessage>, String> {
    let v: Value = serde_json::from_str(text).map_err(|_| "frame is not JSON".to_string())?;
    let Some(arr) = v.get("messages").and_then(|m| m.as_array()) else { return Ok(Vec::new()) };
    Ok(arr.iter().filter_map(parse_message).collect())
}
