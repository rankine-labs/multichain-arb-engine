// ============================================================================
// CALCULATED TRADE SIZE (trigger-first entry point, Oct 23).
//
// Plain English:
//   Before, the entry point tried a fixed list of sizes ($100 / $400 / $1200
//   live) and kept the best. The best size is usually BETWEEN those (or above
//   / below them), so money was left on the table. Here we work out the size
//   that makes the most money, on the pools exactly as they are right after
//   the trade we follow (the replayed feed), and then check that exact size
//   (and one smaller "backup" size) with our real contract.
//
//   HOW (and why this way):
//     Every size is measured with OUR REAL CONTRACT on the copy as it was
//     right after the replay ("a probe", ~10-40 microseconds each; the feed
//     is replayed only once). We never decode pool storage ourselves: the
//     contract run already handles every pool kind we trade (V2, V3 and its
//     forks, Algebra, V4 with or without hooks, coins that take a cut), so
//     the answer is exact by construction. Decoding each fork's storage in
//     Rust (ticks, bitmaps, packed V4 slots) would be a second copy of the
//     swap maths that can quietly drift from the real one.
//
//     To need very few probes, we use the shape of AMM profit:
//       For a constant-product pool (V2, and a V3 / V4 pool while the price
//       stays inside one tick range) the coins you get back for x coins in
//       follow  out(x) = x / (u + v*x)  (u, v fixed numbers; the pool fee and
//       a coin's transfer cut only change u and v). Two pools in a row follow
//       the same shape again. So  x / out(x)  is a STRAIGHT LINE in x, and two
//       measured sizes are enough to know the whole curve.
//       Our profit is  out(x) - k*x  (k = 1 + the lender's fee, 1 with own
//       money). It is largest where the extra coin back for one more coin in
//       equals k, i.e. "where the two pools' prices meet after fees":
//           x* = ( sqrt(u/k) - u ) / v
//     1. FIT: probe the smallest size (lo) and use the biggest allowed size
//        (hi, already run as the main check), compute x*, probe it, refit
//        with the two measured sizes nearest the best, until x* stops moving
//        (within 0.2%). For V2 / in-range V3 this lands in ONE extra probe;
//        crossing ticks takes a few more.
//     2. SEARCH (fallback): if the curve doesn't fit (a hook whose fee
//        changes with size, a coin with odd transfer rules, a profit curve
//        with two hills...) or the bot says the route has a hook, we search
//        with real runs instead: a few sizes on a log scale, golden-section
//        search around the best, and one parabola step (same idea as
//        search.rs). Slower (about 10 probes) but makes no assumption.
//     3. BACKUP: one smaller size (60% of the best by default) is also run,
//        so the bot has a second, safer size from the same replay.
//   Caps: every size stays between lo and hi; hi is the bot's cap (wallet
//   room, MAX_TRADE_USD, auto-vetted coin limit, lender limit), exactly as
//   before. Nothing here ever picks a bigger size than the bot allowed.
//
//   RESULTS: method "fit" / "search" (a size was found), "none" (not even the
//   smallest size makes a profit: no trade), "failed" (we couldn't measure:
//   the bot then uses the old size ladder from the same replay).
// ============================================================================
use revm::primitives::U256;

use super::search::SizeTry;

/// Runs (probes) one calculation may use by default, the backup included.
pub const DEFAULT_PROBES: usize = 12;
/// Most runs one calculation may ever use.
pub const MAX_PROBES: usize = 24;
/// The backup size, as a share of the calculated size.
pub const DEFAULT_BACKUP: f64 = 0.6;
/// The fit has settled when the next size moves less than this share.
pub const FIT_TOL: f64 = 0.002;
/// The fit has also settled when its size lies between two measured
/// profitable sizes this close (share of the size).
pub const BRACKET_TOL: f64 = 0.01;
/// Most fit rounds before the search takes over.
pub const MAX_FIT_ROUNDS: usize = 8;
/// Most fit sizes that turn out too big before the search takes over.
pub const MAX_OVERSHOOTS: usize = 4;

/// What one size did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Probe {
    /// The contract reported this much profit (start-coin units).
    Profit(U256),
    /// No profit (the contract reported 0).
    Loss,
    /// Refused for another reason (a pool said no, a lender too small...).
    Fail,
    /// Couldn't be answered (a value our copy doesn't hold at this size).
    Unknown,
}

impl Probe {
    /// From a size-search row (search.rs classify).
    pub fn of(t: &SizeTry) -> Probe {
        match t.status {
            "profit" => Probe::Profit(t.profit),
            "loss" => Probe::Loss,
            _ => Probe::Fail,
        }
    }
    fn profit(&self) -> Option<U256> {
        match self {
            Probe::Profit(p) => Some(*p),
            _ => None,
        }
    }
    /// For comparing sizes: any profit beats a loss, a loss beats a failure.
    fn score(&self) -> (u8, U256) {
        match self {
            Probe::Profit(p) => (2, *p),
            Probe::Loss => (1, U256::ZERO),
            _ => (0, U256::ZERO),
        }
    }
}

/// What the bot asked for.
#[derive(Clone, Debug, Default)]
pub struct CalcParams {
    /// Smallest size worth trading (start-coin units).
    pub lo: U256,
    /// Biggest size allowed (the bot's cap; never exceeded).
    pub hi: U256,
    /// Lender fee in millionths (0 = own money). Only helps the fit land
    /// sooner; a wrong value is corrected by the extra probes.
    pub loan_pips: u32,
    /// The curve fit may be used (false: the route has a hook pool, search only).
    pub fit: bool,
    /// Backup size as a share of the best (0 = no backup).
    pub backup: f64,
    /// Runs allowed (backup included).
    pub max_probes: usize,
    /// Also run the old size ladder (shadow: to compare the two).
    pub compare: bool,
}

/// How the size was found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Fit,
    Search,
    None,
    Failed,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Fit => "fit",
            Method::Search => "search",
            Method::None => "none",
            Method::Failed => "failed",
        }
    }
}

/// The calculation's answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CalcOut {
    pub method: Method,
    /// The size to trade: the most profitable size measured (None: none).
    pub calc: Option<U256>,
    /// The last size the curve fit worked out (for the log), if any.
    pub fit_size: Option<U256>,
    /// The backup size (run too), if any.
    pub backup: Option<U256>,
    /// Real runs used (sizes already known, like the main check, are free).
    pub probes: usize,
    /// Why the fit was left (search) or why nothing was found.
    pub why: Option<String>,
    /// Every size measured or given, in order.
    pub tried: Vec<(U256, Probe)>,
}

// ---------------------------------------------------------------------------
// Numbers: sizes are whole coin units (U256); the maths runs in f64 (plenty
// of precision for the share of a size; every size is then MEASURED exactly).
// ---------------------------------------------------------------------------
fn f(x: U256) -> f64 {
    f64::from(x)
}
fn to_u(x: f64, lo: U256, hi: U256) -> U256 {
    if !x.is_finite() {
        return if x > 0.0 { hi } else { lo };
    }
    U256::try_from(x.round().max(0.0)).unwrap_or(hi).clamp(lo, hi)
}

/// Sizes measured so far, and the run budget.
struct Book<'a> {
    tried: Vec<(U256, Probe)>,
    left: usize,
    used: usize,
    run: &'a mut dyn FnMut(U256) -> Probe,
}

impl Book<'_> {
    fn known(&self, x: U256) -> Option<Probe> {
        self.tried.iter().find(|(a, _)| *a == x).map(|(_, p)| *p)
    }
    /// This size's result: known, or measured now (None: no runs left).
    fn get(&mut self, x: U256) -> Option<Probe> {
        if let Some(p) = self.known(x) {
            return Some(p);
        }
        if self.left == 0 {
            return None;
        }
        self.left -= 1;
        self.used += 1;
        let p = (self.run)(x);
        self.tried.push((x, p));
        Some(p)
    }
    /// Profitable sizes, smallest first.
    fn profitable(&self) -> Vec<(U256, U256)> {
        let mut v: Vec<(U256, U256)> = self.tried.iter().filter_map(|(x, p)| p.profit().map(|q| (*x, q))).collect();
        v.sort();
        v.dedup_by(|a, b| a.0 == b.0);
        v
    }
    /// The best size (highest profit; on a tie the smaller size).
    fn best(&self) -> Option<(U256, Probe)> {
        self.tried.iter().copied().max_by(|(xa, pa), (xb, pb)| pa.score().cmp(&pb.score()).then(xb.cmp(xa)))
    }
}

/// The curve through two profitable sizes (see the file header), and the
/// size where it makes the most. None = the two sizes don't fit the curve.
/// +infinity = no price impact seen (as big as allowed).
pub fn fit_peak(a: (U256, U256), b: (U256, U256), k: f64) -> Option<f64> {
    let (xa, xb) = (f(a.0), f(b.0));
    if xa == xb || xa <= 0.0 || xb <= 0.0 {
        return None;
    }
    // x / out(x) at each size (out = profit + k*x: what came back).
    let ga = xa / (f(a.1) + k * xa);
    let gb = xb / (f(b.1) + k * xb);
    let v = (gb - ga) / (xb - xa);
    let u = ga - v * xa;
    if !u.is_finite() || !v.is_finite() || u <= 0.0 {
        return None;
    }
    let s = (u / k).sqrt();
    // The very first coin must already be profitable (it is: we measured a
    // profit), else the curve doesn't describe these sizes.
    if s <= u {
        return None;
    }
    if v <= 0.0 {
        return Some(f64::INFINITY);
    }
    Some((s - u) / v)
}

/// `n` sizes evenly spread on a log scale strictly between lo and hi.
fn log_inside(lo: U256, hi: U256, n: usize) -> Vec<U256> {
    let (a, b) = (f(lo.max(U256::from(1u8))).ln(), f(hi).ln());
    let mut v: Vec<U256> = (1..=n).map(|i| to_u((a + (b - a) * i as f64 / (n + 1) as f64).exp(), lo, hi)).filter(|x| *x > lo && *x < hi).collect();
    v.dedup();
    v
}

/// Find the most profitable size (see the file header). `seeds`: sizes
/// already measured on the same replay (the main check at hi, ladder
/// sizes): free. `run`: measure one size with the real contract.
pub fn calc_size(p: &CalcParams, seeds: &[(U256, Probe)], run: &mut dyn FnMut(U256) -> Probe) -> CalcOut {
    let max_probes = if p.max_probes == 0 { DEFAULT_PROBES } else { p.max_probes.min(MAX_PROBES) };
    let hi = p.hi;
    let lo = p.lo.max(U256::from(1u8)).min(hi);
    let backup_on = p.backup > 0.0 && p.backup < 1.0;
    let mut book = Book {
        tried: seeds.iter().filter(|(x, _)| *x <= hi && !x.is_zero()).copied().collect(),
        // One run kept for the backup size.
        left: max_probes.saturating_sub(usize::from(backup_on)).max(1),
        used: 0,
        run,
    };
    if hi.is_zero() {
        return done(book, Method::Failed, None, None, Some("no size allowed (cap 0)".into()));
    }
    // 1. Both ends.
    let p_hi = book.get(hi);
    let p_lo = book.get(lo);
    match p_lo {
        Some(Probe::Unknown) | None => return done(book, Method::Failed, None, None, Some("the smallest size can't be answered".into())),
        Some(Probe::Fail) if p_hi.and_then(|x| x.profit()).is_none() => {
            return done(book, Method::Failed, None, None, Some("the smallest size fails (not a profit question)".into()));
        }
        // Profit is a hill that starts at 0 (each extra coin brings back a
        // little less than the one before): if the smallest size already
        // loses, every bigger size loses too.
        Some(Probe::Loss) if book.profitable().is_empty() => {
            return done(book, Method::None, None, None, Some("no profit even at the smallest size".into()));
        }
        _ => {}
    }
    let k = 1.0 + f64::from(p.loan_pips) / 1e6;
    // Upper end for the next sizes: the smallest measured size above the
    // best profitable one that did NOT make a profit (too big), else hi.
    let top_of = |book: &Book<'_>| -> U256 {
        let best = book.best().map(|b| b.0).unwrap_or(lo);
        book.tried.iter().filter(|(x, pr)| *x > best && pr.profit().is_none()).map(|(x, _)| *x).min().unwrap_or(hi)
    };
    let mut why: Option<String> = None;
    let mut fit_size: Option<U256> = None;
    // 2. FIT (needs the smallest size profitable).
    if !p.fit {
        why = Some("route has a hook pool: search".into());
    } else if p_lo.and_then(|x| x.profit()).is_none() {
        why = Some("smallest size not profitable: search".into());
    } else {
        // A second profitable size: halve the range (log scale) until one is.
        while book.profitable().len() < 2 {
            let top = top_of(&book);
            let m = to_u((f(lo) * f(top)).sqrt(), lo, top);
            if m <= lo || m >= top || book.get(m).is_none() {
                break;
            }
        }
        let mut overshoots = 0usize;
        let mut settled: Option<U256> = None;
        for _ in 0..MAX_FIT_ROUNDS {
            let prof = book.profitable();
            let Some(&best) = prof.iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0))) else { break };
            // Its nearest profitable neighbour (log scale).
            let Some(&other) = prof.iter().filter(|q| q.0 != best.0).min_by(|a, b| (f(a.0).ln() - f(best.0).ln()).abs().total_cmp(&(f(b.0).ln() - f(best.0).ln()).abs())) else {
                why = Some("only one profitable size: search".into());
                break;
            };
            let top = top_of(&book);
            let Some(x) = fit_peak(best, other, k) else {
                why = Some("sizes don't fit the pool curve: search".into());
                break;
            };
            let mut xu = to_u(x, lo, top);
            fit_size = Some(xu);
            // Safeguard: the curve points at (or right next to) a size that
            // already lost / failed / couldn't be answered (a price range we
            // ran out of, a lender limit...): step halfway (log scale)
            // between the best size and it instead.
            if book.known(top).is_some_and(|q| q.profit().is_none()) && f(xu).ln() > f(best.0).ln() + 0.9 * (f(top).ln() - f(best.0).ln()) {
                xu = to_u((f(best.0) * f(top)).sqrt(), lo, top);
            }
            // Settled: the curve's best size is (nearly) one we measured...
            if let Some(near) = prof.iter().map(|q| q.0).find(|t| (f(*t) - f(xu)).abs() <= FIT_TOL * f(xu).max(1.0)) {
                settled = Some(near);
                break;
            }
            // ...or lies between two measured profitable sizes less than 1%
            // apart (a curve with a kink, e.g. right at a tick, makes the fit
            // hop from side to side): the better of the two.
            let below = prof.iter().filter(|q| q.0 <= xu).max_by_key(|q| q.0);
            let above = prof.iter().filter(|q| q.0 >= xu).min_by_key(|q| q.0);
            if let (Some(a), Some(b)) = (below, above) {
                if f(b.0) - f(a.0) <= BRACKET_TOL * f(xu) {
                    settled = Some(if b.1 > a.1 { b.0 } else { a.0 });
                    break;
                }
            }
            match book.get(xu) {
                None => {
                    why = Some("no runs left in the fit".into());
                    break;
                }
                Some(Probe::Profit(_)) => {}
                // Too big (a pool ran out of range, a lender limit...): never above it again.
                Some(_) => {
                    overshoots += 1;
                    if overshoots >= MAX_OVERSHOOTS {
                        why = Some("the fit overshot too often: search".into());
                        break;
                    }
                }
            }
        }
        if let Some(s) = settled {
            // Sanity: the settled size must be the best measured (one hill).
            if book.best().map(|b| b.0) == Some(s) {
                return finish(book, Method::Fit, Some(s), fit_size, None, lo, p, backup_on);
            }
            why = Some("the fit's size is not the best measured: search".into());
        } else if why.is_none() {
            why = Some("the fit did not settle: search".into());
        }
    }
    // 3. SEARCH with real runs.
    let top = top_of(&book);
    search(&mut book, lo, top);
    match book.best() {
        Some((x, Probe::Profit(_))) => finish(book, Method::Search, Some(x), fit_size, why, lo, p, backup_on),
        Some((_, Probe::Loss)) => done(book, Method::None, None, fit_size, Some("no profitable size found".into())),
        _ => done(book, Method::Failed, None, fit_size, Some("no size could be measured".into())),
    }
}

/// An answer without a backup size.
fn done(book: Book<'_>, method: Method, calc: Option<U256>, fit_size: Option<U256>, why: Option<String>) -> CalcOut {
    CalcOut { method, calc, fit_size, backup: None, probes: book.used, why, tried: book.tried }
}

/// The answer, plus the backup size (run now, its own reserved run).
#[allow(clippy::too_many_arguments)]
fn finish(mut book: Book<'_>, method: Method, calc: Option<U256>, fit_size: Option<U256>, why: Option<String>, lo: U256, p: &CalcParams, backup_on: bool) -> CalcOut {
    let mut backup = None;
    if let (Some(c), true) = (calc, backup_on) {
        let b = to_u(f(c) * p.backup, lo, c);
        if b < c {
            book.left += 1;
            if book.get(b).is_some() {
                backup = Some(b);
            }
        }
    }
    CalcOut { method, calc, fit_size, backup, probes: book.used, why, tried: book.tried }
}

/// SEARCH with real runs (no assumption about the curve): a few sizes on a
/// log scale if we have few, then golden-section search between the best
/// size's neighbours, then one parabola step. Uses the runs left.
fn search(book: &mut Book<'_>, lo: U256, top: U256) {
    if top <= lo {
        return;
    }
    let inside = book.tried.iter().filter(|(x, _)| *x >= lo && *x <= top).count();
    if inside < 5 {
        for x in log_inside(lo, top, 3) {
            if book.get(x).is_none() {
                return;
            }
        }
    }
    // Neighbours of the best size bracket the hill top.
    let bracket = |book: &Book<'_>| -> Option<(U256, U256)> {
        let (b, pb) = book.best()?;
        pb.profit()?;
        let mut xs: Vec<U256> = book.tried.iter().map(|t| t.0).filter(|x| *x >= lo && *x <= top).collect();
        xs.push(lo);
        xs.push(top);
        xs.sort();
        xs.dedup();
        let i = xs.iter().position(|x| *x == b)?;
        Some((xs[i.saturating_sub(1)], xs[(i + 1).min(xs.len() - 1)]))
    };
    let Some((left, right)) = bracket(book) else { return };
    const INV_PHI: f64 = 0.618_033_988_749_895;
    let (mut a, mut b) = (f(left.max(U256::from(1u8))).ln(), f(right).ln());
    let at = |x: f64| to_u(x.exp(), left, right);
    let sc = |book: &mut Book<'_>, x: U256| book.get(x).map(|p| p.score());
    let mut c = b - (b - a) * INV_PHI;
    let mut d = a + (b - a) * INV_PHI;
    // Keep one run for the parabola step.
    let golden_runs = book.left.saturating_sub(1);
    let stop = book.left - golden_runs;
    let (Some(mut fc), Some(mut fd)) = (sc(book, at(c)), sc(book, at(d))) else { return };
    while book.left > stop && at(a) < at(b) && at(c) != at(d) {
        let r = if fc >= fd {
            b = d;
            d = c;
            fd = fc;
            c = b - (b - a) * INV_PHI;
            sc(book, at(c)).map(|s| fc = s)
        } else {
            a = c;
            c = d;
            fc = fd;
            d = a + (b - a) * INV_PHI;
            sc(book, at(d)).map(|s| fd = s)
        };
        if r.is_none() {
            break;
        }
    }
    // Parabola through the best size and its neighbours (log scale): near
    // the top a smooth hill looks like one.
    if let Some(x) = parabola(book, lo, top) {
        book.get(x);
    }
}

/// Peak of the parabola through the best profitable size and its nearest
/// measured neighbours (log scale); None if there is no clear top inside.
fn parabola(book: &Book<'_>, lo: U256, hi: U256) -> Option<U256> {
    let mut pts: Vec<(f64, f64, U256)> = book.tried.iter().filter(|(_, p)| !matches!(p, Probe::Fail | Probe::Unknown)).map(|(x, p)| (f(*x).ln(), f(p.profit().unwrap_or(U256::ZERO)), *x)).collect();
    pts.sort_by(|a, b| a.0.total_cmp(&b.0));
    pts.dedup_by(|a, b| a.2 == b.2);
    let bi = (0..pts.len()).max_by(|i, j| pts[*i].1.total_cmp(&pts[*j].1))?;
    if bi == 0 || bi + 1 >= pts.len() || pts[bi].1 <= 0.0 {
        return None;
    }
    let ((x0, y0, _), (x1, y1, _), (x2, y2, _)) = (pts[bi - 1], pts[bi], pts[bi + 1]);
    let den = (x1 - x0) * (y1 - y2) - (x1 - x2) * (y1 - y0);
    if den.abs() < f64::EPSILON {
        return None;
    }
    let num = (x1 - x0).powi(2) * (y1 - y2) - (x1 - x2).powi(2) * (y1 - y0);
    let xv = x1 - 0.5 * num / den;
    if !xv.is_finite() || xv <= x0 || xv >= x2 {
        return None;
    }
    let v = to_u(xv.exp(), lo, hi);
    (book.known(v).is_none()).then_some(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(x: u128) -> U256 {
        U256::from(x)
    }

    /// Exact V2 round trip in integers (0.3% fee each way): buy on A, sell on B.
    fn v2_out(x: U256, r_in: U256, r_out: U256, fee_bps: u64) -> U256 {
        let xf = x * U256::from(10_000 - fee_bps);
        xf * r_out / (r_in * U256::from(10_000u64) + xf)
    }

    #[test]
    fn fit_peak_is_exact_for_a_v2_curve() {
        // out(x) = 2x/(1 + x/1e12): x/out = 0.5 + x/2e12, so u = 0.5,
        // v = 5e-13, k = 1: x* = (sqrt(0.5) - 0.5)/5e-13. Any two sizes give it.
        let out = |x: f64| 2.0 * x / (1.0 + x / 1e12);
        let pr = |x: u128| u((out(x as f64) - x as f64) as u128);
        let want = (0.5f64.sqrt() - 0.5) / 5e-13;
        for (a, b) in [(1_000_000_000u128, 100_000_000_000u128), (10_000_000_000, 900_000_000_000)] {
            let got = fit_peak((u(a), pr(a)), (u(b), pr(b)), 1.0).unwrap();
            assert!((got - want).abs() / want < 1e-6, "{got} vs {want}");
        }
        // With a lender fee (k = 1.0005) the best size is a little smaller.
        let k = 1.0005;
        let prk = |x: u128| u((out(x as f64) - k * x as f64) as u128);
        let want_k = ((0.5f64 / k).sqrt() - 0.5) / 5e-13;
        let got = fit_peak((u(1_000_000_000), prk(1_000_000_000)), (u(100_000_000_000), prk(100_000_000_000)), k).unwrap();
        assert!((got - want_k).abs() / want_k < 1e-6 && want_k < want, "{got} vs {want_k}");
    }

    #[test]
    fn v2_pair_lands_in_a_few_runs() {
        let (ra, rb) = (u(1_000_000_000_000), u(1_020_000_000_000));
        let profit = |x: U256| {
            let mid = v2_out(x, ra, rb, 30);
            let back = v2_out(mid, rb, ra * u(103) / u(100), 30);
            if back > x { Probe::Profit(back - x) } else { Probe::Loss }
        };
        let mut runs = 0;
        let p = CalcParams { lo: u(1_000_000), hi: u(100_000_000_000), loan_pips: 0, fit: true, backup: 0.6, max_probes: 12, compare: false };
        let seeds = [(p.hi, profit(p.hi))];
        let out = calc_size(&p, &seeds, &mut |x| {
            runs += 1;
            profit(x)
        });
        assert_eq!(out.method, Method::Fit, "{out:?}");
        assert!(out.probes <= 5, "{out:?}");
        assert_eq!(runs, out.probes);
        assert!(out.backup.is_some());
    }

    #[test]
    fn loss_at_the_smallest_size_is_no_size() {
        let p = CalcParams { lo: u(10), hi: u(1000), fit: true, backup: 0.6, ..Default::default() };
        let out = calc_size(&p, &[(u(1000), Probe::Loss)], &mut |_| Probe::Loss);
        assert_eq!(out.method, Method::None);
        assert!(out.calc.is_none() && out.backup.is_none());
        assert_eq!(out.probes, 1, "only the smallest size was run");
    }

    #[test]
    fn unknown_at_the_smallest_size_fails_so_the_ladder_decides() {
        let p = CalcParams { lo: u(10), hi: u(1000), fit: true, backup: 0.6, ..Default::default() };
        let out = calc_size(&p, &[(u(1000), Probe::Profit(u(5)))], &mut |_| Probe::Unknown);
        assert_eq!(out.method, Method::Failed);
    }
}
