// ============================================================================
// GUN: READ CLIENT (gas price, block number, nonce)
//
// Plain English:
//   The sender needs a few small facts from a node: the latest block (number
//   + base fee), the parent-chain posting gas, and the wallet's nonce. The
//   Node sender reads these from ROBINHOOD_FAST_RPC, else Robinhood's free
//   public node (src/shadowMain.ts: robinhoodReadProvider). We read from the
//   SAME place, NOT from arbsim's paid node (node.rs): the gas refresh runs
//   every 2 s, which would use up the paid node's daily allowance.
//
//   Same style as node.rs: a small blocking HTTPS client (ureq) with a kept-
//   alive connection; errors never contain the URL (it may hold an API key).
//   Everything else talks through the `ReadRpc` trait so tests can plug in a
//   fake node.
// ============================================================================
use std::time::Duration;

use serde_json::{json, Value};

/// Robinhood Chain's free public node (same default as the Node bot).
pub const ROBINHOOD_PUBLIC_RPC: &str = "https://rpc.mainnet.chain.robinhood.com";

/// One JSON-RPC call to the read node.
pub trait ReadRpc: Send + Sync {
    /// Ok(result) or Err(short text, never a URL).
    fn call(&self, method: &str, params: Value) -> Result<Value, String>;
}

/// The real read node over HTTPS.
pub struct UreqRpc {
    url: String,
    agent: ureq::Agent,
}

impl UreqRpc {
    /// ROBINHOOD_FAST_RPC, else the public node (like the Node bot).
    pub fn from_env() -> Self {
        let url = std::env::var("ROBINHOOD_FAST_RPC").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| ROBINHOOD_PUBLIC_RPC.to_string());
        Self::new(url.trim(), Duration::from_millis(crate::node::env_u64("FASTLANE_READ_TIMEOUT_MS", 4000)))
    }

    pub fn new(url: &str, timeout: Duration) -> Self {
        let cfg = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .http_status_as_error(false)
            .max_idle_connections_per_host(2)
            .build();
        UreqRpc { url: url.to_string(), agent: ureq::Agent::new_with_config(cfg) }
    }
}

impl ReadRpc for UreqRpc {
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).to_string();
        let resp = self
            .agent
            .post(&self.url)
            .header("content-type", "application/json")
            .send(&body)
            .map_err(|e| format!("read node: {}", short_err(&e)))?;
        let status = resp.status().as_u16();
        let text = resp
            .into_body()
            .with_config()
            .limit(4 * 1024 * 1024)
            .read_to_string()
            .map_err(|e| format!("read node: reading answer: {}", short_err(&e)))?;
        if !(200..300).contains(&status) {
            return Err(format!("read node: HTTP {status}"));
        }
        let v: Value = serde_json::from_str(&text).map_err(|_| "read node: not JSON".to_string())?;
        rpc_result(v)
    }
}

/// {"result": ...} -> Ok, {"error": {...}} -> Err(message).
pub fn rpc_result(v: Value) -> Result<Value, String> {
    if let Some(e) = v.get("error") {
        let msg = e.get("message").and_then(|m| m.as_str()).unwrap_or("unknown error");
        let code = e.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
        return Err(format!("{msg} (code {code})"));
    }
    v.get("result").cloned().ok_or_else(|| "answer has no result".to_string())
}

/// ureq error -> short text WITHOUT the URL.
fn short_err(e: &ureq::Error) -> String {
    match e {
        ureq::Error::StatusCode(c) => format!("HTTP {c}"),
        ureq::Error::Timeout(_) => "timeout".into(),
        ureq::Error::HostNotFound => "host not found".into(),
        ureq::Error::ConnectionFailed => "connection failed".into(),
        ureq::Error::Io(io) => format!("io error ({:?})", io.kind()),
        ureq::Error::Tls(_) => "TLS error".into(),
        _ => "request failed".into(),
    }
}

/// eth_getTransactionCount(address, "pending").
pub fn pending_nonce(rpc: &dyn ReadRpc, who: revm::primitives::Address) -> Result<u64, String> {
    let v = rpc.call("eth_getTransactionCount", json!([format!("{who:#x}"), "pending"]))?;
    let s = v.as_str().ok_or("nonce answer is not text")?;
    crate::check::hexutil::parse_u64(s)
}
