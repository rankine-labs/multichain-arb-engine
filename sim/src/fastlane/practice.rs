// ============================================================================
// FAST LANE PRACTICE SCORING: the go / no-go evidence.
//
// Plain English:
//   In practice mode nothing is sent. To know whether sending WOULD have
//   made money, every "would send" is remembered and, once copy 2 has
//   confirmed block N (the block the trade was found on) AND block N+1 (the
//   block it would have landed in), it gets a label:
//     real    re-checked at exactly its size on copy 2's CONFIRMED state of
//             block N (what our trade would really have met at the top of
//             N+1, if the prediction was right): it still pays the minimum
//     gone    it does not pay on the confirmed state (prediction was off,
//             or the gap was never there)
//     unsure  copy 2 can't answer for sure (missing value, V4 bound runs
//             differ, ...)
//   and, separately, "taken": did ANY transaction in block N+1 touch the
//   pools it uses? Approximation: a pool of the route changed in confirmed
//   N+1 = somebody acted on it in that block (we can't know whether they
//   were before or after our would-be position; a rival who took the gap
//   at the top of N+1 shows up here).
//   Each scored would-send is one line in data/fastlane-practice.jsonl
//   (FASTLANE_PRACTICE_FILE; rotated to .1 past FASTLANE_PRACTICE_MAX_BYTES,
//   default 5 MB). Every hour: one summary line there too ("kind":"hour")
//   and in the log: would-sends, real %, taken %, feed -> would-hand
//   latency p50 / p90, prediction agreement %, and the estimated dollars if
//   sent (sum of expected profit of the real ones nobody else touched).
//   Node's hourly practice line reads that summary (fastlaneBridge.ts).
//   Bounded: at most 2,000 would-sends wait for their blocks; a would-send
//   whose blocks copy 2 no longer keeps is counted "expired".
// ============================================================================
use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};

use super::scan::{evaluate_at, CheckRunner, RunAt};
use super::types::Opportunity;
use crate::arb::BlockCtx;
use crate::state::snap::{Snapshot, View};

/// Settings (env names, defaults in brackets).
#[derive(Clone, Debug)]
pub struct PracticeCfg {
    /// FASTLANE_PRACTICE_FILE [data/fastlane-practice.jsonl]
    pub file: PathBuf,
    /// FASTLANE_PRACTICE_MAX_BYTES [5000000]
    pub max_bytes: u64,
    /// Minimum net to call it "real" (the scanner's minimum).
    pub min_net_usd: f64,
    /// Most would-sends waiting for their blocks.
    pub max_pending: usize,
}

impl PracticeCfg {
    pub fn from_lookup(get: &dyn Fn(&str) -> Option<String>) -> PracticeCfg {
        let max = get("FASTLANE_PRACTICE_MAX_BYTES").and_then(|v| v.trim().parse::<u64>().ok()).filter(|v| *v >= 10_000).unwrap_or(5_000_000);
        PracticeCfg {
            file: PathBuf::from(get("FASTLANE_PRACTICE_FILE").filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "data/fastlane-practice.jsonl".into())),
            max_bytes: max,
            min_net_usd: super::scan::ScanConfig::from_lookup(|k| get(k)).min_net_usd,
            max_pending: 2_000,
        }
    }
}

/// One would-send waiting for its blocks.
#[derive(Clone)]
struct Pending {
    opp: Opportunity,
    seq: u64,
    hand_us: u64,
}

/// One confirmed block as scoring needs it.
pub struct ConfirmedBlock {
    pub snap: Arc<Snapshot>,
    pub ctx: BlockCtx,
    /// Our pools (bot keys, lowercase) changed in this block.
    pub moved: Vec<String>,
}

/// Hourly counters.
#[derive(Clone, Debug, Default)]
pub struct PracticeHour {
    pub would_send: u64,
    pub scored: u64,
    pub real: u64,
    pub gone: u64,
    pub unsure: u64,
    pub taken: u64,
    pub expired: u64,
    /// Expected net of the real ones nobody else touched (USD).
    pub est_usd: f64,
    /// Expected net of every real one (USD), touched or not.
    pub real_usd: f64,
    pub hand_us: Vec<u64>,
}

pub struct Practice {
    pub cfg: PracticeCfg,
    l2_offset: u64,
    pending: VecDeque<Pending>,
    pub hour: PracticeHour,
    last: Value,
    /// Lines written (tests).
    pub lines: u64,
}

fn pct(v: &[u64]) -> (u64, u64) {
    let mut s = v.to_vec();
    let p = crate::timing::pct_of(&mut s);
    (p.get("p50").and_then(|x| x.as_u64()).unwrap_or(0), p.get("p90").and_then(|x| x.as_u64()).unwrap_or(0))
}

impl Practice {
    pub fn new(cfg: PracticeCfg, l2_offset: u64) -> Practice {
        Practice { cfg, l2_offset, pending: VecDeque::new(), hour: PracticeHour::default(), last: Value::Null, lines: 0 }
    }

    /// A practice "would send" (lane.rs).
    pub fn note_would_send(&mut self, o: &Opportunity, seq: u64, hand_us: u64) {
        self.hour.would_send += 1;
        if self.hour.hand_us.len() < 20_000 {
            self.hour.hand_us.push(hand_us);
        }
        if self.pending.len() >= self.cfg.max_pending {
            self.pending.pop_front();
            self.hour.expired += 1;
        }
        self.pending.push_back(Pending { opp: o.clone(), seq, hand_us });
    }

    /// Would-sends still waiting.
    pub fn waiting(&self) -> usize {
        self.pending.len()
    }

    /// Score every would-send whose blocks N and N+1 are confirmed.
    /// `block(n)`: copy 2's confirmed block n (None = not confirmed yet /
    /// no longer kept); `newest`: copy 2's newest confirmed block.
    pub fn score(&mut self, newest: u64, block: &dyn Fn(u64) -> Option<ConfirmedBlock>, runner: &dyn CheckRunner) {
        let mut keep = VecDeque::new();
        while let Some(p) = self.pending.pop_front() {
            let n = p.opp.block;
            if newest < n + 1 {
                keep.push_back(p);
                continue;
            }
            let (Some(bn), Some(bn1)) = (block(n), block(n + 1)) else {
                // Confirmed but no longer kept (or never published): expired.
                self.hour.expired += 1;
                continue;
            };
            let view = View::new(bn.snap.clone());
            let at = RunAt { view: &view, ctx: &bn.ctx, block: n, snap: Some(&bn.snap) };
            let ev = evaluate_at(&p.opp, runner, &at, self.cfg.min_net_usd);
            let label = match ev.real {
                Some(true) => "real",
                Some(false) => "gone",
                None => "unsure",
            };
            let taken = p.opp.pools.iter().any(|k| bn1.moved.iter().any(|m| m.eq_ignore_ascii_case(k)));
            self.hour.scored += 1;
            match label {
                "real" => {
                    self.hour.real += 1;
                    self.hour.real_usd += p.opp.expected_net_usd;
                    if !taken {
                        self.hour.est_usd += p.opp.expected_net_usd;
                    }
                }
                "gone" => self.hour.gone += 1,
                _ => self.hour.unsure += 1,
            }
            if taken {
                self.hour.taken += 1;
            }
            let line = json!({
                "kind": "score", "t": super::bridge::wall_ms(), "seq": p.seq, "block": n, "label": p.opp.route_label, "rid": p.opp.rid,
                "result": label, "taken": taken, "expectedNetUsd": p.opp.expected_net_usd, "netAtNUsd": ev.net_usd,
                "why": ev.at_size.as_ref().err(), "sizeUsd": p.opp.size_usd, "pools": p.opp.pools, "src": p.opp.source, "handUs": p.hand_us,
            });
            self.write(&line);
        }
        self.pending = keep;
    }

    /// From the running copy 2: its published versions (the last 64 blocks).
    pub fn on_confirmed(&mut self, c2: &crate::copy2::intake::Copy2Handle, runner: &dyn CheckRunner) {
        if self.pending.is_empty() {
            return;
        }
        let pv = c2.sh.published.view();
        let Some(head) = pv.head() else { return };
        let newest = head.block;
        // Nothing to do until the oldest waiting one's N+1 is in.
        if self.pending.front().is_some_and(|p| newest < p.opp.block + 1) {
            return;
        }
        let core = c2.core_for(Some(&pv));
        let get = |n: u64| -> Option<ConfirmedBlock> {
            let v = pv.versions.iter().find(|v| v.block == n)?;
            let ctx = v.ctx.clone()?;
            let changed: Vec<(revm::primitives::Address, revm::primitives::U256)> = v.diff.accounts.iter().flat_map(|(a, d)| d.storage.keys().map(move |s| (*a, *s))).collect();
            let moved = c2.pools_changed_with(&core, &changed, &[]).into_iter().map(|m| m.key.to_ascii_lowercase()).collect();
            Some(ConfirmedBlock { snap: v.snap.clone(), ctx, moved })
        };
        let _ = self.l2_offset;
        self.score(newest, &get, runner);
    }

    fn write(&mut self, v: &Value) {
        let mut line = v.to_string().into_bytes();
        line.push(b'\n');
        let p = &self.cfg.file;
        if let Some(d) = p.parent() {
            if !d.as_os_str().is_empty() {
                let _ = fs::create_dir_all(d);
            }
        }
        if fs::metadata(p).is_ok_and(|m| m.len() > self.cfg.max_bytes) {
            let mut r = p.as_os_str().to_owned();
            r.push(".1");
            let _ = fs::rename(p, PathBuf::from(r));
        }
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(p) {
            if f.write_all(&line).is_ok() {
                self.lines += 1;
            }
        }
    }

    /// The hour's summary as JSON.
    pub fn hour_json(&self, agreement_pct: Option<f64>) -> Value {
        let h = &self.hour;
        let (p50, p90) = pct(&h.hand_us);
        let real_pct = (h.scored > 0).then(|| 100.0 * h.real as f64 / h.scored as f64);
        let taken_pct = (h.scored > 0).then(|| 100.0 * h.taken as f64 / h.scored as f64);
        json!({
            "kind": "hour", "t": super::bridge::wall_ms(),
            "wouldSend": h.would_send, "scored": h.scored, "real": h.real, "gone": h.gone, "unsure": h.unsure, "taken": h.taken, "expired": h.expired,
            "realPct": real_pct, "takenPct": taken_pct, "handP50Us": p50, "handP90Us": p90, "agreementPct": agreement_pct,
            "estUsd": h.est_usd, "realUsd": h.real_usd, "waiting": self.pending.len(),
        })
    }

    /// Status "practice" (this hour so far).
    pub fn status_json(&self) -> Value {
        self.hour_json(super::lane::agreement_pct())
    }

    /// The last full hour's summary (Null before the first hour).
    pub fn last_hour_json(&self) -> Value {
        self.last.clone()
    }

    /// One hourly line (also written to the practice file), new hour.
    pub fn take_hour(&mut self, agreement_pct: Option<f64>) -> String {
        let j = self.hour_json(agreement_pct);
        self.write(&j);
        self.last = j;
        let h = std::mem::take(&mut self.hour);
        let (p50, p90) = pct(&h.hand_us);
        let pc = |a: u64, b: u64| if b > 0 { format!("{:.0}%", 100.0 * a as f64 / b as f64) } else { "-".into() };
        format!(
            "[arbsim] fastlane practice (last hour): would send {} | scored {}: real {} ({}), gone {}, unsure {}, taken by others in N+1 {} ({}), expired {} | feed -> would hand p50 {:.1} ms p90 {:.1} ms | prediction agreement {} | est. ${:.2} if sent (real and untouched; all real ${:.2})",
            h.would_send, h.scored, h.real, pc(h.real, h.scored), h.gone, h.unsure, h.taken, pc(h.taken, h.scored), h.expired,
            p50 as f64 / 1000.0, p90 as f64 / 1000.0,
            agreement_pct.map(|a| format!("{a:.1}%")).unwrap_or_else(|| "-".into()),
            h.est_usd, h.real_usd,
        )
    }
}
