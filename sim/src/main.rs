// arbsim command line. Subcommands are added by the workstreams (serve, check-fixture, ...).
fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()) {
        Some("check-fixture") => arbsim::check::cli::check_fixture(&args),
        Some("bench-fixture") => arbsim::check::cli::bench_fixture(&args),
        _ => {
            eprintln!("arbsim: no subcommand implemented yet ({:?})", args.get(1));
            std::process::exit(2);
        }
    }
}
