// ============================================================================
// NODE CLIENT: asks the paid Robinhood node questions (JSON-RPC over HTTPS).
// Owner: workstream A.
//
// Plain English:
//   The sidecar keeps its own copy of the chain. Sometimes it needs a fact it
//   doesn't have ("what is in storage slot X of pool P at block N?"). This
//   file asks the node, with three safety rails:
//     1. SPEED LIMIT  (ARBSIM_NODE_RPS, default 8 requests/second). It is
//        ADAPTIVE (dry run #16): the paid plan is shared with the live bot,
//        so when the provider answers "You've exceeded the RPS limit"
//        (-32005 / HTTP 429) our allowed rate is halved at once (at most
//        once per second, never below ARBSIM_NODE_MIN_RPS, default 2), and
//        it creeps back up by 5 % of ARBSIM_NODE_RPS per second once 2 s
//        pass without a refusal. So we never keep hammering at our own cap
//        while the provider refuses. Counted in status (providerRefusals,
//        rateCuts, rpsNow).
//     2. DAILY ALLOWANCE (ARBSIM_NODE_DAILY_CAP, default 6,000 requests/day,
//        counted per call inside a batch, saved to a small file so restarts
//        don't reset it, new day at midnight UTC). Different jobs may use
//        different shares of it (see `Class`), so a low-priority job can
//        never starve the important ones.
//     3. NODE ADDRESSES ARE SECRET: the URL (it contains the API key) is read
//        from env and NEVER printed. Logs say "node1" / "node2" only.
//
//   Which node answers what (cheapest first):
//     public  Robinhood's free node (ARBSIM_PUBLIC_URL, default
//             https://rpc.mainnet.chain.robinhood.com; "off" disables it).
//             Plain state reads only (storage / code / balance / nonce /
//             headers). No daily cap, own speed limit ARBSIM_PUBLIC_RPS (6/s,
//             bursts up to ARBSIM_PUBLIC_BURST 40). Most of our reads go here.
//     node1   ARBSIM_NODE_URL, else CHAINSTACK_RPC_ROBINHOOD (the bot's .env)
//     node2   ARBSIM_NODE_URL_2 (optional backup)
//             The paid nodes: needed for debug_trace (block diffs) and as the
//             backup for plain reads. They share ONE daily allowance
//             (ARBSIM_NODE_DAILY_CAP) and speed limit (ARBSIM_NODE_RPS).
//
//   Everything else talks to the node through the `NodeApi` trait, so tests
//   can plug in a fake node (no network needed).
// ============================================================================
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use revm::primitives::{Address, Bytes, B256, U256};
use serde_json::{json, Value};

use crate::check::hexutil::{parse_address, parse_bytes, parse_u256, parse_u64, quantity_u64, to_hex};
use crate::state::MissItem;

// ---------------------------------------------------------------------------
// Request classes (who is asking) and their share of the daily allowance.
// ---------------------------------------------------------------------------
/// Who is asking the node. Each class may use the daily allowance only up to
/// its share, so that e.g. sampled verification stops long before the
/// allowance runs out and the mirror's own upkeep always has room.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    /// Keeping the live copy exact (feed replay fetches, gap recovery): 100%.
    Critical,
    /// Filling items a check missed / the bot asked to warm: up to 95%.
    Fill,
    /// Block header refresh (base fee, block-number cross-check): up to 95%.
    Header,
    /// Historical ("pinned") views for the comparison harness: up to 90%.
    Pinned,
    /// Sampled accuracy checks (our replay vs the node's trace): up to 80%.
    Verify,
    /// Copy 2's bulk first loads: up to 95%, and NEVER runs the speed limit
    /// into debt (waits for room first), so other classes (a check's missing
    /// value) don't queue behind minutes of loading.
    Bulk,
}

impl Class {
    /// Share of the daily cap this class may use (percent).
    fn share_pct(self) -> u64 {
        match self {
            Class::Critical => 100,
            Class::Fill | Class::Header => 95,
            Class::Pinned => 90,
            Class::Verify => 80,
            Class::Bulk => 95,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Class::Critical => "critical",
            Class::Fill => "fill",
            Class::Header => "header",
            Class::Pinned => "pinned",
            Class::Verify => "verify",
            Class::Bulk => "bulk",
        }
    }
    const ALL: [Class; 6] = [Class::Critical, Class::Fill, Class::Header, Class::Pinned, Class::Verify, Class::Bulk];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
/// The whole request failed (nothing came back).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NodeErr {
    /// Daily allowance (or this class's share of it) used up.
    Budget(String),
    /// No node configured.
    NoNode,
    /// Network / HTTP / timeout problem (text never contains the URL).
    Transport(String),
    /// The node answered something we can't read.
    BadResponse(String),
}

impl std::fmt::Display for NodeErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NodeErr::Budget(s) => write!(f, "budget: {s}"),
            NodeErr::NoNode => write!(f, "no node configured"),
            NodeErr::Transport(s) => write!(f, "transport: {s}"),
            NodeErr::BadResponse(s) => write!(f, "bad response: {s}"),
        }
    }
}

/// One call inside a batch failed (the node's own error).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RpcErr {
    pub code: i64,
    pub message: String,
}

impl RpcErr {
    /// "That block doesn't exist (yet)" - the node is a little behind us.
    pub fn is_block_unavailable(&self) -> bool {
        let m = self.message.to_ascii_lowercase();
        m.contains("not found") || m.contains("unknown block") || m.contains("header") && m.contains("missing")
            || m.contains("block not available") || m.contains("future block")
    }
}

/// Answer to one call of a batch.
pub type CallResult = Result<Value, RpcErr>;

// ---------------------------------------------------------------------------
// The trait everything uses (real node or test fake)
// ---------------------------------------------------------------------------
pub trait NodeApi: Send + Sync {
    /// Send these calls (method, params) as one batch. Answers come back in
    /// the same order. Outer Err = nothing came back at all.
    fn call_batch(&self, class: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr>;
    /// Usage counters for `status`.
    fn usage(&self) -> Value {
        Value::Null
    }
    /// Same as call_batch, but the PAID node(s) first and the free public
    /// node only as a fallback (copy 2's bulk loading: the public node is
    /// slow and rate-limited). Default: same as call_batch.
    fn call_batch_paid(&self, class: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        self.call_batch(class, calls)
    }
}

// ---------------------------------------------------------------------------
// Daily allowance + speed limit
// ---------------------------------------------------------------------------
/// Start of the error text when the SPEED LIMIT (not the daily allowance)
/// turned a request away: nothing was sent.
pub const SPEED_LIMIT: &str = "speed limit";

/// Counts node requests per UTC day (saved to a file) and paces them.
pub struct Budget {
    cap: u64,
    rps: f64,
    /// Largest burst allowed by the speed limit (default = rps).
    pub burst: f64,
    file: Option<String>,
    inner: Mutex<BudgetInner>,
    /// Longest queue a request may join [ARBSIM_NODE_MAX_QUEUE_MS, 10000]: a
    /// safety valve only. Requests normally WAIT their turn (copy 2 paces
    /// itself so the queue stays short); beyond this they are refused.
    pub max_queue: Duration,
    /// Lowest rate the adaptive limit may cut to [ARBSIM_NODE_MIN_RPS, 2].
    pub min_rps: f64,
}

struct BudgetInner {
    day: u64,
    used: u64,
    per_class: [u64; 6],
    refused: u64,
    /// Speed limit: tokens in the bucket, and vt[0] = when they were counted.
    tokens: f64,
    vt: [Instant; 2],
    last_save: Instant,
    unsaved: u64,
    /// Adaptive limit: the rate allowed right now (<= rps), when it was last
    /// brought up to date, the last refusal and the last cut.
    rate: f64,
    rate_at: Instant,
    last_refusal: Option<Instant>,
    last_cut: Option<Instant>,
    /// Provider refusals seen ("exceeded the RPS limit" / 429) and cuts made
    /// (since start).
    provider_refusals: u64,
    cuts: u64,
}

/// Seconds without a refusal before the adaptive rate starts to recover.
const RECOVER_AFTER_S: f64 = 2.0;
/// Recovery speed: this share of ARBSIM_NODE_RPS per second.
const RECOVER_PER_S: f64 = 0.05;

/// Does this node error mean "the provider refused us for going too fast"
/// (Chainstack: code -32005 "You've exceeded the RPS limit available on the
/// current plan", or HTTP 429)? NOT a size limit or a missing block.
pub fn is_rate_refusal(code: i64, message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    code == -32005
        || code == 429
        || m.contains("rps limit")
        || m.contains("rate limit")
        || m.contains("too many requests")
        || m.contains("exceeded the rps")
        || m.contains("request limit reached")
        || m.contains("(429)")
}

fn utc_day() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0)
}

fn class_idx(c: Class) -> usize {
    Class::ALL.iter().position(|x| *x == c).unwrap_or(0)
}

impl Budget {
    /// `cap` requests per UTC day, `rps` per second, counts kept in `file`.
    pub fn new(cap: u64, rps: f64, file: Option<String>) -> Self {
        let mut b = BudgetInner {
            day: utc_day(),
            used: 0,
            per_class: [0; 6],
            refused: 0,
            tokens: rps.max(1.0),
            vt: [Instant::now(), Instant::now()],
            last_save: Instant::now(),
            unsaved: 0,
            rate: rps.max(0.1),
            rate_at: Instant::now(),
            last_refusal: None,
            last_cut: None,
            provider_refusals: 0,
            cuts: 0,
        };
        // Pick up today's count from the file (restarts don't reset it).
        if let Some(f) = &file {
            if let Ok(s) = std::fs::read_to_string(f) {
                if let Ok(v) = serde_json::from_str::<Value>(&s) {
                    if v["day"].as_u64() == Some(b.day) {
                        b.used = v["used"].as_u64().unwrap_or(0);
                    }
                }
            }
        }
        let max_queue = Duration::from_millis(env_u64("ARBSIM_NODE_MAX_QUEUE_MS", 10_000).max(100));
        let min_rps = std::env::var("ARBSIM_NODE_MIN_RPS").ok().and_then(|s| s.parse::<f64>().ok()).unwrap_or(2.0).max(0.1).min(rps.max(0.1));
        Budget { cap, rps: rps.max(0.1), burst: rps.max(1.0), file, inner: Mutex::new(b), max_queue, min_rps }
    }

    /// The adaptive rate right now (brought up to date: recovers by 5 % of
    /// the full rate per second once RECOVER_AFTER_S passed without a refusal).
    fn rate_now(&self, b: &mut BudgetInner, now: Instant) -> f64 {
        let el = now.duration_since(b.rate_at).as_secs_f64();
        b.rate_at = now;
        let quiet = b.last_refusal.map_or(f64::MAX, |t| now.duration_since(t).as_secs_f64());
        if quiet >= RECOVER_AFTER_S && b.rate < self.rps {
            // Only the part of `el` after the quiet period counts.
            let grow_s = el.min(quiet - RECOVER_AFTER_S);
            b.rate = (b.rate + RECOVER_PER_S * self.rps * grow_s).min(self.rps);
        }
        b.rate
    }

    /// The provider refused a request for going too fast: halve the rate
    /// (at most once per second, so 16 refusals in flight at once count as
    /// one), drop any saved-up burst. Returns the new rate.
    pub fn note_refusal(&self) -> f64 {
        let mut b = self.inner.lock().unwrap();
        let now = Instant::now();
        let cur = self.rate_now(&mut b, now);
        b.provider_refusals += 1;
        b.last_refusal = Some(now);
        if b.last_cut.is_none_or(|t| now.duration_since(t) >= Duration::from_secs(1)) {
            b.rate = (cur / 2.0).max(self.min_rps);
            b.last_cut = Some(now);
            b.cuts += 1;
            b.tokens = b.tokens.min(0.0);
        }
        b.rate
    }

    /// Look at one answer for provider refusals (whole request or any item
    /// inside a batch); cut the rate if so. Returns true if it was refused.
    pub fn observe(&self, answer: &Result<Vec<CallResult>, NodeErr>) -> bool {
        let refused = match answer {
            Ok(rs) => rs.iter().any(|r| matches!(r, Err(e) if is_rate_refusal(e.code, &e.message))),
            Err(NodeErr::Transport(m)) | Err(NodeErr::BadResponse(m)) => is_rate_refusal(0, m),
            Err(_) => false,
        };
        if refused {
            self.note_refusal();
        }
        refused
    }

    /// The rate allowed right now (requests per second).
    pub fn current_rps(&self) -> f64 {
        let mut b = self.inner.lock().unwrap();
        self.rate_now(&mut b, Instant::now())
    }

    /// From env: ARBSIM_NODE_DAILY_CAP (6000), ARBSIM_NODE_RPS (8),
    /// ARBSIM_BUDGET_FILE (default ./arbsim-node-budget.json).
    pub fn from_env() -> Self {
        let cap = env_u64("ARBSIM_NODE_DAILY_CAP", 6000);
        let rps = std::env::var("ARBSIM_NODE_RPS").ok().and_then(|s| s.parse().ok()).unwrap_or(8.0);
        let file = std::env::var("ARBSIM_BUDGET_FILE").unwrap_or_else(|_| "arbsim-node-budget.json".into());
        Budget::new(cap, rps, if file.is_empty() { None } else { Some(file) })
    }

    /// Take `n` HTTP requests for `class`: waits for the speed limit (a plain
    /// token bucket at ARBSIM_NODE_RPS requests per second, up to that many
    /// at once). Never refuses for speed; refuses only when today's
    /// allowance share is used up. (NodeClient takes 1 per HTTP request, so
    /// a batch or an eth_getProof counts once, however many values it holds.)
    pub fn take(&self, class: Class, n: u64) -> Result<(), NodeErr> {
        {
            let mut b = self.inner.lock().unwrap();
            let today = utc_day();
            if today != b.day {
                b.day = today;
                b.used = 0;
                b.per_class = [0; 6];
                b.refused = 0;
            }
            let limit = (self.cap as u128 * class.share_pct() as u128 / 100).min(u64::MAX as u128) as u64;
            if b.used + n > limit {
                b.refused += n;
                return Err(NodeErr::Budget(format!(
                    "daily allowance for {} used up ({}/{} today, share {}%)",
                    class.name(),
                    b.used,
                    self.cap,
                    class.share_pct()
                )));
            }
            b.used += n;
            b.per_class[class_idx(class)] += n;
            b.unsaved += n;
            if b.unsaved >= 25 || b.last_save.elapsed() > Duration::from_secs(30) {
                b.unsaved = 0;
                b.last_save = Instant::now();
                self.save(&b);
            }
        }
        // Speed limit: wait for the tokens (at the adaptive rate; the burst
        // shrinks with it).
        let need = n as f64;
        loop {
            let wait = {
                let mut b = self.inner.lock().unwrap();
                let now = Instant::now();
                let rate = self.rate_now(&mut b, now);
                let burst = (self.burst * rate / self.rps).max(1.0);
                let el = now.duration_since(b.vt[0]).as_secs_f64();
                b.vt[0] = now;
                b.tokens = (b.tokens + el * rate).min(burst.max(need));
                if b.tokens >= need {
                    b.tokens -= need;
                    return Ok(());
                }
                Duration::from_secs_f64(((need - b.tokens) / rate).clamp(0.001, 1.0))
            };
            std::thread::sleep(wait);
        }
    }

    fn save(&self, b: &BudgetInner) {
        if let Some(f) = &self.file {
            let tmp = format!("{f}.tmp");
            let body = json!({ "day": b.day, "used": b.used }).to_string();
            if std::fs::write(&tmp, body).is_ok() {
                let _ = std::fs::rename(&tmp, f);
            }
        }
    }

    /// Requests used today, the cap, and per-class counts.
    pub fn usage(&self) -> Value {
        let mut b = self.inner.lock().unwrap();
        let rate = self.rate_now(&mut b, Instant::now());
        let mut per = serde_json::Map::new();
        for c in Class::ALL {
            per.insert(c.name().into(), Value::from(b.per_class[class_idx(c)]));
        }
        json!({ "usedToday": b.used, "cap": self.cap, "refusedToday": b.refused, "byClass": per, "utcDay": b.day,
                "rps": self.rps, "rpsNow": (rate * 10.0).round() / 10.0, "tokens": (b.tokens * 10.0).round() / 10.0,
                "providerRefusals": b.provider_refusals, "rateCuts": b.cuts,
                "secondsSinceRefusal": b.last_refusal.map(|t| t.elapsed().as_secs()) })
    }

    /// Used so far today (for tests / status).
    pub fn used(&self) -> u64 {
        self.inner.lock().unwrap().used
    }
}

/// Read a number from env, with a default.
pub fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(default)
}

// ---------------------------------------------------------------------------
// The real HTTPS client
// ---------------------------------------------------------------------------
/// Robinhood Chain's free public node.
pub const ROBINHOOD_PUBLIC_RPC: &str = "https://rpc.mainnet.chain.robinhood.com";

struct Endpoint {
    label: &'static str,
    url: String,
    /// Can answer debug_* methods (paid nodes).
    debug: bool,
    /// Index into NodeClient::budgets.
    budget: usize,
}

/// JSON-RPC client for the real node(s).
pub struct NodeClient {
    endpoints: Vec<Endpoint>,
    agent: ureq::Agent,
    /// [0] = paid nodes (shared), [1] = public node.
    budgets: Vec<Budget>,
    max_batch: usize,
    errors: Mutex<(u64, Option<Instant>)>,
}

/// Does this error mean "this node doesn't keep that (old) state"?
fn state_unavailable(e: &RpcErr) -> bool {
    let m = e.message.to_ascii_lowercase();
    m.contains("trie") || m.contains("pruned") || m.contains("historical") || m.contains("state not available")
        || m.contains("state is not available") || m.contains("method not found") || m.contains("not supported")
}

impl NodeClient {
    /// Build from env (see file header). None = no node at all.
    pub fn from_env() -> Option<Self> {
        let mut endpoints = Vec::new();
        let public = std::env::var("ARBSIM_PUBLIC_URL").unwrap_or_else(|_| ROBINHOOD_PUBLIC_RPC.to_string());
        if !public.trim().is_empty() && public.trim() != "off" {
            endpoints.push(Endpoint { label: "public", url: public.trim().to_string(), debug: false, budget: 1 });
        }
        let first = std::env::var("ARBSIM_NODE_URL").ok().filter(|s| !s.trim().is_empty())
            .or_else(|| std::env::var("CHAINSTACK_RPC_ROBINHOOD").ok().filter(|s| !s.trim().is_empty()));
        if let Some(u) = first {
            endpoints.push(Endpoint { label: "node1", url: u.trim().to_string(), debug: true, budget: 0 });
        }
        if let Some(u) = std::env::var("ARBSIM_NODE_URL_2").ok().filter(|s| !s.trim().is_empty()) {
            endpoints.push(Endpoint { label: "node2", url: u.trim().to_string(), debug: true, budget: 0 });
        }
        if endpoints.is_empty() {
            return None;
        }
        let timeout = Duration::from_millis(env_u64("ARBSIM_NODE_TIMEOUT_MS", 8000));
        // Keep-alive pool big enough for all parallel requests (ureq keeps
        // only 3 idle connections per host by default: with 16 in flight, 13
        // would open a new TLS connection every time).
        let pool = env_u64("ARBSIM_NODE_POOL", 64).max(4) as usize;
        let cfg = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .http_status_as_error(false)
            .max_idle_connections(pool * 2)
            .max_idle_connections_per_host(pool)
            .build();
        let public_rps = std::env::var("ARBSIM_PUBLIC_RPS").ok().and_then(|s| s.parse().ok()).unwrap_or(6.0);
        let public_cap = env_u64("ARBSIM_PUBLIC_DAILY_CAP", 0);
        let mut public_budget = Budget::new(if public_cap == 0 { u64::MAX / 4 } else { public_cap }, public_rps, None);
        public_budget.burst = env_u64("ARBSIM_PUBLIC_BURST", 40) as f64;
        Some(NodeClient {
            endpoints,
            agent: ureq::Agent::new_with_config(cfg),
            budgets: vec![Budget::from_env(), public_budget],
            max_batch: env_u64("ARBSIM_NODE_BATCH", 25).clamp(1, 50) as usize, // Chainstack: <= 50
            errors: Mutex::new((0, None)),
        })
    }

    /// Labels of the configured nodes (for the startup log; never URLs).
    pub fn labels(&self) -> Vec<&'static str> {
        self.endpoints.iter().map(|e| e.label).collect()
    }

    // One HTTP POST of one batch to one endpoint.
    /// node-bench only: one POST to the first paid node, bypassing the
    /// speed limit and the daily allowance (to see the raw network time).
    pub fn post_paid_raw(&self, body: &str) -> Result<Value, NodeErr> {
        let ep = self.endpoints.iter().find(|e| e.budget == 0).ok_or(NodeErr::NoNode)?;
        self.post(ep, body)
    }

    fn post(&self, ep: &Endpoint, body: &str) -> Result<Value, NodeErr> {
        let resp = self
            .agent
            .post(&ep.url)
            .header("content-type", "application/json")
            .send(body)
            .map_err(|e| NodeErr::Transport(format!("{}: {}", ep.label, safe_err(&e))))?;
        let status = resp.status().as_u16();
        let t_read = Instant::now();
        let text = resp
            .into_body()
            .with_config()
            .limit(64 * 1024 * 1024)
            .read_to_string()
            .map_err(|e| NodeErr::Transport(format!("{}: reading answer: {}", ep.label, safe_err(&e))))?;
        let read_ms = t_read.elapsed().as_secs_f64() * 1000.0;
        LAST_HTTP.with(|c| c.set((text.len(), read_ms)));
        if status == 429 {
            return Err(NodeErr::Transport(format!("{}: rate limited (429)", ep.label)));
        }
        if !(200..300).contains(&status) {
            return Err(NodeErr::Transport(format!("{}: HTTP {status}", ep.label)));
        }
        serde_json::from_str(&text).map_err(|_| NodeErr::BadResponse(format!("{}: not JSON", ep.label)))
    }

    fn note_error(&self, e: &NodeErr) {
        let mut g = self.errors.lock().unwrap();
        g.0 += 1;
        // Log at most one node error every 10 s (no URL in the text).
        if g.1.map_or(true, |t| t.elapsed() > Duration::from_secs(10)) {
            g.1 = Some(Instant::now());
            eprintln!("[arbsim] node error: {e} (total {})", g.0);
        }
    }

    // Send one chunk through the endpoints in order. Calls the cheap node
    // can't answer (old state, debug methods) move on to the next node.
    fn send_chunk(&self, class: Class, chunk: &[(&str, Value)], paid_first: bool) -> Result<Vec<CallResult>, NodeErr> {
        let needs_debug = chunk.iter().any(|(m, _)| m.starts_with("debug_"));
        let mut results: Vec<Option<CallResult>> = vec![None; chunk.len()];
        let mut todo: Vec<usize> = (0..chunk.len()).collect();
        let mut last = NodeErr::NoNode;
        // Normal order: cheap public node first. paid_first: paid nodes
        // (budget 0) first, the public node last (fallback).
        let mut order: Vec<&Endpoint> = self.endpoints.iter().filter(|e| e.debug || !needs_debug).collect();
        if paid_first {
            order.sort_by_key(|e| e.budget != 0);
        }
        for ep in order {
            if todo.is_empty() {
                break;
            }
            // Copy 2 (paid_first) uses only the paid node(s).
            if paid_first && ep.budget != 0 {
                continue;
            }
            let t_wait = Instant::now();
            let took = self.budgets[ep.budget].take(class, 1);
            LAST_WAIT.with(|c| c.set(t_wait.elapsed().as_secs_f64() * 1000.0));
            if let Err(e) = took {
                // Copy 2 paces itself: a speed-limit refusal means "later",
                // not "try the next node".
                let speed = matches!(&e, NodeErr::Budget(m) if m.starts_with(SPEED_LIMIT));
                last = e;
                if paid_first && speed {
                    break;
                }
                continue;
            }
            let body: Vec<Value> = todo
                .iter()
                .enumerate()
                .map(|(i, &k)| json!({ "jsonrpc": "2.0", "id": i, "method": chunk[k].0, "params": chunk[k].1 }))
                .collect();
            let t_send = Instant::now();
            LAST_HTTP.with(|c| c.set((0, 0.0)));
            let posted = self.post(ep, &Value::Array(body).to_string());
            let total_ms = t_send.elapsed().as_secs_f64() * 1000.0;
            let answer = match posted {
                Ok(v) => split_batch_answer(v, todo.len()),
                Err(e) => Err(e),
            };
            // The provider said "too fast": cut our rate (adaptive limit).
            self.budgets[ep.budget].observe(&answer);
            if paid_first {
                log_http(ep.label, &todo.iter().map(|k| &chunk[*k]).collect::<Vec<_>>(), total_ms, &answer);
            }
            match answer {
                Ok(rs) => {
                    let mut again = Vec::new();
                    for (r, k) in rs.into_iter().zip(todo.iter().copied()) {
                        match &r {
                            // Copy 2 reads old state the plain way itself
                            // (loader.rs): no re-routing to other nodes.
                            Err(e) if state_unavailable(e) && !paid_first => {
                                results[k] = Some(r);
                                again.push(k);
                            }
                            _ => results[k] = Some(r),
                        }
                    }
                    todo = again;
                }
                Err(e) => {
                    self.note_error(&e);
                    last = e;
                }
            }
        }
        if results.iter().all(|r| r.is_none()) {
            return Err(last);
        }
        Ok(results
            .into_iter()
            .map(|r| r.unwrap_or(Err(RpcErr { code: -1, message: "no node could answer".into() })))
            .collect())
    }
}

thread_local! {
    /// (answer bytes, ms reading the answer body) of this thread's last POST.
    static LAST_HTTP: std::cell::Cell<(usize, f64)> = const { std::cell::Cell::new((0, 0.0)) };
    /// ms this thread's last request waited for the speed limit / allowance.
    static LAST_WAIT: std::cell::Cell<f64> = const { std::cell::Cell::new(0.0) };
}

/// Copy-2 HTTP requests logged so far (the first ARBSIM_HTTP_LOG, 100).
static HTTP_LOGGED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// One log line per copy-2 HTTP request (the first ARBSIM_HTTP_LOG, 100):
/// node, method mix, calls, storage keys / overrides asked, answer size,
/// total ms and the part spent reading the answer body. Never the URL.
fn log_http(node: &str, calls: &[&(&str, Value)], total_ms: f64, answer: &Result<Vec<CallResult>, NodeErr>) {
    let n = HTTP_LOGGED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if n >= env_u64("ARBSIM_HTTP_LOG", 100) {
        return;
    }
    let mut mix: Vec<(&str, usize)> = Vec::new();
    let mut keys = 0usize;
    for (m, p) in calls {
        match mix.iter_mut().find(|x| x.0 == *m) {
            Some(x) => x.1 += 1,
            None => mix.push((m, 1)),
        }
        if *m == "eth_getProof" {
            keys += p.get(1).and_then(|k| k.as_array()).map(|a| a.len()).unwrap_or(0);
        }
        if *m == "eth_call" {
            keys += p
                .get(2)
                .and_then(|o| o.as_object())
                .map(|o| o.values().map(|v| v["stateDiff"].as_object().map(|d| d.len()).unwrap_or(0)).sum::<usize>())
                .unwrap_or(0);
        }
    }
    let (bytes, read_ms) = LAST_HTTP.with(|c| c.get());
    let wait_ms = LAST_WAIT.with(|c| c.get());
    let errs = match answer {
        Ok(v) => v.iter().filter(|r| r.is_err()).count(),
        Err(_) => calls.len(),
    };
    let mixs: Vec<String> = mix.iter().map(|(m, c)| format!("{m} x{c}")).collect();
    eprintln!(
        "[arbsim] copy2 http #{}: {node} [{}] {} calls, {keys} keys/overrides, answer {} KB, waited {wait_ms:.0} ms for the speed limit before sending, then {:.0} ms total ({:.0} ms reading the answer), {errs} error item(s)",
        n + 1,
        mixs.join(", "),
        calls.len(),
        bytes / 1024,
        total_ms,
        read_ms
    );
}

/// ureq error -> short text WITHOUT the URL (some variants carry it).
fn safe_err(e: &ureq::Error) -> String {
    match e {
        ureq::Error::StatusCode(c) => format!("HTTP {c}"),
        ureq::Error::Timeout(_) => "timeout".into(),
        ureq::Error::HostNotFound => "host not found".into(),
        ureq::Error::ConnectionFailed => "connection failed".into(),
        ureq::Error::Io(io) => format!("io error ({:?})", io.kind()),
        ureq::Error::BadUri(_) => "bad URL".into(),
        ureq::Error::Tls(_) => "TLS error".into(),
        ureq::Error::BodyExceedsLimit(_) => "answer too large".into(),
        _ => "request failed".into(),
    }
}

impl NodeApi for NodeClient {
    fn call_batch(&self, class: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        let mut out: Vec<CallResult> = Vec::with_capacity(calls.len());
        for chunk in calls.chunks(self.max_batch) {
            out.extend(self.send_chunk(class, chunk, false)?);
        }
        Ok(out)
    }

    fn call_batch_paid(&self, class: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        let mut out: Vec<CallResult> = Vec::with_capacity(calls.len());
        for chunk in calls.chunks(self.max_batch) {
            out.extend(self.send_chunk(class, chunk, true)?);
        }
        Ok(out)
    }

    fn usage(&self) -> Value {
        let mut u = self.budgets[0].usage();
        u["public"] = self.budgets[1].usage();
        u["nodes"] = json!(self.labels());
        u["errors"] = json!(self.errors.lock().unwrap().0);
        u
    }
}

/// A batch answer (array, any order, matched by id) -> results in call order.
pub fn split_batch_answer(v: Value, n: usize) -> Result<Vec<CallResult>, NodeErr> {
    let arr = match v {
        Value::Array(a) => a,
        // Some nodes answer a whole-batch error as one object.
        Value::Object(o) => {
            let msg = o.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()).unwrap_or("error");
            return Err(NodeErr::BadResponse(format!("batch refused: {msg}")));
        }
        _ => return Err(NodeErr::BadResponse("batch answer is not a list".into())),
    };
    let mut out: Vec<Option<CallResult>> = vec![None; n];
    for item in arr {
        let Some(id) = item.get("id").and_then(|i| i.as_u64()).map(|i| i as usize) else { continue };
        if id >= n {
            continue;
        }
        let r = if let Some(e) = item.get("error").filter(|e| !e.is_null()) {
            Err(RpcErr {
                code: e.get("code").and_then(|c| c.as_i64()).unwrap_or(0),
                message: e.get("message").and_then(|m| m.as_str()).unwrap_or("").to_string(),
            })
        } else {
            Ok(item.get("result").cloned().unwrap_or(Value::Null))
        };
        out[id] = Some(r);
    }
    Ok(out
        .into_iter()
        .map(|r| r.unwrap_or(Err(RpcErr { code: -1, message: "no answer for this call".into() })))
        .collect())
}

// ---------------------------------------------------------------------------
// Typed helpers on top of NodeApi
// ---------------------------------------------------------------------------
/// Block tag text for a block number.
pub fn tag(block: u64) -> Value {
    Value::String(quantity_u64(block))
}

fn value_u256(v: &Value) -> Result<U256, String> {
    v.as_str().ok_or("not text".to_string()).and_then(parse_u256)
}

/// A value fetched from the node at some block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fetched {
    /// Storage slot value.
    Slot(Address, U256, U256),
    /// Account basics + code. None = the account is empty (no balance,
    /// nonce or code).
    Account(Address, Option<FetchedAccount>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchedAccount {
    pub balance: U256,
    pub nonce: u64,
    pub code: Bytes,
}

/// Why one item could not be fetched.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ItemErr {
    /// The node doesn't have that block (yet).
    BlockUnavailable,
    /// Something else (node error text).
    Other(String),
    /// We can't ask for it (code by hash has no RPC method).
    Unsupported,
}

/// Fetch items (slots / whole accounts) at `block`, batched.
/// Code(hash) items can't be fetched (no RPC for it) -> ItemErr::Unsupported.
pub fn fetch_items(
    node: &dyn NodeApi,
    class: Class,
    block: u64,
    items: &[MissItem],
) -> Result<Vec<(MissItem, Result<Fetched, ItemErr>)>, NodeErr> {
    let t = tag(block);
    let mut calls: Vec<(&str, Value)> = Vec::new();
    // Where each item's answers start in `calls` (and how many).
    let mut spans: Vec<Option<usize>> = Vec::with_capacity(items.len());
    for it in items {
        match it {
            MissItem::Slot(a, s) => {
                spans.push(Some(calls.len()));
                calls.push(("eth_getStorageAt", json!([to_hex(a.as_slice()), format!("{:#066x}", s), t])));
            }
            MissItem::Account(a) => {
                spans.push(Some(calls.len()));
                let ah = to_hex(a.as_slice());
                calls.push(("eth_getBalance", json!([ah, t])));
                calls.push(("eth_getTransactionCount", json!([ah, t])));
                calls.push(("eth_getCode", json!([ah, t])));
            }
            MissItem::Code(_) => spans.push(None),
        }
    }
    let res = if calls.is_empty() { Vec::new() } else { node.call_batch(class, &calls)? };
    let conv = |r: &CallResult| -> Result<Value, ItemErr> {
        match r {
            Ok(Value::Null) => Err(ItemErr::BlockUnavailable),
            Ok(v) => Ok(v.clone()),
            Err(e) if e.is_block_unavailable() => Err(ItemErr::BlockUnavailable),
            Err(e) => Err(ItemErr::Other(e.message.clone())),
        }
    };
    let mut out = Vec::with_capacity(items.len());
    for (it, span) in items.iter().zip(spans) {
        let r = match (it, span) {
            (MissItem::Slot(a, s), Some(i)) => conv(&res[i])
                .and_then(|v| value_u256(&v).map_err(ItemErr::Other))
                .map(|v| Fetched::Slot(*a, *s, v)),
            (MissItem::Account(a), Some(i)) => (|| {
                let bal = value_u256(&conv(&res[i])?).map_err(ItemErr::Other)?;
                let nonce = conv(&res[i + 1])?
                    .as_str()
                    .ok_or(ItemErr::Other("nonce not text".into()))
                    .and_then(|s| parse_u64(s).map_err(ItemErr::Other))?;
                let code = conv(&res[i + 2])?
                    .as_str()
                    .ok_or(ItemErr::Other("code not text".into()))
                    .and_then(|s| parse_bytes(s).map_err(ItemErr::Other))?;
                let empty = bal.is_zero() && nonce == 0 && code.is_empty();
                Ok(Fetched::Account(*a, if empty { None } else { Some(FetchedAccount { balance: bal, nonce, code }) }))
            })(),
            _ => Err(ItemErr::Unsupported),
        };
        out.push((it.clone(), r));
    }
    Ok(out)
}

/// Fetch only contract code for these addresses at `block` (one call each).
pub fn fetch_codes(node: &dyn NodeApi, class: Class, block: u64, addrs: &[Address]) -> Result<Vec<(Address, Result<Bytes, ItemErr>)>, NodeErr> {
    if addrs.is_empty() {
        return Ok(Vec::new());
    }
    let t = tag(block);
    let calls: Vec<(&str, Value)> = addrs.iter().map(|a| ("eth_getCode", json!([to_hex(a.as_slice()), t]))).collect();
    let res = node.call_batch(class, &calls)?;
    Ok(addrs
        .iter()
        .zip(res)
        .map(|(a, r)| {
            let v = match r {
                Ok(Value::String(s)) => parse_bytes(&s).map_err(ItemErr::Other),
                Ok(_) => Err(ItemErr::BlockUnavailable),
                Err(e) if e.is_block_unavailable() => Err(ItemErr::BlockUnavailable),
                Err(e) => Err(ItemErr::Other(e.message)),
            };
            (*a, v)
        })
        .collect())
}

/// The parts of a block header we use.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Header {
    pub number: u64,
    pub hash: B256,
    pub parent_hash: B256,
    pub timestamp: u64,
    pub base_fee: u64,
    pub gas_limit: u64,
    pub miner: Address,
    pub mix_hash: B256,
}

/// Parse an eth_getBlockByNumber answer (header fields only).
pub fn parse_header(v: &Value) -> Result<Header, String> {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).ok_or_else(|| format!("header field {k} missing"));
    let b256 = |k: &str| -> Result<B256, String> { Ok(B256::from(parse_u256(s(k)?)?.to_be_bytes::<32>())) };
    Ok(Header {
        number: parse_u64(s("number")?)?,
        hash: b256("hash")?,
        parent_hash: b256("parentHash")?,
        timestamp: parse_u64(s("timestamp")?)?,
        base_fee: s("baseFeePerGas").ok().map(parse_u64).transpose()?.unwrap_or(0),
        gas_limit: s("gasLimit").ok().map(parse_u64).transpose()?.unwrap_or(0),
        miner: s("miner").ok().map(parse_address).transpose()?.unwrap_or_default(),
        mix_hash: s("mixHash").ok().map(|_| b256("mixHash")).transpose()?.unwrap_or_default(),
    })
}

/// Header of `block` (None = the node doesn't have it yet).
pub fn get_header(node: &dyn NodeApi, class: Class, block: u64) -> Result<Option<Header>, NodeErr> {
    let r = node.call_batch(class, &[("eth_getBlockByNumber", json!([tag(block), false]))])?;
    match r.into_iter().next() {
        Some(Ok(Value::Null)) | None => Ok(None),
        Some(Ok(v)) => parse_header(&v).map(Some).map_err(NodeErr::BadResponse),
        Some(Err(e)) if e.is_block_unavailable() => Ok(None),
        Some(Err(e)) => Err(NodeErr::BadResponse(e.message)),
    }
}

/// Latest block number the node has.
pub fn block_number(node: &dyn NodeApi, class: Class) -> Result<u64, NodeErr> {
    let r = node.call_batch(class, &[("eth_blockNumber", json!([]))])?;
    match r.into_iter().next() {
        Some(Ok(Value::String(s))) => parse_u64(&s).map_err(NodeErr::BadResponse),
        Some(Err(e)) => Err(NodeErr::BadResponse(e.message)),
        _ => Err(NodeErr::BadResponse("eth_blockNumber: no number".into())),
    }
}

/// debug_traceBlockByNumber with the prestate tracer in diff mode: the
/// node's own list of what every transaction of the block changed.
/// Ok(None) = the node doesn't have the block yet.
pub fn trace_block_diff(node: &dyn NodeApi, class: Class, block: u64) -> Result<Option<Value>, NodeErr> {
    let params = json!([tag(block), { "tracer": "prestateTracer", "tracerConfig": { "diffMode": true } }]);
    let r = node.call_batch(class, &[("debug_traceBlockByNumber", params)])?;
    match r.into_iter().next() {
        Some(Ok(Value::Null)) | None => Ok(None),
        Some(Ok(v)) => Ok(Some(v)),
        Some(Err(e)) if e.is_block_unavailable() => Ok(None),
        Some(Err(e)) => Err(NodeErr::BadResponse(format!("trace: {}", e.message))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_answers_are_matched_by_id() {
        let v = json!([
            { "jsonrpc": "2.0", "id": 1, "result": "0x2" },
            { "jsonrpc": "2.0", "id": 0, "error": { "code": -32000, "message": "header not found" } },
        ]);
        let r = split_batch_answer(v, 3).unwrap();
        assert!(r[0].as_ref().unwrap_err().is_block_unavailable());
        assert_eq!(r[1], Ok(json!("0x2")));
        assert!(r[2].is_err()); // missing answer
    }

    #[test]
    fn speed_limit_is_a_plain_bucket_that_waits_and_never_refuses() {
        // 8 callers hammering a 100/s bucket for 1.5 s: about 100 (bucket)
        // + 150 go through, every caller gets some, nobody is refused.
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::sync::Arc;
        let b = Arc::new(Budget::new(1_000_000, 100.0, None));
        let counts: Arc<Vec<AtomicU64>> = Arc::new((0..8).map(|_| AtomicU64::new(0)).collect());
        let stop = Instant::now() + Duration::from_millis(1500);
        let hs: Vec<_> = (0..8)
            .map(|i| {
                let (b, counts) = (b.clone(), counts.clone());
                std::thread::spawn(move || {
                    while Instant::now() < stop {
                        b.take(if i % 2 == 0 { Class::Fill } else { Class::Bulk }, 1).unwrap();
                        counts[i].fetch_add(1, Ordering::Relaxed);
                    }
                })
            })
            .collect();
        for h in hs {
            h.join().unwrap();
        }
        let total: u64 = counts.iter().map(|c| c.load(Ordering::Relaxed)).sum();
        assert!(total <= 100 + 150 + 16, "over the limit: {total}");
        assert!(total >= 200, "too slow: {total}");
        assert!(counts.iter().all(|c| c.load(Ordering::Relaxed) > 0), "somebody starved");
    }

    #[test]
    fn provider_refusals_halve_the_rate_once_per_second_then_it_recovers() {
        let b = Budget::new(1_000_000, 100.0, None);
        assert_eq!(b.current_rps(), 100.0);
        // 16 refusals at once (16 requests in flight): ONE cut.
        for _ in 0..16 {
            b.note_refusal();
        }
        assert!((b.current_rps() - 50.0).abs() < 0.5, "{}", b.current_rps());
        assert_eq!(b.usage()["providerRefusals"], json!(16));
        assert_eq!(b.usage()["rateCuts"], json!(1));
        // A refusal a second later: halved again; never below the floor.
        std::thread::sleep(Duration::from_millis(1050));
        b.note_refusal();
        assert!((b.current_rps() - 25.0).abs() < 0.5, "{}", b.current_rps());
        for _ in 0..10 {
            b.inner.lock().unwrap().last_cut = None;
            b.note_refusal();
        }
        assert!((b.current_rps() - b.min_rps).abs() < 1e-9);
        // No growth during the first 2 s after a refusal, then +5 %/s of 100.
        std::thread::sleep(Duration::from_millis(1500));
        assert!(b.current_rps() < b.min_rps + 0.5, "{}", b.current_rps());
        std::thread::sleep(Duration::from_millis(1500));
        let r = b.current_rps();
        assert!(r > b.min_rps + 3.0 && r < b.min_rps + 8.0, "{r}");
    }

    #[test]
    fn refused_requests_are_recognised_and_slow_the_bucket() {
        // Chainstack's words, an HTTP 429, a batch refused whole: refusals.
        assert!(is_rate_refusal(-32005, "You've exceeded the RPS limit available on the current plan."));
        assert!(is_rate_refusal(0, "node1: rate limited (429)"));
        assert!(is_rate_refusal(0, "batch refused: You've exceeded the RPS limit available on the current plan."));
        // Not refusals: a size limit, a missing block, old state.
        assert!(!is_rate_refusal(-32000, "header not found"));
        assert!(!is_rate_refusal(-32000, "historical state 27a8 is not available"));
        assert!(!is_rate_refusal(-32602, "batch size limit exceeded: max 50"));
        let b = Budget::new(1_000_000, 100.0, None);
        let refused: Result<Vec<CallResult>, NodeErr> = Ok(vec![Ok(json!("0x1")), Err(RpcErr { code: -32005, message: "You've exceeded the RPS limit available on the current plan.".into() })]);
        assert!(b.observe(&refused));
        assert!(!b.observe(&Ok(vec![Ok(json!("0x1"))])));
        assert!(b.observe(&Err(NodeErr::Transport("node1: rate limited (429)".into()))));
        assert!(b.current_rps() <= 50.5);
        // The bucket now lets ~50/s through, not 100/s.
        let t = Instant::now();
        let mut n = 0;
        while t.elapsed() < Duration::from_millis(1000) {
            b.take(Class::Fill, 1).unwrap();
            n += 1;
        }
        assert!(n <= 60, "{n} requests in 1 s after a cut to 50/s");
    }

    #[test]
    fn budget_shares_and_daily_cap() {
        let b = Budget::new(100, 10_000.0, None);
        b.take(Class::Verify, 80).unwrap();
        // Verify may use only 80% of the cap.
        assert!(matches!(b.take(Class::Verify, 1), Err(NodeErr::Budget(_))));
        // Critical may still use the rest.
        b.take(Class::Critical, 20).unwrap();
        assert!(b.take(Class::Critical, 1).is_err());
        assert_eq!(b.used(), 100);
        assert_eq!(b.usage()["refusedToday"], json!(2));
    }

    #[test]
    fn budget_survives_restart_via_file() {
        let dir = std::env::temp_dir().join(format!("arbsim-budget-test-{}", std::process::id()));
        let f = dir.to_string_lossy().to_string() + ".json";
        let b = Budget::new(1000, 10_000.0, Some(f.clone()));
        b.take(Class::Fill, 30).unwrap(); // >= 25 unsaved -> written
        let b2 = Budget::new(1000, 10_000.0, Some(f.clone()));
        assert_eq!(b2.used(), 30);
        let _ = std::fs::remove_file(&f);
    }

    #[test]
    fn header_parse() {
        let h = parse_header(&json!({
            "number": "0x10", "hash": "0x01", "parentHash": "0x02", "timestamp": "0x64",
            "baseFeePerGas": "0x989680", "gasLimit": "0x4000000000000", "miner": "0xa4b000000000000000000073657175656e636572",
            "mixHash": "0x0000000000000001000000000000002a0000000000000033000000000000000"
        }));
        // mixHash above is 63 hex digits: still a number, parsed fine.
        let h = h.unwrap();
        assert_eq!(h.number, 16);
        assert_eq!(h.base_fee, 10_000_000);
        assert_eq!(h.timestamp, 100);
    }
}
