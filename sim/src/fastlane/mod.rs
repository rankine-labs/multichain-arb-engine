// ============================================================================
// FAST LANE (Oct 26): find standing gaps as each feed message arrives and
// send at once, all inside arbsim. Off unless FASTLANE=practice|live.
// Workstreams: ahead (A, copy2/ahead.rs), scan (B), gun (C), safety (D).
// (Each workstream adds its own `pub mod` line here.)
// ============================================================================
pub mod gun;
