// ============================================================================
// SIZE SEARCH: find the trade size that makes the most money.
//
// Plain English:
//   The bot's check runs our contract with "minimum profit = impossibly high",
//   so the contract always refuses at the very end with
//   InsufficientProfit(got, wanted) - and `got` is exactly the profit that
//   size would have made. Here we run that same check at several sizes and
//   keep the best one.
//
//   How sizes are picked (at most `steps` runs, default 12):
//     1. a coarse sweep: ~half the budget, sizes spread evenly on a log scale
//        between lo and hi (so $10 and $10,000 get equal attention),
//     2. zoom in: golden-section search between the neighbours of the best
//        coarse size, with the rest of the budget.
//   Profit vs size is normally one hill (rises, peaks, falls as price impact
//   grows), which this finds in ~12 runs. With an explicit list of amounts,
//   every amount is tried instead.
//
//   Speed: the expensive common part (applying the trade we follow) is run
//   ONCE; each size then starts from a saved copy of that scratch state.
//   Each try changes two things: the amountIn word in the call data and
//   (own-money checks) the token balance slot that gives our test contract
//   its trading money.
//
//   Results:
//     profit  InsufficientProfit with got > 0
//     loss    InsufficientProfit with got = 0
//     fail    any other refusal (pool said no, ...)
//   A size that touches something our copy doesn't have makes the WHOLE
//   search "unknown" (with the missing items), never a partial guess.
// ============================================================================
use std::collections::HashMap;

use revm::primitives::{Address, Bytes, U256};

use super::overrides::Overrides;
use super::run::{CheckOptions, Session};
use super::{CallOutcome, CallReq, CheckUnknown};
use crate::arb::BlockCtx;
use crate::state::StateRead;

/// InsufficientProfit(uint256 got, uint256 wanted) error code.
pub const INSUFFICIENT_PROFIT_SELECTOR: [u8; 4] = [0x4e, 0x88, 0x42, 0x2a];

/// What to run at each size.
#[derive(Clone, Debug)]
pub struct SizeTemplate {
    /// The executor call (data = full calldata incl. selector; minProfit = max).
    pub call: CallReq,
    /// Byte offset of the amountIn word in `call.data`, counted AFTER the
    /// 4-byte selector (so the word lives at data[4+off .. 4+off+32]).
    pub amount_offset: usize,
    /// Storage slots set to the size for each try (own-money checks: the
    /// test contract's balance of the start token). Empty for flash loans.
    pub amount_slots: Vec<(Address, U256)>,
}

/// Which sizes to try.
#[derive(Clone, Debug)]
pub enum SizeSearchAmounts {
    /// Try exactly these.
    List(Vec<U256>),
    /// Search between lo and hi (inclusive) with at most `steps` runs.
    Range { lo: U256, hi: U256, steps: usize },
}

/// One size that was tried.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SizeTry {
    pub amount: U256,
    /// "profit" | "loss" | "fail"
    pub status: &'static str,
    /// Profit in start-token units (0 for loss/fail).
    pub profit: U256,
    pub gas_used: u64,
    /// For "fail": the first bytes of the refusal (hex) or halt reason.
    pub reason: String,
}

/// The best size found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SizeSearchBest {
    pub amount: U256,
    pub profit: U256,
    pub gas_used: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SizeSearchResult {
    /// None when no size made a profit.
    pub best: Option<SizeSearchBest>,
    /// Every size tried, in the order tried.
    pub tried: Vec<SizeTry>,
}

/// Read a check outcome as a size-search result.
pub fn classify(amount: U256, o: &CallOutcome) -> SizeTry {
    let out = &o.output;
    if !o.success && o.halt.is_none() && out.len() == 68 && out[..4] == INSUFFICIENT_PROFIT_SELECTOR {
        let got = U256::from_be_slice(&out[4..36]);
        return SizeTry {
            amount,
            status: if got.is_zero() { "loss" } else { "profit" },
            profit: got,
            gas_used: o.gas_used,
            reason: String::new(),
        };
    }
    let reason = if o.success {
        "call unexpectedly succeeded".to_string()
    } else if let Some(h) = &o.halt {
        h.clone()
    } else {
        super::hexutil::to_hex(&out[..out.len().min(10)])
    };
    SizeTry { amount, status: "fail", profit: U256::ZERO, gas_used: o.gas_used, reason }
}

/// Copy of `data` with the amountIn word replaced.
pub fn patch_amount(data: &Bytes, amount_offset: usize, amount: U256) -> Result<Bytes, String> {
    let start = 4usize.checked_add(amount_offset).ok_or("bad amountOffset")?;
    let end = start.checked_add(32).ok_or("bad amountOffset")?;
    if end > data.len() {
        return Err(format!("amountOffset {amount_offset} is past the end of the call data ({} bytes)", data.len()));
    }
    let mut d = data.to_vec();
    d[start..end].copy_from_slice(&amount.to_be_bytes::<32>());
    Ok(Bytes::from(d))
}

// ---------------------------------------------------------------------------
// Picking sizes on a log scale.
// ---------------------------------------------------------------------------
fn to_f64(v: U256) -> f64 {
    f64::from(v)
}
fn from_f64(x: f64, lo: U256, hi: U256) -> U256 {
    let v = U256::try_from(x.round().max(0.0)).unwrap_or(hi);
    v.clamp(lo, hi)
}
/// `n` sizes evenly spread on a log scale from lo to hi (both included).
fn log_grid(lo: U256, hi: U256, n: usize) -> Vec<U256> {
    if n <= 1 || lo >= hi {
        return vec![hi];
    }
    let (a, b) = (to_f64(lo.max(U256::from(1u8))).ln(), to_f64(hi).ln());
    let mut v: Vec<U256> = (0..n)
        .map(|i| {
            if i == 0 {
                lo
            } else if i == n - 1 {
                hi
            } else {
                from_f64((a + (b - a) * i as f64 / (n - 1) as f64).exp(), lo, hi)
            }
        })
        .collect();
    v.dedup();
    v
}

/// Peak of the parabola through the best profitable size and its nearest
/// tried neighbours (log scale). None if there is no clear hill top inside
/// the neighbours, or the peak was already tried.
fn parabola_peak(tried: &[SizeTry], lo: U256, hi: U256) -> Option<U256> {
    let mut pts: Vec<(f64, f64, U256)> = tried
        .iter()
        .filter(|t| t.status != "fail")
        .map(|t| (to_f64(t.amount).ln(), to_f64(t.profit), t.amount))
        .collect();
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    pts.dedup_by(|a, b| a.2 == b.2);
    let bi = (0..pts.len()).max_by(|i, j| pts[*i].1.partial_cmp(&pts[*j].1).unwrap_or(std::cmp::Ordering::Equal))?;
    if bi == 0 || bi + 1 >= pts.len() || pts[bi].1 <= 0.0 {
        return None;
    }
    let ((x0, y0, _), (x1, y1, _), (x2, y2, _)) = (pts[bi - 1], pts[bi], pts[bi + 1]);
    // Vertex of the parabola through 3 points (standard formula).
    let den = (x1 - x0) * (y1 - y2) - (x1 - x2) * (y1 - y0);
    if den.abs() < f64::EPSILON {
        return None;
    }
    let num = (x1 - x0).powi(2) * (y1 - y2) - (x1 - x2).powi(2) * (y1 - y0);
    let xv = x1 - 0.5 * num / den;
    if !xv.is_finite() || xv <= x0 || xv >= x2 {
        return None;
    }
    let v = from_f64(xv.exp(), lo, hi);
    if pts.iter().any(|p| p.2 == v) {
        return None;
    }
    Some(v)
}

/// Score for comparing tries: profit, with every failure below any loss.
fn score(t: &SizeTry) -> (u8, U256) {
    match t.status {
        "fail" => (0, U256::ZERO),
        _ => (1, t.profit),
    }
}

/// Find the most profitable size. See the header for how.
pub fn size_search(
    view: &dyn StateRead,
    ctx: &BlockCtx,
    overrides: &Overrides,
    raw_txs: &[Bytes],
    template: &SizeTemplate,
    amounts: &SizeSearchAmounts,
) -> Result<SizeSearchResult, CheckUnknown> {
    size_search_opts(view, ctx, overrides, raw_txs, template, amounts, CheckOptions::default())
}

pub fn size_search_opts(
    view: &dyn StateRead,
    ctx: &BlockCtx,
    overrides: &Overrides,
    raw_txs: &[Bytes],
    template: &SizeTemplate,
    amounts: &SizeSearchAmounts,
    opts: CheckOptions,
) -> Result<SizeSearchResult, CheckUnknown> {
    // Check the template once up front (a bad offset is the caller's mistake).
    patch_amount(&template.call.data, template.amount_offset, U256::ZERO).map_err(CheckUnknown::bad_request)?;

    let mut s = Session::new(view, ctx, overrides, opts);
    s.apply_raw_txs(raw_txs)?; // the trade we follow: once
    let base = s.snapshot();

    let mut tried: Vec<SizeTry> = Vec::new();
    let mut cache: HashMap<U256, usize> = HashMap::new();
    // Run one size (or reuse its earlier answer).
    let mut eval = |s: &mut Session<'_>, amount: U256, tried: &mut Vec<SizeTry>| -> Result<SizeTry, CheckUnknown> {
        if let Some(i) = cache.get(&amount) {
            return Ok(tried[*i].clone());
        }
        s.restore(&base);
        let slots: Vec<(Address, U256, U256)> = template.amount_slots.iter().map(|(a, k)| (*a, *k, amount)).collect();
        s.set_slots(&slots);
        let mut call = template.call.clone();
        call.data = patch_amount(&template.call.data, template.amount_offset, amount).map_err(CheckUnknown::bad_request)?;
        let o = s.call(&call)?;
        let t = classify(amount, &o);
        cache.insert(amount, tried.len());
        tried.push(t.clone());
        Ok(t)
    };

    match amounts {
        SizeSearchAmounts::List(list) => {
            if list.is_empty() {
                return Err(CheckUnknown::bad_request("no amounts given"));
            }
            for a in list {
                eval(&mut s, *a, &mut tried)?;
            }
        }
        SizeSearchAmounts::Range { lo, hi, steps } => {
            let (lo, hi) = (*lo, *hi);
            if lo.is_zero() || lo > hi {
                return Err(CheckUnknown::bad_request("range needs 0 < lo <= hi"));
            }
            let steps = (*steps).clamp(1, 64);
            // 1) Coarse sweep with about half the budget (at least 3 points).
            let coarse_n = if steps <= 3 { steps } else { (steps / 2).max(3) };
            let grid = log_grid(lo, hi, coarse_n);
            let mut results = Vec::with_capacity(grid.len());
            for a in &grid {
                results.push(eval(&mut s, *a, &mut tried)?);
            }
            // Best coarse point; its neighbours bracket the peak.
            let bi = (0..results.len()).max_by_key(|i| score(&results[*i])).unwrap_or(0);
            let left = grid[bi.saturating_sub(1)];
            let right = grid[(bi + 1).min(grid.len() - 1)];
            // 2) Golden-section search on log(size) inside [left, right],
            //    keeping one try back for 3) the final "parabola" step.
            let total_budget = steps.saturating_sub(tried.len());
            let keep_for_parabola = usize::from(total_budget >= 3);
            let mut budget = total_budget - keep_for_parabola;
            if budget > 0 && left < right && results[bi].status == "profit" {
                const INV_PHI: f64 = 0.618_033_988_749_895;
                let (mut a, mut b) = (to_f64(left).ln(), to_f64(right).ln());
                let at = |x: f64| from_f64(x.exp(), left, right);
                let mut c = b - (b - a) * INV_PHI;
                let mut d = a + (b - a) * INV_PHI;
                let mut fc = score(&eval(&mut s, at(c), &mut tried)?);
                budget -= 1;
                let mut fd = (0u8, U256::ZERO);
                if budget > 0 {
                    fd = score(&eval(&mut s, at(d), &mut tried)?);
                    budget -= 1;
                }
                while budget > 0 && at(a) < at(b) {
                    if fc >= fd {
                        // Peak is left of d.
                        b = d;
                        d = c;
                        fd = fc;
                        c = b - (b - a) * INV_PHI;
                        fc = score(&eval(&mut s, at(c), &mut tried)?);
                    } else {
                        a = c;
                        c = d;
                        fc = fd;
                        d = a + (b - a) * INV_PHI;
                        fd = score(&eval(&mut s, at(d), &mut tried)?);
                    }
                    budget -= 1;
                    // Sizes converged to the same whole number: done.
                    if at(c) == at(d) {
                        break;
                    }
                }
            }
            // 3) Parabola step: near its top a smooth hill looks like a
            //    parabola, so fit one through the best size and its two
            //    neighbours (on log scale) and try its peak. One extra try
            //    usually lands much closer to the true best than another
            //    golden-section step would.
            if keep_for_parabola + budget > 0 {
                if let Some(x) = parabola_peak(&tried, lo, hi) {
                    eval(&mut s, x, &mut tried)?;
                }
            }
        }
    }

    // Anything missing anywhere = unknown (never a partial guess).
    s.verdict()?;

    // Best = highest profit; on a tie, the smaller size (less capital at risk).
    let best = tried
        .iter()
        .filter(|t| t.status == "profit")
        .max_by(|x, y| x.profit.cmp(&y.profit).then(y.amount.cmp(&x.amount)))
        .map(|t| SizeSearchBest { amount: t.amount, profit: t.profit, gas_used: t.gas_used });
    Ok(SizeSearchResult { best, tried })
}
