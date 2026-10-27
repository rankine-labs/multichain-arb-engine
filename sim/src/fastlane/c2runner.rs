// ============================================================================
// FAST LANE COPY-2 RUNNER: the scanner's checks run the way the sidecar runs
// every copy-2 check (review H3 / integration item 4).
//
// Plain English:
//   The scanner (scan.rs) asks "does this route pay?" through a CheckRunner.
//   The plain runner just runs the size search on the state it is given.
//   That is exact for most pools, but copy 2 knows a few things the plain
//   run doesn't (copy2/checkview.rs, server.rs copy2_runs):
//     - a V4 PoolManager's coin balances are only known as a proven LOWER
//       BOUND, so a run that reads one is repeated with the balance far
//       higher; the answer stands only if both runs agree exactly,
//     - a V4 protocol-fee counter copy 2 never holds is run as 0 and not 0;
//       the answer stands only if the two differ in gas alone (the higher
//       gas is kept, so profit is never over-stated),
//     - far, empty tick-map words of V4 pools it walked are known zero,
//     - a pool that may still be missing reports of the block ("pending")
//       or that is not ready gives "unknown", never an answer.
//   This runner does exactly that, by calling the SAME code the sidecar
//   uses (server::copy2_runs, the same C2View facts, the same pending /
//   unsure rules), with the size search as the run. So a fast-lane answer
//   on copy 2's state is the answer the bot's own sidecar check would give.
//
//   Works on copy 2's confirmed versions AND on the predicted view (copy2/
//   ahead.rs): the facts are taken for the view's block (pools ready since
//   then), and pending reports of earlier blocks still block an answer.
// ============================================================================
use std::sync::Arc;

use revm::primitives::U256;
use serde_json::{json, Value};

use super::scan::{CheckRunner, PreparedCheck, RunAt};
use crate::arb::BlockCtx;
use crate::check::hexutil::{parse_u256, parse_u64, quantity, quantity_u64};
use crate::check::run::CheckOptions;
use crate::check::search::{size_search_opts, SizeSearchAmounts, SizeSearchBest, SizeSearchResult, SizeTry};
use crate::check::{CheckUnknown, UnknownReason};
use crate::copy2::intake::Copy2Handle;
use crate::state::snap::View;
use crate::state::StateRead;

/// The scanner's runner on copy 2 (see the file header).
pub struct Copy2Runner {
    pub c2: Copy2Handle,
}

impl Copy2Runner {
    pub fn new(c2: Copy2Handle) -> Copy2Runner {
        Copy2Runner { c2 }
    }
}

/// A size-search result as the sidecar's JSON answer (handle_size_search's
/// shape, so copy2_runs can compare two runs exactly / merge gas).
pub fn result_json(r: &Result<SizeSearchResult, CheckUnknown>) -> Value {
    match r {
        Ok(r) => json!({
            "ok": true,
            "best": r.best.as_ref().map(|b| json!({ "amount": quantity(b.amount), "profit": quantity(b.profit), "gasUsed": quantity_u64(b.gas_used) })),
            "tried": r.tried.iter().map(|t| json!({
                "amount": quantity(t.amount), "status": t.status, "profit": quantity(t.profit),
                "gasUsed": quantity_u64(t.gas_used), "reason": t.reason,
            })).collect::<Vec<_>>(),
        }),
        Err(u) => {
            let mut v = crate::check::proto_types::unknown_json(&Value::Null, u, 0);
            if let Some(o) = v.as_object_mut() {
                o.remove("us");
            }
            v
        }
    }
}

/// Back from the JSON answer (statuses are the size search's own words).
pub fn result_from_json(v: &Value) -> Result<SizeSearchResult, CheckUnknown> {
    if v.get("ok") != Some(&Value::Bool(true)) {
        let why = v.get("unknown").and_then(|x| x.as_str()).unwrap_or("error");
        let detail = v.get("detail").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let reason = match why {
            "miss" => UnknownReason::Miss,
            "unsupported_precompile" => UnknownReason::UnsupportedPrecompile,
            "bad_request" => UnknownReason::BadRequest,
            "engine_error" => UnknownReason::Engine,
            _ => UnknownReason::Copy2Unsure,
        };
        let mut u = CheckUnknown::new(reason, if reason == UnknownReason::Copy2Unsure { format!("{why}: {detail}") } else { detail });
        if reason == UnknownReason::Miss {
            u.missing = crate::proto::parse_missing(v);
        }
        return Err(u);
    }
    let u256 = |x: &Value| x.as_str().and_then(|s| parse_u256(s).ok()).unwrap_or(U256::ZERO);
    let u64v = |x: &Value| x.as_str().and_then(|s| parse_u64(s).ok()).unwrap_or(0);
    let status = |s: &str| -> &'static str {
        match s {
            "profit" => "profit",
            "loss" => "loss",
            _ => "fail",
        }
    };
    let tried = v
        .get("tried")
        .and_then(|t| t.as_array())
        .map(|a| {
            a.iter()
                .map(|t| SizeTry {
                    amount: u256(&t["amount"]),
                    status: status(t["status"].as_str().unwrap_or("")),
                    profit: u256(&t["profit"]),
                    gas_used: u64v(&t["gasUsed"]),
                    reason: t["reason"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    let best = v.get("best").filter(|b| !b.is_null()).map(|b| SizeSearchBest { amount: u256(&b["amount"]), profit: u256(&b["profit"]), gas_used: u64v(&b["gasUsed"]) });
    Ok(SizeSearchResult { best, tried })
}

impl CheckRunner for Copy2Runner {
    /// Without a snapshot there is nothing for copy 2 to add: the plain run.
    fn run(&self, view: &dyn StateRead, ctx: &BlockCtx, c: &PreparedCheck, amounts: &SizeSearchAmounts) -> Result<SizeSearchResult, CheckUnknown> {
        size_search_opts(view, ctx, &c.overrides, &[], &c.template(), amounts, CheckOptions::default())
    }

    fn run_at(&self, at: &RunAt, c: &PreparedCheck, amounts: &SizeSearchAmounts) -> Result<SizeSearchResult, CheckUnknown> {
        let Some(snap) = at.snap else { return self.run(at.view, at.ctx, c, amounts) };
        run_on_copy2(&self.c2, snap, at.block, at.ctx, c, amounts)
    }
}

/// One size search on copy 2's snapshot, with copy 2's rules (file header).
pub fn run_on_copy2(c2: &Copy2Handle, snap: &Arc<crate::state::snap::Snapshot>, block: u64, ctx: &BlockCtx, c: &PreparedCheck, amounts: &SizeSearchAmounts) -> Result<SizeSearchResult, CheckUnknown> {
    let pv = c2.sh.published.view();
    let core = c2.core_for(Some(&pv));
    let facts = c2.check_facts_with(&core, block);
    let view = View::new(snap.clone());
    let template = c.template();
    let run = |v: &dyn StateRead, b: &BlockCtx| result_json(&size_search_opts(v, b, &c.overrides, &[], &template, amounts, CheckOptions::default()));
    let runs = std::cell::RefCell::new(crate::server::RunLog::default());
    let mut answer = crate::server::copy2_runs(c2, &view, &facts, ctx, &runs, &run);
    if answer.get("ok") == Some(&Value::Bool(true)) {
        // A pool on the route may still be missing reports of this block
        // (same rule as server.rs after_pick_with): never answer from it.
        let touched = view.take_touched();
        if let Some(why) = c2.pending_reason_with(&core, &touched, block, view.touched_overflow()) {
            answer = json!({ "ok": false, "unknown": "pending_reports", "detail": why });
        }
    } else {
        let missing = crate::proto::parse_missing(&answer);
        if let Some(why) = c2.unsure_reason_with(&core, &missing) {
            answer = json!({ "ok": false, "unknown": "unsure_pool", "detail": why });
        }
    }
    result_from_json(&answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_round_trip_keeps_every_field() {
        let r = SizeSearchResult {
            best: Some(SizeSearchBest { amount: U256::from(5u8), profit: U256::from(2u8), gas_used: 300_000 }),
            tried: vec![
                SizeTry { amount: U256::from(5u8), status: "profit", profit: U256::from(2u8), gas_used: 300_000, reason: String::new() },
                SizeTry { amount: U256::from(9u8), status: "fail", profit: U256::ZERO, gas_used: 20_000, reason: "0x90b8ec18".into() },
            ],
        };
        assert_eq!(result_from_json(&result_json(&Ok(r.clone()))).unwrap(), r);
        let u = CheckUnknown::new(UnknownReason::Miss, "x");
        assert_eq!(result_from_json(&result_json(&Err(u))).unwrap_err().reason, UnknownReason::Miss);
        let pm = json!({"ok": false, "unknown": "pool_manager_balance", "detail": "differ"});
        let e = result_from_json(&pm).unwrap_err();
        assert_eq!(e.reason, UnknownReason::Copy2Unsure);
        assert!(e.detail.starts_with("pool_manager_balance"));
    }
}
