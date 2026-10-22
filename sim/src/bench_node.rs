// ============================================================================
// `arbsim node-bench`: how long do node requests take, and where does the
// time go? (read only: it only asks the node questions)
//
//   arbsim node-bench [--url-env NAME] [--n 50] [--parallel 16]
//
// Plain English:
//   Uses the SAME node client copy 2 uses (keep-alive pool, speed limit,
//   daily allowance), configured from the same settings (ARBSIM_NODE_URL /
//   CHAINSTACK_RPC_ROBINHOOD / ARBSIM_NODE_RPS ...; a .env file in the
//   current folder is read for settings not already set). `--url-env NAME`
//   picks which setting holds the paid node's address. The address is never
//   printed. Cases (each prints p50 / p90 / max in ms):
//     A  raw POST, sequential, eth_blockNumber      (network only)
//     B  node client, sequential, eth_blockNumber   (+ limiter / allowance)
//     C  node client, sequential, eth_getStorageAt at the node's tip
//     D  node client, sequential, eth_getProof (2 slots) at the tip
//     E  node client, PARALLEL threads, eth_getStorageAt at the tip
//     F  raw POST, PARALLEL threads, eth_getStorageAt at the tip
//   If B >> A, the time is in our limiter / allowance; if E >> C, in
//   parallel use (connection pool / locks); if F is fast but E slow, in our
//   node client.
// ============================================================================
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::node::{tag, Class, NodeApi, NodeClient};

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

/// Read KEY=VALUE lines of ./.env for keys not already set.
fn load_dotenv() {
    let Ok(t) = std::fs::read_to_string(".env") else { return };
    for l in t.lines() {
        let l = l.trim().trim_start_matches("export ").trim();
        if l.starts_with('#') {
            continue;
        }
        let Some((k, v)) = l.split_once('=') else { continue };
        let k = k.trim();
        let v = v.split(" #").next().unwrap_or("").trim().trim_matches('"').trim_matches('\'');
        if !k.is_empty() && std::env::var_os(k).is_none() {
            std::env::set_var(k, v);
        }
    }
}

fn stats(name: &str, mut ms: Vec<f64>, errors: usize, wall: Duration) {
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let q = |p: f64| if ms.is_empty() { f64::NAN } else { ms[((ms.len() as f64 - 1.0) * p).round() as usize] };
    println!(
        "  {name:<58} n={:<4} p50 {:>7.1} ms  p90 {:>7.1} ms  max {:>7.1} ms  errors {errors}  ({:.1} req/s overall)",
        ms.len(),
        q(0.5),
        q(0.9),
        q(1.0),
        (ms.len() + errors) as f64 / wall.as_secs_f64().max(1e-9)
    );
}

fn body(method: &str, params: Value) -> String {
    json!([{ "jsonrpc": "2.0", "id": 0, "method": method, "params": params }]).to_string()
}

pub fn node_bench(args: &[String]) {
    load_dotenv();
    if let Some(name) = arg(args, "--url-env") {
        match std::env::var(&name) {
            Ok(v) if !v.trim().is_empty() => std::env::set_var("ARBSIM_NODE_URL", v),
            _ => {
                eprintln!("node-bench: setting {name} is not set (environment or ./.env)");
                std::process::exit(2);
            }
        }
    }
    let n: usize = arg(args, "--n").and_then(|s| s.parse().ok()).unwrap_or(50).max(1);
    let par: usize = arg(args, "--parallel").and_then(|s| s.parse().ok()).unwrap_or(16).max(1);
    let Some(client) = NodeClient::from_env() else {
        eprintln!("node-bench: no node configured (ARBSIM_NODE_URL / CHAINSTACK_RPC_ROBINHOOD)");
        std::process::exit(2);
    };
    let client = Arc::new(client);
    let proxy = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "HTTP_PROXY"].iter().any(|k| std::env::var_os(k).is_some());
    println!(
        "node-bench: nodes {:?}, ARBSIM_NODE_RPS {}, ARBSIM_NODE_BATCH {}, pool {}, proxy setting present: {proxy}",
        client.labels(),
        std::env::var("ARBSIM_NODE_RPS").unwrap_or_else(|_| "8 (default)".into()),
        std::env::var("ARBSIM_NODE_BATCH").unwrap_or_else(|_| "25 (default)".into()),
        std::env::var("ARBSIM_NODE_POOL").unwrap_or_else(|_| "64 (default)".into()),
    );
    let tip = match crate::node::block_number(&*client, Class::Fill) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("node-bench: eth_blockNumber failed: {e}");
            std::process::exit(1);
        }
    };
    println!("  node tip block {tip}");
    let addr = "0x0000000000000000000000000000000000000001";
    let sload = || ("eth_getStorageAt", json!([addr, format!("{:#066x}", 0), tag(tip)]));

    // A: raw sequential
    let (mut ms, mut err, t0) = (Vec::new(), 0, Instant::now());
    for _ in 0..n {
        let t = Instant::now();
        match client.post_paid_raw(&body("eth_blockNumber", json!([]))) {
            Ok(_) => ms.push(t.elapsed().as_secs_f64() * 1000.0),
            Err(_) => err += 1,
        }
    }
    stats("A raw POST, sequential, eth_blockNumber", ms, err, t0.elapsed());

    let seq = |name: &str, call: &dyn Fn() -> (&'static str, Value)| {
        let (mut ms, mut err, t0) = (Vec::new(), 0, Instant::now());
        for _ in 0..n {
            let (m, p) = call();
            let t = Instant::now();
            match client.call_batch_paid(Class::Fill, &[(m, p)]) {
                Ok(r) if r.first().is_some_and(|x| x.is_ok()) => ms.push(t.elapsed().as_secs_f64() * 1000.0),
                Ok(r) => {
                    if err == 0 {
                        println!("    first error: {:?}", r.first().and_then(|x| x.as_ref().err()).map(|e| &e.message));
                    }
                    err += 1
                }
                Err(e) => {
                    if err == 0 {
                        println!("    first error: {e}");
                    }
                    err += 1
                }
            }
        }
        stats(name, ms, err, t0.elapsed());
    };
    seq("B node client, sequential, eth_blockNumber", &|| ("eth_blockNumber", json!([])));
    seq("C node client, sequential, eth_getStorageAt at tip", &|| sload());
    seq("D node client, sequential, eth_getProof (2 slots) at tip", &|| {
        ("eth_getProof", json!([addr, [format!("{:#066x}", 0), format!("{:#066x}", 1)], tag(tip)]))
    });

    // E / F: parallel
    let parallel = |name: &str, raw: bool| {
        let t0 = Instant::now();
        let per = n.div_ceil(par);
        let hs: Vec<_> = (0..par)
            .map(|_| {
                let c = client.clone();
                std::thread::spawn(move || {
                    let mut ms = Vec::new();
                    let mut err = 0;
                    for _ in 0..per {
                        let t = Instant::now();
                        let ok = if raw {
                            c.post_paid_raw(&body("eth_getStorageAt", json!([addr, format!("{:#066x}", 0), tag(tip)]))).is_ok()
                        } else {
                            c.call_batch_paid(Class::Bulk, &[("eth_getStorageAt", json!([addr, format!("{:#066x}", 0), tag(tip)]))])
                                .is_ok_and(|r| r.first().is_some_and(|x| x.is_ok()))
                        };
                        if ok {
                            ms.push(t.elapsed().as_secs_f64() * 1000.0)
                        } else {
                            err += 1
                        }
                    }
                    (ms, err)
                })
            })
            .collect();
        let (mut ms, mut err) = (Vec::new(), 0);
        for h in hs {
            let (m, e) = h.join().unwrap();
            ms.extend(m);
            err += e;
        }
        stats(name, ms, err, t0.elapsed());
    };
    parallel(&format!("E node client, {par} parallel, eth_getStorageAt at tip"), false);
    parallel(&format!("F raw POST, {par} parallel, eth_getStorageAt at tip"), true);
    println!("  node client usage: {}", client.usage());
}
