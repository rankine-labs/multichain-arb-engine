// ============================================================================
// Live trader on every venue, against a FAKE node (nothing real is touched).
//
// Plain English:
//   A tiny pretend chain runs on localhost. It keeps the test wallet's
//   balances, answers quotes with numbers the test picks, accepts signed
//   transactions (decoding them with the sniper's own independent
//   transaction reader) and, when a swap arrives, moves balances the way
//   the test scripted. The real LiveTrader then buys and sells through it,
//   so these tests check, end to end:
//     - which transactions go out, in which order, to which contract, with
//       which calldata (the exact bytes liveroute.rs builds, min-outs from
//       the fresh quote minus 3%) and how much ETH;
//     - refusals happen BEFORE anything is sent (short balance, unsafe
//       hook, venue switched off);
//     - real P&L comes from balance changes (WETH, USDG, native ETH);
//     - a swap whose send got no answer leaves a pending position on disk
//       and halts new buys (no forgotten tokens);
//     - the live-dryrun report shape.
//   The private key is the well-known test key 1 (holds nothing anywhere).
// ============================================================================
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use ruint::aliases::U256;
use serde_json::{json, Value};
use sniper::live::{Gate, Ledger, Sender, Signer};
use sniper::liveroute::{self, RouterCfg, PERMIT2, UNIVERSAL_ROUTER};
use sniper::livetrade::{LiveCfg, LivePos, LiveTrader, USDG, WETH};
use sniper::venue::{V4Key, VenueKind, NATIVE_ETH};

const TOKEN: &str = "0x1111111111111111111111111111111111111111";
const KEY1: &str = "0x0000000000000000000000000000000000000000000000000000000000000001";
const ME: &str = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const GAS_PRICE: u64 = 10_000_000; // 0.01 gwei, as the fake receipts say
const GAS_USED: u64 = 100_000;

fn e18() -> U256 {
    U256::from(10u64).pow(U256::from(18u64))
}

/// What one swap does to the wallet: (coin, change) pairs; coin "eth" = native.
type Effect = Vec<(String, i128)>;

#[derive(Default)]
struct Chain {
    /// (coin, holder) -> balance; coin "eth" = native ETH.
    bal: HashMap<(String, String), U256>,
    /// Every transaction received, decoded: (to, data, value, hash).
    sent: Vec<(String, Vec<u8>, u128, String)>,
    nonce: u64,
    /// Next answers of the V4Quoter / V2 reserves (amount out).
    quotes: Vec<U256>,
    /// Effects of the next swaps, in order.
    effects: Vec<Effect>,
    /// Swaps to "lose": the node gives no answer when they are sent.
    drop_swap: bool,
    /// Calls to eth_simulateV1 seen (dry-run test).
    sims: Vec<Value>,
    base_reads: u32,
}

type Shared = Arc<Mutex<Chain>>;

fn word(x: U256) -> String {
    format!("{x:064x}")
}

fn is_swap(to: &str) -> bool {
    to.eq_ignore_ascii_case(UNIVERSAL_ROUTER) || to.eq_ignore_ascii_case(sniper::live::SWAP_ROUTER_02)
}

/// Answer one JSON-RPC call. None = hang up without answering.
fn answer(c: &Shared, method: &str, p: &Value) -> Option<Value> {
    let mut ch = c.lock().unwrap();
    Some(match method {
        "eth_chainId" => json!("0x1237"),
        "eth_blockNumber" => json!("0x64"),
        "eth_getTransactionCount" => json!(format!("0x{:x}", ch.nonce)),
        "eth_getBlockByNumber" => json!({"baseFeePerGas": "0x2faf08"}),
        "eth_getBalance" => {
            let who = p[0].as_str().unwrap_or("").to_ascii_lowercase();
            json!(format!("0x{:x}", ch.bal.get(&("eth".into(), who)).copied().unwrap_or(U256::ZERO)))
        }
        "eth_getTransactionReceipt" => {
            let h = p[0].as_str().unwrap_or("");
            if ch.sent.iter().any(|(_, _, _, x)| x == h) {
                json!({"status": "0x1", "blockNumber": "0x65", "gasUsed": format!("0x{GAS_USED:x}"), "effectiveGasPrice": format!("0x{GAS_PRICE:x}")})
            } else {
                Value::Null
            }
        }
        "eth_sendRawTransaction" => {
            let raw = p[0].as_str().unwrap_or("").trim_start_matches("0x");
            let bytes: Vec<u8> = (0..raw.len() / 2).map(|i| u8::from_str_radix(&raw[2 * i..2 * i + 2], 16).unwrap()).collect();
            let tx = sniper::feedtx::decode_tx(&bytes).expect("fake node: undecodable tx");
            let to = tx.to.clone().unwrap_or_default();
            if is_swap(&to) && ch.drop_swap {
                return None; // the node "never answers": fate unknown
            }
            // Gas comes out of native ETH; ETH sent goes with the tx.
            let gas = U256::from(GAS_USED * GAS_PRICE);
            let eth = ch.bal.entry(("eth".into(), ME.into())).or_default();
            *eth = eth.saturating_sub(gas).saturating_sub(U256::from(tx.value));
            if is_swap(&to) && !ch.effects.is_empty() {
                let eff = ch.effects.remove(0);
                for (coin, d) in eff {
                    if coin == "eth" && tx.value > 0 {
                        continue; // already taken as the tx value
                    }
                    let b = ch.bal.entry((coin, ME.into())).or_default();
                    *b = if d >= 0 { *b + U256::from(d as u128) } else { b.saturating_sub(U256::from((-d) as u128)) };
                }
            }
            ch.nonce += 1;
            ch.sent.push((to, tx.data, tx.value, tx.hash.clone()));
            json!(tx.hash)
        }
        "eth_call" => {
            let to = p[0]["to"].as_str().unwrap_or("").to_ascii_lowercase();
            let data = p[0]["data"].as_str().unwrap_or("").to_ascii_lowercase();
            if data.starts_with("0x70a08231") {
                let who = format!("0x{}", &data[34..74]);
                json!(format!("0x{}", word(ch.bal.get(&(to, who)).copied().unwrap_or(U256::ZERO))))
            } else if to == sniper::venue::V4_QUOTER {
                let q = if ch.quotes.is_empty() { U256::ZERO } else { ch.quotes.remove(0) };
                json!(format!("0x{}{}", word(q), word(U256::from(150_000u64))))
            } else if to == sniper::paper::V3_QUOTER_V2 {
                // ETH price for the dry run: 1 WETH = 3,000 USDG.
                json!(format!("0x{}{}{}{}", word(U256::from(3_000_000_000u64)), word(U256::ZERO), word(U256::ZERO), word(U256::from(1u64))))
            } else {
                json!("0x")
            }
        }
        "eth_simulateV1" => {
            ch.sims.push(p.clone());
            let calls = p[0]["blockStateCalls"][0]["calls"].as_array().cloned().unwrap_or_default();
            let mut out = Vec::new();
            for c in &calls {
                let to = c["to"].as_str().unwrap_or("").to_ascii_lowercase();
                let data = c["data"].as_str().unwrap_or("");
                let ret = if data.starts_with("0x70a08231") {
                    if to == TOKEN {
                        format!("0x{}", word(U256::from(1_000_000u64)))
                    } else {
                        ch.base_reads += 1;
                        // before the sell, then after it (+0.00160 WETH back)
                        let b = if ch.base_reads % 2 == 1 { e18() } else { e18() + U256::from(1_600_000_000_000_000u64) };
                        format!("0x{}", word(b))
                    }
                } else if to == sniper::venue::V4_QUOTER {
                    format!("0x{}{}", word(U256::from(1_650_000_000_000_000u64)), word(U256::from(1u64)))
                } else {
                    "0x".into()
                };
                out.push(json!({"status": "0x1", "returnData": ret, "gasUsed": "0x186a0", "logs": []}));
            }
            json!([{"calls": out}])
        }
        _ => Value::Null,
    })
}

fn fake_node(c: Shared) -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            let c = c.clone();
            std::thread::spawn(move || serve(s, c));
        }
    });
    url
}

fn serve(s: TcpStream, c: Shared) {
    let mut r = BufReader::new(s.try_clone().unwrap());
    let mut len = 0usize;
    loop {
        let mut line = String::new();
        if r.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        if line == "\r\n" {
            break;
        }
        if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            len = v.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; len];
    if r.read_exact(&mut body).is_err() {
        return;
    }
    let q: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let Some(res) = answer(&c, q["method"].as_str().unwrap_or(""), &q["params"]) else { return };
    let out = json!({"jsonrpc": "2.0", "id": q["id"], "result": res}).to_string();
    let mut s = s;
    let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}", out.len());
}

fn tmp_dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("sniper-live-venues-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn trader(url: &str, dir: &Path, venues: Vec<VenueKind>) -> LiveTrader {
    let signer = Signer::from_hex(KEY1).unwrap();
    let sender = Sender::new(sniper::sellcheck::Rpc::new(url), sniper::sellcheck::Rpc::new(url), signer).unwrap();
    let gate = Gate { key_file: dir.join("unused-key"), max_trade_usd: 5.0, max_day_loss_usd: 10.0, ledger: dir.join("ledger.json") };
    let ledger = Ledger { day: 1, realized_usd: 0.0, trades: 0 };
    let cfg = LiveCfg { router: RouterCfg::default(), venues, max_behind_blocks: 5 };
    LiveTrader::assemble(sender, gate, ledger, None, cfg, url, dir)
}

fn chain_with(balances: &[(&str, U256)]) -> Shared {
    let mut c = Chain::default();
    for (coin, b) in balances {
        c.bal.insert((coin.to_string(), ME.into()), *b);
    }
    Arc::new(Mutex::new(c))
}

fn log_lines(dir: &Path) -> Vec<Value> {
    std::fs::read_to_string(dir.join("live_trades.jsonl")).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

fn v4(c0: &str, c1: &str, hooks: &str) -> sniper::paper::Pool {
    sniper::paper::v4_pool(&V4Key { currency0: c0.into(), currency1: c1.into(), fee: 3000, tick_spacing: 60, hooks: hooks.into() }).unwrap()
}

#[test]
fn v4_weth_pool_buy_and_sell_end_to_end() {
    // WETH (0x0b..) sorts below TOKEN (0x11..), so WETH is currency0: we pay currency0.
    let pool = v4(WETH, TOKEN, NATIVE_ETH);
    assert_eq!(pool.base, "WETH");
    let c = chain_with(&[("eth", e18() / U256::from(100u64)), (WETH, e18())]);
    let base_in = U256::from(2_000_000_000_000_000u64); // $5 at $2,500/ETH = 0.002 WETH
    {
        let mut ch = c.lock().unwrap();
        ch.quotes = vec![U256::from(1_000_000u64), U256::from(2_100_000_000_000_000u64)];
        ch.effects = vec![
            vec![(WETH.into(), -(2_000_000_000_000_000i128)), (TOKEN.into(), 990_000)],
            vec![(TOKEN.into(), -990_000), (WETH.into(), 2_080_000_000_000_000)],
        ];
    }
    let url = fake_node(c.clone());
    let dir = tmp_dir("v4weth");
    let mut lt = trader(&url, &dir, vec![VenueKind::V3, VenueKind::V4]);
    lt.buy("0xpoolid", &pool, 2500.0, U256::from(20_000_000u64), 100.0).unwrap();

    // Three transactions: WETH.approve(Permit2), Permit2.approve(router), router.execute.
    let sent = c.lock().unwrap().sent.clone();
    assert_eq!(sent.len(), 3);
    assert_eq!(sent[0].0, WETH);
    assert_eq!(&sent[0].1[..4], &[0x09, 0x5e, 0xa7, 0xb3]);
    assert_eq!(&sent[0].1[16..36], &sniper::live::addr_bytes(PERMIT2).unwrap());
    assert_eq!(U256::from_be_slice(&sent[0].1[36..68]), base_in, "exact approval, not unlimited");
    assert_eq!(sent[1].0, PERMIT2);
    assert_eq!(U256::from_be_slice(&sent[1].1[68..100]), base_in);
    assert_eq!(sent[2].0, UNIVERSAL_ROUTER);
    assert_eq!(sent[2].2, 0, "no ETH sent for a WETH pool");
    // The router call is exactly the one liveroute builds, min = quote - 3%.
    let deadline = U256::from_be_slice(&sent[2].1[4 + 64..4 + 96]).to::<u64>();
    let key = match &pool.venue {
        sniper::venue::Venue::V4 { key } => key.clone(),
        _ => unreachable!(),
    };
    let input = liveroute::v4_swap_input(&key, true, base_in, U256::from(970_000u64), liveroute::UrLayout::Ur20).unwrap();
    assert_eq!(sent[2].1, liveroute::data_execute(&[liveroute::CMD_V4_SWAP], &[input], deadline));
    // Position recorded with what really arrived.
    let pos = lt.open.clone().unwrap();
    assert_eq!((pos.tokens, pos.base_in, pos.pending), (U256::from(990_000u64), base_in, false));
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("live_open.json")).unwrap()).unwrap();
    assert_eq!(LivePos::from_json(&saved), Some(pos));

    // Sell: token approvals then router; P&L from the WETH that came back.
    let net = lt.sell("take_profit", false, Some(1.5), 2500.0).unwrap();
    let sent = c.lock().unwrap().sent.clone();
    assert_eq!(sent.len(), 6);
    assert_eq!(sent[3].0, TOKEN);
    assert_eq!(U256::from_be_slice(&sent[3].1[36..68]), U256::from(990_000u64));
    let input = liveroute::v4_swap_input(&key, false, U256::from(990_000u64), U256::from(2_037_000_000_000_000u64), liveroute::UrLayout::Ur20).unwrap();
    let deadline = U256::from_be_slice(&sent[5].1[4 + 64..4 + 96]).to::<u64>();
    assert_eq!(sent[5].1, liveroute::data_execute(&[liveroute::CMD_V4_SWAP], &[input], deadline));
    // +0.00008 WETH at $2,500 = +$0.20, minus 6 tx x 0.000001 ETH gas ($0.015).
    assert!((net - (0.2 - 6.0 * 0.000001 * 2500.0)).abs() < 1e-9, "{net}");
    assert!(lt.open.is_none() && !dir.join("live_open.json").exists());
    assert!((lt.ledger.realized_usd - net).abs() < 1e-12);
    let log = log_lines(&dir);
    assert_eq!(log[0]["event"], "buy");
    assert_eq!(log[0]["venue"], "v4");
    assert_eq!(log[0]["txs"].as_array().unwrap().len(), 3);
    assert_eq!(log[0]["paper_tokens_per_usd"], 200_000.0);
    assert_eq!(log[0]["live_tokens_per_usd"], 198_000.0);
    assert_eq!(log[1]["event"], "sell");
    assert_eq!(log[1]["base_out"], "2080000000000000");
    assert_eq!(log[1]["paper_pct"], 1.5);
    assert_eq!(log[1]["paper_net_usd"], 1.5);
}

#[test]
fn v4_native_eth_pool_sends_eth_and_counts_gas_once() {
    let pool = v4(NATIVE_ETH, TOKEN, NATIVE_ETH);
    assert_eq!(pool.base, "ETH");
    let c = chain_with(&[("eth", e18() / U256::from(100u64))]); // 0.01 ETH
    {
        let mut ch = c.lock().unwrap();
        ch.quotes = vec![U256::from(5_000u64), U256::from(2_000_000_000_000_000u64)];
        ch.effects = vec![vec![("eth".into(), 0), (TOKEN.into(), 5_000)], vec![(TOKEN.into(), -5_000), ("eth".into(), 1_900_000_000_000_000)]];
    }
    let url = fake_node(c.clone());
    let dir = tmp_dir("v4eth");
    let mut lt = trader(&url, &dir, vec![VenueKind::V4]);
    lt.buy("0xid", &pool, 2500.0, U256::ZERO, 50.0).unwrap();
    let sent = c.lock().unwrap().sent.clone();
    assert_eq!(sent.len(), 1, "native ETH: no approvals");
    assert_eq!(sent[0].2, 2_000_000_000_000_000, "exactly the amount swapped is sent");
    // Spent = balance drop minus the gas: exactly 0.002 ETH.
    assert_eq!(lt.open.as_ref().unwrap().base_in, U256::from(2_000_000_000_000_000u64));
    let net = lt.sell("hold_timeout", false, None, 2500.0).unwrap();
    // 1.9 - 2.0 = -0.0001 ETH = -$0.25; gas 4 tx x 0.000001 ETH = -$0.01.
    assert!((net - (-0.25 - 0.01)).abs() < 1e-9, "{net}");
    assert_eq!(c.lock().unwrap().sent[3].2, 0, "selling into ETH sends no ETH");
}

#[test]
fn refusals_happen_before_anything_is_sent() {
    let c = chain_with(&[("eth", e18() / U256::from(100u64)), (USDG, U256::from(1_000_000u64))]); // only $1 of USDG
    let url = fake_node(c.clone());
    let dir = tmp_dir("refuse");
    let mut lt = trader(&url, &dir, vec![VenueKind::V3, VenueKind::V4]);
    // Short on the base coin: clear reason, nothing sent, nothing open.
    let e = lt.buy("0xid", &v4(TOKEN, USDG, NATIVE_ETH), 1.0, U256::ZERO, 50.0).unwrap_err();
    assert!(e.contains("wallet has 1.000000 USDG, needs 5.000000 USDG") && e.contains("never swaps"), "{e}");
    // Unsafe hook.
    let e = lt.buy("0xid", &v4(TOKEN, USDG, "0x0000000000000000000000000000000000000008"), 1.0, U256::ZERO, 50.0).unwrap_err();
    assert!(e.contains("hook"), "{e}");
    // V2 switched off (default live venues).
    let v2 = sniper::paper::v2_pool_from("0x2222222222222222222222222222222222222222", USDG, TOKEN, sniper::venue::V2_FACTORY).unwrap();
    assert!(lt.buy("0x22", &v2, 1.0, U256::ZERO, 50.0).unwrap_err().contains("V2 is off"));
    // Native ETH below trade + gas reserve.
    let mut ch = c.lock().unwrap();
    ch.bal.insert(("eth".into(), ME.into()), U256::from(1_000_000_000_000_000u64)); // 0.001 ETH
    drop(ch);
    let e = lt.buy("0xid", &v4(NATIVE_ETH, TOKEN, NATIVE_ETH), 2500.0, U256::ZERO, 50.0).unwrap_err();
    assert!(e.contains("gas reserve"), "{e}");
    assert!(c.lock().unwrap().sent.is_empty());
    assert!(lt.open.is_none() && lt.halted.is_none());
}

#[test]
fn unanswered_swap_leaves_a_pending_position_and_halts() {
    let pool = v4(WETH, TOKEN, NATIVE_ETH);
    let c = chain_with(&[("eth", e18() / U256::from(100u64)), (WETH, e18())]);
    {
        let mut ch = c.lock().unwrap();
        ch.quotes = vec![U256::from(1_000u64)];
        ch.drop_swap = true;
    }
    let url = fake_node(c.clone());
    let dir = tmp_dir("unknown");
    let mut lt = trader(&url, &dir, vec![VenueKind::V4]);
    let e = lt.buy("0xid", &pool, 2500.0, U256::ZERO, 50.0).unwrap_err();
    assert!(e.contains("send refused after 2 of 3"), "{e}");
    assert!(lt.halted.as_deref().unwrap_or("").contains("fate unknown"));
    let pos = lt.open.clone().expect("pending position kept");
    assert!(pos.pending && pos.buy_hashes.len() == 3, "{pos:?}");
    assert!(dir.join("live_open.json").exists(), "on disk too, for a restart");
    // No tokens yet and the deadline has not passed: keep waiting, keep it.
    let e = lt.sell("retry after failed sell", true, None, 2500.0).unwrap_err();
    assert!(e.contains("not settled yet"), "{e}");
    assert!(lt.open.is_some());
    // New buys are blocked.
    assert!(lt.refuse(&pool).unwrap().contains("halted"));
    // The tokens show up late: the next retry sells them.
    {
        let mut ch = c.lock().unwrap();
        ch.drop_swap = false;
        ch.bal.insert((TOKEN.into(), ME.into()), U256::from(1_000u64));
        ch.quotes = vec![U256::from(2_000_000_000_000_000u64)];
        ch.effects = vec![vec![(TOKEN.into(), -1_000), (WETH.into(), 1_000_000_000_000_000)]];
    }
    lt.sell("retry after failed sell", true, None, 2500.0).unwrap();
    assert!(lt.open.is_none());
}

#[test]
fn dryrun_report_shape_for_a_v4_pool() {
    let c = chain_with(&[("eth", e18()), (WETH, e18())]);
    {
        c.lock().unwrap().quotes = vec![U256::from(1_000_000u64)];
    }
    let url = fake_node(c.clone());
    let dir = tmp_dir("dryrun");
    // The paper trader's key file, with this pool's key.
    let key = V4Key { currency0: WETH.into(), currency1: TOKEN.into(), fee: 3000, tick_spacing: 60, hooks: NATIVE_ETH.into() };
    let mut ks = sniper::venue::V4Keys::default();
    ks.insert(key.clone());
    let kp = dir.join("v4_pool_keys.json");
    ks.save_if_dirty(&kp).unwrap();
    let kps = kp.to_string_lossy().to_string();
    let get = |k: &str| match k {
        "SNIPER_LIVE_ADDRESS" => Some(ME.to_string()),
        "SNIPER_V4_KEYS" => Some(kps.clone()),
        _ => None,
    };
    let v = sniper::livedry::live_dryrun(&url, &key.id(), 5.0, &get).unwrap();
    assert_eq!(v["ok"], true, "{v}");
    assert_eq!(v["venue"], "v4");
    assert_eq!(v["base"], "WETH");
    assert_eq!(v["wallet"], ME);
    assert_eq!(v["router"], UNIVERSAL_ROUTER);
    assert_eq!(v["router_shape"], "2.0");
    assert_eq!(v["live_allowed"], true);
    assert_eq!(v["funded_in_sim"], false, "wallet already holds 1 WETH");
    assert_eq!(v["buy"]["txs"].as_array().unwrap().len(), 3);
    assert_eq!(v["sell"]["txs"].as_array().unwrap().len(), 3);
    assert_eq!(v["buy"]["sim_tokens"], "1000000");
    assert_eq!(v["sell"]["sim_base_back"], "1600000000000000");
    assert_eq!(v["gas_used_total"], 6 * 100_000);
    for k in ["block", "usd_in", "base_in", "usd_back", "round_trip_usd_before_gas", "gas_warnings"] {
        assert!(!v[k].is_null(), "missing {k}: {v}");
    }
    // Read-only: nothing was sent, every call was a simulation from the live wallet.
    let ch = c.lock().unwrap();
    assert!(ch.sent.is_empty());
    assert!(ch.sims.iter().all(|s| s[0]["blockStateCalls"][0]["calls"].as_array().unwrap().iter().all(|c| c["from"] == ME)));
}
