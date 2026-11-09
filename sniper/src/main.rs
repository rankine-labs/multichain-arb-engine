// ============================================================================
// sniper command line.
//
//   sniper probe                    run the read-only probe (config: env vars,
//                                   see src/probe.rs or README.md)
//   sniper report <dir> [options]   print the numbers for a probe run and
//                                   save them as <dir>/summary.json
//     --min-lead-ms N    lead time needed to act on a pending buy (default 150)
//     --warmup-secs N    ignore N s after each reconnect (default 10)
//     --burst-buys N     buys (from N wallets) that make a burst (default 3)
//     --hurdle-pct X     gain needed to count as profitable (default 3)
//     --json             print the full JSON instead of the summary
// ============================================================================
use std::path::PathBuf;
use std::process::ExitCode;

use sniper::{probe, report};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("probe") => match probe::Config::from_env().and_then(probe::run) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("probe: {e}");
                ExitCode::FAILURE
            }
        },
        Some("report") => {
            let Some(dir) = args.get(1) else {
                eprintln!("usage: sniper report <probe output dir> [options]");
                return ExitCode::FAILURE;
            };
            let mut o = report::Opts::default();
            let mut json_out = false;
            let mut i = 2;
            while i < args.len() {
                let val = args.get(i + 1).and_then(|v| v.parse::<f64>().ok());
                match (args[i].as_str(), val) {
                    ("--json", _) => {
                        json_out = true;
                        i += 1;
                        continue;
                    }
                    ("--min-lead-ms", Some(v)) => o.min_lead_ms = v,
                    ("--warmup-secs", Some(v)) => o.warmup_secs = v,
                    ("--burst-buys", Some(v)) => o.burst_buys = v as usize,
                    ("--hurdle-pct", Some(v)) => o.hurdle_pct = v,
                    (a, _) => {
                        eprintln!("unknown or incomplete option: {a}");
                        return ExitCode::FAILURE;
                    }
                }
                i += 2;
            }
            let dir = PathBuf::from(dir);
            let r = report::build(&dir, &o);
            let _ = std::fs::write(dir.join("summary.json"), serde_json::to_string_pretty(&r).unwrap_or_default());
            if json_out {
                println!("{}", serde_json::to_string_pretty(&r).unwrap_or_default());
            } else {
                print!("{}", report::render(&r));
            }
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("usage: sniper probe | sniper report <dir> [--min-lead-ms N] [--burst-buys N] [--hurdle-pct X] [--json]");
            ExitCode::FAILURE
        }
    }
}
