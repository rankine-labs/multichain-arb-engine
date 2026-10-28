// ============================================================================
// arbsim command line. One line per subcommand; each workstream owns its own.
//   serve           the sidecar: socket server + live mirror (workstream A)
//   check-fixture   run one test file and compare with the node (C)
//   bench-fixture   speed test on one test file (C)
//   node-bench      time node requests through our node client (A, read only)
//   ahead-replay    replay a fast lane prediction capture offline (fast lane A)
//   trig-replay     replay a capture through the fire-first decision Rust makes (fastlane/trig_replay.rs)
// ============================================================================
fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()) {
        Some("serve") => arbsim::serve::serve_main(&args),
        Some("check-fixture") => arbsim::check::cli::check_fixture(&args),
        Some("bench-fixture") => arbsim::check::cli::bench_fixture(&args),
        Some("node-bench") => arbsim::bench_node::node_bench(&args),
        Some("ahead-replay") => arbsim::copy2::ahead_capture::replay_main(&args),
        Some("trig-replay") => arbsim::fastlane::trig_replay::replay_main(&args),
        _ => {
            eprintln!("usage: arbsim serve | check-fixture <file> | bench-fixture <file> | node-bench [--url-env NAME] [--n 50] [--parallel 16] | ahead-replay <capture file> [--json] [--samples N] [--budget-ms N] [--partial] | trig-replay <capture file> [--table <file>] [--ours 0x..] [--json] [--samples N] [--partial] [--no-full] [--fetch [--fetch-max N] [--fetch-paid on|off] [--fetch-scope all|moved] [--fetch-url-env NAME]]");
            std::process::exit(2);
        }
    }
}
