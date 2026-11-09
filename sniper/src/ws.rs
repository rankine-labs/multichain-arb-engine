// ============================================================================
// WEBSOCKET SUBSCRIPTIONS: keep an eth_subscribe stream alive.
//
// Plain English:
//   Connects to a node's websocket, asks for one or more subscriptions
//   (pending txs, new blocks, logs), and hands every notification to a
//   callback together with the moment it arrived. If the connection drops
//   or goes silent it reconnects with a growing delay, and reports each
//   up/down change so the report can exclude periods we were blind.
//
//   The arrival time is taken right after the socket read returns, before
//   any JSON parsing, so parsing cost never inflates the lead times.
// ============================================================================
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

/// One shared clock for every thread: ns since the probe started, so times
/// from different sources are directly comparable.
#[derive(Clone, Copy)]
pub struct Clock {
    start: Instant,
}

impl Clock {
    pub fn new() -> Self {
        Clock { start: Instant::now() }
    }
    pub fn now(&self) -> u64 {
        self.start.elapsed().as_nanos() as u64
    }
}

impl Default for Clock {
    fn default() -> Self {
        Self::new()
    }
}

/// One subscription to request after connecting.
#[derive(Clone, Debug)]
pub struct Sub {
    /// Our own label for it ("pending", "heads", "logs").
    pub label: &'static str,
    /// eth_subscribe params, e.g. ["newHeads"].
    pub params: Value,
    /// Params to retry with if the node refuses the first form (used to fall
    /// back from full pending txs to hash-only).
    pub fallback: Option<Value>,
}

/// If no message arrives for this long the connection is treated as dead.
/// BSC produces a block every ~0.45 s, so 20 s of silence is never normal.
const IDLE_LIMIT: Duration = Duration::from_secs(20);

fn set_timeout(ws: &mut WebSocket<MaybeTlsStream<TcpStream>>, d: Duration) {
    let r = match ws.get_mut() {
        MaybeTlsStream::Plain(s) => s.set_read_timeout(Some(d)),
        MaybeTlsStream::Rustls(s) => s.get_ref().set_read_timeout(Some(d)),
        _ => Ok(()),
    };
    let _ = r;
    // Lower latency for small frames.
    match ws.get_mut() {
        MaybeTlsStream::Plain(s) => {
            let _ = s.set_nodelay(true);
        }
        MaybeTlsStream::Rustls(s) => {
            let _ = s.get_ref().set_nodelay(true);
        }
        _ => {}
    }
}

/// Run until `stop` is set. `on_item(t, label, result)` gets each
/// notification; `on_link(t, up, detail)` gets connection changes.
pub fn run(
    url: &str,
    subs: &[Sub],
    clock: Clock,
    stop: &AtomicBool,
    mut on_item: impl FnMut(u64, &'static str, &Value),
    mut on_link: impl FnMut(u64, bool, String),
) {
    let mut backoff = Duration::from_secs(1);
    while !stop.load(Ordering::Relaxed) {
        match session(url, subs, clock, stop, &mut on_item, &mut on_link) {
            // A session that stayed healthy for a while resets the backoff.
            Ok(lived) if lived > Duration::from_secs(60) => backoff = Duration::from_secs(1),
            Ok(_) => {}
            Err(e) => on_link(clock.now(), false, e),
        }
        if stop.load(Ordering::Relaxed) {
            break;
        }
        std::thread::sleep(backoff);
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

/// One connection's lifetime. Returns how long it lived (after reporting
/// "down") or an error if it never got going.
fn session(
    url: &str,
    subs: &[Sub],
    clock: Clock,
    stop: &AtomicBool,
    on_item: &mut impl FnMut(u64, &'static str, &Value),
    on_link: &mut impl FnMut(u64, bool, String),
) -> Result<Duration, String> {
    let (mut ws, _) = tungstenite::connect(url).map_err(|e| format!("connect: {e}"))?;
    set_timeout(&mut ws, IDLE_LIMIT);
    let born = Instant::now();

    // Request ids: 1..=n first forms, 1001.. fallbacks.
    for (i, s) in subs.iter().enumerate() {
        let req = json!({"jsonrpc": "2.0", "id": i + 1, "method": "eth_subscribe", "params": s.params});
        ws.send(Message::text(req.to_string())).map_err(|e| format!("subscribe: {e}"))?;
    }
    // subscription id (from the node) -> our label
    let mut ids: Vec<(String, &'static str)> = Vec::new();
    let mut announced = false;

    let reason = loop {
        if stop.load(Ordering::Relaxed) {
            let _ = ws.close(None);
            break "stopped".to_string();
        }
        let msg = match ws.read() {
            Ok(m) => m,
            Err(e) => break format!("read: {e}"),
        };
        let t = clock.now();
        let text = match msg {
            Message::Text(s) => s.to_string(),
            Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
            Message::Close(_) => break "closed by server".to_string(),
            _ => continue, // ping/pong handled by tungstenite
        };
        let v: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Notification.
        if v.get("method").and_then(Value::as_str) == Some("eth_subscription") {
            let p = &v["params"];
            let sid = p["subscription"].as_str().unwrap_or("");
            if let Some((_, label)) = ids.iter().find(|(id, _)| id == sid) {
                on_item(t, label, &p["result"]);
            }
            continue;
        }
        // Reply to one of our subscribe requests.
        if let Some(id) = v.get("id").and_then(Value::as_u64) {
            let (idx, is_fallback) = if id > 1000 { ((id - 1001) as usize, true) } else { ((id - 1) as usize, false) };
            let Some(sub) = subs.get(idx) else { continue };
            if let Some(sid) = v.get("result").and_then(Value::as_str) {
                ids.push((sid.to_string(), sub.label));
                let form = if is_fallback { "fallback form" } else { "requested form" };
                on_link(t, true, format!("subscribed {} ({form})", sub.label));
                announced = true;
            } else if let Some(err) = v.get("error") {
                match (&sub.fallback, is_fallback) {
                    (Some(fb), false) => {
                        let req = json!({"jsonrpc": "2.0", "id": 1001 + idx, "method": "eth_subscribe", "params": fb});
                        ws.send(Message::text(req.to_string())).map_err(|e| format!("subscribe fallback: {e}"))?;
                    }
                    _ => break format!("node refused {}: {err}", sub.label),
                }
            }
        }
    };
    if announced {
        on_link(clock.now(), false, reason);
        Ok(born.elapsed())
    } else {
        Err(reason)
    }
}
