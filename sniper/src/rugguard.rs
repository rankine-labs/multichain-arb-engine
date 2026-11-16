// ============================================================================
// RUG GUARD: pool age, creator blocklist, rug measurements
//
// Plain English:
//   Run 5's 8 rugs all followed one pattern: a new coin, its pool created
//   seconds earlier, a small fake rush, we buy ~30 s after the pool was
//   made, and the creator pulls all the liquidity 2-5 s later. Scoring rules
//   on all 385 run-5 trades (deploy/rug-rules.py):
//     skip pools < 2 min old: stops 8/8 rugs, loses 28 good trades (+$68),
//     net +$307. "Creator added the liquidity" alone is useless (nearly
//     every meme coin launches that way).
//   So this module:
//     1. PoolAges: remembers when each pool was created (V3 PoolCreated,
//        V2 PairCreated, V4 Initialize) and by which transaction. Pools
//        created before the trader started are found by a short look back
//        at startup (default 15 min); anything older than that is "old".
//        Rule: skip pools younger than SNIPER_MIN_POOL_AGE_SECS (120).
//     2. Creators blocklist: when a coin rugs or fails the trap check, the
//        wallet that created its pool is blocked for good, so the same
//        scammer's next coin is skipped even if they wait past 2 minutes.
//     3. Measurements only (no rule yet): for each trade we take, the
//        creator's share of the coin's supply and the "bundle" share (coins
//        bought out of the pool in its first ~2 s). Logged with the trade so
//        the next scoring run can test them before we trust them.
// ============================================================================
use std::collections::HashMap;

use serde_json::Value;

use crate::rhc::V4_POOL_MANAGER;
use crate::venue::V2_FACTORY;

/// keccak("PoolCreated(address,address,uint24,int24,address)"): V3 factory.
pub const SIG_V3_POOL_CREATED: &str = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";
/// keccak("PairCreated(address,address,address,uint256)"): V2 factory.
pub const SIG_V2_PAIR_CREATED: &str = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";

/// When a pool was created and the transaction that created it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Born {
    pub block: u64,
    pub tx: String,
}

fn hex_u64(v: Option<&Value>) -> u64 {
    v.and_then(Value::as_str).and_then(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16).ok()).unwrap_or(0)
}

/// If this log is a pool-creation event from a factory we trade on, the
/// pool's id (address for V2/V3, pool id for V4) and when it was born.
/// The V3 factory address is passed in (it lives in paper.rs).
pub fn decode_created(log: &Value, v3_factory: &str) -> Option<(String, Born)> {
    let addr = log["address"].as_str()?.to_ascii_lowercase();
    let t0 = log["topics"].as_array()?.first()?.as_str()?.to_ascii_lowercase();
    let data = log["data"].as_str().unwrap_or("").trim_start_matches("0x");
    let born = Born { block: hex_u64(log.get("blockNumber")), tx: log["transactionHash"].as_str().unwrap_or("").to_ascii_lowercase() };
    let pool = if t0 == SIG_V3_POOL_CREATED && addr == v3_factory {
        // data: tickSpacing (word 0), pool (word 1)
        format!("0x{}", data.get(64 + 24..128)?)
    } else if t0 == SIG_V2_PAIR_CREATED && addr == V2_FACTORY {
        // data: pair (word 0), pair count (word 1)
        format!("0x{}", data.get(24..64)?)
    } else if t0 == crate::rhc::sig_v4_init() && addr == V4_POOL_MANAGER {
        // topic1 is the pool id
        log["topics"][1].as_str()?.to_ascii_lowercase()
    } else {
        return None;
    };
    Some((pool.to_ascii_lowercase(), born))
}

/// Pool birth records. Pools not in here are older than our look-back.
#[derive(Default, Debug)]
pub struct PoolAges {
    born: HashMap<String, Born>,
}

impl PoolAges {
    /// Memory guard: Robinhood makes thousands of pools a day; keep the newest.
    pub const MAX: usize = 100_000;

    pub fn insert(&mut self, pool: &str, b: Born) {
        if self.born.len() >= Self::MAX {
            // drop the oldest half (rare; keeps the young pools we care about)
            let mut blocks: Vec<u64> = self.born.values().map(|b| b.block).collect();
            blocks.sort_unstable();
            let cut = blocks[blocks.len() / 2];
            self.born.retain(|_, b| b.block > cut);
        }
        self.born.entry(pool.to_ascii_lowercase()).or_insert(b);
    }

    pub fn get(&self, pool: &str) -> Option<&Born> {
        self.born.get(&pool.to_ascii_lowercase())
    }

    /// Age in seconds at `block`, or None = older than our look-back.
    pub fn age_secs(&self, pool: &str, block: u64, block_s: f64) -> Option<f64> {
        self.get(pool).map(|b| block.saturating_sub(b.block) as f64 * block_s)
    }

    pub fn len(&self) -> usize {
        self.born.len()
    }

    pub fn is_empty(&self) -> bool {
        self.born.is_empty()
    }
}

/// The age rule: too young only when we KNOW the age and it is under the
/// minimum. (paper.rs now looks up the real age of any pool it has not seen
/// being created, so "unknown" only happens when that lookup fails, and the
/// trade is then skipped as "pool age unknown".)
pub fn too_young(age_secs: Option<f64>, min_secs: f64) -> bool {
    age_secs.is_some_and(|a| a < min_secs)
}

// ---------------------------------------------------------------------------
// REAL BIRTH LOOKUP (fixes the restart hole)
//
// Plain English: on restart the bot only sees pools created in the last few
// minutes. Any pool older than that used to count as "old", so a 20-minute
// old scam pool passed the age rule right after a restart. Now we ask the
// chain directly when the pool first existed, with a binary search over
// history (about 27 node requests per pool, done once, then remembered on
// disk in paper-out/pool_births.json and shared by every run):
//   V3/V2 pool = a contract: first block where it has code.
//   V4 pool    = a slot in the PoolManager (pools[id]): first block where it
//                is non-zero. It is set by Initialize.
// ---------------------------------------------------------------------------

/// Storage slot of `pools[id]` in the V4 PoolManager (mapping at slot 6).
pub fn v4_state_slot(pool_id: &str) -> Option<String> {
    let id = pool_id.trim_start_matches("0x");
    if id.len() != 64 {
        return None;
    }
    let mut buf = Vec::with_capacity(64);
    for i in (0..64).step_by(2) {
        buf.push(u8::from_str_radix(&id[i..i + 2], 16).ok()?);
    }
    buf.extend_from_slice(&[0u8; 31]);
    buf.push(6);
    Some(crate::fourmeme::hex(&crate::fourmeme::keccak(&buf)))
}

/// Does the pool exist at `block`? (one node request)
fn exists_at(rpc: &crate::sellcheck::Rpc, pool: &str, block: u64) -> Result<bool, String> {
    let tag = format!("0x{block:x}");
    if let Some(slot) = v4_state_slot(pool) {
        // extsload(bytes32) = 0x1e2eaeaf
        let data = format!("0x1e2eaeaf{}", slot.trim_start_matches("0x"));
        let v = rpc.call("eth_call", serde_json::json!([{"to": V4_POOL_MANAGER, "data": data}, tag]))?;
        Ok(v.as_str().unwrap_or("0x").trim_start_matches("0x").chars().any(|c| c != '0'))
    } else {
        let v = rpc.call("eth_getCode", serde_json::json!([pool, tag]))?;
        Ok(v.as_str().unwrap_or("0x").len() > 2)
    }
}

/// First block where the pool exists, searching 0..=upper.
/// Err when the node fails or the pool does not exist at `upper`.
pub fn birth_lookup(rpc: &crate::sellcheck::Rpc, pool: &str, upper: u64) -> Result<u64, String> {
    first_true(upper, |b| exists_at(rpc, pool, b))
}

/// Binary search: smallest block in 0..=upper where `test` is true
/// (`test` must be false then true, never back). Split out so it can be
/// tested without a node.
pub fn first_true(upper: u64, mut test: impl FnMut(u64) -> Result<bool, String>) -> Result<u64, String> {
    if !test(upper)? {
        return Err("pool does not exist yet at that block".into());
    }
    let (mut lo, mut hi) = (0u64, upper);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if test(mid)? {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    Ok(lo)
}

/// Birth blocks found by lookups, kept on disk and shared by all runs
/// (paper-out/pool_births.json: {"<pool>": block}). The pool-age study
/// script writes the same file, so its results are reused for free.
#[derive(Default, Debug)]
pub struct Births {
    pub map: HashMap<String, u64>,
    path: Option<std::path::PathBuf>,
}

impl Births {
    pub const FILE: &'static str = "pool_births.json";

    /// Load (a missing or damaged file just means starting empty; values
    /// that are not block numbers, like the study's error notes, are skipped).
    pub fn load(path: std::path::PathBuf) -> Self {
        let mut map = HashMap::new();
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(Value::Object(o)) = serde_json::from_str::<Value>(&text) {
                for (k, v) in o {
                    if let Some(b) = v.as_u64() {
                        map.insert(k.to_ascii_lowercase(), b);
                    }
                }
            }
        }
        Births { map, path: Some(path) }
    }

    pub fn get(&self, pool: &str) -> Option<u64> {
        self.map.get(&pool.to_ascii_lowercase()).copied()
    }

    /// Remember and save (write to a temp file, then rename, so a crash
    /// never leaves a half-written file).
    pub fn add(&mut self, pool: &str, block: u64) {
        self.map.insert(pool.to_ascii_lowercase(), block);
        if let Some(p) = &self.path {
            let tmp = p.with_extension("json.tmp");
            let ok = serde_json::to_string(&self.map).map_err(|e| e.to_string()).and_then(|s| std::fs::write(&tmp, s).map_err(|e| e.to_string())).and_then(|_| std::fs::rename(&tmp, p).map_err(|e| e.to_string()));
            if let Err(e) = ok {
                eprintln!("paper: could not save pool births ({e})");
            }
        }
    }
}

/// A hex number ("0x...", one 32-byte word or less) as u128; numbers too
/// big for u128 are capped at u128::MAX (only ratios are taken from them).
pub fn hex_u128(h: &str) -> Option<u128> {
    let d = h.trim_start_matches("0x");
    let d = d.get(..64.min(d.len()))?.trim_start_matches('0');
    if d.is_empty() {
        return Some(0);
    }
    if d.len() > 32 {
        return Some(u128::MAX);
    }
    u128::from_str_radix(d, 16).ok()
}

/// Share (0..1) of `amounts` in `total`, None when total is zero.
pub fn share(part: u128, total: u128) -> Option<f64> {
    (total > 0).then(|| part as f64 / total as f64)
}

/// Bundle share: coins that left `pool` (Transfer from the pool) in the
/// given Transfer logs, as a share of `supply`. Used on the logs of the
/// pool's first ~2 s. Amounts above u128 are capped (absurd supplies).
pub fn bundle_share(transfers: &[Value], pool: &str, supply: u128) -> Option<f64> {
    let pool = pool.trim_start_matches("0x").to_ascii_lowercase();
    let mut out: u128 = 0;
    for l in transfers {
        let from = l["topics"][1].as_str().unwrap_or("").to_ascii_lowercase();
        if from.len() >= 40 && from[from.len() - 40..] == pool {
            out = out.saturating_add(hex_u128(l["data"].as_str().unwrap_or("0x")).unwrap_or(0));
        }
    }
    share(out, supply)
}

/// Wallets that created pools of coins that rugged or failed the trap
/// check. Saved in the output folder (blocked_creators.json), never forgotten.
pub struct Creators {
    pub list: crate::paper::Blocklist,
    path: std::path::PathBuf,
    /// creation tx -> the wallet that sent it
    cache: HashMap<String, String>,
}

impl Creators {
    pub const FILE: &'static str = "blocked_creators.json";

    pub fn load(dir: &std::path::Path) -> Result<Self, String> {
        let path = dir.join(Self::FILE);
        Ok(Creators { list: crate::paper::Blocklist::load(&path)?, path, cache: HashMap::new() })
    }

    /// The wallet that created this pool, if we saw the pool being created
    /// (one node request the first time, cached after).
    pub fn creator(&mut self, rpc: &crate::sellcheck::Rpc, ages: &PoolAges, pool: &str) -> Option<String> {
        let tx = ages.get(pool)?.tx.clone();
        if let Some(c) = self.cache.get(&tx) {
            return Some(c.clone());
        }
        let from = rpc.call("eth_getTransactionByHash", serde_json::json!([tx])).ok()?["from"].as_str()?.to_ascii_lowercase();
        self.cache.insert(tx, from.clone());
        Some(from)
    }

    /// Is this pool's creator blocked? (false when the creator is unknown)
    pub fn blocked(&mut self, rpc: &crate::sellcheck::Rpc, ages: &PoolAges, pool: &str) -> Option<String> {
        let c = self.creator(rpc, ages, pool)?;
        self.list.contains(&c).then_some(c)
    }

    /// Block the creator of this pool (when known) and save right away.
    pub fn block(&mut self, rpc: &crate::sellcheck::Rpc, ages: &PoolAges, pool: &str, why: &str) {
        if let Some(c) = self.creator(rpc, ages, pool) {
            if self.list.add(&c, why) {
                eprintln!("paper: BLOCKED CREATOR {c} ({why})");
                if let Err(e) = self.list.save(&self.path) {
                    eprintln!("paper: could not save creator blocklist ({e})");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const V3F: &str = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";

    fn w(hex40: &str) -> String {
        format!("{:0>64}", hex40.trim_start_matches("0x"))
    }

    #[test]
    fn creation_signatures_are_the_real_ones() {
        let k = |s: &str| format!("0x{}", crate::fourmeme::hex(&crate::fourmeme::keccak(s.as_bytes())));
        assert_eq!(k("PoolCreated(address,address,uint24,int24,address)"), SIG_V3_POOL_CREATED);
        assert_eq!(k("PairCreated(address,address,address,uint256)"), SIG_V2_PAIR_CREATED);
    }

    #[test]
    fn decodes_v3_v2_v4_creations() {
        let pool = "0xbfe5fa56a26f59edea478f6fcccb668dccdbf0a8";
        let v3 = json!({"address": V3F, "topics": [SIG_V3_POOL_CREATED, "0x1", "0x2", "0x3"],
            "data": format!("0x{}{}", "0".repeat(63) + "a", w(pool)), "blockNumber": "0x10", "transactionHash": "0xAB"});
        assert_eq!(decode_created(&v3, V3F), Some((pool.to_string(), Born { block: 16, tx: "0xab".into() })));
        // same event from another factory: ignored
        let fake = json!({"address": "0x00000000000000000000000000000000000000ff", "topics": [SIG_V3_POOL_CREATED], "data": v3["data"]});
        assert_eq!(decode_created(&fake, V3F), None);
        let v2 = json!({"address": V2_FACTORY, "topics": [SIG_V2_PAIR_CREATED, "0x1", "0x2"],
            "data": format!("0x{}{}", w(pool), w("1")), "blockNumber": "0x20", "transactionHash": "0xcd"});
        assert_eq!(decode_created(&v2, V3F).map(|x| x.0), Some(pool.to_string()));
        let id = format!("0x{}", "ee".repeat(32));
        let v4 = json!({"address": V4_POOL_MANAGER, "topics": [crate::rhc::sig_v4_init(), id.clone()], "data": "0x", "blockNumber": "0x30", "transactionHash": "0xef"});
        assert_eq!(decode_created(&v4, V3F).map(|x| (x.0, x.1.block)), Some((id, 48)));
    }

    #[test]
    fn age_rule_only_blocks_known_young_pools() {
        let mut a = PoolAges::default();
        a.insert("0xAA", Born { block: 1000, tx: "0x1".into() });
        // 30 s after creation (block time 0.1 s): too young for a 120 s rule
        assert!(too_young(a.age_secs("0xaa", 1300, 0.1), 120.0));
        // 3 min after: fine
        assert!(!too_young(a.age_secs("0xaa", 2800, 0.1), 120.0));
        // pool we never saw created: older than our look-back, allowed
        assert!(!too_young(a.age_secs("0xbb", 2800, 0.1), 120.0));
        // first record wins (a re-delivered log can't make a pool younger)
        a.insert("0xaa", Born { block: 2000, tx: "0x2".into() });
        assert_eq!(a.get("0xaa").unwrap().block, 1000);
    }

    #[test]
    fn hex_numbers() {
        assert_eq!(hex_u128("0x0"), Some(0));
        assert_eq!(hex_u128(&format!("0x{:064x}", 1234u64)), Some(1234));
        assert_eq!(hex_u128(&format!("0x{}", "f".repeat(64))), Some(u128::MAX));
    }

    #[test]
    fn bundle_share_counts_only_coins_leaving_the_pool() {
        let pool = "0x7644a995369f0b39b87d08435c7dcccfe8cf94cf";
        let t = |from: &str, amt: u64| json!({"topics": ["0xddf", format!("0x{}", w(from)), format!("0x{}", w("abc"))], "data": format!("0x{amt:064x}")});
        let logs = vec![t(pool, 100), t(pool, 50), t("0x1111111111111111111111111111111111111111", 999)];
        assert_eq!(bundle_share(&logs, pool, 1000), Some(0.15));
        assert_eq!(bundle_share(&logs, pool, 0), None);
    }

    #[test]
    fn v4_slot_matches_python_and_chain() {
        // Same formula the pool-age study used; for this pool it gave 34.9
        // min, matching the Initialize event found by v4-rug-check.py.
        let id = "0x5295c931d68835960420dedc2012e6e6bd1d08ce2dd338238f92a06e91757fda";
        assert_eq!(v4_state_slot(id).unwrap(), "d001e6ac5165509468e527d4a6f8fe3e5782970e34f95805ce116ac02a402aff");
        // a V3 address is not a V4 id
        assert_eq!(v4_state_slot("0xf8818bf7bd50437d11595a10eaa3aae7a2f8bf3b"), None);
    }

    #[test]
    fn binary_search_finds_first_block() {
        let mut calls = 0;
        let got = first_true(115_000_000, |b| {
            calls += 1;
            Ok(b >= 114_321_987)
        });
        assert_eq!(got, Ok(114_321_987));
        assert!(calls <= 30, "about 27 node requests, got {calls}");
        // pool not there yet = error, not a fake block
        assert!(first_true(100, |_| Ok(false)).is_err());
        // node failure propagates (trade gets skipped, not passed)
        assert!(first_true(100, |b| if b == 100 { Ok(true) } else { Err("down".into()) }).is_err());
        // existed from block 0
        assert_eq!(first_true(100, |_| Ok(true)), Ok(0));
    }

    #[test]
    fn births_file_round_trip_and_skips_bad_values() {
        let dir = std::env::temp_dir().join(format!("births-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(Births::FILE);
        std::fs::write(&path, r#"{"0xAA": 10, "0xbb": "error: node down"}"#).unwrap();
        let mut b = Births::load(path.clone());
        assert_eq!(b.get("0xaa"), Some(10));
        assert_eq!(b.get("0xbb"), None);
        b.add("0xCC", 42);
        let again = Births::load(path);
        assert_eq!(again.get("0xcc"), Some(42));
        assert_eq!(again.get("0xaa"), Some(10));
        std::fs::remove_dir_all(&dir).ok();
    }
}
