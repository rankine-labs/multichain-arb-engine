// ============================================================================
// arbsim command line. One line per subcommand; each workstream owns its own.
//   serve           the sidecar: socket server + live mirror (workstream A)
//   check-fixture   run one test file and compare with the node (C)
//   bench-fixture   speed test on one test file (C)
// ============================================================================
fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()) {
        Some("serve") => arbsim::serve::serve_main(&args),
        Some("check-fixture") => arbsim::check::cli::check_fixture(&args),
        Some("bench-fixture") => arbsim::check::cli::bench_fixture(&args),
        _ => {
            eprintln!("usage: arbsim serve | check-fixture <file> | bench-fixture <file>");
            std::process::exit(2);
        }
    }
}
