// ============================================================================
// GUN: GAS PRICE, BLOCK CLOCK AND GAS LIMIT (kept fresh in the background)
//
// Plain English:
//   Same rules as the Node sender (src/execution/fastSender.ts), so a trade
//   from Rust carries the same gas fields a Node trade would:
//     - every 2 s: read the latest block (eth_getBlockByNumber "latest").
//       maxFeePerGas = 2 x base fee + 1 (no tip: Robinhood is first come,
//       first served; the cap only has to cover base-fee moves). No base fee
//       in the answer -> eth_gasPrice instead (ethers' getFeeData fallback).
//     - the block time is learned from consecutive reads (smoothed 80/20,
//       starts at 50 ms, only 10..5000 ms readings count).
//     - every 5th refresh (~10 s): the parent-chain posting gas for one
//       trade's calldata, from NodeInterface (0xC8) gasEstimateL1Component
//       with FIRE_L1_CALLDATA_BYTES (default 800) RANDOM bytes (random bytes
//       don't compress, so this errs high).
//     - gas limit = tuned L2 limit + 1.5 x posting gas. The L2 limit starts
//       at FIRE_GAS_LIMIT (default 1,500,000) and follows real receipts
//       (note_gas_used: 1.5 x the most seen, never below half the default).
//     - deadline (maxBlock) = estimated current block (last read + elapsed
//       time / block time) + margin: MAX_BLOCK_MARGIN blocks if set, else
//       MAX_BLOCK_MARGIN_MS (default 3000) worth of blocks.
//   STALE GUARD: block info older than 10 s -> no deadline -> no send
//   ("block info stale"), exactly like the Node sender. A failed read keeps
//   the last values (and they age into the stale guard).
// ============================================================================
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::rpc::ReadRpc;
use crate::check::hexutil::{parse_bytes, parse_u256, parse_u64, to_hex};

/// Snapshot of what the gas thread knows.
#[derive(Clone, Debug, Default)]
pub struct GasState {
    /// 2 x base fee + 1 (None until the first successful read).
    pub max_fee_per_gas: Option<u128>,
    pub base_fee: Option<u128>,
    pub latest_block: u64,
    /// When latest_block was read.
    pub latest_block_at: Option<Instant>,
    /// Smoothed block time (ms).
    pub block_ms: f64,
    /// Parent-chain posting gas for one trade.
    pub l1_gas: u64,
    /// Tuned L2 gas limit (before the posting gas).
    pub gas_limit_l2: u64,
    pub max_gas_seen: u64,
    pub reads_ok: u64,
    pub reads_failed: u64,
}

/// Settings (env, same names as the Node sender).
#[derive(Clone, Debug)]
pub struct GasConfig {
    pub fire_gas_limit: u64,
    pub l1_bytes: usize,
    pub margin_blocks: Option<f64>,
    pub margin_ms: f64,
    pub refresh: Duration,
}

impl GasConfig {
    pub fn from_env() -> Self {
        let env_f = |k: &str| std::env::var(k).ok().and_then(|s| s.trim().parse::<f64>().ok());
        let l1 = env_f("FIRE_L1_CALLDATA_BYTES").unwrap_or(800.0);
        GasConfig {
            fire_gas_limit: env_f("FIRE_GAS_LIMIT").filter(|v| v.is_finite() && *v > 0.0).map(|v| v as u64).unwrap_or(1_500_000),
            l1_bytes: if l1.fract() == 0.0 && (100.0..=20_000.0).contains(&l1) { l1 as usize } else { 800 },
            margin_blocks: std::env::var("MAX_BLOCK_MARGIN").ok().filter(|s| !s.is_empty()).map(|s| s.trim().parse::<f64>().unwrap_or(f64::NAN)),
            margin_ms: env_f("MAX_BLOCK_MARGIN_MS").unwrap_or(3000.0),
            refresh: Duration::from_millis(2000),
        }
    }
}

/// The gas keeper: shared state + the refresh logic.
pub struct Gas {
    cfg: GasConfig,
    st: Mutex<GasState>,
    tick: Mutex<u64>,
}

/// Parse a JSON hex quantity.
fn q_u128(v: &Value) -> Option<u128> {
    let u = parse_u256(v.as_str()?).ok()?;
    u128::try_from(u).ok()
}

/// One random buffer from the OS (for the L1 posting estimate).
fn random_bytes(n: usize) -> Vec<u8> {
    use std::io::Read;
    let mut b = vec![0u8; n];
    if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).is_err() {
        // Fallback: a cheap mixer (only needs to be incompressible-ish).
        let mut x: u64 = 0x9e37_79b9_7f4a_7c15 ^ Instant::now().elapsed().as_nanos() as u64;
        for v in b.iter_mut() {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            *v = x as u8;
        }
    }
    b
}

/// calldata for NodeInterface.gasEstimateL1Component(address(0), false, bytes).
pub fn l1_estimate_calldata(payload: &[u8]) -> Vec<u8> {
    let sel = super::calldata::selector_of("gasEstimateL1Component(address,bool,bytes)");
    let padded = payload.len().div_ceil(32) * 32;
    let mut d = vec![0u8; 4 + 32 * 4 + padded];
    d[..4].copy_from_slice(&sel);
    // word0 address(0), word1 false, word2 offset 0x60, word3 length, data
    d[4 + 64 + 31] = 0x60;
    d[4 + 96 + 24..4 + 128].copy_from_slice(&(payload.len() as u64).to_be_bytes());
    d[4 + 128..4 + 128 + payload.len()].copy_from_slice(payload);
    d
}

impl Gas {
    pub fn new(cfg: GasConfig) -> Self {
        let st = GasState { block_ms: 50.0, gas_limit_l2: cfg.fire_gas_limit, ..Default::default() };
        Gas { cfg, st: Mutex::new(st), tick: Mutex::new(0) }
    }

    pub fn snapshot(&self) -> GasState {
        self.st.lock().unwrap().clone()
    }

    /// One refresh (the background thread calls this every 2 s).
    pub fn refresh(&self, rpc: &dyn ReadRpc) -> Result<(), String> {
        let r = self.refresh_inner(rpc);
        let mut s = self.st.lock().unwrap();
        if r.is_ok() {
            s.reads_ok += 1;
        } else {
            s.reads_failed += 1;
        }
        r
    }

    fn refresh_inner(&self, rpc: &dyn ReadRpc) -> Result<(), String> {
        let block = rpc.call("eth_getBlockByNumber", json!(["latest", false]))?;
        let now = Instant::now();
        let number = block.get("number").and_then(|v| v.as_str()).and_then(|s| parse_u64(s).ok());
        if let Some(n) = number.filter(|n| *n > 0) {
            let mut s = self.st.lock().unwrap();
            if s.latest_block > 0 && n > s.latest_block {
                if let Some(at) = s.latest_block_at {
                    let per = now.duration_since(at).as_secs_f64() * 1000.0 / (n - s.latest_block) as f64;
                    if per > 10.0 && per < 5000.0 {
                        s.block_ms = s.block_ms * 0.8 + per * 0.2;
                    }
                }
            }
            s.latest_block = n;
            s.latest_block_at = Some(now);
        }
        // Posting gas: every 5th refresh (~10 s), failures keep the last value.
        let do_l1 = {
            let mut t = self.tick.lock().unwrap();
            let d = *t % 5 == 0;
            *t += 1;
            d
        };
        if do_l1 {
            if let Ok(l1) = self.read_l1(rpc) {
                self.st.lock().unwrap().l1_gas = l1;
            }
        }
        let base = match block.get("baseFeePerGas").and_then(q_u128) {
            Some(b) => b,
            None => rpc.call("eth_gasPrice", json!([])).ok().as_ref().and_then(q_u128).unwrap_or(0),
        };
        let mut s = self.st.lock().unwrap();
        s.base_fee = Some(base);
        s.max_fee_per_gas = Some(base.saturating_mul(2).saturating_add(1));
        Ok(())
    }

    fn read_l1(&self, rpc: &dyn ReadRpc) -> Result<u64, String> {
        let data = l1_estimate_calldata(&random_bytes(self.cfg.l1_bytes));
        let ret = rpc.call("eth_call", json!([{"to": "0x00000000000000000000000000000000000000C8", "data": to_hex(&data)}, "latest"]))?;
        let b = parse_bytes(ret.as_str().ok_or("l1 answer not text")?)?;
        if b.len() < 32 {
            return Err("l1 answer too short".into());
        }
        // First return value: uint64 gasEstimateForL1.
        let v = parse_u256(&to_hex(&b[..32]))?;
        u64::try_from(v).map_err(|_| "l1 gas too large".to_string())
    }

    /// Real gas used by one of our trades (from its receipt).
    pub fn note_gas_used(&self, gas: u64) {
        let mut s = self.st.lock().unwrap();
        s.max_gas_seen = s.max_gas_seen.max(gas);
        let tuned = s.max_gas_seen.saturating_mul(3) / 2;
        let floor = self.cfg.fire_gas_limit / 2;
        s.gas_limit_l2 = tuned.max(floor);
    }

    /// Gas limit actually used: tuned L2 limit + 1.5 x posting gas.
    pub fn current_gas_limit(&self) -> u64 {
        let s = self.st.lock().unwrap();
        s.gas_limit_l2.saturating_add(s.l1_gas.saturating_mul(3) / 2)
    }

    /// Room for `units` of L2 gas with 20% headroom? (gasLimitOk in shadowMain)
    pub fn gas_limit_ok(&self, units: u64) -> bool {
        let s = self.st.lock().unwrap();
        s.gas_limit_l2 as f64 >= (units as f64 * 1.2).ceil()
    }

    /// Deadline block (see header); None = block info stale.
    pub fn deadline_block(&self, now: Instant) -> Option<u64> {
        let s = self.st.lock().unwrap();
        let at = s.latest_block_at?;
        if s.latest_block == 0 {
            return None;
        }
        let age_ms = now.saturating_duration_since(at).as_secs_f64() * 1000.0;
        if age_ms > 10_000.0 {
            return None;
        }
        let est = s.latest_block + (age_ms / s.block_ms).floor() as u64;
        let mut margin = self.cfg.margin_blocks.unwrap_or_else(|| (self.cfg.margin_ms / s.block_ms).ceil());
        if !(margin.is_finite() && margin >= 1.0) {
            margin = (3000.0 / s.block_ms).ceil();
        }
        Some(est + margin.floor() as u64)
    }

    /// Ready to sign: a gas price was read and block info is fresh.
    pub fn max_fee(&self) -> Option<u128> {
        self.st.lock().unwrap().max_fee_per_gas
    }

    pub fn refresh_every(&self) -> Duration {
        self.cfg.refresh
    }
}

/// Background refresh thread (light: one small read every 2 s). Stops when
/// `stop` is set. `also` runs after each refresh (the gun re-syncs the nonce
/// there, so a fire never waits for the network).
pub fn spawn_refresher(gas: Arc<Gas>, rpc: Arc<dyn ReadRpc>, stop: Arc<AtomicBool>, also: Box<dyn Fn() + Send>) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("fastlane-gas".into())
        .spawn(move || {
            let mut errs = 0u64;
            let mut last_log: Option<Instant> = None;
            while !stop.load(Ordering::Relaxed) {
                if let Err(e) = gas.refresh(rpc.as_ref()) {
                    errs += 1;
                    if last_log.map_or(true, |t| t.elapsed() > Duration::from_secs(30)) {
                        last_log = Some(Instant::now());
                        eprintln!("[fastlane] gas read failed: {e} (total {errs}); keeping last values");
                    }
                }
                also();
                // Sleep in short steps so stop is quick.
                let until = Instant::now() + gas.refresh_every();
                while Instant::now() < until && !stop.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        })
        .expect("spawn gas thread")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake {
        block: Mutex<Value>,
        calls: Mutex<Vec<String>>,
    }
    impl ReadRpc for Fake {
        fn call(&self, method: &str, _p: Value) -> Result<Value, String> {
            self.calls.lock().unwrap().push(method.to_string());
            match method {
                "eth_getBlockByNumber" => Ok(self.block.lock().unwrap().clone()),
                "eth_gasPrice" => Ok(json!("0x64")),
                "eth_call" => Ok(json!(format!("0x{:064x}{:064x}{:064x}", 12_345u64, 0, 0))),
                _ => Err("no".into()),
            }
        }
    }

    fn cfg() -> GasConfig {
        GasConfig { fire_gas_limit: 1_500_000, l1_bytes: 800, margin_blocks: None, margin_ms: 3000.0, refresh: Duration::from_millis(2000) }
    }

    #[test]
    fn fee_limit_and_deadline_follow_node_rules() {
        let f = Fake { block: Mutex::new(json!({"number": "0x100", "baseFeePerGas": "0x989680"})), calls: Mutex::new(vec![]) };
        let g = Gas::new(cfg());
        assert!(g.deadline_block(Instant::now()).is_none());
        g.refresh(&f).unwrap();
        assert_eq!(g.max_fee(), Some(2 * 10_000_000 + 1));
        assert_eq!(g.snapshot().l1_gas, 12_345);
        assert_eq!(g.current_gas_limit(), 1_500_000 + 12_345 * 3 / 2);
        // 50 ms blocks, 3000 ms margin -> 60 blocks.
        assert_eq!(g.deadline_block(Instant::now()), Some(256 + 60));
        // Stale after 10 s.
        assert!(g.deadline_block(Instant::now() + Duration::from_secs(11)).is_none());
        // Gas used tuning.
        g.note_gas_used(400_000);
        assert_eq!(g.snapshot().gas_limit_l2, 750_000); // floor = half of 1.5M
        g.note_gas_used(600_000);
        assert_eq!(g.snapshot().gas_limit_l2, 900_000);
        assert!(g.gas_limit_ok(750_000));
        assert!(!g.gas_limit_ok(750_001));
        // L1 read only every 5th refresh.
        for _ in 0..4 {
            g.refresh(&f).unwrap();
        }
        let n = f.calls.lock().unwrap().iter().filter(|m| *m == "eth_call").count();
        assert_eq!(n, 1);
    }

    #[test]
    fn no_base_fee_uses_gas_price() {
        let f = Fake { block: Mutex::new(json!({"number": "0x5"})), calls: Mutex::new(vec![]) };
        let g = Gas::new(cfg());
        g.refresh(&f).unwrap();
        assert_eq!(g.max_fee(), Some(201));
    }

    #[test]
    fn l1_calldata_layout() {
        let d = l1_estimate_calldata(&[1, 2, 3]);
        assert_eq!(d.len(), 4 + 128 + 32);
        assert_eq!(d[4 + 63], 0); // bool false
        assert_eq!(d[4 + 95], 0x60);
        assert_eq!(d[4 + 127], 3);
        assert_eq!(&d[4 + 128..4 + 131], &[1, 2, 3]);
    }
}
