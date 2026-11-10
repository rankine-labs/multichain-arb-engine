// ============================================================================
// sniper command line.
//
//   sniper probe                    run the read-only probe (config: env vars,
//                                   see src/probe.rs or README.md)
//   sniper scan                     live token scanner (config: env vars,
//                                   see src/scan.rs)
//   sniper sell-check <token> <BNB> simulate our buy + sell of a token
//                                   (env: SNIPER_RPC, SNIPER_WALLET)
//   sniper curve-check <dir>        fit + verify the Four.meme price formula
//                                   against real trades (writes curve_fit.json)
//   sniper report <dir> [options]   print the numbers for a probe run and
//                                   save them as <dir>/summary.json
//     --min-lead-ms N    lead time needed to act on a pending buy (default 150)
//     --warmup-secs N    ignore N s after each reconnect (default 10)
//     --burst-buys N     buys (from N wallets) that make a burst (default 3)
//     --min-rise-pct X   price rise within the burst block (default 2)
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
        Some("scan") => match sniper::scan::Config::from_env().and_then(sniper::scan::run) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("scan: {e}");
                ExitCode::FAILURE
            }
        },
        Some("sell-check") => {
            // sniper sell-check <token> <funds in BNB, e.g. 0.05>
            // env: SNIPER_RPC (https URL), SNIPER_WALLET (our trading wallet address)
            let (Some(token), Some(bnb)) = (args.get(1), args.get(2).and_then(|v| v.parse::<f64>().ok())) else {
                eprintln!("usage: sniper sell-check <token address> <BNB amount>   (env: SNIPER_RPC, SNIPER_WALLET)");
                return ExitCode::FAILURE;
            };
            let (Ok(url), Ok(wallet)) = (std::env::var("SNIPER_RPC"), std::env::var("SNIPER_WALLET")) else {
                eprintln!("set SNIPER_RPC (https node URL) and SNIPER_WALLET (wallet address to simulate)");
                return ExitCode::FAILURE;
            };
            use sniper::sellcheck::*;
            let funds = ruint::aliases::U256::from((bnb * 1e9).round() as u64) * ruint::aliases::U256::from(1_000_000_000u64);
            let req = Request {
                manager: sniper::fourmeme::TOKEN_MANAGER_2.into(),
                token: token.clone(),
                wallet,
                funds,
                block: "latest".into(),
            };
            match run_check(&Rpc::new(&url), &req) {
                Ok(r) => {
                    println!("{r:#?}");
                    println!("buy tax: {:?} bps | round trip loss: {:?} bps", r.buy_tax_bps(), r.round_trip_loss_bps(funds));
                    println!("VERDICT: {:?}", verdict(&r, funds, &Limits::default()));
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("check could not complete (= REJECT): {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Some("curve-check") => {
            let Some(dir) = args.get(1) else {
                eprintln!("usage: sniper curve-check <probe output dir>");
                return ExitCode::FAILURE;
            };
            let dir = PathBuf::from(dir);
            let r = sniper::calibrate::build(&dir);
            let _ = std::fs::write(dir.join("curve_fit.json"), serde_json::to_string_pretty(&r).unwrap_or_default());
            print!("{}", sniper::calibrate::render(&r));
            ExitCode::SUCCESS
        }
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
                    ("--min-rise-pct", Some(v)) => o.min_rise_pct = v,
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
            eprintln!("usage: sniper probe | sniper scan | sniper sell-check <token> <BNB> | sniper curve-check <dir> | sniper report <dir> [--min-lead-ms N] [--burst-buys N] [--hurdle-pct X] [--json]");
            ExitCode::FAILURE
        }
    }
}
