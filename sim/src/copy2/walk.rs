// ============================================================================
// COPY 2 TICK WALK: give a READY V3-style pool ALL the tick data a trade
// check of any realistic size can touch, in ONE node request per pool.
//
// Plain English (why):
//   Dry run #17: two thirds of the trade checks answered "miss" (bot falls
//   back to the node). The misses were storage of READY pools that the load
//   never fetched: the pool's "tick map" words and the data of price points
//   ("ticks") further from the current price than its own events had
//   needed, plus its price history. A ready pool held only slot0 /
//   liquidity / fee counters (V3: slots 0-4, Pancake 0-5, V4 its 4 base
//   slots, Algebra nothing) + whatever replays had asked for. A 1,000 USDG
//   check crossing a few ticks missed; the fill fetched those; the next
//   check crossed other ticks and missed again.
//
// How (one request per pool):
//   debug_traceCall of TickLens.walk(...) (TickLens.sol: placed at a
//   made-up address with a state override, never deployed) with the node's
//   prestateTracer. The lens asks the pool, through the pool's OWN read
//   functions, for every tick-map word in a wide window around the price
//   (zero words too), every initialized tick in it, the price history and
//   the settings, and runs two probe swaps that it cancels in the pay-me
//   callback. The tracer answers with every storage slot the call READ and
//   its value at the traced block. We keep ONLY:
//     - the pool contract's own storage (V3 / Pancake / Algebra), and the
//       storage of accounts the pool's replays already follow (its Algebra
//       plugin), never coins or anything else;
//     - V4: only this pool's own entries in the PoolManager (its 4 base
//       slots, its tick-map words of the walked window, the 3 slots of each
//       initialized tick in them), computed here from the pool id. A "full"
//       V4 walk (WalkCfg.full_words) reads every word of the tick map; the
//       zero ones outside the window come back as `far_zero` (kept
//       compactly, answered only by checks: copy2/checkview.rs).
//   The pool's own code decides which slots it reads, so no storage layout
//   is assumed for V3 / Pancake / Algebra.
//
// Exactness: the values are exact AT the traced block k. The intake only
// takes them while the pool has been ready since <= k without a reload (so
// every change its events made after k is in the copy's own changes and the
// value is carried forward exactly, like fills; intake.rs on_walk), and
// only where the copy doesn't hold the slot already.
//
// Cost: one debug_traceCall per pool (V3 spacing 1: ~260 words + ticks,
// a few hundred KB of answer, ~1-10 M gas inside the node). V2 / Solidly
// pools need no walk (their swap reads only what the load fetches).
// ============================================================================
use std::collections::HashSet;
use std::sync::OnceLock;

use revm::primitives::{keccak256, Address, U256};
use serde_json::{json, Value};

use super::{PoolKind, TrackedPool};
use crate::check::hexutil::{parse_address, parse_u256, to_hex};

const LENS_HEX: &str = include_str!("tick_lens.hex");

/// Where the lens is placed for the pretend call (made up, never on chain).
pub const LENS: Address = Address::new([0xc0, 0xb7, 0x2d, 0x0e, 0x5a, 0x1f, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x1e, 0x45]);

/// High 128 bits of the lens's "finished" marker slot (TickLens.DONE_BASE).
fn done_base() -> U256 {
    U256::from_str_radix("c0b72d0e5a1f00d5c0b72d0e5a1f00d500000000000000000000000000000000", 16).unwrap()
}

fn lens_code() -> &'static str {
    static C: OnceLock<String> = OnceLock::new();
    C.get_or_init(|| format!("0x{}", LENS_HEX.trim()))
}

/// Walk settings (ARBSIM_COPY2_WALK_*).
#[derive(Clone, Debug)]
pub struct WalkCfg {
    /// Ticks each side of the current price [ARBSIM_COPY2_WALK_TICKS, 32768
    /// = a price move of x26 / /26; no realistic trade moves a pool that far].
    pub window_ticks: u64,
    /// At least this many tick-map words each side [ARBSIM_COPY2_WALK_MIN_WORDS, 8].
    pub min_side_words: u64,
    /// Stop after this many initialized ticks [ARBSIM_COPY2_WALK_MAX_TICKS, 3000].
    pub max_ticks: u64,
    /// At most this many price-history entries [ARBSIM_COPY2_WALK_MAX_OBS, 1024].
    pub max_obs: u64,
    /// Probe swaps move the sqrt price by this many 1/10000 [ARBSIM_COPY2_WALK_PROBE_BPS, 100].
    pub probe_bps: u64,
    /// Gas for the pretend call [ARBSIM_COPY2_WALK_GAS, 40,000,000].
    pub gas: u64,
    /// V4: read the pool's WHOLE tick map (every word from the lowest to the
    /// highest price) when it has at most this many words
    /// [ARBSIM_COPY2_WALK_FULL_WORDS, 8000 = every tick spacing (spacing 1:
    /// 6932 words); 0 = window only]. Live Oct 22: 503 of the bot's missed
    /// items were PoolManager tick-map words beyond the window: checks on
    /// thin pools (or with no liquidity on one side) run the price to its
    /// limit. Zero words outside the window are kept compactly (far_zero).
    pub full_words: u64,
}

impl WalkCfg {
    pub fn from_env() -> Self {
        use crate::node::env_u64;
        WalkCfg {
            window_ticks: env_u64("ARBSIM_COPY2_WALK_TICKS", 32_768).min(1_774_544),
            min_side_words: env_u64("ARBSIM_COPY2_WALK_MIN_WORDS", 8).min(4000),
            max_ticks: env_u64("ARBSIM_COPY2_WALK_MAX_TICKS", 3000),
            max_obs: env_u64("ARBSIM_COPY2_WALK_MAX_OBS", 1024),
            probe_bps: env_u64("ARBSIM_COPY2_WALK_PROBE_BPS", 100).min(5000),
            gas: env_u64("ARBSIM_COPY2_WALK_GAS", 40_000_000),
            full_words: env_u64("ARBSIM_COPY2_WALK_FULL_WORDS", 8000).min(8000),
        }
    }
}

impl Default for WalkCfg {
    fn default() -> Self {
        WalkCfg { window_ticks: 32_768, min_side_words: 8, max_ticks: 3000, max_obs: 1024, probe_bps: 100, gas: 40_000_000, full_words: 8000 }
    }
}

/// Does this kind of pool get a walk? (V2 / Solidly: no ticks.)
pub fn walks(kind: PoolKind) -> bool {
    matches!(kind, PoolKind::V3 | PoolKind::PancakeV3 | PoolKind::Algebra | PoolKind::V4)
}

fn kind_code(k: PoolKind) -> u64 {
    match k {
        PoolKind::V3 => 1,
        PoolKind::PancakeV3 => 2,
        PoolKind::Algebra => 3,
        PoolKind::V4 => 4,
        _ => 0,
    }
}

fn int_word(v: i64) -> U256 {
    if v >= 0 {
        U256::from(v as u64)
    } else {
        U256::ZERO.wrapping_sub(U256::from(v.unsigned_abs()))
    }
}

/// The debug_traceCall params for one pool's walk at `tag` (block tag).
pub fn trace_params(p: &TrackedPool, cfg: &WalkCfg, tag: &Value) -> Value {
    let sel = &keccak256("walk((uint256,address,bytes32,int256,uint256,uint256,uint256,uint256,uint256,uint256))".as_bytes())[..4];
    let words = [
        U256::from(kind_code(p.kind)),
        U256::from_be_slice(p.address.as_slice()),
        p.v4_id.map(|i| U256::from_be_bytes(i.0)).unwrap_or_default(),
        int_word(p.tick_spacing as i64),
        U256::from(cfg.window_ticks),
        U256::from(cfg.min_side_words),
        U256::from(cfg.max_ticks),
        U256::from(cfg.max_obs),
        U256::from(cfg.probe_bps),
        U256::from(if p.kind == PoolKind::V4 { cfg.full_words } else { 0 }),
    ];
    let mut data = sel.to_vec();
    for w in words {
        data.extend_from_slice(&w.to_be_bytes::<32>());
    }
    let lens = format!("{LENS:#x}");
    json!([
        { "from": "0x0000000000000000000000000000000000000000", "to": lens, "data": to_hex(&data), "gas": format!("{:#x}", cfg.gas) },
        tag,
        { "tracer": "prestateTracer", "stateOverrides": { lens: { "code": lens_code() } } }
    ])
}

/// What one walk taught us.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WalkOut {
    /// The lens reached its end (not cut short by gas / an error).
    pub done: bool,
    /// Tick-map words walked (V3 / Pancake / V4), as word indexes.
    pub word_lo: i64,
    pub word_hi: i64,
    /// The pool's tick when walked.
    pub center: i64,
    pub ticks: u64,
    pub words: u64,
    /// (account, slot, value) to learn: only the pool's own storage.
    pub slots: Vec<(Address, U256, U256)>,
    /// Slots the trace listed that we did NOT take (other accounts).
    pub ignored: usize,
    /// V4: the lens read the WHOLE tick map (marker bit 96).
    pub full: bool,
    /// V4 full walks: tick-map words OUTSIDE the window (word_lo..word_hi)
    /// that were zero at the walked block (sorted PoolManager slots). Not in
    /// `slots`: kept compactly by the intake (PoolEntry.far_zero, ~32 bytes
    /// each instead of ~280 for a held value) and answered as 0 by checks
    /// only (copy2/checkview.rs), never by replays.
    pub far_zero: Vec<U256>,
}

fn signed16(x: u64) -> i64 {
    (x as u16) as i16 as i64
}
fn signed24(x: u64) -> i64 {
    let v = (x & 0xff_ffff) as i64;
    if v >= 1 << 23 {
        v - (1 << 24)
    } else {
        v
    }
}

/// keccak(abi.encode(key, base)) for a Solidity mapping slot.
fn map_slot(key: U256, base: U256) -> U256 {
    let mut b = [0u8; 64];
    b[..32].copy_from_slice(&key.to_be_bytes::<32>());
    b[32..].copy_from_slice(&base.to_be_bytes::<32>());
    U256::from_be_bytes(keccak256(b).0)
}

/// Word range of the whole tick map for this spacing (MIN_TICK..MAX_TICK).
pub fn full_word_range(spacing: i64) -> (i64, i64) {
    const MAX_TICK: i64 = 887_272;
    (((-MAX_TICK).div_euclid(spacing)) >> 8, (MAX_TICK.div_euclid(spacing)) >> 8)
}

/// V4: this pool's own PoolManager slots for words lo..hi, given the
/// tick-map words the trace returned (their set bits name the ticks), plus
/// the word slots by index.
fn v4_allowed_words(p: &TrackedPool, lo: i64, hi: i64, storage: &dyn Fn(U256) -> Option<U256>) -> (HashSet<U256>, Vec<(i64, U256)>) {
    let mut ok = HashSet::new();
    let mut words = Vec::new();
    let Some(id) = p.v4_id else { return (ok, words) };
    let base = map_slot(U256::from_be_bytes(id.0), U256::from(6u8));
    for i in 0..4u64 {
        ok.insert(base + U256::from(i));
    }
    let sp = p.tick_spacing as i64;
    if sp <= 0 || hi < lo || hi - lo > 8000 {
        return (ok, words);
    }
    for w in lo..=hi {
        let ws = map_slot(int_word(w), base + U256::from(5u8));
        ok.insert(ws);
        words.push((w, ws));
        let Some(bits) = storage(ws) else { continue };
        for b in 0..256usize {
            if bits.bit(b) {
                let t = ((w << 8) + b as i64) * sp;
                let ts = map_slot(int_word(t), base + U256::from(4u8));
                for k in 0..3u64 {
                    ok.insert(ts + U256::from(k));
                }
            }
        }
    }
    (ok, words)
}

/// Read a prestate trace of one walk. `owned`: accounts the pool's replays
/// follow (e.g. its Algebra plugin) whose storage may be learned too.
/// Entries that don't parse are skipped (never defaulted).
pub fn read_walk(tr: &Value, p: &TrackedPool, owned: &[Address]) -> WalkOut {
    let mut out = WalkOut::default();
    let Some(m) = tr.as_object() else { return out };
    // The marker: one slot of the lens's own storage.
    let lens = m.iter().find(|(k, _)| parse_address(k).ok() == Some(LENS)).map(|x| x.1);
    if let Some(st) = lens.and_then(|l| l.get("storage")).and_then(|s| s.as_object()) {
        let one = U256::from(1u8);
        let hi_mask: U256 = !((one << 128usize) - one);
        for k in st.keys() {
            let Ok(key) = parse_u256(k) else { continue };
            if key & hi_mask == done_base() {
                let low = (key & !hi_mask).to::<u128>();
                out.done = true;
                out.word_lo = signed16((low & 0xffff) as u64);
                out.word_hi = signed16(((low >> 16) & 0xffff) as u64);
                out.center = signed24(((low >> 32) & 0xff_ffff) as u64);
                out.ticks = ((low >> 56) & 0xff_ffff) as u64;
                out.words = ((low >> 80) & 0xffff) as u64;
                out.full = (low >> 96) & 1 == 1;
            }
        }
    }
    let read = |acct: &Value| -> Vec<(U256, U256)> {
        let mut v = Vec::new();
        if let Some(st) = acct.get("storage").and_then(|s| s.as_object()) {
            for (k, val) in st {
                if let (Ok(k), Some(Ok(val))) = (parse_u256(k), val.as_str().map(parse_u256)) {
                    v.push((k, val));
                }
            }
        }
        v
    };
    for (k, acct) in m {
        let Ok(a) = parse_address(k) else { continue };
        if a == LENS {
            continue;
        }
        let slots = read(acct);
        if a == p.address && p.kind == PoolKind::V4 {
            let have: std::collections::HashMap<U256, U256> = slots.iter().copied().collect();
            // A full walk: the whole word range (else the window).
            let (lo, hi) = match (out.done, out.full, p.tick_spacing > 0) {
                (true, true, true) => full_word_range(p.tick_spacing as i64),
                (true, _, _) => (out.word_lo, out.word_hi),
                _ => (0, -1),
            };
            let (ok, words) = v4_allowed_words(p, lo, hi, &|s| have.get(&s).copied());
            // Zero words outside the window: compact (never in `slots`).
            let mut far: HashSet<U256> = HashSet::new();
            if out.done && out.full {
                for (w, ws) in &words {
                    if (*w < out.word_lo || *w > out.word_hi) && have.get(ws).is_some_and(|v| v.is_zero()) {
                        far.insert(*ws);
                    }
                }
            }
            for (s, v) in slots {
                if far.contains(&s) {
                    out.far_zero.push(s);
                } else if ok.contains(&s) {
                    out.slots.push((a, s, v));
                } else {
                    out.ignored += 1;
                }
            }
            out.far_zero.sort_unstable();
        } else if a == p.address || owned.contains(&a) {
            out.slots.extend(slots.into_iter().map(|(s, v)| (a, s, v)));
        } else {
            out.ignored += slots.len();
        }
    }
    out.slots.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use revm::primitives::B256;

    fn w(v: U256) -> String {
        format!("{v:#066x}")
    }

    #[test]
    fn lens_code_is_present_and_params_are_well_formed() {
        assert!(lens_code().len() > 1000);
        let p = TrackedPool { address: Address::with_last_byte(9), v4_id: None, kind: PoolKind::V3, token0: Address::ZERO, token1: Address::ZERO, fee: 0, tick_spacing: 0 };
        let v = trace_params(&p, &WalkCfg::default(), &json!("0x10"));
        assert_eq!(v[2]["tracer"], "prestateTracer");
        assert_eq!(v[0]["data"].as_str().unwrap().len(), 2 + 8 + 10 * 64);
    }

    #[test]
    fn only_the_pools_own_storage_and_the_marker_are_read() {
        let pool = Address::with_last_byte(9);
        let coin = Address::with_last_byte(7);
        let p = TrackedPool { address: pool, v4_id: None, kind: PoolKind::V3, token0: coin, token1: Address::ZERO, fee: 0, tick_spacing: 0 };
        // lo = -3 (0xfffd), hi = 4, center = -100, 5 ticks, 8 words
        let low: u128 = 0xfffd | (4 << 16) | ((((-100i64) as u64 & 0xff_ffff) as u128) << 32) | (5 << 56) | (8 << 80);
        let marker = done_base() | U256::from(low);
        let mut tr = serde_json::Map::new();
        tr.insert(format!("{LENS:#x}"), json!({"balance": "0x0", "code": "0x00", "storage": { w(marker): w(U256::ZERO) }}));
        tr.insert(format!("{pool:#x}"), json!({"balance": "0x0", "storage": { w(U256::from(6)): w(U256::from(77)), w(U256::from(5)): w(U256::ZERO), "0xzz": "0x1" }}));
        tr.insert(format!("{coin:#x}"), json!({"storage": { w(U256::from(1)): w(U256::from(3)) }}));
        let o = read_walk(&Value::Object(tr), &p, &[]);
        assert!(o.done);
        assert_eq!((o.word_lo, o.word_hi, o.center, o.ticks, o.words), (-3, 4, -100, 5, 8));
        assert_eq!(o.slots, vec![(pool, U256::from(5), U256::ZERO), (pool, U256::from(6), U256::from(77))]);
        assert_eq!(o.ignored, 1, "the coin's slot is never learned");
    }

    #[test]
    fn v4_keeps_only_this_pools_entries() {
        let pm = Address::with_last_byte(4);
        let id = B256::with_last_byte(0x42);
        let p = TrackedPool { address: pm, v4_id: Some(id), kind: PoolKind::V4, token0: Address::ZERO, token1: Address::ZERO, fee: 500, tick_spacing: 10 };
        let base = map_slot(U256::from_be_bytes(id.0), U256::from(6u8));
        let word0 = map_slot(U256::ZERO, base + U256::from(5u8));
        // bit 3 of word 0 = tick 30
        let tick30 = map_slot(U256::from(30u8), base + U256::from(4u8));
        let other = map_slot(U256::from(1u8), U256::from(1u8)); // e.g. protocol fees (shared)
        let low: u128 = 0 | (0 << 16);
        let mut tr = serde_json::Map::new();
        tr.insert(format!("{LENS:#x}"), json!({"storage": { w(done_base() | U256::from(low)): w(U256::ZERO) }}));
        tr.insert(
            format!("{pm:#x}"),
            json!({"storage": { w(base): w(U256::from(1)), w(word0): w(U256::from(8)), w(tick30 + U256::from(2u8)): w(U256::from(9)), w(other): w(U256::from(5)) }}),
        );
        let o = read_walk(&Value::Object(tr), &p, &[]);
        let got: Vec<U256> = o.slots.iter().map(|x| x.1).collect();
        assert!(got.contains(&base) && got.contains(&word0) && got.contains(&(tick30 + U256::from(2u8))));
        assert!(!got.contains(&other), "a shared PoolManager slot is never learned");
        assert_eq!(o.ignored, 1);
    }

    #[test]
    fn unfinished_walk_says_so() {
        let pool = Address::with_last_byte(9);
        let p = TrackedPool { address: pool, v4_id: None, kind: PoolKind::Algebra, token0: Address::ZERO, token1: Address::ZERO, fee: 0, tick_spacing: 0 };
        let mut tr = serde_json::Map::new();
        tr.insert(format!("{pool:#x}"), json!({"storage": { w(U256::from(1)): w(U256::from(2)) }}));
        let o = read_walk(&Value::Object(tr), &p, &[]);
        assert!(!o.done);
        assert_eq!(o.slots.len(), 1, "what was read is still exact");
    }
}
