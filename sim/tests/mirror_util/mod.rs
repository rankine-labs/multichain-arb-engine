// ============================================================================
// Helpers for the mirror tests (workstream A): build feed frames exactly the
// way Robinhood's sequencer feed sends them, and a FAKE NODE that answers
// from a hand-made "chain" (per-block state), counting every request.
// ============================================================================
#![allow(dead_code)]
use std::collections::HashMap;
use std::sync::Mutex;

use arbsim::check::hexutil::{parse_address, parse_u256, parse_u64};
use arbsim::node::{CallResult, Class, NodeApi, NodeErr, RpcErr};
use base64::Engine;
use revm::primitives::{Address, U256};
use serde_json::{json, Value};

/// [8-byte BE length][msg] entry of a batch.
pub fn batch_entry(msg: &[u8]) -> Vec<u8> {
    let mut v = (msg.len() as u64).to_be_bytes().to_vec();
    v.extend_from_slice(msg);
    v
}

/// l2Msg = kind 4 + raw signed tx.
pub fn signed_msg(raw: &[u8]) -> Vec<u8> {
    let mut v = vec![4u8];
    v.extend_from_slice(raw);
    v
}

/// l2Msg = kind 3 batch of entries.
pub fn batch_msg(entries: &[Vec<u8>]) -> Vec<u8> {
    let mut v = vec![3u8];
    for e in entries {
        v.extend(batch_entry(e));
    }
    v
}

/// One feed frame with one message.
pub fn frame(seq: u64, l2msg: &[u8], header_kind: u64, l1_block: u64, ts: u64) -> String {
    frames(&[(seq, l2msg.to_vec(), header_kind, l1_block, ts)])
}

/// One feed frame with several messages.
pub fn frames(msgs: &[(u64, Vec<u8>, u64, u64, u64)]) -> String {
    let m: Vec<Value> = msgs
        .iter()
        .map(|(seq, l2, kind, l1, ts)| {
            json!({
                "sequenceNumber": seq,
                "message": {
                    "message": {
                        "header": { "kind": kind, "sender": "0xa4b000000000000000000073657175656e636572",
                                    "blockNumber": l1, "timestamp": ts, "requestId": null, "baseFeeL1": null },
                        "l2Msg": base64::engine::general_purpose::STANDARD.encode(l2),
                    },
                    "delayedMessagesRead": 1
                },
                "signature": null
            })
        })
        .collect();
    json!({ "version": 1, "messages": m }).to_string()
}

/// Account in the fake chain.
#[derive(Clone, Debug, Default)]
pub struct FakeAcct {
    pub balance: U256,
    pub nonce: u64,
    pub code: Vec<u8>,
    pub storage: HashMap<U256, U256>,
}

/// A fake node: state per block, block traces, request counter.
#[derive(Default)]
pub struct FakeNode {
    /// block -> address -> account (blocks not listed = unavailable).
    pub states: Mutex<HashMap<u64, HashMap<Address, FakeAcct>>>,
    /// block -> debug_traceBlockByNumber answer.
    pub traces: Mutex<HashMap<u64, Value>>,
    pub tip: Mutex<u64>,
    pub base_fee: u64,
    pub calls: Mutex<Vec<String>>,
    /// Fail everything (node down).
    pub down: Mutex<bool>,
}

impl FakeNode {
    pub fn set_state(&self, block: u64, accts: HashMap<Address, FakeAcct>) {
        self.states.lock().unwrap().insert(block, accts);
        let mut t = self.tip.lock().unwrap();
        *t = (*t).max(block);
    }
    pub fn count(&self, method: &str) -> usize {
        self.calls.lock().unwrap().iter().filter(|m| *m == method).count()
    }
    pub fn total(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
    fn acct(&self, block: u64, a: Address) -> Option<Option<FakeAcct>> {
        let s = self.states.lock().unwrap();
        s.get(&block).map(|m| m.get(&a).cloned())
    }
}

fn hexs(b: &[u8]) -> String {
    let mut s = String::from("0x");
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}

fn unavailable() -> CallResult {
    Err(RpcErr { code: -32000, message: "header not found".into() })
}

impl NodeApi for FakeNode {
    fn call_batch(&self, _class: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        if *self.down.lock().unwrap() {
            return Err(NodeErr::Transport("node1: connection failed".into()));
        }
        let mut out = Vec::new();
        for (m, p) in calls {
            self.calls.lock().unwrap().push(m.to_string());
            let block = |i: usize| p[i].as_str().and_then(|s| parse_u64(s).ok()).unwrap_or(0);
            let r: CallResult = match *m {
                "eth_blockNumber" => Ok(json!(format!("{:#x}", *self.tip.lock().unwrap()))),
                "eth_getBlockByNumber" => {
                    let b = block(0);
                    if b > *self.tip.lock().unwrap() {
                        Ok(Value::Null)
                    } else {
                        Ok(json!({
                            "number": format!("{b:#x}"), "hash": format!("{:#066x}", b + 0x1000), "parentHash": format!("{:#066x}", b + 0xfff),
                            "timestamp": format!("{:#x}", 1_700_000_000 + b), "baseFeePerGas": format!("{:#x}", self.base_fee),
                            "gasLimit": "0x4000000000000", "miner": "0xa4b000000000000000000073657175656e636572",
                            "mixHash": format!("0x{:016x}{:016x}{:016x}{:016x}", 0, 1000 + b, 51, 0),
                        }))
                    }
                }
                "eth_getStorageAt" => {
                    let a = parse_address(p[0].as_str().unwrap()).unwrap();
                    let s = parse_u256(p[1].as_str().unwrap()).unwrap();
                    match self.acct(block(2), a) {
                        None => unavailable(),
                        Some(acc) => Ok(json!(format!("{:#066x}", acc.and_then(|x| x.storage.get(&s).copied()).unwrap_or(U256::ZERO)))),
                    }
                }
                "eth_getBalance" | "eth_getTransactionCount" | "eth_getCode" => {
                    let a = parse_address(p[0].as_str().unwrap()).unwrap();
                    match self.acct(block(1), a) {
                        None => unavailable(),
                        Some(acc) => {
                            let acc = acc.unwrap_or_default();
                            Ok(match *m {
                                "eth_getBalance" => json!(format!("{:#x}", acc.balance)),
                                "eth_getTransactionCount" => json!(format!("{:#x}", acc.nonce)),
                                _ => json!(hexs(&acc.code)),
                            })
                        }
                    }
                }
                "debug_traceBlockByNumber" => match self.traces.lock().unwrap().get(&block(0)) {
                    Some(t) => Ok(t.clone()),
                    None => unavailable(),
                },
                _ => Err(RpcErr { code: -32601, message: "method not found".into() }),
            };
            out.push(r);
        }
        Ok(out)
    }
}
