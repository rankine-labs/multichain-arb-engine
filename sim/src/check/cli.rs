// ============================================================================
// Command-line tools for checks (wired into main.rs by one line each):
//
//   arbsim check-fixture <fixture.json>      (or --stdin: one fixture per line)
//       Runs the fixture's call and prints ONE JSON line per fixture:
//       {"success","output","gasUsed", "match", "exact", ...}. "match" =
//       exact, or exact output with the fixture's documented approximate gas.
//
//   arbsim bench-fixture <fixture.json> [--n 2000]
//       Timing: single check, chained check (a state-changing trade then the
//       check again on its result), and a full size search (12 tries).
//       All in-process (no socket), on this machine's CPU.
// ============================================================================
use std::time::Instant;

use revm::primitives::{Bytes, U256};
use serde_json::json;

use super::fixture::Fixture;
use super::hexutil::to_hex;
use super::overrides::Overrides;
use super::search::{size_search, SizeSearchAmounts, SizeTemplate};
use super::{run_calls, run_calls_opts, CallReq};

fn arg_after(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

fn load_or_exit(args: &[String], cmd: &str) -> Fixture {
    let Some(path) = args.get(2) else {
        eprintln!("usage: arbsim {cmd} <fixture.json> [--n N]");
        std::process::exit(2);
    };
    match Fixture::load(path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("arbsim {cmd}: {e}");
            std::process::exit(2);
        }
    }
}

/// One fixture -> one result line (JSON object). Used by both modes below.
/// Fields: success / output / gasUsed (ours, node-style hex) first, then the
/// comparison with the fixture's expected answer.
pub fn check_fixture_value(f: &Fixture) -> serde_json::Value {
    let ov = Overrides::none();
    let t = Instant::now();
    // Fixtures were recorded on anvil as real calls with the block's base fee
    // in place, so they run in "mined" block mode (see fixture::fixture_opts).
    let r = run_calls_opts(&f.state, &f.ctx, &ov, &[], std::slice::from_ref(&f.call), super::fixture::fixture_opts());
    let us = t.elapsed().as_secs_f64() * 1e6;
    match r {
        Ok(out) => {
            let o = &out[0];
            let c = f.compare(o);
            let ok = c.exact() || (f.expected.gas_approx && c.success_match && c.output_match);
            json!({
                "fixture": f.name,
                "success": o.success,
                "output": to_hex(&o.output),
                "gasUsed": format!("{:#x}", o.gas_used),
                "halt": o.halt,
                "match": ok,
                "exact": c.exact(),
                "successMatch": c.success_match,
                "outputMatch": c.output_match,
                "gasMatch": c.gas_match,
                "gasDiff": c.gas_diff,
                "expectedGasIsApproximate": f.expected.gas_approx,
                "us": (us * 10.0).round() / 10.0,
            })
        }
        Err(u) => json!({ "fixture": f.name, "unknown": u.reason.as_str(), "detail": u.detail,
                          "missing": u.missing.iter().map(super::proto_types::miss_json).collect::<Vec<_>>(), "match": false }),
    }
}

/// `arbsim check-fixture <fixture.json>`   -> one JSON line on stdout.
/// `arbsim check-fixture --stdin`          -> reads one fixture JSON per line
///    from stdin, prints one result line per fixture (same order). A line
///    that can't be read gives {"error": "..."} so lines stay in step.
/// Exit code: 0 when every fixture ran (match or not; see "match"),
/// 2 for a usage / unreadable-file problem.
pub fn check_fixture(args: &[String]) {
    use std::io::{BufRead, Write};
    if args.get(2).map(|s| s.as_str()) == Some("--stdin") {
        let stdin = std::io::stdin();
        let mut out = std::io::stdout().lock();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let v = match serde_json::from_str::<serde_json::Value>(&line).map_err(|e| e.to_string()).and_then(Fixture::from_json) {
                Ok(f) => check_fixture_value(&f),
                Err(e) => json!({ "error": e }),
            };
            let _ = writeln!(out, "{v}");
            let _ = out.flush(); // the harness reads answers as they come
        }
        return;
    }
    let f = load_or_exit(args, "check-fixture");
    println!("{}", check_fixture_value(&f));
}

/// Timing summary (microseconds).
fn stats(mut v: Vec<f64>) -> serde_json::Value {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let p = |q: f64| v[((v.len() as f64 - 1.0) * q).round() as usize];
    let r = |x: f64| (x * 10.0).round() / 10.0;
    json!({ "n": v.len(), "median_us": r(p(0.5)), "p90_us": r(p(0.9)), "p99_us": r(p(0.99)), "min_us": r(v[0]), "max_us": r(v[v.len() - 1]) })
}

/// ArbExecutor execute(...) calldata: where amountIn / minProfit live
/// (byte offsets after the selector). Layout:
///   [selector][word0: offset of the Trade tuple][word1: flash pool][tuple: token, amountIn, minProfit, maxBlock, ...]
pub fn executor_offsets(data: &Bytes) -> Option<(usize, usize)> {
    if data.len() < 4 + 64 {
        return None;
    }
    let tuple = U256::from_be_slice(&data[4..36]).try_into().ok().filter(|t: &usize| 4 + t + 96 <= data.len())?;
    Some((tuple + 32, tuple + 64)) // amountIn, minProfit
}

/// Same call with minProfit = 1 wei: the trade really happens (state changes).
pub fn with_min_profit_one(data: &Bytes) -> Option<Bytes> {
    let (_, mp) = executor_offsets(data)?;
    let mut d = data.to_vec();
    d[4 + mp..4 + mp + 32].fill(0);
    d[4 + mp + 31] = 1;
    Some(Bytes::from(d))
}

/// `arbsim bench-fixture <fixture.json> [--n N]`
pub fn bench_fixture(args: &[String]) {
    let f = load_or_exit(args, "bench-fixture");
    let n: usize = arg_after(args, "--n").and_then(|s| s.parse().ok()).unwrap_or(2000).max(1);
    let ov = Overrides::none();
    let call = std::slice::from_ref(&f.call);

    // Single check.
    let first = run_calls(&f.state, &f.ctx, &ov, &[], call);
    let mut single = Vec::with_capacity(n);
    for _ in 0..n {
        let t = Instant::now();
        let _ = std::hint::black_box(run_calls(&f.state, &f.ctx, &ov, &[], call));
        single.push(t.elapsed().as_secs_f64() * 1e6);
    }

    // Chained: the same trade with minProfit = 1 (really trades), then the check.
    let chained = with_min_profit_one(&f.call.data).map(|a| {
        let calls = vec![CallReq { data: a, ..f.call.clone() }, f.call.clone()];
        let res = run_calls(&f.state, &f.ctx, &ov, &[], &calls);
        let mut v = Vec::with_capacity(n);
        for _ in 0..n {
            let t = Instant::now();
            let _ = std::hint::black_box(run_calls(&f.state, &f.ctx, &ov, &[], &calls));
            v.push(t.elapsed().as_secs_f64() * 1e6);
        }
        json!({ "timing": stats(v), "results": res.map(|r| r.iter().map(|o| json!({"success": o.success, "gas": o.gas_used, "output": to_hex(&o.output[..o.output.len().min(36)])})).collect::<Vec<_>>()).unwrap_or_default() })
    });

    // Size search: 12 tries from 1/100x to 10x the fixture's size.
    let search = executor_offsets(&f.call.data).map(|(amt_off, _)| {
        let base = U256::from_be_slice(&f.call.data[4 + amt_off..4 + amt_off + 32]);
        let lo = (base / U256::from(100u64)).max(U256::from(1u64));
        let hi = base * U256::from(10u64);
        let tpl = SizeTemplate { call: f.call.clone(), amount_offset: amt_off, amount_slots: vec![] };
        let range = SizeSearchAmounts::Range { lo, hi, steps: 12 };
        let res = size_search(&f.state, &f.ctx, &ov, &[], &tpl, &range);
        let m = (n / 10).max(20);
        let mut v = Vec::with_capacity(m);
        for _ in 0..m {
            let t = Instant::now();
            let _ = std::hint::black_box(size_search(&f.state, &f.ctx, &ov, &[], &tpl, &range));
            v.push(t.elapsed().as_secs_f64() * 1e6);
        }
        json!({
            "range": { "lo": lo.to_string(), "hi": hi.to_string(), "steps": 12 },
            "timing": stats(v),
            "best": res.as_ref().ok().and_then(|r| r.best.as_ref()).map(|b| json!({"amount": b.amount.to_string(), "profit": b.profit.to_string(), "gas": b.gas_used})),
            "tries": res.as_ref().map(|r| r.tried.len()).unwrap_or(0),
        })
    });

    let report = json!({
        "fixture": f.name,
        "first": first.as_ref().map(|o| json!({"success": o[0].success, "gas": o[0].gas_used, "exact": f.compare(&o[0]).exact()})).unwrap_or_else(|u| json!({"unknown": u.reason.as_str()})),
        "single": stats(single),
        "chained_A_then_B": chained,
        "size_search_12": search,
    });
    println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
}
