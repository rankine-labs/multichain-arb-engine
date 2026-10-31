// ============================================================================
// FASTLANE_AHEAD=observe (Oct 31): the predicted copy runs and measures
// itself, but its tips are NEVER handed out, so no lane / scanner / trigger
// decision can read them. Own test binary: the runtime is process-wide.
// ============================================================================
use std::sync::Arc;
use std::time::{Duration, Instant};

use arbsim::copy2::ahead::{feeds_lane, global_tip, observing, start_as, status_json, wait_tip, AheadCfg, AheadMode, Mode};
use arbsim::copy2::intake::{manual, C2Config};
use arbsim::state::fill::FillQueue;
use arbsim::state::mirror::{Config, Shared};

#[test]
fn observe_runs_but_never_hands_out_a_tip() {
    let sh = Shared::new(Config::for_tests(), None, Arc::new(arbsim::state::snap::Volatile::default()));
    let (_intake, h) = manual(sh, Arc::new(FillQueue::new(10, 10)), C2Config::for_tests());
    // FASTLANE_AHEAD off starts nothing, whatever FASTLANE says.
    assert!(!start_as(Mode::Practice, AheadMode::Off, h.clone(), AheadCfg::default()));
    assert!(status_json().is_none() && !feeds_lane() && !observing());
    // Observe: running (status), but it does not feed the lane.
    assert!(start_as(Mode::Practice, AheadMode::Observe, h, AheadCfg::default()));
    assert!(observing(), "running, observe only");
    assert!(!feeds_lane(), "the lane must scan copy 2, not the predicted copy");
    let st = status_json().expect("status shows it");
    assert_eq!(st["mode"], "observe");
    assert!(global_tip().is_none());
    let t = Instant::now();
    assert!(wait_tip(0, Duration::from_millis(50)).is_none(), "never a tip in observe mode");
    assert!(t.elapsed() < Duration::from_secs(1), "returns at once, no waiting");
}
