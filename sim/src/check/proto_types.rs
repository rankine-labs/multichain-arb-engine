// ============================================================================
// SOCKET MESSAGES for checks ("call" and "size_search"), see DESIGN.md
// "Socket protocol".
//
// Plain English:
//   The bot sends JSON questions over the local socket; the server (worker A)
//   works out WHICH state the question is about (`at`: after the head block,
//   after feed message N, ...) and hands us that state view plus the block
//   details. These two functions turn the JSON question into a check, run
//   it, and build the JSON answer:
//       ok:true  + results / best          a sure answer
//       ok:false + unknown + missing       "can't be sure" (bot asks the node)
//
//   NOTE for merging: worker A owns src/proto.rs. Until it exists these are
//   the shapes; they follow DESIGN.md field for field, so A can re-export
//   them or copy them.
// ============================================================================
use std::time::Instant;

use revm::primitives::{Address, Bytes, U256};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::hexutil::{parse_address, parse_bytes, parse_u256, parse_u64, quantity, quantity_u64, to_hex};
use super::overrides::Overrides;
use super::search::{size_search, SizeSearchAmounts, SizeTemplate};
use super::{run_calls, CallOutcome, CallReq, CheckUnknown};
use crate::arb::BlockCtx;
use crate::state::{MissItem, StateRead};

/// One call in a request (all hex text, like a node's eth_call).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct WireCall {
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    /// `data` (geth also accepts `input`).
    #[serde(default)]
    pub data: Option<String>,
    #[serde(default)]
    pub input: Option<String>,
    #[serde(default)]
    pub gas: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
}

/// `{"type":"call", ...}`
#[derive(Clone, Debug, Default, Deserialize)]
pub struct CallRequest {
    pub id: Value,
    /// Which state to use; resolved by the server, echoed back.
    #[serde(default)]
    pub at: Value,
    #[serde(default)]
    pub overrides: Value,
    #[serde(default)]
    pub calls: Vec<WireCall>,
    #[serde(default, rename = "rawTxs")]
    pub raw_txs: Vec<String>,
    /// Extension (needed for eth_simulateV1 replays): `{"time":"0x..",
    /// "gasLimit":"0x.."}` changes what TIMESTAMP / GASLIMIT return.
    /// Any other field is refused (never silently ignored).
    #[serde(default, rename = "blockOverrides")]
    pub block_overrides: Value,
    /// Extension: run as the block AFTER the chosen state (what
    /// eth_simulateV1 does: state of block N, simulated block N+1), so
    /// ArbSys.arbBlockNumber() returns N+1.
    #[serde(default, rename = "nextBlock")]
    pub next_block: bool,
    /// Trigger-first (check/ordered.rs): the feed messages around the trade
    /// we follow, to replay in sequence order before our calls. The server
    /// works out which of them the chosen copy version already holds.
    #[serde(default)]
    pub feed: Option<Value>,
    /// Trigger-first entry point (only with `feed`): also try our trade at
    /// these other sizes, each on the same replayed feed (see
    /// `WireSizes`). The answer then carries `sizes`.
    #[serde(default)]
    pub sizes: Option<WireSizes>,
}

/// SIZE LADDER on the replayed feed (trigger-first entry point).
/// Plain English: our trade size matters (too small = little profit, too
/// big = the price moves against us). With `sizes`, the same feed replay is
/// run once per size, each followed by our trade with only its amount
/// changed: the amountIn word at `amountOffset` (after the 4-byte code)
/// and, for own-money trades, every pretend balance slot that held exactly
/// the original amount (the test contract's trading money). One request,
/// no extra round trips.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct WireSizes {
    #[serde(rename = "amountOffset")]
    pub amount_offset: usize,
    /// The other amounts to try (hex), at most 8.
    pub amounts: Vec<String>,
}

/// Block details for one request: the server's, plus the request's changes.
pub fn apply_block_overrides(ctx: &BlockCtx, bo: &Value, next_block: bool) -> Result<BlockCtx, String> {
    let mut c = ctx.clone();
    if next_block {
        c.l2_block_number = c.l2_block_number.map(|n| n + 1);
    }
    match bo {
        Value::Null => {}
        Value::Object(m) => {
            for (k, v) in m {
                let t = v.as_str().ok_or_else(|| format!("blockOverrides.{k} must be hex text"))?;
                match k.as_str() {
                    "time" => c.timestamp = parse_u64(t).map_err(|e| format!("blockOverrides.time: {e}"))?,
                    "gasLimit" => c.gas_limit = parse_u64(t).map_err(|e| format!("blockOverrides.gasLimit: {e}"))?,
                    // Block number: on Arbitrum (ArbSys known) this is the
                    // chain's OWN number (ArbSys.arbBlockNumber()); the NUMBER
                    // opcode stays the parent-chain number. Plain-EVM mode:
                    // it is what NUMBER returns.
                    "number" => {
                        let n = parse_u64(t).map_err(|e| format!("blockOverrides.number: {e}"))?;
                        if c.l2_block_number.is_some() {
                            c.l2_block_number = Some(n);
                        } else {
                            c.l1_block_number = n;
                        }
                    }
                    other => return Err(format!("blockOverrides.{other} not supported")),
                }
            }
        }
        _ => return Err("blockOverrides must be an object".into()),
    }
    Ok(c)
}

/// `range` of a size search.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct WireRange {
    pub lo: String,
    pub hi: String,
    #[serde(default)]
    pub steps: Option<usize>,
}

/// `{"type":"size_search", ...}`
#[derive(Clone, Debug, Default, Deserialize)]
pub struct SizeSearchRequest {
    pub id: Value,
    #[serde(default)]
    pub at: Value,
    #[serde(default)]
    pub overrides: Value,
    #[serde(default, rename = "rawTxs")]
    pub raw_txs: Vec<String>,
    pub template: WireCall,
    #[serde(rename = "amountOffset")]
    pub amount_offset: usize,
    #[serde(default)]
    pub amounts: Option<Vec<String>>,
    #[serde(default)]
    pub range: Option<WireRange>,
    /// Extension: storage slots set to the size for each try (own-money
    /// checks: our test contract's token balance), `[{"account","slot"}]`.
    /// The bot's own-money check gives the contract `amountIn` tokens, so a
    /// different size needs a different pretend balance.
    #[serde(default, rename = "amountSlots")]
    pub amount_slots: Vec<WireSlot>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct WireSlot {
    pub account: String,
    pub slot: String,
}

/// One call's answer.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct WireOutcome {
    pub success: bool,
    pub output: String,
    #[serde(rename = "gasUsed")]
    pub gas_used: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub halt: Option<String>,
}

impl From<&CallOutcome> for WireOutcome {
    fn from(o: &CallOutcome) -> Self {
        WireOutcome { success: o.success, output: to_hex(&o.output), gas_used: quantity_u64(o.gas_used), halt: o.halt.clone() }
    }
}

/// Missing item as sent to the bot: `{"account"}`, `{"account","slot"}`, `{"code"}`.
pub fn miss_json(m: &MissItem) -> Value {
    match m {
        MissItem::Account(a) => serde_json::json!({ "account": to_hex(a.as_slice()) }),
        MissItem::Slot(a, s) => serde_json::json!({ "account": to_hex(a.as_slice()), "slot": format!("{:#066x}", s) }),
        MissItem::Code(h) => serde_json::json!({ "code": to_hex(h.as_slice()) }),
    }
}

/// Answer for "can't be sure".
/// (Oct 25) `missingPre`: [[hash, word1, word2], ...] hex, only when the run
/// recorded the inputs that name the missing slots (CheckUnknown.pre). The
/// server reads it for copy 2 and takes it out before the bot sees the answer.
pub fn unknown_json(id: &Value, u: &CheckUnknown, us: u128) -> Value {
    let mut v = serde_json::json!({
        "id": id,
        "ok": false,
        "unknown": u.reason.as_str(),
        "detail": u.detail,
        "missing": u.missing.iter().map(miss_json).collect::<Vec<_>>(),
        "us": us as u64,
    });
    // (Oct 27) Trigger-first: the replayed feed transaction it got stuck on
    // (status / trig-replay tell the trigger from a lag-replayed one).
    if let Some(at) = &u.at {
        v["at"] = at.json();
    }
    if !u.pre.is_empty() {
        v["missingPre"] = serde_json::json!(u.pre.iter().map(|(h, a, b)| [format!("{h:#x}"), format!("{a:#x}"), format!("{b:#x}")]).collect::<Vec<_>>());
    }
    // (Oct 26) `missingKeys`: [[pool id, currency0, currency1, fee,
    // tickSpacing, hooks], ...] hex words, the keys of the V4 pools named
    // above when the run computed them (CheckUnknown.keys). Also read and
    // removed by the server before the bot sees the answer.
    if !u.keys.is_empty() {
        v["missingKeys"] = serde_json::json!(u
            .keys
            .iter()
            .map(|(id, k)| {
                let mut row = vec![format!("{id:#x}")];
                row.extend(k.iter().map(|w| format!("{w:#x}")));
                row
            })
            .collect::<Vec<_>>());
    }
    v
}

/// Wire call -> CallReq (strict: bad hex = bad request).
pub fn call_from_wire(c: &WireCall) -> Result<CallReq, String> {
    let from = match &c.from {
        Some(s) => parse_address(s).map_err(|e| format!("from: {e}"))?,
        None => Address::ZERO,
    };
    let to = match &c.to {
        Some(s) if !s.is_empty() => Some(parse_address(s).map_err(|e| format!("to: {e}"))?),
        _ => None,
    };
    let data = match (&c.data, &c.input) {
        (Some(d), Some(i)) if d != i => return Err("data and input differ".into()),
        (Some(d), _) | (None, Some(d)) => parse_bytes(d).map_err(|e| format!("data: {e}"))?,
        (None, None) => Bytes::new(),
    };
    let gas = match &c.gas {
        Some(g) => Some(parse_u64(g).map_err(|e| format!("gas: {e}"))?),
        None => None,
    };
    let value = match &c.value {
        Some(v) => parse_u256(v).map_err(|e| format!("value: {e}"))?,
        None => U256::ZERO,
    };
    Ok(CallReq { from, to, data, gas, value })
}

fn raw_from_wire(v: &[String]) -> Result<Vec<Bytes>, String> {
    v.iter().enumerate().map(|(i, s)| parse_bytes(s).map_err(|e| format!("rawTxs[{i}]: {e}"))).collect()
}

/// `at` as echoed in an answer: the request's own `at`, plus where the view sits.
fn at_json(at: &Value, view: &dyn StateRead) -> Value {
    let p = view.position();
    let mut o = serde_json::Map::new();
    if let Value::Object(m) = at {
        o.extend(m.clone());
    }
    o.insert("block".into(), Value::String(quantity_u64(p.base_block)));
    if let Some(seq) = p.after_seq {
        o.insert("seq".into(), Value::from(seq));
    }
    Value::Object(o)
}

/// Run a `call` request on `view` (the state the server picked for `at`).
/// `ctx` = the block details the SERVER built for `at` (incl. "env":"next"
/// and any blockOverrides it already applied); this function only adds the
/// request's own `blockOverrides` / `nextBlock` on top, if present (the
/// server may strip them once it applies them itself). One result per call,
/// prefix calls included, in order.
pub fn handle_call(view: &dyn StateRead, ctx: &BlockCtx, req: &CallRequest) -> Value {
    let t0 = Instant::now();
    let parsed = (|| -> Result<(BlockCtx, Overrides, Vec<Bytes>, Vec<CallReq>), String> {
        let bctx = apply_block_overrides(ctx, &req.block_overrides, req.next_block)?;
        let ov = Overrides::from_json(&req.overrides)?;
        let raw = raw_from_wire(&req.raw_txs)?;
        let calls = req.calls.iter().enumerate().map(|(i, c)| call_from_wire(c).map_err(|e| format!("calls[{i}]: {e}"))).collect::<Result<Vec<_>, _>>()?;
        if calls.is_empty() {
            return Err("no calls".into());
        }
        Ok((bctx, ov, raw, calls))
    })();
    let (bctx, ov, raw, calls) = match parsed {
        Ok(x) => x,
        Err(e) => return unknown_json(&req.id, &CheckUnknown::bad_request(e), t0.elapsed().as_micros()),
    };
    match run_calls(view, &bctx, &ov, &raw, &calls) {
        Ok(out) => serde_json::json!({
            "id": req.id,
            "ok": true,
            "at": at_json(&req.at, view),
            "results": out.iter().map(WireOutcome::from).collect::<Vec<_>>(),
            "us": t0.elapsed().as_micros() as u64,
        }),
        Err(u) => unknown_json(&req.id, &u, t0.elapsed().as_micros()),
    }
}

/// Run a trigger-first `call` request (`feed` given) on `view`: the plan's
/// feed transactions in order, then the request's calls (check/ordered.rs).
/// The answer is a normal call answer plus `trig`: what was replayed. Its
/// `digest` covers every replayed transaction's success and output, so two
/// runs of one copy-2 check (server.rs copy2_runs: lower bound / far above
/// it) only agree if the replayed transactions ran the same way too.
pub fn handle_trig_call(
    view: &dyn StateRead,
    plan: &super::ordered::OrderedPlan,
    info: &super::ordered::PlanInfo,
    req: &CallRequest,
    prov: &dyn super::ordered::Provenance,
    strict_call: bool,
) -> Value {
    handle_trig_call_with(view, plan, info, req, prov, strict_call, &super::ordered::Assume::default())
}

/// `handle_trig_call` with best-effort assumptions (check/ordered.rs BEST
/// EFFORT). The answer's `trig` then also says `conf` (high / medium /
/// low) and `assumed` (the labels, e.g. ["sender_funds",
/// "skipped_unrelated:2"]).
pub fn handle_trig_call_with(
    view: &dyn StateRead,
    plan: &super::ordered::OrderedPlan,
    info: &super::ordered::PlanInfo,
    req: &CallRequest,
    prov: &dyn super::ordered::Provenance,
    strict_call: bool,
    assume: &super::ordered::Assume,
) -> Value {
    let t0 = Instant::now();
    let parsed = (|| -> Result<(Overrides, Vec<CallReq>), String> {
        let ov = Overrides::from_json(&req.overrides)?;
        let calls = req.calls.iter().enumerate().map(|(i, c)| call_from_wire(c).map_err(|e| format!("calls[{i}]: {e}"))).collect::<Result<Vec<_>, _>>()?;
        if calls.is_empty() {
            return Err("no calls".into());
        }
        Ok((ov, calls))
    })();
    let (ov, calls) = match parsed {
        Ok(x) => x,
        Err(e) => return unknown_json(&req.id, &CheckUnknown::bad_request(e), t0.elapsed().as_micros()),
    };
    // Size ladder (entry point): our trade at the other sizes, on the same replay.
    let lad = req.sizes.as_ref().and_then(|z| ladder_of(&ov, &calls, z));
    match super::ordered::run_ordered_sizes(view, plan, &ov, &calls, prov, strict_call, assume, lad.as_ref()) {
        Ok(out) => {
            let ladder = lad.as_ref().map(|_| {
                Value::Array(
                    out.ladder
                        .iter()
                        .map(|r| match &r.outcome {
                            Some(o) => {
                                let t = super::search::classify(r.amount, o);
                                serde_json::json!({ "amount": quantity(t.amount), "status": t.status, "profit": quantity(t.profit), "gasUsed": quantity_u64(t.gas_used), "reason": t.reason })
                            }
                            None => serde_json::json!({ "amount": quantity(r.amount), "status": "unknown", "reason": "not answerable at this size" }),
                        })
                        .collect(),
                )
            });
            // One fingerprint of how every replayed transaction ended
            // (success + output; gas is left out so the protocol-fee runs,
            // which differ in gas only, can still be merged).
            let mut h: Vec<u8> = Vec::with_capacity(out.replayed.len() * 40);
            for r in &out.replayed {
                h.extend_from_slice(r.hash.as_slice());
                h.push(r.outcome.success as u8);
                h.extend_from_slice(revm::primitives::keccak256(&r.outcome.output).as_slice());
            }
            // How the trigger itself ended (null: already in the copy, not replayed).
            let trigger_ok = out.replayed.iter().find(|r| r.hash == info.trigger).map(|r| r.outcome.success);
            let mut a = serde_json::json!({
                "id": req.id,
                "ok": true,
                "at": at_json(&req.at, view),
                "results": out.results.iter().map(WireOutcome::from).collect::<Vec<_>>(),
                "trig": {
                    "snapBlock": info.snap_block,
                    "snapSeq": info.snap_seq,
                    "included": info.included,
                    "triggerOk": trigger_ok,
                    "msgs": info.msgs,
                    "txs": info.txs,
                    "later": info.later,
                    "lastSeq": info.last_seq,
                    "reverted": out.replayed.iter().filter(|r| !r.outcome.success).count(),
                    "digest": to_hex(revm::primitives::keccak256(&h).as_slice()),
                    // Best effort: how sure, and what was assumed.
                    "conf": out.assumed.confidence(),
                    "assumed": out.assumed.labels(),
                    "skipped": out.assumed.skipped_related + out.assumed.skipped_unrelated,
                },
                "us": t0.elapsed().as_micros() as u64,
            });
            if let (Some(l), Some(o)) = (ladder, a.as_object_mut()) {
                o.insert("sizes".into(), l);
            }
            a
        }
        Err(u) => unknown_json(&req.id, &u, t0.elapsed().as_micros()),
    }
}

/// The size ladder (see `WireSizes`) for check/ordered.rs: None when it
/// can't be applied (not exactly one call, or the amountIn word isn't where
/// it should be). The trading-money slots are the pretend slots that hold
/// exactly the original amount.
fn ladder_of(ov: &Overrides, calls: &[CallReq], z: &WireSizes) -> Option<super::ordered::Ladder> {
    if calls.len() != 1 || z.amounts.is_empty() {
        return None;
    }
    let data = &calls[0].data;
    let start = 4usize.checked_add(z.amount_offset)?;
    let end = start.checked_add(32)?;
    if end > data.len() {
        return None;
    }
    let original = U256::from_be_slice(&data[start..end]);
    if original.is_zero() {
        return None;
    }
    let amounts: Vec<U256> = z.amounts.iter().take(8).filter_map(|a| parse_u256(a).ok()).collect();
    let mut slots = Vec::new();
    for (a, acc) in &ov.accounts {
        for (k, v) in &acc.state_diff {
            if *v == original {
                slots.push((*a, *k));
            }
        }
    }
    Some(super::ordered::Ladder { amount_offset: z.amount_offset, amounts, slots })
}

/// Run a `size_search` request on `view`.
pub fn handle_size_search(view: &dyn StateRead, ctx: &BlockCtx, req: &SizeSearchRequest) -> Value {
    let t0 = Instant::now();
    let parsed = (|| -> Result<(Overrides, Vec<Bytes>, SizeTemplate, SizeSearchAmounts), String> {
        let ov = Overrides::from_json(&req.overrides)?;
        let raw = raw_from_wire(&req.raw_txs)?;
        let call = call_from_wire(&req.template).map_err(|e| format!("template: {e}"))?;
        let amount_slots = req
            .amount_slots
            .iter()
            .map(|s| Ok((parse_address(&s.account)?, parse_u256(&s.slot)?)))
            .collect::<Result<Vec<_>, String>>()
            .map_err(|e| format!("amountSlots: {e}"))?;
        let amounts = match (&req.amounts, &req.range) {
            (Some(list), None) => SizeSearchAmounts::List(list.iter().map(|s| parse_u256(s)).collect::<Result<_, _>>().map_err(|e| format!("amounts: {e}"))?),
            (None, Some(r)) => SizeSearchAmounts::Range {
                lo: parse_u256(&r.lo).map_err(|e| format!("range.lo: {e}"))?,
                hi: parse_u256(&r.hi).map_err(|e| format!("range.hi: {e}"))?,
                steps: r.steps.unwrap_or(12),
            },
            _ => return Err("give exactly one of amounts / range".into()),
        };
        Ok((ov, raw, SizeTemplate { call, amount_offset: req.amount_offset, amount_slots }, amounts))
    })();
    let (ov, raw, template, amounts) = match parsed {
        Ok(x) => x,
        Err(e) => return unknown_json(&req.id, &CheckUnknown::bad_request(e), t0.elapsed().as_micros()),
    };
    match size_search(view, ctx, &ov, &raw, &template, &amounts) {
        Ok(r) => serde_json::json!({
            "id": req.id,
            "ok": true,
            "at": at_json(&req.at, view),
            "best": r.best.map(|b| serde_json::json!({ "amount": quantity(b.amount), "profit": quantity(b.profit), "gasUsed": quantity_u64(b.gas_used) })),
            "tried": r.tried.iter().map(|t| serde_json::json!({
                "amount": quantity(t.amount), "status": t.status, "profit": quantity(t.profit),
                "gasUsed": quantity_u64(t.gas_used), "reason": t.reason,
            })).collect::<Vec<_>>(),
            "us": t0.elapsed().as_micros() as u64,
        }),
        Err(u) => unknown_json(&req.id, &u, t0.elapsed().as_micros()),
    }
}
