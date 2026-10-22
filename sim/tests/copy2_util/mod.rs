// ============================================================================
// Helpers for the copy-2 replay test on a practice chain (anvil).
//
// Plain English:
//   - Anvil: starts a private practice chain (Foundry's anvil, at
//     ~/.foundry/bin/anvil) and talks to it over JSON-RPC.
//   - ABI helpers: build contract calls by hand (no extra libraries).
//   - RemoteView: "the truth" - reads the practice chain's state at one block
//     (cached), shaped like our own copy (StateRead), so the SAME check engine
//     can run on the truth and on our copy.
//   - CopyView: our copy (the Overlay) for the pool accounts we follow, the
//     truth for everything else (coins, reference pools): exactly the split
//     the live sidecar has (coins are workstream A's job, not the replay's).
//   - Rng: small seeded random numbers (same generator as the offline bench).
// Nothing here talks to a real chain; the practice chain lives only for the
// duration of the test.
// ============================================================================
#![allow(dead_code)]
use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use arbsim::check::hexutil::{parse_address, parse_bytes, parse_u256};
use arbsim::copy2::overlay::Overlay;
use arbsim::state::snap::Fact;
use arbsim::state::{Lookup, MissItem, StatePosition, StateRead};
use revm::primitives::{keccak256, Address, Bytes, B256, KECCAK_EMPTY, U256};
use revm::state::{AccountInfo, Bytecode};
use serde_json::{json, Value};

pub fn hx(v: U256) -> String {
    format!("{v:#x}")
}
pub fn hx64(v: U256) -> String {
    format!("0x{}", hexs(&v.to_be_bytes::<32>()))
}
pub fn hexs(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
pub fn hb(b: &[u8]) -> String {
    format!("0x{}", hexs(b))
}
pub fn ha(a: Address) -> String {
    format!("{a:#x}")
}
pub fn u(v: &Value) -> U256 {
    parse_u256(v.as_str().unwrap_or("0x0")).unwrap()
}
pub fn u64v(v: &Value) -> u64 {
    u(v).to::<u64>()
}

// ---------------------------------------------------------------------------
// Practice chain.
// ---------------------------------------------------------------------------
pub struct Anvil {
    child: Mutex<Child>,
    pub url: String,
    agent: ureq::Agent,
    id: AtomicU64,
    pub me: Address,
}

pub fn anvil_path() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let p = format!("{home}/.foundry/bin/anvil");
    std::path::Path::new(&p).exists().then_some(p)
}

impl Anvil {
    /// Start a fresh chain (chain id 4663 like Robinhood). None = no anvil here.
    pub fn start() -> Option<Anvil> {
        let bin = anvil_path()?;
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
            l.local_addr().ok()?.port()
        };
        let child = Command::new(bin)
            .args(["--port", &port.to_string(), "--chain-id", "4663", "--hardfork", "cancun", "--gas-limit", "1000000000"])
            .args(["--code-size-limit", "100000", "--silent", "--no-request-size-limit"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        // Local chain: never go through a proxy.
        let cfg = ureq::Agent::config_builder().proxy(None).timeout_global(Some(Duration::from_secs(60))).http_status_as_error(false).build();
        let mut a = Anvil { child: Mutex::new(child), url: format!("http://127.0.0.1:{port}"), agent: ureq::Agent::new_with_config(cfg), id: AtomicU64::new(1), me: Address::ZERO };
        for _ in 0..200 {
            if a.rpc("eth_blockNumber", json!([])).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let accts = a.rpc("eth_accounts", json!([])).ok()?;
        a.me = parse_address(accts[0].as_str()?).ok()?;
        Some(a)
    }

    fn post(&self, body: &Value) -> Result<Value, String> {
        let resp = self.agent.post(&self.url).header("content-type", "application/json").send(body.to_string()).map_err(|e| format!("{e}"))?;
        let text = resp.into_body().with_config().limit(256 * 1024 * 1024).read_to_string().map_err(|e| format!("{e}"))?;
        serde_json::from_str(&text).map_err(|e| format!("{e}"))
    }

    pub fn rpc(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.id.fetch_add(1, Ordering::Relaxed);
        let v = self.post(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        if let Some(e) = v.get("error") {
            return Err(format!("{method}: {e}"));
        }
        Ok(v["result"].clone())
    }

    pub fn ok(&self, method: &str, params: Value) -> Value {
        self.rpc(method, params).unwrap_or_else(|e| panic!("{e}"))
    }

    /// Several calls in one request; answers in the same order.
    pub fn batch(&self, reqs: &[(&str, Value)]) -> Vec<Result<Value, String>> {
        if reqs.is_empty() {
            return Vec::new();
        }
        let base = self.id.fetch_add(reqs.len() as u64, Ordering::Relaxed);
        let body: Vec<Value> = reqs.iter().enumerate().map(|(i, (m, p))| json!({"jsonrpc":"2.0","id":base + i as u64,"method":m,"params":p})).collect();
        // Read-only batches (the copy's node questions): a dropped local
        // connection (anvil busy, e.g. the latency bench's CPU load) is
        // asked again.
        let mut v = self.post(&Value::Array(body.clone()));
        for _ in 0..5 {
            if v.is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
            v = self.post(&Value::Array(body.clone()));
        }
        let v = v.expect("batch");
        let mut out: Vec<Option<Result<Value, String>>> = vec![None; reqs.len()];
        for r in v.as_array().expect("batch answer") {
            let i = (r["id"].as_u64().unwrap() - base) as usize;
            out[i] = Some(match r.get("error") {
                Some(e) => Err(format!("{e}")),
                None => Ok(r["result"].clone()),
            });
        }
        out.into_iter().map(|x| x.expect("answer")).collect()
    }

    pub fn block_number(&self) -> u64 {
        u64v(&self.ok("eth_blockNumber", json!([])))
    }

    /// Send a transaction from the unlocked test account; returns its hash.
    pub fn send(&self, to: Option<Address>, data: &[u8]) -> Result<B256, String> {
        self.send_from(self.me, to, data)
    }

    /// Send from any address (anvil pretends to be it; it is given gas money).
    pub fn send_from(&self, from: Address, to: Option<Address>, data: &[u8]) -> Result<B256, String> {
        if from != self.me {
            self.rpc("anvil_impersonateAccount", json!([ha(from)]))?;
            self.rpc("anvil_setBalance", json!([ha(from), "0x3635c9adc5dea00000"]))?;
        }
        let mut tx = json!({"from": ha(from), "data": hb(data), "gas": "0x1c9c380"});
        if let Some(t) = to {
            tx["to"] = json!(ha(t));
        }
        let h = self.rpc("eth_sendTransaction", json!([tx]))?;
        Ok(B256::from_slice(&parse_bytes(h.as_str().unwrap()).unwrap()))
    }

    pub fn receipt(&self, h: B256) -> Value {
        for _ in 0..200 {
            let r = self.ok("eth_getTransactionReceipt", json!([hb(h.as_slice())]));
            if !r.is_null() {
                return r;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("no receipt for {h}");
    }

    /// Send with automine on and require success.
    pub fn send_ok(&self, to: Address, data: &[u8]) -> Value {
        let r = self.receipt(self.send(Some(to), data).unwrap());
        assert_eq!(r["status"], "0x1", "tx to {to} failed: {}", hb(&data[..4.min(data.len())]));
        r
    }

    /// Deploy init code (+ encoded constructor args); returns the address.
    pub fn deploy(&self, init_hex: &str, args: &[u8]) -> Address {
        let mut code = parse_bytes(init_hex).unwrap().to_vec();
        code.extend_from_slice(args);
        let r = self.receipt(self.send(None, &code).unwrap());
        assert_eq!(r["status"], "0x1", "deploy failed");
        parse_address(r["contractAddress"].as_str().unwrap()).unwrap()
    }

    pub fn call(&self, to: Address, data: &[u8]) -> Result<Bytes, String> {
        let r = self.rpc("eth_call", json!([{"to": ha(to), "data": hb(data)}, "latest"]))?;
        parse_bytes(r.as_str().unwrap())
    }

    pub fn nonce(&self, a: Address) -> u64 {
        u64v(&self.ok("eth_getTransactionCount", json!([ha(a), "latest"])))
    }
}

impl Drop for Anvil {
    fn drop(&mut self) {
        if let Ok(mut c) = self.child.lock() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// Address of a contract created by `from` with `nonce` (CREATE rule).
pub fn create_address(from: Address, nonce: u64) -> Address {
    let mut rlp = Vec::new();
    let nb: Vec<u8> = if nonce == 0 {
        vec![0x80]
    } else if nonce < 0x80 {
        vec![nonce as u8]
    } else {
        let b = nonce.to_be_bytes();
        let s = b.iter().position(|x| *x != 0).unwrap();
        let mut v = vec![0x80 + (8 - s) as u8];
        v.extend_from_slice(&b[s..]);
        v
    };
    let len = 21 + nb.len();
    rlp.push(0xc0 + len as u8);
    rlp.push(0x94);
    rlp.extend_from_slice(from.as_slice());
    rlp.extend_from_slice(&nb);
    Address::from_slice(&keccak256(rlp)[12..])
}

// ---------------------------------------------------------------------------
// ABI encoding (just what the test needs).
// ---------------------------------------------------------------------------
#[derive(Clone, Debug)]
pub enum Arg {
    W(U256),
    A(Address),
    I(i128),
    B(bool),
    /// Dynamic bytes / string.
    D(Vec<u8>),
}

pub fn int_word(v: i128) -> U256 {
    if v < 0 {
        (!U256::from(v.unsigned_abs())).wrapping_add(U256::from(1u8))
    } else {
        U256::from(v as u128)
    }
}

pub fn encode(args: &[Arg]) -> Vec<u8> {
    let mut head = Vec::new();
    let mut tail = Vec::new();
    let head_len = 32 * args.len();
    for a in args {
        let w = match a {
            Arg::W(w) => *w,
            Arg::A(x) => U256::from_be_slice(x.as_slice()),
            Arg::I(i) => int_word(*i),
            Arg::B(b) => U256::from(*b as u8),
            Arg::D(d) => {
                let off = head_len + tail.len();
                tail.extend_from_slice(&U256::from(d.len()).to_be_bytes::<32>());
                tail.extend_from_slice(d);
                while tail.len() % 32 != 0 {
                    tail.push(0);
                }
                U256::from(off)
            }
        };
        head.extend_from_slice(&w.to_be_bytes::<32>());
    }
    head.extend(tail);
    head
}

pub fn sel(sig: &str) -> [u8; 4] {
    let h = keccak256(sig.as_bytes());
    [h[0], h[1], h[2], h[3]]
}

pub fn calldata(sig: &str, args: &[Arg]) -> Vec<u8> {
    let mut v = sel(sig).to_vec();
    v.extend(encode(args));
    v
}

pub fn word(b: &[u8], i: usize) -> U256 {
    U256::from_be_slice(&b[32 * i..32 * i + 32])
}

/// Storage slot of mapping[key] at `base`.
pub fn map_slot(key: U256, base: U256) -> U256 {
    let mut b = [0u8; 64];
    b[..32].copy_from_slice(&key.to_be_bytes::<32>());
    b[32..].copy_from_slice(&base.to_be_bytes::<32>());
    U256::from_be_bytes(keccak256(b).0)
}

/// Price of 1 W in U (whole coins) -> sqrtPriceX96 for the pool's coin order.
pub fn sqrt_price_for(price_u_per_w: f64, u: Address, w: Address) -> U256 {
    let w_is0 = w < u;
    let mut p = price_u_per_w * 1e-12; // U units (6 dec) per W unit (18 dec)
    if !w_is0 {
        p = 1.0 / p;
    }
    U256::from((p.sqrt() * 2f64.powi(48)).floor() as u128) << 48
}

// ---------------------------------------------------------------------------
// Seeded random numbers (mulberry32, as in the bench).
// ---------------------------------------------------------------------------
pub struct Rng(u32);
impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng(seed)
    }
    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
    pub fn int(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.next() * ((hi - lo + 1) as f64)).floor() as i64
    }
    /// Log-uniform between lo and hi: many small values, some huge ones.
    pub fn log_big(&mut self, lo: f64, hi: f64) -> U256 {
        let (a, b) = (lo.ln(), hi.ln());
        U256::from((a + (b - a) * self.next()).exp().floor() as u128)
    }
}

// ---------------------------------------------------------------------------
// The truth, read from the practice chain at one block.
// ---------------------------------------------------------------------------
#[derive(Default)]
struct Cache {
    accts: HashMap<Address, Option<AccountInfo>>,
    codes: HashMap<B256, Bytecode>,
    slots: HashMap<(Address, U256), U256>,
}

pub struct RemoteView<'a> {
    pub a: &'a Anvil,
    pub block: u64,
    cache: Mutex<Cache>,
}

impl<'a> RemoteView<'a> {
    pub fn new(a: &'a Anvil, block: u64) -> Self {
        RemoteView { a, block, cache: Mutex::new(Cache::default()) }
    }
    fn tag(&self) -> String {
        format!("{:#x}", self.block)
    }
    pub fn fetch_account(&self, addr: Address) -> Option<AccountInfo> {
        if let Some(v) = self.cache.lock().unwrap().accts.get(&addr) {
            return v.clone();
        }
        let t = self.tag();
        let r = self.a.batch(&[
            ("eth_getBalance", json!([ha(addr), t])),
            ("eth_getTransactionCount", json!([ha(addr), t])),
            ("eth_getCode", json!([ha(addr), t])),
        ]);
        let bal = u(r[0].as_ref().unwrap());
        let nonce = u64v(r[1].as_ref().unwrap());
        let code = parse_bytes(r[2].as_ref().unwrap().as_str().unwrap()).unwrap();
        let info = if bal.is_zero() && nonce == 0 && code.is_empty() {
            None
        } else {
            let h = if code.is_empty() { KECCAK_EMPTY } else { keccak256(&code) };
            let bc = Bytecode::new_raw(code);
            self.cache.lock().unwrap().codes.insert(h, bc.clone());
            Some(AccountInfo { balance: bal, nonce, code_hash: h, code: Some(bc), ..Default::default() })
        };
        self.cache.lock().unwrap().accts.insert(addr, info.clone());
        info
    }
    pub fn fetch_slot(&self, addr: Address, slot: U256) -> U256 {
        if let Some(v) = self.cache.lock().unwrap().slots.get(&(addr, slot)) {
            return *v;
        }
        let v = u(&self.a.ok("eth_getStorageAt", json!([ha(addr), hx64(slot), self.tag()])));
        self.cache.lock().unwrap().slots.insert((addr, slot), v);
        v
    }
    /// Many slots at once (one HTTP request).
    pub fn fetch_slots(&self, items: &[(Address, U256)]) -> Vec<U256> {
        let t = self.tag();
        let reqs: Vec<(&str, Value)> = items.iter().map(|(a, s)| ("eth_getStorageAt", json!([ha(*a), hx64(*s), t]))).collect();
        let mut out = Vec::with_capacity(items.len());
        for chunk in reqs.chunks(500) {
            for r in self.a.batch(chunk) {
                out.push(u(&r.unwrap()));
            }
        }
        let mut c = self.cache.lock().unwrap();
        for (k, v) in items.iter().zip(&out) {
            c.slots.insert(*k, *v);
        }
        out
    }
    pub fn code(&self, h: B256) -> Option<Bytecode> {
        self.cache.lock().unwrap().codes.get(&h).cloned()
    }
}

impl StateRead for RemoteView<'_> {
    fn account(&self, addr: Address) -> Lookup<Option<AccountInfo>> {
        Lookup::Known(self.fetch_account(addr))
    }
    fn storage(&self, addr: Address, slot: U256) -> Lookup<U256> {
        Lookup::Known(self.fetch_slot(addr, slot))
    }
    fn code_by_hash(&self, hash: B256) -> Lookup<Bytecode> {
        match self.code(hash) {
            Some(c) => Lookup::Known(c),
            None => Lookup::Missing,
        }
    }
    fn position(&self) -> StatePosition {
        StatePosition { base_block: self.block, after_seq: None }
    }
}

/// Fill items our copy asked for, from the chain at the copy's START block
/// (the first-load rule: a slot our replays never wrote still holds its
/// start value). Returns how many items were filled.
pub fn fill(ov: &mut Overlay, start: &RemoteView, items: &[MissItem]) -> usize {
    for m in items {
        match m {
            MissItem::Slot(a, s) => {
                let v = start.fetch_slot(*a, *s);
                ov.learn(&Fact::Slot(*a, *s, v));
            }
            MissItem::Account(a) => {
                let info = start.fetch_account(*a);
                let code = info.as_ref().and_then(|i| i.code.clone());
                ov.learn(&Fact::Basics { addr: *a, info, code });
            }
            MissItem::Code(h) => panic!("copy asked for code {h} by hash only"),
        }
    }
    items.len()
}

/// Our copy for the followed accounts, the truth (at the current block) for
/// everything else. A followed slot the copy never loaded is read at the
/// START block (same rule as `fill`).
pub struct CopyView<'a> {
    pub ov: &'a Overlay,
    pub tracked: Vec<Address>,
    pub start: &'a RemoteView<'a>,
    pub now: &'a RemoteView<'a>,
}

impl StateRead for CopyView<'_> {
    fn account(&self, addr: Address) -> Lookup<Option<AccountInfo>> {
        if self.tracked.contains(&addr) {
            match self.ov.account(addr) {
                Lookup::Known(i) => Lookup::Known(i),
                Lookup::Missing => self.start.account(addr),
            }
        } else {
            self.now.account(addr)
        }
    }
    fn storage(&self, addr: Address, slot: U256) -> Lookup<U256> {
        if self.tracked.contains(&addr) {
            match self.ov.storage(addr, slot) {
                Lookup::Known(v) => Lookup::Known(v),
                Lookup::Missing => self.start.storage(addr, slot),
            }
        } else {
            self.now.storage(addr, slot)
        }
    }
    fn code_by_hash(&self, hash: B256) -> Lookup<Bytecode> {
        match self.ov.code_by_hash(hash) {
            Lookup::Known(c) => Lookup::Known(c),
            Lookup::Missing => match self.start.code_by_hash(hash) {
                Lookup::Known(c) => Lookup::Known(c),
                Lookup::Missing => self.now.code_by_hash(hash),
            },
        }
    }
    fn position(&self) -> StatePosition {
        self.now.position()
    }
}

/// The bot's ArbExecutor runtime code, read from the bot's source file.
pub fn arb_executor_runtime() -> String {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/execution/arbExecutorBytecode.ts");
    let src = std::fs::read_to_string(p).expect("arbExecutorBytecode.ts");
    let i = src.find("ARB_EXECUTOR_RUNTIME_CODE").expect("runtime code name");
    let rest = &src[i..];
    let s = rest.find("0x").unwrap();
    let e = rest[s..].find(|c: char| !c.is_ascii_hexdigit() && c != 'x').unwrap();
    rest[s..s + e].to_string()
}

/// Test contract artifacts (deploy code), see sim/tools/copy2/build.js.
pub fn artifacts() -> Value {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/copy2/artifacts.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

pub fn art(a: &Value, name: &str) -> String {
    a[name].as_str().unwrap_or_else(|| panic!("artifact {name}")).to_string()
}
