// ============================================================================
// VENUES: Uniswap V3, V4 and V2 on Robinhood Chain, for the paper trader.
//
// Plain English:
//   The paper trader used to watch only Uniswap V3 pools. Many meme coins
//   trade on Uniswap V4 or the old V2 instead, so this file holds what the
//   trader needs to know about each "venue" (exchange type) to watch,
//   price and safety-check them the SAME way as V3:
//
//   V3   one contract per pool, priced by Uniswap's QuoterV2 (paper.rs).
//   V4   ALL pools live inside one contract (the PoolManager). A pool has no
//        address, only an id: a fingerprint (keccak hash) of its "key" =
//        (coin 0, coin 1, fee, tick spacing, hook). The key is needed to
//        price a trade, and the chain does not store it. It is only written
//        once, in the pool's Initialize event. So we keep every key we see
//        (and save them to disk). For pools created before we started, a
//        helper thread asks the node for that pool's old Initialize event;
//        if the node can't find it, rushes on that pool are skipped as
//        "unknown v4 pool".
//        Priced by Uniswap's V4Quoter (quoteExactInputSingle, checked against
//        the Uniswap v4-periphery source, IV4Quoter.sol).
//   V2   one contract per pair, price = reserves maths with the 0.30% fee
//        (the dex bot uses feeBps 30 for Robinhood Uniswap V2,
//        src/shadowMain.ts). Reserves come from the pair's own Sync event
//        (emitted right before every Swap) and from getReserves().
//
//   V4 hooks: a hook is extra code a pool runs around each trade. The last
//   14 bits of the hook's ADDRESS are permission flags checked by Uniswap.
//   Two of them ("return delta" on swaps) let a hook change how many coins
//   a trade pays or gets (custom curves, hidden taxes). Pools with those are
//   skipped ("unsafe hook"), same rule as the dex bot
//   (src/config/robinhoodHookedPools.ts). Hook-free pools are fine.
//
//   Native ETH: V4 pools can hold real ETH (coin address 0x000..0) instead
//   of WETH. The V4Quoter prices those directly and the trap check moves
//   only the meme token (an ERC-20), so they are included, priced as ETH.
//
//   Trap check for V4: the tokens of every V4 pool sit in the PoolManager,
//   so the simulated "buy" transfer comes FROM the PoolManager and the
//   "sell" goes back TO it. That is exactly the transfer a real V4 trade
//   makes (the PoolManager pays out on a buy and receives on a sell), so a
//   token that taxes or blocks transfers to/from the PoolManager is caught.
//
//   Live sending stays V3 only (SwapRouter02). V4 and V2 are paper only;
//   dry_fire_supported() says so.
//
// Addresses (src/config/knownAddresses.ts ROBINHOOD_V4 / ROBINHOOD_V2):
//   V4 PoolManager 0x8366a39CC670B4001A1121B8F6A443A643e40951 (rhc.rs)
//   V4 Quoter      0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94
//   V2 factory     0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f
// ============================================================================
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::Path;

use ruint::aliases::U256;
use serde_json::{json, Value};

use crate::fourmeme::{hex, keccak, topic0};
use crate::rhc::{sig_v4_init, V4_POOL_MANAGER};

/// Uniswap V4Quoter on Robinhood Chain (ROBINHOOD_V4.QUOTER).
pub const V4_QUOTER: &str = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";
/// Uniswap V2 factory on Robinhood Chain (ROBINHOOD_V2.FACTORY).
pub const V2_FACTORY: &str = "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f";
/// Uniswap V2 swap fee in millionths (0.30%, as the dex bot uses).
pub const V2_FEE_PPM: u32 = 3000;
/// Gas for one V2 pair swap (there is no V2 quoter to tell us). A plain V2
/// pair swap costs roughly 60-70k; the trader adds its usual overhead on top.
pub const V2_SWAP_GAS: u64 = 70_000;
/// Native ETH as a V4 currency.
pub const NATIVE_ETH: &str = "0x0000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Which venues are switched on (SNIPER_VENUES)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum VenueKind {
    V3,
    V4,
    V2,
}

impl VenueKind {
    pub const ALL: [VenueKind; 3] = [VenueKind::V3, VenueKind::V4, VenueKind::V2];
    /// Short name used in files and the report ("v3", "v4", "v2").
    pub fn name(self) -> &'static str {
        match self {
            VenueKind::V3 => "v3",
            VenueKind::V4 => "v4",
            VenueKind::V2 => "v2",
        }
    }
}

/// Read SNIPER_VENUES ("v3,v4,v2"). Any order, spaces and case ignored,
/// duplicates dropped. An unknown name or an empty list is an error, so a
/// typo stops the trader instead of quietly watching nothing.
pub fn parse_venues(s: &str) -> Result<Vec<VenueKind>, String> {
    let mut out: Vec<VenueKind> = Vec::new();
    for part in s.split(',').map(|p| p.trim().to_ascii_lowercase()).filter(|p| !p.is_empty()) {
        let k = VenueKind::ALL.into_iter().find(|k| k.name() == part).ok_or(format!("SNIPER_VENUES: unknown venue \"{part}\" (use v3, v4, v2)"))?;
        if !out.contains(&k) {
            out.push(k);
        }
    }
    if out.is_empty() {
        return Err("SNIPER_VENUES is empty (use e.g. v3,v4,v2)".into());
    }
    out.sort();
    Ok(out)
}

// ---------------------------------------------------------------------------
// One pool's venue, with what its quoter needs
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub enum Venue {
    /// Uniswap V3: the fee tier picks the pool for QuoterV2.
    V3 { fee: u32 },
    /// Uniswap V4: the full pool key.
    V4 { key: V4Key },
    /// Uniswap V2: the pair address and its token0 (to orient reserves).
    V2 { pair: String, token0: String },
}

impl Venue {
    pub fn kind(&self) -> VenueKind {
        match self {
            Venue::V3 { .. } => VenueKind::V3,
            Venue::V4 { .. } => VenueKind::V4,
            Venue::V2 { .. } => VenueKind::V2,
        }
    }
}

/// The address that HOLDS a pool's tokens, used by the trap check as the
/// "pool" side of its simulated transfers. V3/V2: the pool itself. V4: the
/// PoolManager (all V4 pools keep their coins there; see file header).
pub fn token_holder(venue: &Venue, pool: &str) -> String {
    match venue {
        Venue::V4 { .. } => V4_POOL_MANAGER.to_string(),
        _ => pool.to_ascii_lowercase(),
    }
}

/// Can the live sender's dry-fire handle this venue? Only V3 (it builds
/// SwapRouter02 calls). V4 and V2 are paper only for now.
pub fn dry_fire_supported(kind: VenueKind) -> Result<(), String> {
    match kind {
        VenueKind::V3 => Ok(()),
        k => Err(format!(
            "dry-fire supports only Uniswap V3 pools (it sends SwapRouter02 calls); this is a Uniswap {} pool, which the sniper trades on paper only",
            k.name().to_ascii_uppercase()
        )),
    }
}

// ---------------------------------------------------------------------------
// Small hex helpers
// ---------------------------------------------------------------------------

fn word_addr(a: &str) -> String {
    format!("{:0>64}", a.trim_start_matches("0x").to_ascii_lowercase())
}

/// A signed number as one 32-byte ABI word (negative numbers sign-extended,
/// as abi.encode writes an int24).
fn int_word(n: i64) -> String {
    if n >= 0 {
        format!("{n:064x}")
    } else {
        format!("{:064x}", U256::MAX - U256::from(n.unsigned_abs()) + U256::from(1u64))
    }
}

/// The 64-hex-digit words of log data or a call reply.
pub fn words(data: &str) -> Vec<&str> {
    let d = data.trim_start_matches("0x");
    (0..d.len() / 64).map(|i| &d[i * 64..i * 64 + 64]).collect()
}

fn word_u256(w: &str) -> Option<U256> {
    U256::from_str_radix(w, 16).ok()
}

/// The last 20 bytes of a word or topic, as a lowercase address.
fn word_to_addr(w: &str) -> Option<String> {
    let h = w.trim_start_matches("0x");
    (h.len() == 64).then(|| format!("0x{}", h[24..].to_ascii_lowercase()))
}

/// Is a 64-hex-digit signed number (int256 / sign-extended int128) below zero?
fn word_is_negative(w: &str) -> bool {
    w.len() == 64 && w.chars().next().and_then(|c| c.to_digit(16)).is_some_and(|d| d >= 8)
}

fn word_is_zero(w: &str) -> bool {
    w.chars().all(|c| c == '0')
}

// ---------------------------------------------------------------------------
// Uniswap V4: pool keys, ids, hooks, quotes
// ---------------------------------------------------------------------------

/// A V4 pool key, exactly as stored in its Initialize event. `fee` is the
/// raw uint24, so a dynamic-fee pool keeps its 0x800000 marker (the quoter
/// needs the exact key, or it prices a different, empty pool).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct V4Key {
    pub currency0: String,
    pub currency1: String,
    pub fee: u32,
    pub tick_spacing: i32,
    pub hooks: String,
}

impl V4Key {
    /// Pool id = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)).
    /// Same formula as the dex bot's v4IdSlow / v4Id (src/core/v4Lookup.ts),
    /// with the hook included (the dex bot's helper fixes it to 0).
    pub fn id(&self) -> String {
        let enc = format!(
            "{}{}{}{}{}",
            word_addr(&self.currency0),
            word_addr(&self.currency1),
            int_word(self.fee as i64),
            int_word(self.tick_spacing as i64),
            word_addr(&self.hooks)
        );
        let bytes: Vec<u8> = (0..enc.len() / 2).map(|i| u8::from_str_radix(&enc[2 * i..2 * i + 2], 16).unwrap_or(0)).collect();
        format!("0x{}", hex(&keccak(&bytes)))
    }

    /// LP fee in millionths for display (0 for a dynamic-fee pool, whose
    /// fee is chosen by its hook each trade; the quote still includes it).
    pub fn fee_ppm(&self) -> u32 {
        if self.fee & 0x80_0000 != 0 {
            0
        } else {
            self.fee
        }
    }
}

/// Uniswap v4 Hooks.sol permission flags (the last 14 bits of the hook address).
pub const HOOK_BEFORE_SWAP: u16 = 1 << 7;
pub const HOOK_AFTER_SWAP: u16 = 1 << 6;
pub const HOOK_BEFORE_SWAP_RETURNS_DELTA: u16 = 1 << 3;
pub const HOOK_AFTER_SWAP_RETURNS_DELTA: u16 = 1 << 2;

/// The 14 permission bits of a hook address (0 for "no hook").
pub fn hook_flags(hooks: &str) -> u16 {
    let h = hooks.trim_start_matches("0x");
    let tail = &h[h.len().saturating_sub(4)..];
    u16::from_str_radix(tail, 16).unwrap_or(0) & 0x3fff
}

/// Can this hook change a swap's amounts? (Either "return delta" swap flag.)
/// Such pools are skipped: our quote/trap maths would not be the real deal.
/// Mirrors the dex bot's hookPermissions().returnsSwapDelta.
pub fn hook_changes_amounts(hooks: &str) -> bool {
    hook_flags(hooks) & (HOOK_BEFORE_SWAP_RETURNS_DELTA | HOOK_AFTER_SWAP_RETURNS_DELTA) != 0
}

/// Read a V4 Initialize log: (pool id, key). Only from the real PoolManager,
/// and only if the key really hashes to the logged id (guards against a
/// malformed or look-alike event). Layout (v4-core IPoolManager.sol):
///   topics: [sig, id, currency0, currency1]
///   data:   fee, tickSpacing, hooks, sqrtPriceX96, tick
pub fn decode_v4_init(log: &Value) -> Option<(String, V4Key)> {
    if !log["address"].as_str()?.eq_ignore_ascii_case(V4_POOL_MANAGER) {
        return None;
    }
    let t = log["topics"].as_array()?;
    if !t.first()?.as_str()?.eq_ignore_ascii_case(&sig_v4_init()) {
        return None;
    }
    let id = t.get(1)?.as_str()?.to_ascii_lowercase();
    let w = words(log["data"].as_str()?);
    if w.len() < 3 {
        return None;
    }
    let fee = u32::from_str_radix(&w[0][58..], 16).ok()? & 0xff_ffff;
    // int24 tick spacing: low 24 bits, sign-extended.
    let ts_raw = i32::from_str_radix(&w[1][58..], 16).ok()?;
    let tick_spacing = if ts_raw & 0x80_0000 != 0 { ts_raw - 0x100_0000 } else { ts_raw };
    let key = V4Key {
        currency0: word_to_addr(t.get(2)?.as_str()?)?,
        currency1: word_to_addr(t.get(3)?.as_str()?)?,
        fee,
        tick_spacing,
        hooks: word_to_addr(w[2])?,
    };
    (key.id() == id).then_some((id, key))
}

/// The selector's signature, from v4-periphery IV4Quoter.sol:
/// quoteExactInputSingle(QuoteExactSingleParams{PoolKey poolKey; bool
/// zeroForOne; uint128 exactAmount; bytes hookData}) returns (amountOut, gasEstimate).
pub const V4_QUOTE_SIG: &str = "quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))";

/// Calldata for V4Quoter.quoteExactInputSingle. The params struct holds a
/// `bytes`, so it is "dynamic" in ABI terms: word 0 is the offset (0x20) to
/// the struct, then the 5 key words, zeroForOne, exactAmount, the offset of
/// hookData inside the struct (8 words = 0x100), and hookData's length (0).
pub fn data_v4_quote(key: &V4Key, zero_for_one: bool, amount_in: U256) -> Result<String, String> {
    if amount_in > U256::from(u128::MAX) {
        return Err("v4 quote: amount too large for uint128".into());
    }
    let sel = hex(&keccak(V4_QUOTE_SIG.as_bytes())[..4]);
    Ok(format!(
        "0x{sel}{}{}{}{}{}{}{}{amount_in:064x}{}{}",
        int_word(0x20),
        word_addr(&key.currency0),
        word_addr(&key.currency1),
        int_word(key.fee as i64),
        int_word(key.tick_spacing as i64),
        word_addr(&key.hooks),
        int_word(zero_for_one as i64),
        int_word(0x100),
        int_word(0)
    ))
}

/// Which way a V4 trade goes: true if we pay currency0 (zeroForOne).
/// None if `token_in` is not in this pool.
pub fn v4_zero_for_one(key: &V4Key, token_in: &str) -> Option<bool> {
    if token_in.eq_ignore_ascii_case(&key.currency0) {
        Some(true)
    } else if token_in.eq_ignore_ascii_case(&key.currency1) {
        Some(false)
    } else {
        None
    }
}

/// Read the V4Quoter's answer: (amountOut, gasEstimate).
pub fn parse_v4_quote(reply: &str) -> Result<(U256, u64), String> {
    let w = words(reply);
    if w.len() < 2 {
        return Err("v4 quote: short answer".into());
    }
    let out = word_u256(w[0]).ok_or("v4 quote: bad amount")?;
    let gas = u64::from_str_radix(w[1].trim_start_matches('0'), 16).unwrap_or(150_000);
    Ok((out, gas))
}

/// Was this V4 swap a SELL of the token? V4 Swap amounts are from the
/// SWAPPER's side (negative = the swapper paid that coin; the dex bot reads
/// them the same way, src/core/blockReader.ts). A sell = the swapper GOT the
/// base coin: base word positive and not zero. Base is currency1 when the
/// token is currency0, and the other way round.
pub fn is_sell_v4(w: &[&str], token_is0: bool) -> bool {
    let base_word = if token_is0 { w.get(1) } else { w.first() };
    base_word.is_some_and(|w| w.len() == 64 && !word_is_negative(w) && !word_is_zero(w))
}

// ---------------------------------------------------------------------------
// Old V4 pools: key from the swap's own receipt (dex bot lesson, PR #211)
// ---------------------------------------------------------------------------
//
// Plain English:
//   A V4 Swap log only carries the pool's id (a hash of its key). For pools
//   made before our run we never saw the Initialize event. Searching the
//   whole chain history for it failed for the dex bot (Chainstack times out
//   or refuses), so instead:
//     1. read the swap transaction's receipt (1 request),
//     2. the ERC-20 Transfer logs to or from the PoolManager name the coins
//        that moved (native ETH moves without a Transfer log, so it is
//        always tried too),
//     3. hash every coin pair with every fee / tick-spacing setting the dex
//        bot has seen on Robinhood (hooks = none) and keep the one whose hash
//        equals the pool id. A match is exact, never a guess.
//   Hooked pools or unusual settings don't match and stay "unknown v4 pool".
//   At most KeyLookupBudget::PER_HOUR receipts an hour, each pool tried at
//   most once an hour.

/// Fee / tick-spacing settings seen on Robinhood V4 pools (dex bot
/// src/config/v4Tiers.ts: STANDARD_V4_TIERS + EXTRA_V4_TIERS).
pub const V4_TIERS: &[(u32, i32)] = &[
    (500, 10), (3000, 60), (10000, 200), (100, 1),
    (200, 4), (310, 3), (450, 9), (460, 9), (500, 1), (500, 5), (800, 5), (1000, 2), (1000, 10),
    (1200, 15), (1500, 15), (2000, 20), (2300, 23), (2400, 24), (2500, 25), (2690, 54), (3000, 30),
    (5000, 50), (7500, 75), (8000, 80), (9000, 90), (9900, 99), (10000, 100), (19000, 190),
    (25000, 250), (28000, 280), (32000, 320),
];

/// keccak("Transfer(address,address,uint256)")
pub const SIG_TRANSFER: &str = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

fn topic_is(t: &Value, addr: &str) -> bool {
    t.as_str().is_some_and(|x| x.len() >= 42 && x[x.len() - 40..].eq_ignore_ascii_case(addr.trim_start_matches("0x")))
}

/// Coins that moved to or from the PoolManager in this receipt, plus native ETH.
pub fn currencies_from_receipt(receipt: &Value) -> Vec<String> {
    let mut out = vec![NATIVE_ETH.to_string()];
    for l in receipt["logs"].as_array().into_iter().flatten() {
        let t = &l["topics"];
        if t[0].as_str().map(str::to_ascii_lowercase).as_deref() != Some(SIG_TRANSFER) {
            continue;
        }
        if !(topic_is(&t[1], V4_POOL_MANAGER) || topic_is(&t[2], V4_POOL_MANAGER)) {
            continue;
        }
        if let Some(a) = l["address"].as_str().map(str::to_ascii_lowercase) {
            if !out.contains(&a) {
                out.push(a);
            }
        }
    }
    out
}

/// The hook-free key among (coin pairs x V4_TIERS) whose id is `id`.
pub fn match_v4_key(id: &str, currencies: &[String]) -> Option<V4Key> {
    let id = id.to_ascii_lowercase();
    for (i, a) in currencies.iter().enumerate() {
        for b in &currencies[i + 1..] {
            let (c0, c1) = if a < b { (a, b) } else { (b, a) };
            for (fee, ts) in V4_TIERS {
                let k = V4Key { currency0: c0.clone(), currency1: c1.clone(), fee: *fee, tick_spacing: *ts, hooks: NATIVE_ETH.to_string() };
                if k.id() == id {
                    return Some(k);
                }
            }
        }
    }
    None
}

/// Limits receipt lookups: PER_HOUR per clock hour, one try per pool per hour.
#[derive(Clone, Debug, Default)]
pub struct KeyLookupBudget {
    hour: u64,
    used: u32,
    tried: HashMap<String, u64>,
}

impl KeyLookupBudget {
    pub const PER_HOUR: u32 = 60;
    /// May we look this pool up now (`hour` = unix hours)? Records the try.
    pub fn take(&mut self, id: &str, hour: u64) -> bool {
        if hour != self.hour {
            self.hour = hour;
            self.used = 0;
            self.tried.retain(|_, h| *h == hour);
        }
        if self.used >= Self::PER_HOUR || self.tried.contains_key(id) {
            return false;
        }
        self.used += 1;
        self.tried.insert(id.to_string(), hour);
        true
    }
}

/// Every V4 pool key we know, saved next to the run's files so a restart
/// keeps them (a pool's Initialize event happens only once, ever).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct V4Keys {
    pub keys: BTreeMap<String, V4Key>,
    /// Keys from the shared history read: looked up, never re-saved here
    /// (that file is written by deploy/v4-history.py).
    shared: HashMap<String, V4Key>,
    dirty: bool,
}

impl V4Keys {
    pub const FILE: &'static str = "v4_pool_keys.json";
    /// Memory guard: we only keep keys of pools we could trade (one side
    /// WETH/USDG/ETH), but cap the file anyway.
    pub const MAX: usize = 2_000_000;

    /// Missing file = empty (first run). A damaged file is ignored with an
    /// error message (unlike the blocklist, losing keys is safe: those pools
    /// are just skipped as "unknown v4 pool").
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = match fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        let v: Value = serde_json::from_str(&text).map_err(|e| format!("{} is damaged ({e})", path.display()))?;
        let mut out = V4Keys::default();
        for (id, k) in v.as_object().into_iter().flatten() {
            let key = V4Key {
                currency0: k["c0"].as_str().unwrap_or("").to_ascii_lowercase(),
                currency1: k["c1"].as_str().unwrap_or("").to_ascii_lowercase(),
                fee: k["fee"].as_u64().unwrap_or(0) as u32,
                tick_spacing: k["ts"].as_i64().unwrap_or(0) as i32,
                hooks: k["hooks"].as_str().unwrap_or(NATIVE_ETH).to_ascii_lowercase(),
            };
            // Only keep entries whose key really gives this id.
            if key.id() == id.to_ascii_lowercase() {
                out.keys.insert(key.id(), key);
            }
        }
        Ok(out)
    }

    /// Save (temp file then rename) if anything changed since the last save.
    pub fn save_if_dirty(&mut self, path: &Path) -> Result<(), String> {
        if !self.dirty {
            return Ok(());
        }
        let obj: serde_json::Map<String, Value> = self
            .keys
            .iter()
            .map(|(id, k)| (id.clone(), json!({"c0": k.currency0, "c1": k.currency1, "fee": k.fee, "ts": k.tick_spacing, "hooks": k.hooks})))
            .collect();
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_string(&Value::Object(obj)).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        self.dirty = false;
        Ok(())
    }

    /// Add a key. Returns true if it was new.
    pub fn insert(&mut self, key: V4Key) -> bool {
        let id = key.id();
        if self.keys.contains_key(&id) || self.shared.contains_key(&id) || self.keys.len() >= Self::MAX {
            return false;
        }
        self.keys.insert(id, key);
        self.dirty = true;
        true
    }

    /// Add every key from another file (the shared history read,
    /// deploy/v4-history.py). Returns how many were new.
    pub fn merge(&mut self, other: V4Keys) -> usize {
        let before = self.shared.len();
        for (id, k) in other.keys {
            if !self.keys.contains_key(&id) && self.shared.len() < Self::MAX {
                self.shared.insert(id, k);
            }
        }
        self.shared.len() - before
    }

    /// All keys known (this run's plus the shared history read).
    pub fn len(&self) -> usize {
        self.keys.len() + self.shared.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn get(&self, id: &str) -> Option<&V4Key> {
        let id = id.to_ascii_lowercase();
        self.keys.get(&id).or_else(|| self.shared.get(&id))
    }
}

// ---------------------------------------------------------------------------
// Uniswap V2: events, reserves maths
// ---------------------------------------------------------------------------

pub fn sig_v2_swap() -> String {
    topic0("Swap(address,uint256,uint256,uint256,uint256,address)")
}
pub fn sig_v2_sync() -> String {
    topic0("Sync(uint112,uint112)")
}

/// The two reserves from a Sync log's data or a getReserves() reply (both
/// start with reserve0, reserve1).
pub fn v2_reserves(data: &str) -> Option<(U256, U256)> {
    let w = words(data);
    Some((word_u256(w.first()?)?, word_u256(w.get(1)?)?))
}

/// What a V2 pair pays out for `amount_in` (UniswapV2Library.getAmountOut,
/// 0.30% fee): out = in*997*rOut / (rIn*1000 + in*997). Zero for an empty
/// pool or zero input.
pub fn v2_amount_out(amount_in: U256, r_in: U256, r_out: U256) -> U256 {
    if amount_in.is_zero() || r_in.is_zero() || r_out.is_zero() {
        return U256::ZERO;
    }
    let fee_keep = U256::from(1_000_000u64 - V2_FEE_PPM as u64); // 997,000 of 1,000,000
    let with_fee = amount_in * fee_keep;
    with_fee * r_out / (r_in * U256::from(1_000_000u64) + with_fee)
}

/// Spot price of the token in base (raw units, same convention as V3's
/// token_price): base reserve / token reserve.
pub fn v2_price(r0: U256, r1: U256, token_is0: bool) -> Option<f64> {
    let (base, token) = if token_is0 { (f64::from(r1), f64::from(r0)) } else { (f64::from(r0), f64::from(r1)) };
    let p = base / token;
    (token > 0.0 && p > 0.0 && p.is_finite()).then_some(p)
}

/// Was this V2 swap a SELL of the token? V2 Swap data = amount0In,
/// amount1In, amount0Out, amount1Out. A sell = the pair paid OUT base.
pub fn is_sell_v2(w: &[&str], token_is0: bool) -> bool {
    let base_out = if token_is0 { w.get(3) } else { w.get(2) };
    base_out.is_some_and(|w| w.len() == 64 && !word_is_zero(w))
}

// ---------------------------------------------------------------------------
// Real buyers (V4 swap logs don't name the buyer)
// ---------------------------------------------------------------------------

/// A V4 Swap log's only address is the "sender": the router contract that
/// called the PoolManager, not the person. So a V4 buy is first counted by
/// its TRANSACTION, and when a rush fires the transactions are looked up
/// (who signed them) and counted again as wallets (see distinct_buyers).
pub fn swap_buyer_v4(log: &Value) -> String {
    log["transactionHash"].as_str().unwrap_or("").to_ascii_lowercase()
}

/// Is this buyer id a transaction hash (to look up) rather than a wallet?
pub fn is_tx_hash(id: &str) -> bool {
    id.len() == 66 && id.starts_with("0x")
}

/// Count different buyer WALLETS. Wallet ids count as themselves; tx hashes
/// count as the wallet that signed them (`signer_of`). A hash we could not
/// look up is NOT counted (the safe direction: fewer buyers, fewer trades).
pub fn distinct_buyers(ids: &[String], signer_of: &HashMap<String, String>) -> usize {
    let mut set: std::collections::HashSet<String> = std::collections::HashSet::new();
    for id in ids {
        if is_tx_hash(id) {
            if let Some(w) = signer_of.get(&id.to_ascii_lowercase()) {
                set.insert(w.to_ascii_lowercase());
            }
        } else {
            set.insert(id.to_ascii_lowercase());
        }
    }
    set.len()
}

/// Read a batch of eth_getTransactionByHash replies into hash -> signer.
pub fn signers_from_replies(replies: &Value) -> HashMap<String, String> {
    replies
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let tx = &r["result"];
            Some((tx["hash"].as_str()?.to_ascii_lowercase(), tx["from"].as_str()?.to_ascii_lowercase()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn shared_keys_are_found_but_not_resaved() {
        let k = V4Key { currency0: NATIVE_ETH.into(), currency1: "0x1111111111111111111111111111111111111111".into(), fee: 3000, tick_spacing: 60, hooks: NATIVE_ETH.into() };
        let mut shared = V4Keys::default();
        assert!(shared.insert(k.clone()));
        let mut mine = V4Keys::default();
        assert_eq!(mine.merge(shared), 1);
        assert_eq!(mine.get(&k.id().to_ascii_uppercase().replace("0X", "0x")), Some(&k));
        assert!(!mine.insert(k.clone())); // already known: not added to this run's file
        assert!(mine.keys.is_empty());
        assert_eq!(mine.len(), 1);
    }

    use super::*;

    const WETH: &str = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
    const USDG: &str = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

    fn key(c0: &str, c1: &str, fee: u32, ts: i32, hooks: &str) -> V4Key {
        V4Key { currency0: c0.into(), currency1: c1.into(), fee, tick_spacing: ts, hooks: hooks.into() }
    }

    #[test]
    fn venues_parse() {
        assert_eq!(parse_venues("v3,v4,v2").unwrap(), vec![VenueKind::V3, VenueKind::V4, VenueKind::V2]);
        assert_eq!(parse_venues(" V2 , v3,v2").unwrap(), vec![VenueKind::V3, VenueKind::V2]);
        assert!(parse_venues("v3,v5").is_err());
        assert!(parse_venues(" , ").is_err());
    }

    #[test]
    fn pool_id_matches_known_vectors() {
        // Ethereum mainnet ETH/USDC 0.05% V4 pool: its published id.
        let eth_usdc = key(NATIVE_ETH, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 500, 10, NATIVE_ETH);
        assert_eq!(eth_usdc.id(), "0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27");
        // Same formula as the dex bot's v4IdSlow (abi.encode of 5 words), values
        // computed independently with Python keccak for this test.
        assert_eq!(key(WETH, USDG, 3000, 60, NATIVE_ETH).id(), "0x77c25b9386d47de62e0155c393696e9f43f7e6d036c6ca52f66735ccbb8808a7");
        assert_eq!(key(NATIVE_ETH, USDG, 500, 10, NATIVE_ETH).id(), "0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982");
        // Negative tick spacing (sign-extended), dynamic fee, and a hook.
        assert_eq!(
            key(WETH, USDG, 0x80_0000, -1, "0x000000000000000000000000000000000000beef").id(),
            "0x01d7d38a0272ee7e97b0edf6bac1a4f0218b513ffc7f42e7ff02090a9ef20ccb"
        );
    }

    #[test]
    fn hook_flags_decode() {
        assert_eq!(hook_flags(NATIVE_ETH), 0);
        assert!(!hook_changes_amounts(NATIVE_ETH));
        // beforeSwap + afterSwap only (0xc0): may refuse or set the fee, but
        // can't change amounts -> allowed.
        let fee_hook = "0x00000000000000000000000000000000000000c0";
        assert_eq!(hook_flags(fee_hook), HOOK_BEFORE_SWAP | HOOK_AFTER_SWAP);
        assert!(!hook_changes_amounts(fee_hook));
        // beforeSwapReturnDelta (bit 3) or afterSwapReturnDelta (bit 2) -> unsafe.
        assert!(hook_changes_amounts("0x0000000000000000000000000000000000000088"));
        assert!(hook_changes_amounts("0x1234000000000000000000000000000000000044"));
        // Only the last 14 bits count (bit 14+ of the address is ignored).
        assert_eq!(hook_flags("0x000000000000000000000000000000000000c000"), 0);
        assert!(!hook_changes_amounts("0x000000000000000000000000000000000000fff3"));
        assert!(hook_changes_amounts("0x000000000000000000000000000000000000fff4"));
    }

    fn init_log(k: &V4Key, id: &str) -> Value {
        let t = |a: &str| format!("0x{}", word_addr(a));
        json!({
            "address": V4_POOL_MANAGER,
            "topics": [sig_v4_init(), id, t(&k.currency0), t(&k.currency1)],
            "data": format!("0x{}{}{}{}{}", int_word(k.fee as i64), int_word(k.tick_spacing as i64), word_addr(&k.hooks), int_word(1 << 40), int_word(-5)),
        })
    }

    #[test]
    fn v4_init_decodes_and_checks_the_id() {
        let k = key(NATIVE_ETH, USDG, 0x80_0000, -1, "0x00000000000000000000000000000000000000c0");
        let (id, got) = decode_v4_init(&init_log(&k, &k.id())).unwrap();
        assert_eq!(id, k.id());
        assert_eq!(got, k);
        assert_eq!(got.fee_ppm(), 0); // dynamic fee shows as 0, key keeps 0x800000
        // Wrong id (key doesn't hash to it) -> refused.
        assert!(decode_v4_init(&init_log(&k, &format!("0x{:064x}", 1))).is_none());
        // Not from the PoolManager -> refused.
        let mut other = init_log(&k, &k.id());
        other["address"] = json!("0x1111111111111111111111111111111111111111");
        assert!(decode_v4_init(&other).is_none());
    }

    #[test]
    fn v4_quote_selector_and_layout() {
        // Selector of the IV4Quoter.sol signature (independently computed: 0xaa9d21cb).
        let k = key(NATIVE_ETH, USDG, 500, 10, NATIVE_ETH);
        let d = data_v4_quote(&k, true, U256::from(1000u64)).unwrap();
        assert!(d.starts_with("0xaa9d21cb"), "{d}");
        // selector + offset + 5 key words + zeroForOne + amount + hookData offset + hookData length
        assert_eq!(d.len(), 2 + 8 + 64 * 10);
        let w = words(&d[10..]);
        assert_eq!(w[0], int_word(0x20));
        assert_eq!(w[1], word_addr(NATIVE_ETH));
        assert_eq!(w[2], word_addr(USDG));
        assert_eq!(w[3], int_word(500));
        assert_eq!(w[4], int_word(10));
        assert_eq!(w[5], word_addr(NATIVE_ETH));
        assert_eq!(w[6], int_word(1));
        assert_eq!(w[7], int_word(1000));
        assert_eq!(w[8], int_word(0x100)); // 8 words into the struct
        assert_eq!(w[9], int_word(0));
        // Negative tick spacing is sign-extended; zeroForOne false = 0.
        let d2 = data_v4_quote(&key(WETH, USDG, 3000, -60, NATIVE_ETH), false, U256::from(1u64)).unwrap();
        let w2 = words(&d2[10..]);
        assert_eq!(w2[4], "f".repeat(62) + "c4");
        assert_eq!(w2[6], int_word(0));
        // Too big for uint128 -> refused.
        assert!(data_v4_quote(&k, true, U256::from(u128::MAX) + U256::from(1u64)).is_err());
    }

    #[test]
    fn v4_direction_and_reply() {
        let k = key(NATIVE_ETH, USDG, 500, 10, NATIVE_ETH);
        assert_eq!(v4_zero_for_one(&k, NATIVE_ETH), Some(true));
        assert_eq!(v4_zero_for_one(&k, &USDG.to_ascii_uppercase().replace("0X", "0x")), Some(false));
        assert_eq!(v4_zero_for_one(&k, WETH), None);
        let reply = format!("0x{:064x}{:064x}", 12345u64, 98765u64);
        assert_eq!(parse_v4_quote(&reply).unwrap(), (U256::from(12345u64), 98765));
        assert!(parse_v4_quote("0x").is_err());
    }

    #[test]
    fn v4_sell_is_base_received_by_swapper() {
        let neg = "f".repeat(60) + "fc18"; // -1000
        let pos = format!("{:064x}", 1000);
        let zero = format!("{:064x}", 0);
        // token is currency0, base currency1: swapper got base (+) = sell
        assert!(is_sell_v4(&[neg.as_str(), pos.as_str()], true));
        assert!(!is_sell_v4(&[pos.as_str(), neg.as_str()], true)); // paid base = buy
        // token is currency1, base currency0
        assert!(is_sell_v4(&[pos.as_str(), neg.as_str()], false));
        assert!(!is_sell_v4(&[neg.as_str(), pos.as_str()], false));
        assert!(!is_sell_v4(&[zero.as_str(), zero.as_str()], false));
        assert!(!is_sell_v4(&[], true));
    }

    #[test]
    fn key_found_from_receipt_transfers() {
        let token = "0x1111111111111111111111111111111111111111";
        let pm = V4_POOL_MANAGER.trim_start_matches("0x");
        let user = "000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        // The real pool: ETH(native)/token at a non-standard setting, no hook.
        let real = V4Key { currency0: NATIVE_ETH.into(), currency1: token.into(), fee: 2500, tick_spacing: 25, hooks: NATIVE_ETH.into() };
        let receipt = json!({"logs": [
            // token sent from the PoolManager to the user (a buy)
            {"address": token, "topics": [SIG_TRANSFER, format!("0x000000000000000000000000{pm}"), format!("0x{user}")]},
            // unrelated transfer elsewhere in the tx: ignored
            {"address": "0x2222222222222222222222222222222222222222", "topics": [SIG_TRANSFER, format!("0x{user}"), format!("0x{user}")]},
        ]});
        let cur = currencies_from_receipt(&receipt);
        assert_eq!(cur, vec![NATIVE_ETH.to_string(), token.to_string()]);
        assert_eq!(match_v4_key(&real.id(), &cur), Some(real.clone()));
        // A hooked pool (or unknown setting) never matches: stays unknown.
        let hooked = V4Key { hooks: "0x00000000000000000000000000000000000000c0".into(), ..real.clone() };
        assert_eq!(match_v4_key(&hooked.id(), &cur), None);
        let odd = V4Key { fee: 1234, tick_spacing: 7, ..real };
        assert_eq!(match_v4_key(&odd.id(), &cur), None);
    }

    #[test]
    fn key_budget_once_per_pool_per_hour_and_capped() {
        let mut b = KeyLookupBudget::default();
        assert!(b.take("0xa", 10));
        assert!(!b.take("0xa", 10)); // same pool, same hour
        assert!(b.take("0xa", 11)); // next hour: may try again
        let mut b = KeyLookupBudget::default();
        for i in 0..KeyLookupBudget::PER_HOUR {
            assert!(b.take(&format!("0x{i}"), 5));
        }
        assert!(!b.take("0xnew", 5)); // hourly cap
        assert!(b.take("0xnew", 6));
    }

    #[test]
    fn v4_keys_save_and_load() {
        let dir = std::env::temp_dir().join(format!("sniper-v4keys-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(V4Keys::FILE);
        let mut ks = V4Keys::load(&path).unwrap();
        assert!(ks.keys.is_empty());
        let k = key(NATIVE_ETH, USDG, 0x80_0000, -1, "0x00000000000000000000000000000000000000c0");
        assert!(ks.insert(k.clone()));
        assert!(!ks.insert(k.clone()));
        ks.save_if_dirty(&path).unwrap();
        let back = V4Keys::load(&path).unwrap();
        assert_eq!(back.get(&k.id().to_ascii_uppercase().replace("0X", "0x")), Some(&k));
        // A tampered entry (key doesn't match id) is dropped on load.
        fs::write(&path, json!({"0x01": {"c0": NATIVE_ETH, "c1": USDG, "fee": 500, "ts": 10, "hooks": NATIVE_ETH}}).to_string()).unwrap();
        assert!(V4Keys::load(&path).unwrap().keys.is_empty());
        fs::write(&path, "{nope").unwrap();
        assert!(V4Keys::load(&path).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn v2_event_ids_are_uniswaps() {
        assert_eq!(sig_v2_swap(), "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822");
        assert_eq!(sig_v2_sync(), "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1");
    }

    #[test]
    fn v2_maths() {
        // Textbook: 1,000 in to a 1,000,000 / 1,000,000 pool -> 996 out (0.3% fee + impact).
        let m = U256::from(1_000_000u64);
        assert_eq!(v2_amount_out(U256::from(1000u64), m, m), U256::from(996u64));
        // Matches getAmountOut's integer formula exactly on a big case.
        let (a, ri, ro) = (U256::from(10u64).pow(U256::from(18)), U256::from(5u64) * U256::from(10u64).pow(U256::from(20)), U256::from(123_456_789_000u64));
        let expect = a * U256::from(997u64) * ro / (ri * U256::from(1000u64) + a * U256::from(997u64));
        assert_eq!(v2_amount_out(a, ri, ro), expect);
        assert_eq!(v2_amount_out(U256::ZERO, m, m), U256::ZERO);
        assert_eq!(v2_amount_out(U256::from(5u64), U256::ZERO, m), U256::ZERO);
        // Round trip always loses (fees both ways).
        let toks = v2_amount_out(U256::from(10_000u64), m, m);
        let back = v2_amount_out(toks, m - toks, m + U256::from(10_000u64));
        assert!(back < U256::from(10_000u64));
        // Reserves from data, price oriented to "base per token".
        let data = format!("0x{:064x}{:064x}{:064x}", 4000u64, 2u64, 99u64);
        let (r0, r1) = v2_reserves(&data).unwrap();
        assert_eq!((r0, r1), (U256::from(4000u64), U256::from(2u64)));
        assert_eq!(v2_price(r0, r1, true), Some(0.0005)); // token0, base1: 2/4000
        assert_eq!(v2_price(r0, r1, false), Some(2000.0)); // token1, base0: 4000/2
        assert_eq!(v2_price(U256::ZERO, r1, true), None);
        assert!(v2_reserves("0x12").is_none());
    }

    #[test]
    fn v2_sell_is_base_paid_out() {
        let z = format!("{:064x}", 0);
        let n = format!("{:064x}", 5);
        // token0, base1: amount1Out > 0 = sell
        assert!(is_sell_v2(&[n.as_str(), z.as_str(), z.as_str(), n.as_str()], true));
        assert!(!is_sell_v2(&[z.as_str(), n.as_str(), n.as_str(), z.as_str()], true));
        // token1, base0: amount0Out > 0 = sell
        assert!(is_sell_v2(&[z.as_str(), n.as_str(), n.as_str(), z.as_str()], false));
        assert!(!is_sell_v2(&[], false));
    }

    #[test]
    fn holder_and_dry_fire_rules() {
        let v4 = Venue::V4 { key: key(NATIVE_ETH, USDG, 500, 10, NATIVE_ETH) };
        assert_eq!(token_holder(&v4, "0xabc"), V4_POOL_MANAGER);
        assert_eq!(token_holder(&Venue::V3 { fee: 500 }, "0xABC"), "0xabc");
        assert_eq!(token_holder(&Venue::V2 { pair: "0xp".into(), token0: "0xt".into() }, "0xp"), "0xp");
        assert!(dry_fire_supported(VenueKind::V3).is_ok());
        assert!(dry_fire_supported(VenueKind::V4).unwrap_err().contains("only Uniswap V3"));
        assert!(dry_fire_supported(VenueKind::V2).unwrap_err().contains("V2"));
    }

    #[test]
    fn buyers_counted_as_signing_wallets() {
        let h = |n: u8| format!("0x{:064x}", n);
        let ids = vec![h(1), h(2), h(3), "0x000000000000000000000000000000000000beef".to_string()];
        // Three transactions, two signed by the same wallet; one unknown.
        let mut signer = HashMap::new();
        signer.insert(h(1), "0xaaa".to_string());
        signer.insert(h(2), "0xAAA".to_string());
        assert_eq!(distinct_buyers(&ids, &signer), 2); // 0xaaa + beef; h(3) not counted
        signer.insert(h(3), "0xbbb".to_string());
        assert_eq!(distinct_buyers(&ids, &signer), 3);
        let replies = json!([{"id": 1, "result": {"hash": h(9), "from": "0xCCC"}}, {"id": 2, "result": null}]);
        let m = signers_from_replies(&replies);
        assert_eq!(m.get(&h(9)).map(String::as_str), Some("0xccc"));
        assert_eq!(m.len(), 1);
        assert_eq!(swap_buyer_v4(&json!({"transactionHash": "0xABC"})), "0xabc");
        assert!(is_tx_hash(&h(1)) && !is_tx_hash("0xbeef"));
    }
}
