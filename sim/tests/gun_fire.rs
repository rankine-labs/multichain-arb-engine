// ============================================================================
// GUN FIRE: the whole sender path, practice and live, against a fake node.
//
// Plain English:
//   A tiny local HTTP server plays the send endpoint (and a fake read node
//   gives gas / nonce answers), so the gun's real code runs end to end with
//   no network and no real money:
//     - practice: signs with a throwaway key, never sends, nonce never synced
//     - live: the bytes reach the endpoint, decode to OUR wallet, nonce,
//       gas fields and calldata; "handed to socket" comes before the reply;
//       the reply hook gets the hash
//     - "nonce too low" from the endpoint -> pause, re-sync, move past it
//     - stale block info / safety gate / zero profit floor -> refused, nothing sent
//   Plus the speed test (labelled TEST numbers, this machine): calldata +
//   sign per fire, target < 1 ms.
// ============================================================================
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use arbsim::check::hexutil::parse_bytes;
use arbsim::fastlane::gun::calldata::{ExecutorHop, Funding, KIND_V2, KIND_V3, KIND_V4};
use arbsim::fastlane::gun::gas::GasConfig;
use arbsim::fastlane::gun::rpc::ReadRpc;
use arbsim::fastlane::gun::send::{SendOutcome, SendPool};
use arbsim::fastlane::gun::tx::Signer;
use arbsim::fastlane::gun::{CallInput, Gate, Gun, GunConfig, Mode, NoGate};
use revm::primitives::{Address, U256};
use serde_json::{json, Value};

/// Fake read node: a block with base fee 0.01 gwei, nonce 42.
struct FakeRead {
    nonce: AtomicU64,
    block: AtomicU64,
}
impl ReadRpc for FakeRead {
    fn call(&self, method: &str, _p: Value) -> Result<Value, String> {
        match method {
            "eth_getBlockByNumber" => Ok(json!({"number": format!("{:#x}", self.block.load(Ordering::Relaxed)), "baseFeePerGas": "0x989680"})),
            "eth_getTransactionCount" => Ok(json!(format!("{:#x}", self.nonce.load(Ordering::Relaxed)))),
            "eth_call" => Ok(json!(format!("0x{:064x}{:064x}{:064x}", 20_000u64, 0, 0))),
            _ => Err("unsupported".into()),
        }
    }
}

/// Fake send endpoint. `answer` decides the reply for each raw tx.
fn fake_endpoint(answer: Arc<dyn Fn(&[u8]) -> Value + Send + Sync>, got: mpsc::Sender<Vec<u8>>, delay: Duration) -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for s in l.incoming() {
            let Ok(s) = s else { continue };
            let (answer, got) = (answer.clone(), got.clone());
            std::thread::spawn(move || {
                let mut rd = BufReader::new(s.try_clone().unwrap());
                let mut w = s;
                loop {
                    let mut line = String::new();
                    if rd.read_line(&mut line).unwrap_or(0) == 0 {
                        return;
                    }
                    let mut len = 0usize;
                    loop {
                        let mut h = String::new();
                        rd.read_line(&mut h).unwrap();
                        if h.trim().is_empty() {
                            break;
                        }
                        if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                            len = v.trim().parse().unwrap();
                        }
                    }
                    let mut body = vec![0u8; len];
                    rd.read_exact(&mut body).unwrap();
                    let req: Value = serde_json::from_slice(&body).unwrap();
                    let reply = match req["method"].as_str().unwrap() {
                        "eth_chainId" => json!({"jsonrpc": "2.0", "id": 1, "result": "0x1237"}),
                        "eth_sendRawTransaction" => {
                            let raw = parse_bytes(req["params"][0].as_str().unwrap()).unwrap().to_vec();
                            std::thread::sleep(delay);
                            let a = answer(&raw);
                            let _ = got.send(raw);
                            a
                        }
                        _ => json!({"jsonrpc": "2.0", "id": 1, "error": {"code": -32601, "message": "nope"}}),
                    };
                    let b = reply.to_string();
                    // Chunked on purpose (real nodes do this too).
                    let msg = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n", b.len(), b);
                    if w.write_all(msg.as_bytes()).is_err() {
                        return;
                    }
                }
            });
        }
    });
    format!("http://127.0.0.1:{port}")
}

fn addr(n: u8) -> Address {
    Address::repeat_byte(n)
}

fn input(hops: usize, funding: Funding) -> CallInput {
    let kinds = [KIND_V2, KIND_V3, KIND_V4];
    CallInput {
        block: 1000,
        route_label: "WETH>USDC>WETH".into(),
        token_in: addr(0xaa),
        amount_in: U256::from(10u64).pow(U256::from(18u64)),
        hops: (0..hops)
            .map(|i| ExecutorHop {
                kind: kinds[i % 3],
                pool: addr(0x10 + i as u8),
                token_in: addr(0xa0 + i as u8),
                token_out: addr(0xa1 + i as u8),
                fee_bps: if i % 3 == 0 { 30 } else { 0 },
                v4_fee: if i % 3 == 2 { 3000 } else { 0 },
                v4_tick_spacing: if i % 3 == 2 { 60 } else { 0 },
                v4_native: false,
                v4_pool_manager: None,
            })
            .collect(),
        funding,
        net_usd: 0.42,
        usd_per_token_in: 3400.0,
        token_in_decimals: 18,
        size_usd: 3400.0,
        gas_usd: 0.03,
        found_at: Instant::now(),
    }
}

fn gas_cfg() -> GasConfig {
    GasConfig { fire_gas_limit: 1_500_000, l1_bytes: 800, margin_blocks: None, margin_ms: 3000.0, refresh: Duration::from_secs(2) }
}

#[test]
fn practice_signs_but_never_sends() {
    let read = Arc::new(FakeRead { nonce: AtomicU64::new(42), block: AtomicU64::new(500) });
    let cfg = GunConfig { mode: Mode::Practice, broadcast: false, executor: None, hand_timeout: Duration::from_secs(1) };
    let gun = Gun::with_parts(cfg, Signer::random().unwrap(), Some(read.clone()), None, Arc::new(NoGate), Arc::new(|_: &SendOutcome| {}), gas_cfg());
    gun.gas().refresh(read.as_ref()).unwrap();
    let r = gun.fire(&input(2, Funding::Own));
    assert!(r.signed && !r.sent, "{r:?}");
    assert_eq!(r.mode, "practice");
    assert_eq!(r.nonce, Some(0)); // practice never reads the wallet's nonce
    assert!(r.hash.is_some() && r.handed_us.is_none());
    assert_eq!(r.max_fee_per_gas, Some(20_000_001));
    assert_eq!(r.gas_limit, Some(1_500_000 + 30_000));
    // Practice: deadline is filled when known (Node uses 0 when not live; we
    // use the estimate when we have one, else 0).
    assert!(r.max_block.unwrap() > U256::from(500u64));
}

#[test]
fn live_send_reaches_endpoint_with_our_fields() {
    let (gtx, grx) = mpsc::channel();
    let url = fake_endpoint(Arc::new(|raw: &[u8]| json!({"jsonrpc": "2.0", "id": 1, "result": format!("{:#x}", revm::primitives::keccak256(raw))})), gtx, Duration::from_millis(30));
    let read = Arc::new(FakeRead { nonce: AtomicU64::new(42), block: AtomicU64::new(500) });
    let pool = SendPool::start(&url, 2, Duration::from_secs(2), Duration::from_secs(1)).unwrap();
    let replies = Arc::new(Mutex::new(Vec::<SendOutcome>::new()));
    let r2 = replies.clone();
    let exec = addr(0xee);
    let cfg = GunConfig { mode: Mode::Live, broadcast: true, executor: Some(exec), hand_timeout: Duration::from_secs(2) };
    let signer = Signer::random().unwrap();
    let me = signer.address();
    let gun = Gun::with_parts(cfg, signer, Some(read.clone()), Some(pool), Arc::new(NoGate), Arc::new(move |o: &SendOutcome| r2.lock().unwrap().push(o.clone())), gas_cfg());
    // Not ready before gas + nonce are known.
    let r = gun.fire(&input(2, Funding::Own));
    assert!(!r.sent && r.why.is_some(), "{r:?}");
    gun.gas().refresh(read.as_ref()).unwrap();
    assert_eq!(gun.not_ready(), Some("nonce not loaded yet"));
    gun.nonce().resync(Some(42)).unwrap();

    let a = gun.fire(&input(2, Funding::V3Flash(addr(0x77))));
    let b = gun.fire(&input(5, Funding::Own));
    assert!(a.sent && b.sent, "{a:?} {b:?}");
    assert_eq!((a.nonce, b.nonce), (Some(42), Some(43)));
    // The caller got "handed" long before the 30 ms reply.
    assert!(a.handed_us.unwrap() < 30_000, "handed after {} us", a.handed_us.unwrap());
    let mut seen = vec![grx.recv_timeout(Duration::from_secs(3)).unwrap(), grx.recv_timeout(Duration::from_secs(3)).unwrap()];
    seen.sort_by_key(|raw| arbsim::feed::tx::decode(raw).unwrap().nonce);
    for (raw, rec) in seen.iter().zip([&a, &b]) {
        let d = arbsim::feed::tx::decode(raw).unwrap();
        assert_eq!(d.from, me);
        assert_eq!(d.to, Some(exec));
        assert_eq!(d.chain_id, Some(4663));
        assert_eq!(d.priority_fee, Some(0));
        assert_eq!(d.gas_price, 20_000_001);
        assert_eq!(Some(d.nonce), rec.nonce);
        assert_eq!(format!("{:#x}", d.hash), rec.hash.clone().unwrap());
        assert_eq!(d.data.len(), rec.calldata_len);
    }
    // Replies reach the hook with the node's hash; nonces accepted.
    let t = Instant::now();
    while replies.lock().unwrap().len() < 2 && t.elapsed() < Duration::from_secs(3) {
        std::thread::sleep(Duration::from_millis(5));
    }
    let reps = replies.lock().unwrap().clone();
    assert_eq!(reps.len(), 2);
    for o in &reps {
        assert_eq!(o.result.as_ref().unwrap(), &o.hash);
        assert!(o.reply_us >= o.wait_us && o.wait_us >= 25_000, "{o:?}");
    }
    assert_eq!(gun.nonce().take().unwrap(), 44);
}

#[test]
fn nonce_too_low_resyncs_past_it() {
    let (gtx, grx) = mpsc::channel();
    let first = Arc::new(AtomicU64::new(0));
    let f2 = first.clone();
    let url = fake_endpoint(
        Arc::new(move |raw: &[u8]| {
            if f2.fetch_add(1, Ordering::Relaxed) == 0 {
                json!({"jsonrpc": "2.0", "id": 1, "error": {"code": -32000, "message": "nonce too low: next nonce 8, tx nonce 7"}})
            } else {
                json!({"jsonrpc": "2.0", "id": 1, "result": format!("{:#x}", revm::primitives::keccak256(raw))})
            }
        }),
        gtx,
        Duration::ZERO,
    );
    // The read node lags: still says 7.
    let read = Arc::new(FakeRead { nonce: AtomicU64::new(7), block: AtomicU64::new(500) });
    let pool = SendPool::start(&url, 1, Duration::from_secs(2), Duration::from_secs(1)).unwrap();
    let cfg = GunConfig { mode: Mode::Live, broadcast: true, executor: Some(addr(0xee)), hand_timeout: Duration::from_secs(2) };
    let gun = Gun::with_parts(cfg, Signer::random().unwrap(), Some(read.clone()), Some(pool), Arc::new(NoGate), Arc::new(|_: &SendOutcome| {}), gas_cfg());
    gun.gas().refresh(read.as_ref()).unwrap();
    gun.nonce().resync(Some(7)).unwrap();
    let a = gun.fire(&input(2, Funding::Own));
    assert!(a.sent && a.nonce == Some(7));
    grx.recv_timeout(Duration::from_secs(2)).unwrap();
    // The reply hook re-syncs on the sender thread; wait for it.
    let t = Instant::now();
    while gun.nonce().resyncs() < 2 && t.elapsed() < Duration::from_secs(3) {
        std::thread::sleep(Duration::from_millis(5));
    }
    let b = gun.fire(&input(2, Funding::Own));
    assert!(b.sent, "{b:?}");
    assert_eq!(b.nonce, Some(8), "moved past the used nonce even though the read node lags");
}

#[test]
fn refusals_send_nothing() {
    struct No;
    impl Gate for No {
        fn allow(&self, _c: &CallInput) -> Result<(), String> {
            Err("kill switch on".into())
        }
    }
    let (gtx, grx) = mpsc::channel();
    let url = fake_endpoint(Arc::new(|_: &[u8]| json!({"jsonrpc": "2.0", "id": 1, "result": "0x00"})), gtx, Duration::ZERO);
    let read = Arc::new(FakeRead { nonce: AtomicU64::new(1), block: AtomicU64::new(500) });
    let mk = |gate: Arc<dyn Gate>, exec: Option<Address>| {
        let pool = SendPool::start(&url, 1, Duration::from_secs(2), Duration::from_secs(1)).unwrap();
        let cfg = GunConfig { mode: Mode::Live, broadcast: true, executor: exec, hand_timeout: Duration::from_secs(2) };
        Gun::with_parts(cfg, Signer::random().unwrap(), Some(read.clone()), Some(pool), gate, Arc::new(|_: &SendOutcome| {}), gas_cfg())
    };
    // No block info yet -> stale.
    let g = mk(Arc::new(NoGate), Some(addr(1)));
    g.nonce().load(1);
    assert_eq!(g.fire(&input(2, Funding::Own)).why.as_deref(), Some("block info stale"));
    g.gas().refresh(read.as_ref()).unwrap();
    // Profit floor rounds to zero.
    let mut c = input(2, Funding::Own);
    c.net_usd = 1e-20;
    assert_eq!(g.fire(&c).why.as_deref(), Some("profit floor rounds to zero"));
    // Lender is a trade pool.
    let c = input(2, Funding::V3Flash(addr(0x10)));
    assert_eq!(g.fire(&c).why.as_deref(), Some("lender pool is also a trade pool"));
    // No executor in live.
    let g2 = mk(Arc::new(NoGate), None);
    g2.gas().refresh(read.as_ref()).unwrap();
    g2.nonce().load(1);
    assert_eq!(g2.fire(&input(2, Funding::Own)).why.as_deref(), Some("no trade contract set"));
    // Safety gate says no: nothing signed, nonce not used.
    let g3 = mk(Arc::new(No), Some(addr(1)));
    g3.gas().refresh(read.as_ref()).unwrap();
    g3.nonce().load(1);
    let r = g3.fire(&input(2, Funding::Own));
    assert_eq!(r.why.as_deref(), Some("safety gate: kill switch on"));
    assert!(!r.signed);
    assert_eq!(g3.nonce().take().unwrap(), 1);
    assert!(grx.recv_timeout(Duration::from_millis(200)).is_err(), "nothing may reach the endpoint");
}

/// TEST NUMBERS (this build machine, not the server): calldata + sign per fire.
#[test]
fn bench_calldata_and_sign() {
    let read = Arc::new(FakeRead { nonce: AtomicU64::new(0), block: AtomicU64::new(500) });
    let cfg = GunConfig { mode: Mode::Practice, broadcast: false, executor: Some(addr(0xee)), hand_timeout: Duration::from_secs(1) };
    let gun = Gun::with_parts(cfg, Signer::random().unwrap(), Some(read.clone()), None, Arc::new(NoGate), Arc::new(|_: &SendOutcome| {}), gas_cfg());
    gun.gas().refresh(read.as_ref()).unwrap();
    // Silence the per-fire "would send" lines is not possible (stderr); keep N modest.
    for hops in [2usize, 5] {
        let c = input(hops, Funding::V3Flash(addr(0x77)));
        let mut cd = Vec::new();
        let mut sg = Vec::new();
        let mut tot = Vec::new();
        for _ in 0..300 {
            let t = Instant::now();
            let r = gun.fire(&c);
            tot.push(t.elapsed().as_micros() as u64);
            cd.push(r.calldata_us);
            sg.push(r.sign_us);
        }
        for v in [&mut cd, &mut sg, &mut tot] {
            v.sort();
        }
        let p = |v: &Vec<u64>, q: f64| v[((v.len() - 1) as f64 * q) as usize];
        eprintln!(
            "TEST NUMBERS ({hops} hops, {} bytes calldata): calldata median {} us p99 {} us | sign median {} us p99 {} us | whole fire() median {} us p99 {} us",
            4 + 32 * (8 + 8 * hops),
            p(&cd, 0.5),
            p(&cd, 0.99),
            p(&sg, 0.5),
            p(&sg, 0.99),
            p(&tot, 0.5),
            p(&tot, 0.99)
        );
        assert!(p(&cd, 0.5) + p(&sg, 0.5) < 1000, "calldata + sign must be < 1 ms");
    }
}

/// Our own TLS client (rustls, kept-alive) against a local rustls server
/// with a throwaway certificate made by the `openssl` command (skipped if
/// openssl is missing). Proves: handshake + certificate check by host name,
/// request/reply over TLS, connection reuse, and that a WRONG certificate
/// is refused.
#[test]
fn tls_send_path_with_local_server() {
    use std::process::Command;
    let dir = std::env::temp_dir().join(format!("gun-tls-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let key = dir.join("key.pem");
    let cert = dir.join("cert.der");
    let ok = Command::new("openssl")
        .args(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2", "-subj", "/CN=localhost",
               "-addext", "subjectAltName=DNS:localhost", "-addext", "basicConstraints=critical,CA:FALSE", "-outform", "DER"])
        .arg("-keyout").arg(&key).arg("-out").arg(&cert)
        .output();
    if !matches!(&ok, Ok(o) if o.status.success()) {
        eprintln!("openssl not available: skipping local TLS test");
        return;
    }
    let pk8 = Command::new("openssl").args(["pkcs8", "-topk8", "-nocrypt", "-outform", "DER", "-in"]).arg(&key).output().unwrap();
    assert!(pk8.status.success());
    let cert_der = std::fs::read(&cert).unwrap();
    let _ = std::fs::remove_dir_all(&dir);

    let scfg = Arc::new(
        rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![rustls::pki_types::CertificateDer::from(cert_der.clone())],
                rustls::pki_types::PrivateKeyDer::Pkcs8(pk8.stdout.into()),
            )
            .unwrap(),
    );
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for s in l.incoming() {
            let Ok(s) = s else { continue };
            let scfg = scfg.clone();
            std::thread::spawn(move || {
                let conn = rustls::ServerConnection::new(scfg).unwrap();
                let mut tls = BufReader::new(rustls::StreamOwned::new(conn, s));
                loop {
                    let mut line = String::new();
                    if tls.read_line(&mut line).unwrap_or(0) == 0 {
                        return;
                    }
                    let mut len = 0usize;
                    loop {
                        let mut h = String::new();
                        if tls.read_line(&mut h).unwrap_or(0) == 0 {
                            return;
                        }
                        if h.trim().is_empty() {
                            break;
                        }
                        if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                            len = v.trim().parse().unwrap();
                        }
                    }
                    let mut body = vec![0u8; len];
                    tls.read_exact(&mut body).unwrap();
                    let b = json!({"jsonrpc": "2.0", "id": 1, "result": "0x1237"}).to_string();
                    let msg = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}", b.len(), b);
                    let w = tls.get_mut();
                    if w.write_all(msg.as_bytes()).and_then(|_| w.flush()).is_err() {
                        return;
                    }
                }
            });
        }
    });
    let url = format!("https://localhost:{port}");
    let mut c = arbsim::fastlane::gun::send::Conn::with_extra_root(&url, Duration::from_secs(3), cert_der).unwrap();
    assert_eq!(c.call("eth_chainId", json!([])).unwrap(), json!("0x1237"));
    assert_eq!(c.call("eth_chainId", json!([])).unwrap(), json!("0x1237"));
    assert_eq!(c.opened, 1, "kept-alive: one connection for both calls");
    // Without trusting that certificate, the connection is refused.
    let mut bad = arbsim::fastlane::gun::send::Conn::new(&url, Duration::from_secs(3)).unwrap();
    let e = bad.call("eth_chainId", json!([])).unwrap_err();
    assert!(e.contains("TLS"), "{e}");
}

/// Real TLS to the public sequencer, read-only eth_chainId (no transaction).
/// Ignored by default (needs internet): cargo test --release --test gun_fire -- --ignored
#[test]
#[ignore]
fn tls_chain_id_on_real_sequencer() {
    let mut c = arbsim::fastlane::gun::send::Conn::new(arbsim::fastlane::gun::send::ROBINHOOD_SEQUENCER_RPC, Duration::from_secs(5)).unwrap();
    let t = Instant::now();
    let v = c.call("eth_chainId", json!([])).unwrap();
    let first = t.elapsed();
    let t = Instant::now();
    let v2 = c.call("eth_chainId", json!([])).unwrap();
    eprintln!("TEST NUMBERS (this machine): first call incl. TLS handshake {:?}, kept-alive call {:?}, fresh connections {}", first, t.elapsed(), c.opened);
    assert_eq!(v, json!("0x1237"));
    assert_eq!(v2, json!("0x1237"));
    assert_eq!(c.opened, 1, "second call must reuse the connection");
}
