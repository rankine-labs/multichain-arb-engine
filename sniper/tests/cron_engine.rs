// Linux only: needs Unix sockets / bash (the server is Linux; the Windows
// desktop copy never runs the engine).
#![cfg(unix)]
// ============================================================================
// Runs tests/cron_engine_test.sh (the cron script's engine auto-start,
// against fake binaries in a temp folder) as part of `cargo test`.
// Skipped (passes) when a tool it needs is missing on this machine.
// ============================================================================
use std::process::Command;

#[test]
fn cron_keeps_the_sniper_engine_running() {
    for tool in ["bash", "git", "python3", "flock", "pgrep", "sha256sum"] {
        let found = Command::new("sh").arg("-c").arg(format!("command -v {tool}")).output().map(|o| o.status.success()).unwrap_or(false);
        if !found {
            eprintln!("SKIP: {tool} not found");
            return;
        }
    }
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/cron_engine_test.sh");
    let out = Command::new("bash").arg(&script).output().expect("run the cron test script");
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    eprintln!("{text}");
    assert!(out.status.success(), "cron engine test failed:\n{text}");
}
