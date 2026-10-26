// ============================================================================
// FAST LANE (Oct 26): find standing gaps as each feed message arrives and
// send at once, all inside arbsim. Off unless FASTLANE=practice|live.
// Workstreams: ahead (A, copy2/ahead.rs), scan (B), gun (C), safety (D).
// (Each workstream adds its own `pub mod` line here.)
// ============================================================================
// Workstream B: the shared Opportunity type and the standing-gap scanner.
pub mod scan;
pub mod types;
// Opportunity -> gun CallInput / safety SafetyInput. Needs C's and D's
// modules, so it is compiled only when integration turns the feature on.
#[cfg(feature = "fastlane_integration")]
pub mod convert;
