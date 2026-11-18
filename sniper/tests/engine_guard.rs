// Linux only: needs Unix sockets / bash (the server is Linux; the Windows
// desktop copy never runs the engine).
#![cfg(unix)]
// ============================================================================
// Runs tests/engine_guard_test.sh (the engine's memory guard in the cron and
// the `trial` command, against fake binaries in a temp folder, with the
// REAL sniper program for the trial) as part of `cargo test`.
// Skipped (passes) when a tool it needs is missing on this machine.
// ============================================================================
use std::process::Command;

#[test]
fn engine_memory_guard_and_trial() {
    for tool in ["bash", "git", "python3", "flock", "pgrep", "ps", "sha256sum"] {
        let found = Command::new("sh").arg("-c").arg(format!("command -v {tool}")).output().map(|o| o.status.success()).unwrap_or(false);
        if !found {
            eprintln!("SKIP: {tool} not found");
            return;
        }
    }
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/engine_guard_test.sh");
    let out = Command::new("bash").arg(&script).env("SNIPER_BIN", env!("CARGO_BIN_EXE_sniper")).output().expect("run the engine guard test script");
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    eprintln!("{text}");
    assert!(out.status.success(), "engine guard test failed:\n{text}");
}
