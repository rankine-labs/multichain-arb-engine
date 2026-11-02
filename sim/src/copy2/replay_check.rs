// ============================================================================
// COPY 2 REPLAY CHECK (Nov 2): `arbsim copy2-replay-check` - proof, on REAL
// chain history, that copy 2 re-does a pool's actions exactly like the chain.
//
// Plain English:
//   Copy 2 keeps a pool current by re-running each of its events (swap,
//   mint, burn, ...) with the pool's own code on its private copy, and only
//   accepts the result if the pool emits EXACTLY the chain's event (every
//   byte: amounts, price, liquidity, tick, and for V4 the fee). This tool
//   runs that very code (copy2/replay.rs apply_replay) on recorded chain
//   state, one real event at a time:
//     1. Find the pool's events in a block range (eth_getLogs).
//     2. For each transaction, read the chain's own record of the state the
//        transaction started from (debug_traceTransaction, prestateTracer:
//        every account, code and storage value it touched, exact).
//     3. Put that state into a fresh copy and replay the transaction's pool
//        events in order (several in one transaction see each other).
//        Values the replay needs that the transaction itself never touched
//        are read at the block before (counted and shown).
//     4. Compare: the event must be reproduced byte for byte, and every
//        storage value the replay wrote in the pool (V4: the PoolManager)
//        must equal the chain's value after the transaction (prestateTracer
//        diff mode).
//   So "exact" here means: same event, same storage. Read only: no keys, no
//   transactions; node URL from ARBSIM_NODE_URL like arbsim itself (never
//   printed).
//
// Usage:
//   arbsim copy2-replay-check '<pool json>' --from B --to B2 [--max N]
//   <pool json> = one entry of the bot's track message, e.g.
//     {"kind":"slipstream","address":"0x..","token0":"0x..","token1":"0x.."}
//     {"kind":"v4","address":"<PoolManager>","v4Id":"0x..","token0":"0x0..",
//      "token1":"0x..","fee":8388608,"tickSpacing":200,"hooks":"0x.."}
// ============================================================================
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use revm::primitives::{keccak256, Address, B256, KECCAK_EMPTY, U256};
use revm::state::{AccountInfo, Bytecode};
use serde_json::{json, Value};

use super::overlay::Overlay;
use super::replay::apply_replay;
use super::{ApplyResult, BlockCtx, PoolKind, PoolLog, TrackedPool};
use crate::check::hexutil::{parse_address, parse_bytes, parse_u256, parse_u64, to_hex};
use crate::node::{Class, NodeApi};
use crate::state::snap::{Fact, Snapshot};
use crate::state::MissItem;

/// One checked event.
#[derive(Debug, Default)]
pub struct Checked {
    pub block: u64,
    pub tx: B256,
    pub event: String,
    /// "exact" or why not.
    pub result: String,
    /// Storage values the replay wrote that match / differ from the chain.
    pub slots_same: usize,
    pub slots_differ: Vec<String>,
    /// Values read at the block before (the transaction itself never touched them).
    pub extra_reads: usize,
}

fn rpc(node: &dyn NodeApi, method: &str, params: Value) -> Result<Value, String> {
    let r = node.call_batch_paid(Class::Pinned, &[(method, params)]).map_err(|e| format!("{method}: {e}"))?;
    match r.into_iter().next() {
        Some(Ok(v)) => Ok(v),
        Some(Err(e)) => Err(format!("{method}: {}", e.message)),
        None => Err(format!("{method}: no answer")),
    }
}

/// A prestateTracer account entry as facts (basics + storage it lists).
fn facts_of(addr: Address, a: &Value) -> Vec<Fact> {
    let mut out = Vec::new();
    let bal = a.get("balance").and_then(|x| x.as_str()).and_then(|x| parse_u256(x).ok()).unwrap_or_default();
    let nonce = match a.get("nonce") {
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0),
        Some(Value::String(t)) => parse_u64(t).unwrap_or(0),
        _ => 0,
    };
    let code = a.get("code").and_then(|x| x.as_str()).and_then(|x| parse_bytes(x).ok()).unwrap_or_default();
    let (hash, bc) = if code.is_empty() { (KECCAK_EMPTY, None) } else { (keccak256(&code), Some(Bytecode::new_raw(code))) };
    let info = AccountInfo { balance: bal, nonce, code_hash: hash, code: bc.clone(), ..Default::default() };
    out.push(Fact::Basics { addr, info: Some(info), code: bc });
    if let Some(st) = a.get("storage").and_then(|x| x.as_object()) {
        for (k, v) in st {
            if let (Ok(k), Some(Ok(v))) = (parse_u256(k), v.as_str().map(parse_u256)) {
                out.push(Fact::Slot(addr, k, v));
            }
        }
    }
    out
}

/// The pool's events in [from, to] (at most `max`), oldest first.
fn pool_logs(node: &dyn NodeApi, p: &TrackedPool, from: u64, to: u64, max: usize) -> Result<Vec<PoolLog>, String> {
    let mut out = Vec::new();
    let mut a = from;
    while a <= to && out.len() < max {
        // The node refuses log ranges over 10,000 blocks.
        let b = (a + 9_999).min(to);
        let mut f = json!({ "fromBlock": format!("{a:#x}"), "toBlock": format!("{b:#x}"), "address": to_hex(p.address.as_slice()) });
        if let Some(id) = p.v4_id {
            f["topics"] = json!([Value::Null, format!("{id:#x}")]);
        }
        let v = rpc(node, "eth_getLogs", json!([f]))?;
        for l in v.as_array().cloned().unwrap_or_default() {
            let blk = l.get("blockNumber").and_then(|x| x.as_str()).and_then(|x| parse_u64(x).ok()).unwrap_or(0);
            if let Ok(pl) = super::intake::parse_log(&l, blk) {
                out.push(pl);
            }
        }
        a = b + 1;
    }
    out.truncate(max);
    Ok(out)
}

/// Replay every event of `p` in [from, to] (at most `max`) on recorded state.
pub fn check_pool(node: &dyn NodeApi, p: &TrackedPool, from: u64, to: u64, max: usize) -> Result<Vec<Checked>, String> {
    let logs = pool_logs(node, p, from, to, max)?;
    // Group by transaction (in chain order).
    let mut txs: Vec<(B256, Vec<PoolLog>)> = Vec::new();
    for l in logs {
        match txs.last_mut() {
            Some((h, v)) if *h == l.tx_hash => v.push(l),
            _ => txs.push((l.tx_hash, vec![l])),
        }
    }
    let mut out = Vec::new();
    let mut ctx_cache: HashMap<u64, BlockCtx> = HashMap::new();
    for (h, logs) in txs {
        let block = logs[0].block;
        let ctx = match ctx_cache.get(&block) {
            Some(c) => *c,
            None => {
                let b = rpc(node, "eth_getBlockByNumber", json!([format!("{block:#x}"), false]))?;
                let ts = b.get("timestamp").and_then(|x| x.as_str()).and_then(|x| parse_u64(x).ok()).unwrap_or(0);
                // Nitro: NUMBER inside the EVM is the parent-chain (L1) block.
                let l1 = b.get("l1BlockNumber").and_then(|x| x.as_str()).and_then(|x| parse_u64(x).ok()).unwrap_or(0);
                let c = BlockCtx { number: block, timestamp: ts, l1_number: l1 };
                ctx_cache.insert(block, c);
                c
            }
        };
        let tx = format!("{h:#x}");
        let pre = rpc(node, "debug_traceTransaction", json!([tx, { "tracer": "prestateTracer" }]))?;
        let post = rpc(node, "debug_traceTransaction", json!([tx, { "tracer": "prestateTracer", "tracerConfig": { "diffMode": true } }]))?;
        let mut snap = Snapshot::default();
        for (a, acct) in pre.as_object().cloned().unwrap_or_default() {
            if let Ok(addr) = parse_address(&a) {
                for f in facts_of(addr, &acct) {
                    snap.apply_fact(&f);
                }
            }
        }
        let mut ov = Overlay::new(snap);
        let mut extra = 0usize;
        let mut results: Vec<Checked> = Vec::new();
        for log in &logs {
            let name = event_name(p, log);
            let mut c = Checked { block, tx: h, event: name, ..Default::default() };
            let mut rounds = 0;
            loop {
                let mut f = ov.fork();
                match apply_replay(&mut f, p, log, &ctx) {
                    ApplyResult::Applied => {
                        ov.absorb(&f);
                        c.result = "exact".into();
                        break;
                    }
                    ApplyResult::Unsure(why) => {
                        c.result = format!("NOT exact: {why}");
                        break;
                    }
                    ApplyResult::NeedItems(items) => {
                        rounds += 1;
                        if rounds > 8 {
                            c.result = "NOT exact: needs more values than 8 rounds".into();
                            break;
                        }
                        // Values the transaction itself never touched: read
                        // at the block before (counted).
                        let items: Vec<MissItem> = items.into_iter().filter(|m| !matches!(m, MissItem::Code(_))).collect();
                        if items.is_empty() {
                            c.result = "NOT exact: needs code it can't name".into();
                            break;
                        }
                        extra += items.len();
                        let got = crate::node::fetch_items(node, Class::Pinned, block.saturating_sub(1), &items).map_err(|e| e.to_string())?;
                        for (_, r) in got {
                            match r {
                                Ok(crate::node::Fetched::Slot(a, s, v)) => ov.learn(&Fact::Slot(a, s, v)),
                                Ok(crate::node::Fetched::Account(a, acc)) => {
                                    let (info, code) = match acc {
                                        Some(x) => {
                                            let (hh, bc) = if x.code.is_empty() { (KECCAK_EMPTY, None) } else { (keccak256(&x.code), Some(Bytecode::new_raw(x.code))) };
                                            (Some(AccountInfo { balance: x.balance, nonce: x.nonce, code_hash: hh, code: bc.clone(), ..Default::default() }), bc)
                                        }
                                        None => (None, None),
                                    };
                                    ov.learn(&Fact::Basics { addr: a, info, code });
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
            results.push(c);
        }
        // Storage the replays wrote in the pool's account vs the chain's
        // values after the transaction.
        let chain_post: BTreeMap<U256, U256> = post
            .get("post")
            .and_then(|x| x.get(format!("{:#x}", p.address)))
            .and_then(|x| x.get("storage"))
            .and_then(|x| x.as_object())
            .map(|m| m.iter().filter_map(|(k, v)| Some((parse_u256(k).ok()?, parse_u256(v.as_str()?).ok()?))).collect())
            .unwrap_or_default();
        let chain_pre: BTreeMap<U256, U256> = post
            .get("pre")
            .and_then(|x| x.get(format!("{:#x}", p.address)))
            .and_then(|x| x.get("storage"))
            .and_then(|x| x.as_object())
            .map(|m| m.iter().filter_map(|(k, v)| Some((parse_u256(k).ok()?, parse_u256(v.as_str()?).ok()?))).collect())
            .unwrap_or_default();
        let mut same = 0usize;
        let mut differ = Vec::new();
        if let Some(d) = ov.changes().accounts.get(&p.address) {
            for (s, v) in &d.storage {
                // The chain's value after the transaction: in diff "post" if
                // it changed; in diff "pre" only = cleared to zero; in
                // neither = the chain left it unchanged.
                let chain = chain_post.get(s).copied().or_else(|| chain_pre.contains_key(s).then_some(U256::ZERO));
                match chain {
                    Some(c) if c == *v => same += 1,
                    Some(c) => differ.push(format!("slot {s:#x}: copy {v:#x} chain {c:#x}")),
                    None => differ.push(format!("slot {s:#x}: copy wrote {v:#x}, chain left it unchanged")),
                }
            }
        }
        // For a contract pool every slot the chain changed must be ours too
        // (V4: the PoolManager also holds other pools / settlement: skipped).
        if p.v4_id.is_none() {
            let ours = ov.changes().accounts.get(&p.address).map(|d| d.storage.clone()).unwrap_or_default();
            for (s, c) in &chain_post {
                if !ours.contains_key(s) {
                    differ.push(format!("slot {s:#x}: chain wrote {c:#x}, copy did not"));
                }
            }
            for s in chain_pre.keys() {
                if !chain_post.contains_key(s) && !ours.contains_key(s) {
                    differ.push(format!("slot {s:#x}: chain cleared it, copy did not"));
                }
            }
        }
        if let Some(last) = results.last_mut() {
            last.slots_same = same;
            last.slots_differ = differ;
            last.extra_reads = extra;
        }
        out.extend(results);
    }
    Ok(out)
}

fn event_name(p: &TrackedPool, l: &PoolLog) -> String {
    let t = l.topics.first().copied().unwrap_or_default();
    let names = [
        "Swap(address,address,int256,int256,uint160,uint128,int24)",
        "Mint(address,address,int24,int24,uint128,uint256,uint256)",
        "Burn(address,int24,int24,uint128,uint256,uint256)",
        "Collect(address,address,int24,int24,uint128,uint128)",
        "CollectFees(address,uint128,uint128)",
        "Flash(address,address,uint256,uint256,uint256,uint256)",
        "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)",
        "ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)",
        "Donate(bytes32,address,uint256,uint256)",
    ];
    for n in names {
        if keccak256(n.as_bytes()) == t {
            return n.split('(').next().unwrap_or(n).to_string();
        }
    }
    let _ = p;
    format!("{t:#x}")
}

/// `arbsim copy2-replay-check '<pool json>' --from B --to B2 [--max N]`.
pub fn main(args: &[String]) {
    let usage = "usage: arbsim copy2-replay-check '<pool json>' --from B --to B2 [--max N]";
    let Some(spec) = args.get(2) else {
        eprintln!("{usage}");
        std::process::exit(2);
    };
    let arg = |f: &str| args.iter().position(|a| a == f).and_then(|i| args.get(i + 1)).and_then(|v| v.parse::<u64>().ok());
    let (Some(from), Some(to)) = (arg("--from"), arg("--to")) else {
        eprintln!("{usage}");
        std::process::exit(2);
    };
    let max = arg("--max").unwrap_or(50) as usize;
    let v: Value = match serde_json::from_str(spec) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("pool json: {e}");
            std::process::exit(2);
        }
    };
    // Same parsing as the track message (flags are not needed for a check).
    let p = match parse_spec(&v) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("pool json: {e}");
            std::process::exit(2);
        }
    };
    let Some(node) = crate::node::NodeClient::from_env() else {
        eprintln!("no node configured (ARBSIM_NODE_URL)");
        std::process::exit(2);
    };
    let node: Arc<dyn NodeApi> = Arc::new(node);
    match check_pool(node.as_ref(), &p, from, to, max) {
        Ok(rows) => {
            let exact = rows.iter().filter(|r| r.result == "exact").count();
            let storage_ok = rows.iter().filter(|r| r.slots_differ.is_empty()).count();
            let extra: usize = rows.iter().map(|r| r.extra_reads).sum();
            for r in &rows {
                println!(
                    "{} {:#x} {:<14} {}  storage: {} same{}{}",
                    r.block,
                    r.tx,
                    r.event,
                    r.result,
                    r.slots_same,
                    if r.slots_differ.is_empty() { String::new() } else { format!(", {} DIFFER: {}", r.slots_differ.len(), r.slots_differ.join("; ")) },
                    if r.extra_reads > 0 { format!(" (values read at the block before: {})", r.extra_reads) } else { String::new() }
                );
            }
            println!(
                "SUMMARY kind={}{} events={} exact={} storage_match={} values_read_at_block_before={}",
                super::intake::kind_name(p.kind),
                if p.hooks != Address::ZERO { "+hook" } else { "" },
                rows.len(),
                exact,
                storage_ok,
                extra
            );
        }
        Err(e) => {
            eprintln!("copy2-replay-check: {e}");
            std::process::exit(1);
        }
    }
}

fn parse_spec(v: &Value) -> Result<TrackedPool, String> {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).ok_or(format!("{k} missing"));
    let kind = super::intake::parse_kind(s("kind")?).ok_or("unknown kind")?;
    let v4_id = match v.get("v4Id").and_then(|x| x.as_str()) {
        Some(h) => Some(B256::from(parse_u256(h)?.to_be_bytes::<32>())),
        None => None,
    };
    if (kind == PoolKind::V4) != v4_id.is_some() {
        return Err("v4Id must be given for (and only for) kind v4".into());
    }
    Ok(TrackedPool {
        address: parse_address(s("address")?)?,
        v4_id,
        kind,
        token0: parse_address(s("token0")?)?,
        token1: parse_address(s("token1")?)?,
        fee: v.get("fee").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
        tick_spacing: v.get("tickSpacing").and_then(|x| x.as_i64()).unwrap_or(0) as i32,
        hooks: v.get("hooks").and_then(|x| x.as_str()).map(parse_address).transpose()?.unwrap_or(Address::ZERO),
        ..Default::default()
    })
}
