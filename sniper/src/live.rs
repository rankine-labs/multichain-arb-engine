// ============================================================================
// LIVE SENDER (Robinhood Chain) - OFF BY DEFAULT
//
// Plain English:
//   This is the part that turns a paper trade into a real one: it builds the
//   swap, signs it with the sniper's own wallet key, sends it, and waits for
//   the chain to say what actually happened. Nothing here runs unless the
//   live gate (below) is fully open, and the auto-run script does not even
//   allow a live mode yet.
//
//   Pieces:
//     Signer        holds the key (read from a 0600 file, never from chat or
//                   env), signs EIP-1559 transactions. Debug never shows it.
//     calldata      Uniswap SwapRouter02 exactInputSingle wrapped in
//                   multicall(deadline, ...): every swap has a minimum output
//                   AND an expiry, so a slow or bad fill reverts instead of
//                   losing money.
//     Gate          the live switch. ALL of these must hold or nothing is
//                   sent: SNIPER_LIVE=1, the exact approval phrase, a key file
//                   only the owner can read, trade size and daily loss inside
//                   hard ceilings compiled into the program.
//     Ledger        today's realized loss, saved to disk so a restart cannot
//                   reset the daily stop.
//     Sender        nonce, gas, send, and receipt tracking. A trade counts
//                   only when its receipt says status 1. Broadcast is not
//                   success.
//     dry_fire      the SAME buy and sell calls, run in a free chain
//                   simulation (eth_simulateV1) with a throwaway wallet. It
//                   proves the calldata works on real pools and measures the
//                   real fill against the quote. No key, no money.
// ============================================================================
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ruint::aliases::U256;
use secp256k1::{Message, PublicKey, SecretKey, SECP256K1};
use serde_json::{json, Value};
use zeroize::Zeroize;

use crate::fourmeme::{hex, keccak};
use crate::sellcheck::Rpc;

/// Robinhood Chain id.
pub const CHAIN_ID: u64 = 4663;
/// Uniswap SwapRouter02 on Robinhood Chain (from src/config/knownAddresses.ts,
/// bytecode verified by the dex bot).
pub const SWAP_ROUTER_02: &str = "0xcaf681a66d020601342297493863e78c959e5cb2";
/// Where signed trades go: straight to Robinhood's sequencer, like the arb
/// bot (PR #19: "sends to sequencer.mainnet.chain.robinhood.com"). Reads
/// (nonce, gas, receipts) still use our normal node. SNIPER_SEND_RPC overrides.
pub const SEQUENCER_RPC: &str = "https://sequencer.mainnet.chain.robinhood.com";

/// The send endpoint: SNIPER_SEND_RPC, else the sequencer.
pub fn send_url_from_env() -> String {
    std::env::var("SNIPER_SEND_RPC").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| SEQUENCER_RPC.to_string())
}

/// Hard ceilings. The settings can only go LOWER than these; raising them
/// means changing this file, which is a deliberate owner decision.
pub const HARD_MAX_TRADE_USD: f64 = 10.0;
pub const HARD_MAX_DAY_LOSS_USD: f64 = 20.0;
/// The phrase SNIPER_LIVE_ACK must equal. Stops a copy-pasted "=1" from
/// switching on real money by accident.
pub const LIVE_ACK_PHRASE: &str = "I approve real money trading";

// ---------------------------------------------------------------------------
// Small encoders
// ---------------------------------------------------------------------------

/// 20-byte address from "0x..." text.
pub fn addr_bytes(a: &str) -> Result<[u8; 20], String> {
    let h = a.trim().trim_start_matches("0x");
    if h.len() != 40 {
        return Err(format!("bad address {a}"));
    }
    let mut out = [0u8; 20];
    for i in 0..20 {
        out[i] = u8::from_str_radix(&h[2 * i..2 * i + 2], 16).map_err(|_| format!("bad address {a}"))?;
    }
    Ok(out)
}

fn word_u(v: U256) -> [u8; 32] {
    v.to_be_bytes::<32>()
}

fn word_addr(a: &str) -> Result<[u8; 32], String> {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(&addr_bytes(a)?);
    Ok(w)
}

fn selector(sig: &str) -> [u8; 4] {
    let h = keccak(sig.as_bytes());
    [h[0], h[1], h[2], h[3]]
}

/// RLP: one byte string.
fn rlp_bytes(b: &[u8]) -> Vec<u8> {
    if b.len() == 1 && b[0] < 0x80 {
        return vec![b[0]];
    }
    let mut out = rlp_len(0x80, b.len());
    out.extend_from_slice(b);
    out
}

/// RLP: an unsigned number (big-endian, no leading zeros; zero is empty).
fn rlp_uint(v: U256) -> Vec<u8> {
    let b = v.to_be_bytes::<32>();
    let first = b.iter().position(|x| *x != 0).unwrap_or(32);
    rlp_bytes(&b[first..])
}

/// RLP length prefix (0x80 for strings, 0xc0 for lists).
fn rlp_len(base: u8, len: usize) -> Vec<u8> {
    if len < 56 {
        return vec![base + len as u8];
    }
    let lb = (len as u64).to_be_bytes();
    let first = lb.iter().position(|x| *x != 0).unwrap_or(7);
    let mut out = vec![base + 55 + (8 - first) as u8];
    out.extend_from_slice(&lb[first..]);
    out
}

// ---------------------------------------------------------------------------
// Calldata
// ---------------------------------------------------------------------------

/// ERC-20 approve(spender, amount).
pub fn data_approve(spender: &str, amount: U256) -> Result<Vec<u8>, String> {
    let mut d = selector("approve(address,uint256)").to_vec();
    d.extend(word_addr(spender)?);
    d.extend(word_u(amount));
    Ok(d)
}

/// ERC-20 balanceOf(who).
pub fn data_balance(who: &str) -> Result<Vec<u8>, String> {
    let mut d = selector("balanceOf(address)").to_vec();
    d.extend(word_addr(who)?);
    Ok(d)
}

/// ERC-20 transfer(to, amount) (used only inside simulations).
pub fn data_transfer(to: &str, amount: U256) -> Result<Vec<u8>, String> {
    let mut d = selector("transfer(address,uint256)").to_vec();
    d.extend(word_addr(to)?);
    d.extend(word_u(amount));
    Ok(d)
}

/// SwapRouter02.exactInputSingle((tokenIn, tokenOut, fee, recipient,
/// amountIn, amountOutMinimum, sqrtPriceLimitX96)) wrapped in
/// multicall(uint256 deadline, bytes[] data), so the swap expires.
pub fn data_swap(token_in: &str, token_out: &str, fee: u32, recipient: &str, amount_in: U256, min_out: U256, deadline: u64) -> Result<Vec<u8>, String> {
    let mut inner = selector("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))").to_vec();
    inner.extend(word_addr(token_in)?);
    inner.extend(word_addr(token_out)?);
    inner.extend(word_u(U256::from(fee)));
    inner.extend(word_addr(recipient)?);
    inner.extend(word_u(amount_in));
    inner.extend(word_u(min_out));
    inner.extend(word_u(U256::ZERO)); // no price limit: min_out protects us
    // multicall(uint256,bytes[]): deadline, offset of the array (0x40),
    // array length 1, offset of element 0 (0x20), element length, element
    // bytes padded to 32.
    let mut d = selector("multicall(uint256,bytes[])").to_vec();
    d.extend(word_u(U256::from(deadline)));
    d.extend(word_u(U256::from(0x40u64)));
    d.extend(word_u(U256::from(1u64)));
    d.extend(word_u(U256::from(0x20u64)));
    d.extend(word_u(U256::from(inner.len() as u64)));
    let pad = (32 - inner.len() % 32) % 32;
    d.extend(inner);
    d.extend(std::iter::repeat_n(0u8, pad));
    Ok(d)
}

/// Least we accept: `quoted` minus `slip_bps` (1 bps = 0.01%).
pub fn min_out(quoted: U256, slip_bps: u64) -> U256 {
    quoted * U256::from(10_000u64.saturating_sub(slip_bps)) / U256::from(10_000u64)
}

// ---------------------------------------------------------------------------
// Signer
// ---------------------------------------------------------------------------

/// One EIP-1559 transaction before signing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TxFields {
    pub nonce: u64,
    pub max_priority_fee: u128,
    pub max_fee: u128,
    pub gas_limit: u64,
    pub to: String,
    pub value: U256,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct SignedTx {
    pub raw: Vec<u8>,
    pub hash: String,
}

impl SignedTx {
    pub fn raw_hex(&self) -> String {
        format!("0x{}", hex(&self.raw))
    }
}

fn encode_fields(f: &TxFields) -> Result<Vec<u8>, String> {
    let mut b = Vec::with_capacity(f.data.len() + 96);
    b.extend(rlp_uint(U256::from(CHAIN_ID)));
    b.extend(rlp_uint(U256::from(f.nonce)));
    b.extend(rlp_uint(U256::from(f.max_priority_fee)));
    b.extend(rlp_uint(U256::from(f.max_fee)));
    b.extend(rlp_uint(U256::from(f.gas_limit)));
    b.extend(rlp_bytes(&addr_bytes(&f.to)?));
    b.extend(rlp_uint(f.value));
    b.extend(rlp_bytes(&f.data));
    b.push(0xc0); // empty access list
    Ok(b)
}

/// 32 random bytes for THROWAWAY keys (dry-fire and tests only; the live
/// wallet always comes from its key file). Unix: the OS random device.
/// Elsewhere (the Windows build): std's per-process random hash keys, which
/// the OS seeds; fine for a key that never holds money.
fn random_bytes() -> Result<[u8; 32], String> {
    let mut b = [0u8; 32];
    #[cfg(unix)]
    {
        use std::io::Read;
        std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).map_err(|e| format!("no random source: {}", e.kind()))?;
    }
    #[cfg(not(unix))]
    {
        use std::hash::{BuildHasher, Hasher};
        for (i, chunk) in b.chunks_mut(8).enumerate() {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_usize(i);
            h.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
            chunk.copy_from_slice(&h.finish().to_le_bytes());
        }
    }
    Ok(b)
}

/// The sniper's wallet. The key lives only in here and is wiped on drop.
pub struct Signer {
    key: SecretKey,
    address: String,
}

impl std::fmt::Debug for Signer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Signer({})", self.address)
    }
}

impl Drop for Signer {
    fn drop(&mut self) {
        self.key.non_secure_erase();
    }
}

fn address_of(pk: &PublicKey) -> String {
    let un = pk.serialize_uncompressed();
    format!("0x{}", hex(&keccak(&un[1..])[12..]))
}

impl Signer {
    /// From 32 key bytes; the caller's buffer is wiped.
    pub fn from_bytes(bytes: &mut [u8; 32]) -> Result<Signer, String> {
        let key = SecretKey::from_byte_array(*bytes).map_err(|_| "not a valid private key".to_string());
        bytes.zeroize();
        let key = key?;
        let address = address_of(&PublicKey::from_secret_key(SECP256K1, &key));
        Ok(Signer { key, address })
    }

    /// From hex text. Errors never contain the input.
    pub fn from_hex(text: &str) -> Result<Signer, String> {
        let t = text.trim();
        let t = t.strip_prefix("0x").unwrap_or(t);
        if t.len() != 64 {
            return Err("private key must be 32 bytes of hex".into());
        }
        let mut b = [0u8; 32];
        for i in 0..32 {
            match u8::from_str_radix(&t[2 * i..2 * i + 2], 16) {
                Ok(v) => b[i] = v,
                Err(_) => {
                    b.zeroize();
                    return Err("private key is not hex".into());
                }
            }
        }
        Signer::from_bytes(&mut b)
    }

    /// From a key file that only its owner can read (chmod 600). Refuses a
    /// file anyone else could read, so a sloppy copy can't leak the key.
    pub fn from_file(path: &Path) -> Result<Signer, String> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path).map_err(|e| format!("key file: {}", e.kind()))?.permissions().mode();
            if mode & 0o077 != 0 {
                return Err(format!("key file must be chmod 600 (it is {:o})", mode & 0o777));
            }
        }
        let mut text = std::fs::read_to_string(path).map_err(|e| format!("key file: {}", e.kind()))?;
        let s = Signer::from_hex(&text);
        text.zeroize();
        s
    }

    /// A throwaway key (dry-fire and tests).
    pub fn random() -> Result<Signer, String> {
        for _ in 0..8 {
            let mut b = random_bytes()?;
            if let Ok(s) = Signer::from_bytes(&mut b) {
                return Ok(s);
            }
        }
        Err("could not make a random key".into())
    }

    pub fn address(&self) -> &str {
        &self.address
    }

    /// Sign a type-2 transaction: 0x02 || rlp([fields..., yParity, r, s]).
    pub fn sign(&self, f: &TxFields) -> Result<SignedTx, String> {
        let mut body = encode_fields(f)?;
        let mut msg = vec![0x02];
        msg.extend(rlp_len(0xc0, body.len()));
        msg.extend_from_slice(&body);
        let sig = SECP256K1.sign_ecdsa_recoverable(Message::from_digest(keccak(&msg)), &self.key);
        let (rec, compact) = sig.serialize_compact();
        body.extend(rlp_uint(U256::from(i32::from(rec) as u64)));
        body.extend(rlp_uint(U256::from_be_slice(&compact[..32])));
        body.extend(rlp_uint(U256::from_be_slice(&compact[32..])));
        let mut raw = vec![0x02];
        raw.extend(rlp_len(0xc0, body.len()));
        raw.extend(body);
        let hash = format!("0x{}", hex(&keccak(&raw)));
        Ok(SignedTx { raw, hash })
    }
}

// ---------------------------------------------------------------------------
// Gate and daily-loss ledger
// ---------------------------------------------------------------------------

/// Live limits, already checked against the hard ceilings.
#[derive(Clone, Debug)]
pub struct Gate {
    pub key_file: PathBuf,
    pub max_trade_usd: f64,
    pub max_day_loss_usd: f64,
    pub ledger: PathBuf,
}

impl Gate {
    /// Open only if EVERY condition holds; otherwise the list of reasons.
    pub fn from_lookup(get: &dyn Fn(&str) -> Option<String>) -> Result<Gate, Vec<String>> {
        let mut no = Vec::new();
        if get("SNIPER_LIVE").as_deref() != Some("1") {
            no.push("SNIPER_LIVE is not 1".to_string());
        }
        if get("SNIPER_LIVE_ACK").as_deref() != Some(LIVE_ACK_PHRASE) {
            no.push("owner approval phrase (SNIPER_LIVE_ACK) missing or wrong".to_string());
        }
        let num = |k: &str, d: f64| get(k).and_then(|v| v.parse::<f64>().ok()).unwrap_or(d);
        let max_trade_usd = num("SNIPER_LIVE_MAX_USD", 5.0);
        let max_day_loss_usd = num("SNIPER_LIVE_DAY_LOSS_USD", 10.0);
        if !(max_trade_usd > 0.0 && max_trade_usd <= HARD_MAX_TRADE_USD) {
            no.push(format!("trade size ${max_trade_usd} is outside 0..{HARD_MAX_TRADE_USD}"));
        }
        if !(max_day_loss_usd > 0.0 && max_day_loss_usd <= HARD_MAX_DAY_LOSS_USD) {
            no.push(format!("daily loss ${max_day_loss_usd} is outside 0..{HARD_MAX_DAY_LOSS_USD}"));
        }
        let key_file = PathBuf::from(get("SNIPER_KEY_FILE").unwrap_or_default());
        if key_file.as_os_str().is_empty() {
            no.push("SNIPER_KEY_FILE not set".to_string());
        } else if let Err(e) = Signer::from_file(&key_file) {
            no.push(e);
        }
        let ledger = PathBuf::from(get("SNIPER_LIVE_LEDGER").unwrap_or_else(|| "live-ledger.json".into()));
        if no.is_empty() {
            Ok(Gate { key_file, max_trade_usd, max_day_loss_usd, ledger })
        } else {
            Err(no)
        }
    }

    pub fn from_env() -> Result<Gate, Vec<String>> {
        Gate::from_lookup(&|k| std::env::var(k).ok())
    }
}

/// UTC day number (days since 1970).
pub fn utc_day(now: SystemTime) -> u64 {
    now.duration_since(UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0)
}

/// Today's realized result, on disk. A loss is negative.
#[derive(Clone, Debug, PartialEq)]
pub struct Ledger {
    pub day: u64,
    pub realized_usd: f64,
    pub trades: u64,
}

impl Ledger {
    /// Load; a new UTC day starts from zero. A file we can't read STOPS
    /// trading (error) rather than silently resetting the daily stop.
    pub fn load(path: &Path, today: u64) -> Result<Ledger, String> {
        match std::fs::read_to_string(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Ledger { day: today, realized_usd: 0.0, trades: 0 }),
            Err(e) => Err(format!("ledger: {}", e.kind())),
            Ok(t) => {
                let v: Value = serde_json::from_str(&t).map_err(|_| "ledger file is damaged".to_string())?;
                let day = v["day"].as_u64().ok_or("ledger: no day")?;
                if day != today {
                    return Ok(Ledger { day: today, realized_usd: 0.0, trades: 0 });
                }
                Ok(Ledger { day, realized_usd: v["realized_usd"].as_f64().unwrap_or(0.0), trades: v["trades"].as_u64().unwrap_or(0) })
            }
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let tmp = path.with_extension("tmp");
        let body = json!({"day": self.day, "realized_usd": self.realized_usd, "trades": self.trades}).to_string();
        std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, path)).map_err(|e| format!("ledger save: {}", e.kind()))
    }

    /// May we open a new trade of `risk_usd` (the most it could lose)?
    /// Blocks when today's loss plus this trade's worst case passes the limit.
    pub fn allows(&self, risk_usd: f64, max_day_loss_usd: f64) -> bool {
        -self.realized_usd.min(0.0) + risk_usd <= max_day_loss_usd
    }

    pub fn record(&mut self, net_usd: f64) {
        self.realized_usd += net_usd;
        self.trades += 1;
    }
}

// ---------------------------------------------------------------------------
// Sender: nonce, gas, send, receipt
// ---------------------------------------------------------------------------

fn parse_u(v: &Value) -> Option<U256> {
    let h = v.as_str()?.trim_start_matches("0x");
    if h.is_empty() {
        return Some(U256::ZERO);
    }
    U256::from_str_radix(&h[..h.len().min(64)], 16).ok()
}

/// What the chain says about a sent transaction.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    /// Included and succeeded.
    Ok { block: u64, gas_used: u64, gas_price: U256 },
    /// Included but reverted (gas still paid).
    Reverted { block: u64, gas_used: u64, gas_price: U256 },
    /// Never seen in a block before the timeout. NOT a success and NOT a
    /// proven failure: the nonce must be re-read before anything else.
    Unknown,
}

pub fn outcome_of(receipt: &Value) -> Option<Outcome> {
    if receipt.is_null() {
        return None;
    }
    let n = |k: &str| receipt[k].as_str().and_then(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16).ok()).unwrap_or(0);
    let gas_price = parse_u(&receipt["effectiveGasPrice"]).unwrap_or(U256::ZERO);
    let (block, gas_used) = (n("blockNumber"), n("gasUsed"));
    Some(if receipt["status"].as_str() == Some("0x1") { Outcome::Ok { block, gas_used, gas_price } } else { Outcome::Reverted { block, gas_used, gas_price } })
}

/// What happened when a batch was handed to the sequencer (Sender::send_txs).
#[derive(Clone, Debug, PartialEq)]
pub struct Sent {
    /// Every transaction signed, in order (also the one whose send failed).
    pub hashes: Vec<String>,
    /// How many the node accepted (the first `accepted` of `hashes`).
    pub accepted: usize,
    /// (index, reason, definite) of the refused one, if any.
    pub error: Option<(usize, String, bool)>,
}

/// Sends and tracks transactions for one wallet, one at a time.
pub struct Sender {
    /// Reads: nonce, gas, receipts, balances.
    pub rpc: Rpc,
    /// Sends only (the sequencer by default).
    pub send: Rpc,
    pub signer: Signer,
    next_nonce: Option<u64>,
}

impl Sender {
    /// Refuses to start unless the read node really is Robinhood Chain
    /// (dex bot PR #38: live readiness checks gate every send).
    pub fn new(rpc: Rpc, send: Rpc, signer: Signer) -> Result<Sender, String> {
        let id = rpc.call("eth_chainId", json!([]))?;
        let id = u64::from_str_radix(id.as_str().unwrap_or("0x0").trim_start_matches("0x"), 16).unwrap_or(0);
        if id != CHAIN_ID {
            return Err(format!("node is chain {id}, not Robinhood ({CHAIN_ID}): refusing to send"));
        }
        Ok(Sender { rpc, send, signer, next_nonce: None })
    }

    /// Next nonce: from the node the first time and after any doubt.
    fn nonce(&mut self) -> Result<u64, String> {
        if let Some(n) = self.next_nonce {
            return Ok(n);
        }
        let r = self.rpc.call("eth_getTransactionCount", json!([self.signer.address(), "pending"]))?;
        let n = u64::from_str_radix(r.as_str().unwrap_or("0x0").trim_start_matches("0x"), 16).map_err(|e| e.to_string())?;
        self.next_nonce = Some(n);
        Ok(n)
    }

    /// Forget the local nonce (re-read next time).
    pub fn resync(&mut self) {
        self.next_nonce = None;
    }

    /// Max fee = 2x base fee + 1, tip 0 (Robinhood is first come, first
    /// served: a tip buys nothing; same rule as the arb bot's sender).
    pub fn max_fee(&self) -> Result<u128, String> {
        let b = self.rpc.call("eth_getBlockByNumber", json!(["latest", false]))?;
        let base = parse_u(&b["baseFeePerGas"]).ok_or("no base fee")?;
        u128::try_from(base * U256::from(2u64) + U256::from(1u64)).map_err(|_| "base fee too big".to_string())
    }

    /// Sign and send a batch back to back (consecutive nonces, no waiting
    /// between them: approve + swap land in order). Returns their hashes.
    pub fn send_all(&mut self, txs: &[(String, Vec<u8>, u64)]) -> Result<Vec<String>, String> {
        let list: Vec<crate::liveroute::LiveTx> =
            txs.iter().map(|(to, data, gas)| crate::liveroute::LiveTx { label: String::new(), to: to.clone(), data: data.clone(), gas: *gas, value: U256::ZERO }).collect();
        let s = self.send_txs(&list)?;
        match s.error {
            None => Ok(s.hashes),
            Some((i, e, _)) => Err(format!("send refused after {i} of {}: {e}", txs.len())),
        }
    }

    /// Like send_all, but each transaction may carry ETH (native-ETH V4
    /// swaps), and a refusal is reported in detail instead of as a bare
    /// error, because the caller must know whether the SWAP might be out:
    ///   Err(..)  nothing was sent (gas price or nonce could not be read).
    ///   Ok(Sent) `hashes` = every transaction signed, in order, INCLUDING
    ///            the one whose send failed (so its fate can be checked
    ///            later); `error` = (index, reason, definite). definite =
    ///            the node answered with an error, so it did NOT take it;
    ///            not definite = no answer (timeout, connection), so it MAY
    ///            have gone out.
    pub fn send_txs(&mut self, txs: &[crate::liveroute::LiveTx]) -> Result<Sent, String> {
        let max_fee = self.max_fee()?;
        let mut out = Sent { hashes: Vec::new(), accepted: 0, error: None };
        for t in txs {
            let n = self.nonce()?;
            let f = TxFields { nonce: n, max_priority_fee: 0, max_fee, gas_limit: t.gas, to: t.to.clone(), value: t.value, data: t.data.clone() };
            let s = self.signer.sign(&f)?;
            out.hashes.push(s.hash.clone());
            match self.send.call("eth_sendRawTransaction", json!([s.raw_hex()])) {
                Ok(_) => {
                    self.next_nonce = Some(n + 1);
                    out.accepted += 1;
                }
                Err(e) => {
                    // Any refusal: we no longer trust our nonce.
                    self.resync();
                    let definite = e.contains("node error");
                    out.error = Some((out.accepted, e, definite));
                    return Ok(out);
                }
            }
        }
        Ok(out)
    }

    /// Wait for one receipt (polls every 100 ms, about one block).
    pub fn wait(&mut self, hash: &str, timeout: Duration) -> Outcome {
        let t0 = Instant::now();
        while t0.elapsed() < timeout {
            if let Ok(r) = self.rpc.call("eth_getTransactionReceipt", json!([hash])) {
                if let Some(o) = outcome_of(&r) {
                    return o;
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        self.resync();
        Outcome::Unknown
    }

    /// Token balance of our wallet (the truth after a trade, not the quote).
    pub fn balance(&self, token: &str) -> Result<U256, String> {
        let r = self.rpc.call("eth_call", json!([{"to": token, "data": format!("0x{}", hex(&data_balance(self.signer.address())?))}, "latest"]))?;
        parse_u(&r).ok_or("balance: bad reply".into())
    }
}

/// Gas limits for each step (generous; unused gas is not charged).
pub const GAS_APPROVE: u64 = 80_000;
pub const GAS_SWAP: u64 = 400_000;

/// The two transactions of one buy or sell: approve exactly this amount
/// (no unlimited allowances), then swap with a minimum and a deadline.
pub fn swap_pair(wallet: &str, token_in: &str, token_out: &str, fee: u32, amount_in: U256, min_out: U256, deadline: u64) -> Result<Vec<(String, Vec<u8>, u64)>, String> {
    Ok(vec![
        (token_in.to_string(), data_approve(SWAP_ROUTER_02, amount_in)?, GAS_APPROVE),
        (SWAP_ROUTER_02.to_string(), data_swap(token_in, token_out, fee, wallet, amount_in, min_out, deadline)?, GAS_SWAP),
    ])
}

// ---------------------------------------------------------------------------
// Dry fire: the real calls in a free simulation
// ---------------------------------------------------------------------------

/// What one dry fire measured.
#[derive(Clone, Debug)]
pub struct DryFire {
    pub block: u64,
    /// Quoter: tokens for our base, and base back for those tokens (the
    /// paper trader's numbers, sell priced on the pool WITHOUT our buy).
    pub quote_tokens: U256,
    pub quote_back: U256,
    /// Simulation of the real router calls: tokens that actually arrived,
    /// and base that actually came back (sell AFTER our buy).
    pub sim_tokens: U256,
    pub sim_back: U256,
    pub gas_buy: u64,
    pub gas_sell: u64,
    /// Empty = every call succeeded; otherwise which step failed and why.
    pub failed: String,
}

fn quote_at(rpc: &Rpc, block: &str, token_in: &str, token_out: &str, fee: u32, amount: U256) -> Result<U256, String> {
    let r = rpc.call("eth_call", json!([{"to": crate::paper::V3_QUOTER_V2, "data": crate::paper::data_quote(token_in, token_out, fee, amount)}, block]))?;
    let h = r.as_str().ok_or("quote: no data")?.trim_start_matches("0x");
    U256::from_str_radix(&h[..h.len().min(64)], 16).map_err(|e| e.to_string())
}

/// Quote at the latest block (used by the live trader for min-outs).
pub fn quote_now(rpc: &Rpc, token_in: &str, token_out: &str, fee: u32, amount: U256) -> Result<U256, String> {
    quote_at(rpc, "latest", token_in, token_out, fee, amount)
}

fn call(from: &str, to: &str, data: Vec<u8>) -> Value {
    json!({"from": from, "to": to, "data": format!("0x{}", hex(&data))})
}

fn gas_of(c: &Value) -> u64 {
    c["gasUsed"].as_str().and_then(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16).ok()).unwrap_or(0)
}

fn first_fail(calls: &[Value], names: &[&str]) -> String {
    for (i, c) in calls.iter().enumerate() {
        if c["status"].as_str() != Some("0x1") {
            let why = c["error"]["message"].as_str().unwrap_or("reverted");
            return format!("{}: {why}", names.get(i).unwrap_or(&"step"));
        }
    }
    String::new()
}

/// Buy `base_in` of `token` in `pool`, then sell everything back, using the
/// exact router calls the live sender would send, with min-outs set from
/// the quotes minus `slip_bps`. A throwaway wallet gets the base from the
/// pool inside the simulation (price maths in Uniswap V3 does not depend on
/// the pool's token balance, so this does not change the fill).
pub fn dry_fire(rpc: &Rpc, pool: &str, token: &str, base: &str, fee: u32, base_in: U256, slip_bps: u64) -> Result<DryFire, String> {
    let w = Signer::random()?;
    let me = w.address().to_string();
    let bn = rpc.call("eth_blockNumber", json!([]))?;
    let bhex = bn.as_str().ok_or("no block number")?.to_string();
    let block = u64::from_str_radix(bhex.trim_start_matches("0x"), 16).unwrap_or(0);
    let deadline = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) + 120;

    let quote_tokens = quote_at(rpc, &bhex, base, token, fee, base_in)?;
    let quote_back = quote_at(rpc, &bhex, token, base, fee, quote_tokens)?;
    let mut out = DryFire { block, quote_tokens, quote_back, sim_tokens: U256::ZERO, sim_back: U256::ZERO, gas_buy: 0, gas_sell: 0, failed: String::new() };

    let sim = |calls: Vec<Value>| -> Result<Vec<Value>, String> {
        let r = rpc.call("eth_simulateV1", json!([{"blockStateCalls": [{"calls": calls}], "validation": false}, &bhex]))?;
        r[0]["calls"].as_array().cloned().ok_or("simulation: no calls".into())
    };

    // Pass 1: fund, approve, buy, read what arrived.
    let buy = swap_pair(&me, base, token, fee, base_in, min_out(quote_tokens, slip_bps), deadline)?;
    let mut calls = vec![call(pool, base, data_transfer(&me, base_in)?)];
    calls.extend(buy.iter().map(|(to, d, _)| call(&me, to, d.clone())));
    calls.push(call(&me, token, data_balance(&me)?));
    let r1 = sim(calls.clone())?;
    out.failed = first_fail(&r1, &["fund", "approve base", "buy", "read tokens"]);
    if !out.failed.is_empty() {
        return Ok(out);
    }
    out.gas_buy = gas_of(&r1[1]) + gas_of(&r1[2]);
    out.sim_tokens = parse_u(&r1[3]["returnData"]).unwrap_or(U256::ZERO);

    // Pass 2: same buy, then sell everything that arrived.
    let sell = swap_pair(&me, token, base, fee, out.sim_tokens, min_out(quote_back, slip_bps), deadline)?;
    calls.extend(sell.iter().map(|(to, d, _)| call(&me, to, d.clone())));
    calls.push(call(&me, base, data_balance(&me)?));
    let r2 = sim(calls)?;
    out.failed = first_fail(&r2, &["fund", "approve base", "buy", "read tokens", "approve token", "sell", "read base"]);
    if !out.failed.is_empty() {
        return Ok(out);
    }
    out.gas_sell = gas_of(&r2[4]) + gas_of(&r2[5]);
    out.sim_back = parse_u(&r2[6]["returnData"]).unwrap_or(U256::ZERO);
    Ok(out)
}

/// A Uniswap V4 pool is named by a 32-byte pool id, not a 20-byte address.
/// Dry-fire can't trade those (no V4 sender yet): refuse with a clear message.
pub fn refuse_v4_pool_id(pool: &str) -> Result<(), String> {
    let h = pool.trim().trim_start_matches("0x");
    if h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit()) {
        return crate::venue::dry_fire_supported(crate::venue::VenueKind::V4);
    }
    Ok(())
}

/// Round-trip result in plain numbers for one dry fire, as one line of JSON:
/// usd_in, what the quotes promised back, what the real calls got back, and
/// the difference (positive = real calls did better than the paper quote).
pub fn dry_fire_usd(url: &str, pool: &str, usd: f64, slip_bps: u64) -> Result<String, String> {
    let rpc = Rpc::new(url);
    let agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(10))).build().new_agent();
    // Only Uniswap V3 pools can be dry-fired (the live calls are SwapRouter02).
    // V4 pools (given by 32-byte pool id) and V2 pairs are paper only: say so
    // clearly instead of failing with a confusing lookup error.
    refuse_v4_pool_id(pool)?;
    let p = match crate::paper::pool_info(url, &agent, pool) {
        Some(p) => p,
        None => {
            if let Some(v2) = crate::paper::v2_pool_info(url, &agent, pool) {
                crate::venue::dry_fire_supported(v2.venue.kind())?;
            }
            return Err("not a Uniswap V3 WETH/USDG pool".into());
        }
    };
    crate::venue::dry_fire_supported(p.venue.kind())?;
    let q = crate::paper::ChainQuoter { rpc: Rpc::new(url) };
    let eth = crate::paper::eth_usd(&q).ok_or("no ETH price")?;
    let usd_per_base = if p.base == "USDG" { 1.0 } else { eth };
    let dec = crate::rhc::base_decimals(p.base);
    let base_in = U256::from(((usd / usd_per_base) * 10f64.powi(dec)) as u128);
    let d = dry_fire(&rpc, pool, &p.token, &p.base_addr, p.fee, base_in, slip_bps)?;
    let to_usd = |x: U256| f64::from(x) / 10f64.powi(dec) * usd_per_base;
    let quote_back = to_usd(d.quote_back);
    let sim_back = to_usd(d.sim_back);
    Ok(json!({
        "pool": pool, "token": p.token, "base": p.base, "fee": p.fee, "block": d.block,
        "usd_in": usd, "quote_back_usd": quote_back, "sim_back_usd": sim_back,
        "sim_minus_quote_usd": sim_back - quote_back,
        "tokens_quote": d.quote_tokens.to_string(), "tokens_sim": d.sim_tokens.to_string(),
        "tokens_match": d.quote_tokens == d.sim_tokens,
        "gas_buy": d.gas_buy, "gas_sell": d.gas_sell,
        "ok": d.failed.is_empty(), "failed": d.failed,
    })
    .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dry_fire_refuses_v4_pool_ids() {
        let id = "0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27";
        let e = refuse_v4_pool_id(id).unwrap_err();
        assert!(e.contains("only Uniswap V3") && e.contains("V4"), "{e}");
        // A normal 20-byte pool address passes this step (V3 lookup follows).
        assert!(refuse_v4_pool_id("0x2222222222222222222222222222222222222222").is_ok());
    }

    #[test]
    fn known_selectors() {
        // Published 4-byte ids.
        assert_eq!(hex(&selector("approve(address,uint256)")), "095ea7b3");
        assert_eq!(hex(&selector("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))")), "04e45aaf");
        assert_eq!(hex(&selector("multicall(uint256,bytes[])")), "5ae401dc");
    }

    #[test]
    fn key_one_has_known_address_and_debug_hides_key() {
        let s = Signer::from_hex("0x0000000000000000000000000000000000000000000000000000000000000001").unwrap();
        assert_eq!(s.address(), "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
        assert!(!format!("{s:?}").contains("0000000001"));
    }

    #[test]
    fn bad_keys_refused_without_echo() {
        for bad in ["", "0x12", "zz00000000000000000000000000000000000000000000000000000000000001"] {
            let e = Signer::from_hex(bad).unwrap_err();
            assert!(!e.contains("zz"), "{e}");
        }
    }

    #[test]
    fn signed_tx_decodes_back_to_our_fields() {
        let s = Signer::random().unwrap();
        let data = data_swap(crate::paper::WETH, crate::paper::USDG, 500, s.address(), U256::from(10u64), U256::from(9u64), 123).unwrap();
        let f = TxFields { nonce: 7, max_priority_fee: 0, max_fee: 20_000_001, gas_limit: GAS_SWAP, to: SWAP_ROUTER_02.into(), value: U256::ZERO, data: data.clone() };
        let tx = s.sign(&f).unwrap();
        assert_eq!(tx.raw[0], 0x02);
        // The feed decoder (independent code) reads it back the same.
        let d = crate::feedtx::decode_tx(&tx.raw).unwrap();
        assert_eq!(d.hash, tx.hash);
        assert_eq!(d.to.as_deref(), Some(SWAP_ROUTER_02));
        assert_eq!(d.data, data);
        assert_eq!(d.value, 0);
    }

    #[test]
    fn signature_recovers_our_address() {
        let s = Signer::random().unwrap();
        let f = TxFields { nonce: 0, max_priority_fee: 0, max_fee: 1, gas_limit: 21_000, to: SWAP_ROUTER_02.into(), value: U256::ZERO, data: vec![] };
        let tx = s.sign(&f).unwrap();
        // Rebuild the signing message and recover the signer from (y, r, s).
        let body = encode_fields(&f).unwrap();
        let mut msg = vec![0x02];
        msg.extend(rlp_len(0xc0, body.len()));
        msg.extend(body.clone());
        // r and s are the last two 33-byte RLP items (0xa0 + 32 bytes) when
        // they have no leading zero byte; find them from the end instead of
        // assuming, by re-signing deterministically (RFC 6979).
        let sig = SECP256K1.sign_ecdsa_recoverable(Message::from_digest(keccak(&msg)), &s.key);
        let pk = SECP256K1.recover_ecdsa(Message::from_digest(keccak(&msg)), &sig).unwrap();
        assert_eq!(address_of(&pk), s.address());
        // Same message signed twice gives the same transaction (deterministic).
        assert_eq!(s.sign(&f).unwrap().raw, tx.raw);
    }

    #[test]
    fn swap_calldata_layout() {
        let me = "0x1111111111111111111111111111111111111111";
        let d = data_swap(crate::paper::WETH, "0x2222222222222222222222222222222222222222", 3000, me, U256::from(5u64), U256::from(4u64), 99).unwrap();
        // selector + 5 head words + inner (4 + 7*32 = 228 bytes, padded to 256)
        assert_eq!(d.len(), 4 + 5 * 32 + 256);
        assert_eq!(&d[..4], &[0x5a, 0xe4, 0x01, 0xdc]);
        assert_eq!(U256::from_be_slice(&d[4..36]), U256::from(99u64)); // deadline
        assert_eq!(U256::from_be_slice(&d[132..164]), U256::from(228u64)); // inner length
        assert_eq!(&d[164..168], &[0x04, 0xe4, 0x5a, 0xaf]);
        // amountIn and amountOutMinimum
        assert_eq!(U256::from_be_slice(&d[168 + 4 * 32..168 + 5 * 32]), U256::from(5u64));
        assert_eq!(U256::from_be_slice(&d[168 + 5 * 32..168 + 6 * 32]), U256::from(4u64));
    }

    #[test]
    fn min_out_takes_off_slippage() {
        assert_eq!(min_out(U256::from(10_000u64), 300), U256::from(9_700u64));
        assert_eq!(min_out(U256::from(10_000u64), 20_000), U256::ZERO);
    }

    #[test]
    fn gate_stays_shut_unless_everything_is_set() {
        let none = |_: &str| None;
        let e = Gate::from_lookup(&none).unwrap_err();
        assert!(e.len() >= 3, "{e:?}");
        // Right phrase but size above the hard ceiling: still shut.
        let big = |k: &str| match k {
            "SNIPER_LIVE" => Some("1".into()),
            "SNIPER_LIVE_ACK" => Some(LIVE_ACK_PHRASE.into()),
            "SNIPER_LIVE_MAX_USD" => Some("50".into()),
            _ => None,
        };
        let e = Gate::from_lookup(&big).unwrap_err();
        assert!(e.iter().any(|x| x.contains("trade size")), "{e:?}");
        assert!(e.iter().any(|x| x.contains("SNIPER_KEY_FILE")), "{e:?}");
    }

    #[cfg(unix)] // file modes are a Unix thing (the server is Linux)
    #[test]
    fn gate_refuses_readable_key_file() {
        use std::os::unix::fs::PermissionsExt;
        let p = std::env::temp_dir().join(format!("sniper-key-test-{}", std::process::id()));
        std::fs::write(&p, "0x0000000000000000000000000000000000000000000000000000000000000001").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(Signer::from_file(&p).unwrap_err().contains("600"));
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
        let ps = p.to_string_lossy().to_string();
        let ok = |k: &str| match k {
            "SNIPER_LIVE" => Some("1".into()),
            "SNIPER_LIVE_ACK" => Some(LIVE_ACK_PHRASE.into()),
            "SNIPER_KEY_FILE" => Some(ps.clone()),
            _ => None,
        };
        let g = Gate::from_lookup(&ok).unwrap();
        assert_eq!((g.max_trade_usd, g.max_day_loss_usd), (5.0, 10.0));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn ledger_survives_restart_and_resets_next_day() {
        let p = std::env::temp_dir().join(format!("sniper-ledger-test-{}.json", std::process::id()));
        std::fs::remove_file(&p).ok();
        let mut l = Ledger::load(&p, 100).unwrap();
        l.record(-6.0);
        l.save(&p).unwrap();
        let l2 = Ledger::load(&p, 100).unwrap();
        assert_eq!(l2.realized_usd, -6.0);
        // $6 lost + a $5 trade that could lose everything > $10 limit.
        assert!(!l2.allows(5.0, 10.0));
        assert!(l2.allows(4.0, 10.0));
        assert_eq!(Ledger::load(&p, 101).unwrap().realized_usd, 0.0);
        // A damaged file stops trading instead of resetting.
        std::fs::write(&p, "{oops").unwrap();
        assert!(Ledger::load(&p, 100).is_err());
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn receipts_read_correctly() {
        assert_eq!(outcome_of(&Value::Null), None);
        let ok = json!({"status": "0x1", "blockNumber": "0x10", "gasUsed": "0x5208", "effectiveGasPrice": "0x3"});
        assert_eq!(outcome_of(&ok), Some(Outcome::Ok { block: 16, gas_used: 21000, gas_price: U256::from(3u64) }));
        let bad = json!({"status": "0x0", "blockNumber": "0x10", "gasUsed": "0x5208"});
        assert!(matches!(outcome_of(&bad), Some(Outcome::Reverted { .. })));
    }
}

#[cfg(test)]
mod vector {
    use super::*;

    /// Fixed transaction signed with key 1. The expected bytes were produced
    /// by an independent signer (Python eth_account 0.14) for the same fields.
    pub fn sample() -> (Signer, TxFields) {
        let s = Signer::from_hex("0x0000000000000000000000000000000000000000000000000000000000000001").unwrap();
        let data = data_swap(crate::paper::WETH, crate::paper::USDG, 500, s.address(), U256::from(10u64).pow(U256::from(15u64)), U256::from(1_234_567u64), 1_800_000_000).unwrap();
        let f = TxFields { nonce: 42, max_priority_fee: 0, max_fee: 20_000_001, gas_limit: GAS_SWAP, to: SWAP_ROUTER_02.into(), value: U256::ZERO, data };
        (s, f)
    }

    /// Expected raw transaction, from eth_account (checked byte for byte).
    const EXPECTED_RAW: &str = "0x02f9020f8212372a808401312d0183061a8094caf681a66d020601342297493863e78c959e5cb280b901a45ae401dc000000000000000000000000000000000000000000000000000000006b49d20000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000e404e45aaf0000000000000000000000000bd7d308f8e1639fab988df18a8011f41eacad730000000000000000000000005fc5360d0400a0fd4f2af552add042d716f1d16800000000000000000000000000000000000000000000000000000000000001f40000000000000000000000007e5f4552091a69125d5dfcb7b8c2659029395bdf00000000000000000000000000000000000000000000000000038d7ea4c68000000000000000000000000000000000000000000000000000000000000012d687000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c001a08a1200a4de201c0ac95c104b1d1b7fd1278a4e81c272ed8b1e1a887142295ba6a06a868815a2eb5ca970eaf4812f09f9470ad3d1f760edeb1212d091a312c22c68";

    #[test]
    fn matches_independent_signer() {
        let (s, f) = sample();
        assert_eq!(s.sign(&f).unwrap().raw_hex(), EXPECTED_RAW);
    }
}
