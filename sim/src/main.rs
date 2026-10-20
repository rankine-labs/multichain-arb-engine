// arbsim command line. Subcommands are added by the workstreams (serve, check-fixture, ...).
fn main() {
    let args: Vec<String> = std::env::args().collect();
    eprintln!("arbsim: no subcommand implemented yet ({:?})", args.get(1));
    std::process::exit(2);
}
