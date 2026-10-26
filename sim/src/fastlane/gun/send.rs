// ============================================================================
// GUN: SEND (eth_sendRawTransaction over kept-alive connections)
//
// Plain English:
//   The signed trade goes to the same place the Node sender sends to:
//   ROBINHOOD_SEND_RPC, else Robinhood's sequencer
//   (src/config/robinhoodEndpoints.ts robinhoodSendRpc). The URL is never
//   printed (it may hold an API key): logs say "send endpoint".
//
//   Speed:
//     - The connection (TCP + TLS) is opened in advance and kept warm with a
//       tiny eth_chainId every SEND_WARM_MS (default 1000, same as Node), so
//       a trade never pays a fresh handshake (~20-25 ms to the sequencer).
//     - The caller does NOT wait for the reply. The sequencer's reply takes
//       ~115 ms, mostly it queueing us; what matters for winning is when our
//       bytes LEFT. So a small pool of sender threads (FASTLANE_SEND_CONNS,
//       default 2, each with its own kept-alive connection) takes jobs from a
//       queue: the thread writes the request, tells the caller "handed to
//       socket" right away, then waits for the reply on its own and reports
//       it through the job's reply channel.
//     - Two connections: a second trade fired while the first one's reply
//       is still on its way goes out at once on the other connection
//       (HTTP/1.1 can't send two requests on one connection without waiting).
//   Small and blocking on purpose (no async runtime): the threads sleep in
//   the queue almost all the time, so they cost nothing on 2 CPUs.
//
//   Retry rule: if WRITING to a kept-alive connection fails (the server
//   closed it while idle), the same signed bytes are written once more on a
//   fresh connection. Sending the same signed transaction twice is harmless
//   (the second copy is "already known"). Once the request is written, there
//   is no retry: a missing reply is reported as an error and the nonce
//   tracker re-syncs from the chain.
// ============================================================================
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::check::hexutil::to_hex;

/// Robinhood's sequencer (same default as the Node bot).
pub const ROBINHOOD_SEQUENCER_RPC: &str = "https://sequencer.mainnet.chain.robinhood.com";

/// The send endpoint, like robinhoodSendRpc(): ROBINHOOD_SEND_RPC else the sequencer.
pub fn send_url_from_env() -> String {
    std::env::var("ROBINHOOD_SEND_RPC").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| ROBINHOOD_SEQUENCER_RPC.to_string())
}

// ---------------------------------------------------------------------------
// URL + connection
// ---------------------------------------------------------------------------
#[derive(Clone, Debug)]
struct Target {
    tls: bool,
    host: String,
    port: u16,
    /// Path + query ("/" if none).
    path: String,
}

fn parse_url(url: &str) -> Result<Target, String> {
    let (tls, rest) = if let Some(r) = url.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = url.strip_prefix("http://") {
        (false, r)
    } else {
        return Err("send endpoint must start with http:// or https://".into());
    };
    let (hostport, path) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].to_string()),
        None => match rest.find('?') {
            Some(i) => (&rest[..i], format!("/{}", &rest[i..])),
            None => (rest, "/".to_string()),
        },
    };
    if hostport.contains('@') {
        return Err("send endpoint with user:password is not supported".into());
    }
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) if !h.contains(']') || h.ends_with(']') => (h.to_string(), p.parse::<u16>().map_err(|_| "send endpoint: bad port".to_string())?),
        _ => (hostport.to_string(), if tls { 443 } else { 80 }),
    };
    if host.is_empty() {
        return Err("send endpoint: no host".into());
    }
    Ok(Target { tls, host, port, path })
}

fn tls_config() -> Arc<rustls::ClientConfig> {
    static CFG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    CFG.get_or_init(|| {
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("TLS versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
        Arc::new(cfg)
    })
    .clone()
}

enum Stream {
    Plain(BufReader<TcpStream>),
    Tls(Box<BufReader<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>>),
}

impl Stream {
    fn writer(&mut self) -> &mut dyn Write {
        match self {
            Stream::Plain(b) => b.get_mut(),
            Stream::Tls(b) => b.get_mut(),
        }
    }
    fn reader(&mut self) -> &mut dyn BufRead {
        match self {
            Stream::Plain(b) => b,
            Stream::Tls(b) => b.as_mut(),
        }
    }
}

/// One kept-alive HTTP/1.1 connection to the send endpoint.
pub struct Conn {
    target: Target,
    timeout: Duration,
    /// TLS settings (public web roots; tests may add their own root).
    tls: Arc<rustls::ClientConfig>,
    stream: Option<Stream>,
    /// Fresh connections opened (status: should stay low when warm works).
    pub opened: u64,
}

impl Conn {
    pub fn new(url: &str, timeout: Duration) -> Result<Conn, String> {
        Ok(Conn { target: parse_url(url)?, timeout, tls: tls_config(), stream: None, opened: 0 })
    }

    /// Tests only: trust this extra root certificate (DER) too.
    #[doc(hidden)]
    pub fn with_extra_root(url: &str, timeout: Duration, der: Vec<u8>) -> Result<Conn, String> {
        let mut roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        roots.add(rustls::pki_types::CertificateDer::from(der)).map_err(|_| "bad test root".to_string())?;
        let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|_| "TLS versions".to_string())?
            .with_root_certificates(roots)
            .with_no_client_auth();
        Ok(Conn { target: parse_url(url)?, timeout, tls: Arc::new(cfg), stream: None, opened: 0 })
    }

    fn connect(&mut self) -> Result<(), String> {
        let addr = (self.target.host.as_str(), self.target.port)
            .to_socket_addrs()
            .map_err(|_| "send endpoint: host not found".to_string())?
            .next()
            .ok_or("send endpoint: host not found")?;
        let tcp = TcpStream::connect_timeout(&addr, self.timeout).map_err(|e| format!("send endpoint: connect failed ({:?})", e.kind()))?;
        let _ = tcp.set_nodelay(true);
        let _ = tcp.set_read_timeout(Some(self.timeout));
        let _ = tcp.set_write_timeout(Some(self.timeout));
        let s = if self.target.tls {
            let name = rustls::pki_types::ServerName::try_from(self.target.host.clone()).map_err(|_| "send endpoint: bad host name".to_string())?;
            let conn = rustls::ClientConnection::new(self.tls.clone(), name).map_err(|_| "send endpoint: TLS setup failed".to_string())?;
            let mut so = rustls::StreamOwned::new(conn, tcp);
            // Finish the handshake now, not on the first trade.
            while so.conn.is_handshaking() {
                so.conn.complete_io(&mut so.sock).map_err(|e| format!("send endpoint: TLS handshake failed ({:?})", e.kind()))?;
            }
            Stream::Tls(Box::new(BufReader::new(so)))
        } else {
            Stream::Plain(BufReader::new(tcp))
        };
        self.stream = Some(s);
        self.opened += 1;
        Ok(())
    }

    /// Write one JSON-RPC POST. Ok = fully handed to the socket.
    fn write_request(&mut self, body: &[u8]) -> Result<(), String> {
        if self.stream.is_none() {
            self.connect()?;
        }
        let head = format!(
            "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n",
            self.target.path,
            self.target.host,
            body.len()
        );
        let mut msg = Vec::with_capacity(head.len() + body.len());
        msg.extend_from_slice(head.as_bytes());
        msg.extend_from_slice(body);
        let w = self.stream.as_mut().unwrap().writer();
        let r = w.write_all(&msg).and_then(|_| w.flush());
        if let Err(e) = r {
            self.stream = None;
            return Err(format!("send endpoint: write failed ({:?})", e.kind()));
        }
        Ok(())
    }

    /// Read one HTTP response: (status, body).
    fn read_response(&mut self) -> Result<(u16, Vec<u8>), String> {
        let r = self.read_response_inner();
        if r.is_err() {
            self.stream = None;
        }
        r
    }

    fn read_response_inner(&mut self) -> Result<(u16, Vec<u8>), String> {
        let rd = self.stream.as_mut().ok_or("send endpoint: no connection")?.reader();
        let io = |e: std::io::Error| format!("send endpoint: no reply ({:?})", e.kind());
        let mut line = String::new();
        if rd.read_line(&mut line).map_err(io)? == 0 {
            return Err("send endpoint: connection closed".into());
        }
        let status: u16 = line.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or("send endpoint: bad status line")?;
        let (mut len, mut chunked, mut close) = (None::<usize>, false, false);
        loop {
            line.clear();
            if rd.read_line(&mut line).map_err(io)? == 0 {
                return Err("send endpoint: connection closed in headers".into());
            }
            let l = line.trim_end();
            if l.is_empty() {
                break;
            }
            if let Some((k, v)) = l.split_once(':') {
                let (k, v) = (k.trim().to_ascii_lowercase(), v.trim().to_ascii_lowercase());
                match k.as_str() {
                    "content-length" => len = v.parse().ok(),
                    "transfer-encoding" => chunked = v.contains("chunked"),
                    "connection" => close = v.contains("close"),
                    _ => {}
                }
            }
        }
        const MAX: usize = 1 << 20;
        let mut body = Vec::new();
        if chunked {
            loop {
                line.clear();
                rd.read_line(&mut line).map_err(io)?;
                let n = usize::from_str_radix(line.trim().split(';').next().unwrap_or(""), 16).map_err(|_| "send endpoint: bad chunk")?;
                if n == 0 {
                    // trailers until empty line
                    loop {
                        line.clear();
                        if rd.read_line(&mut line).map_err(io)? == 0 || line.trim().is_empty() {
                            break;
                        }
                    }
                    break;
                }
                if body.len() + n > MAX {
                    return Err("send endpoint: reply too large".into());
                }
                let start = body.len();
                body.resize(start + n, 0);
                rd.read_exact(&mut body[start..]).map_err(io)?;
                let mut crlf = [0u8; 2];
                rd.read_exact(&mut crlf).map_err(io)?;
            }
        } else if let Some(n) = len {
            if n > MAX {
                return Err("send endpoint: reply too large".into());
            }
            body.resize(n, 0);
            rd.read_exact(&mut body).map_err(io)?;
        } else {
            rd.take(MAX as u64).read_to_end(&mut body).map_err(io)?;
            close = true;
        }
        if close {
            self.stream = None;
        }
        Ok((status, body))
    }

    /// Write (retrying once on a fresh connection if a kept-alive one was
    /// closed), returning when the bytes are handed to the socket.
    fn write_with_retry(&mut self, body: &[u8]) -> Result<(), String> {
        let was_open = self.stream.is_some();
        match self.write_request(body) {
            Ok(()) => Ok(()),
            Err(_) if was_open => self.write_request(body),
            Err(e) => Err(e),
        }
    }

    /// Blocking JSON-RPC call (warm-ups, tests).
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).to_string();
        self.write_with_retry(body.as_bytes())?;
        let (status, b) = self.read_response()?;
        parse_rpc_reply(status, &b)
    }
}

fn parse_rpc_reply(status: u16, body: &[u8]) -> Result<Value, String> {
    match serde_json::from_slice::<Value>(body) {
        Ok(v) => super::rpc::rpc_result(v).map_err(|e| e.chars().take(200).collect()),
        Err(_) if !(200..300).contains(&status) => Err(format!("send endpoint: HTTP {status}")),
        Err(_) => Err("send endpoint: reply not JSON".into()),
    }
}

// ---------------------------------------------------------------------------
// The sender pool
// ---------------------------------------------------------------------------
/// What came back for one send.
#[derive(Clone, Debug)]
pub struct SendOutcome {
    pub nonce: u64,
    /// Our own hash (computed before sending).
    pub hash: String,
    /// Ok(hash the node returned) or Err(node's / network's message).
    pub result: Result<String, String>,
    /// From fire start to reply (µs).
    pub reply_us: u64,
    /// From handed-to-socket to reply (µs): the sequencer's part.
    pub wait_us: u64,
}

/// One job for the sender threads.
pub struct Job {
    pub raw: Vec<u8>,
    pub nonce: u64,
    pub hash: String,
    /// Fire start (for reply_us).
    pub t0: Instant,
    /// Told "handed to socket" (Ok(µs since t0)) or the write error.
    pub handed: SyncSender<Result<u64, String>>,
    /// Called with the outcome once the reply arrives (on the sender thread).
    pub done: Box<dyn FnOnce(SendOutcome) + Send>,
}

/// The pool: a bounded queue and N threads, each with its own connection.
pub struct SendPool {
    tx: SyncSender<Job>,
}

impl SendPool {
    /// Start `conns` sender threads to `url`. Each opens its connection now
    /// and keeps it warm every `warm` (eth_chainId).
    pub fn start(url: &str, conns: usize, timeout: Duration, warm: Duration) -> Result<SendPool, String> {
        parse_url(url)?;
        let (tx, rx) = mpsc::sync_channel::<Job>(64);
        let rx = Arc::new(Mutex::new(rx));
        for i in 0..conns.clamp(1, 4) {
            let mut conn = Conn::new(url, timeout)?;
            let rx = rx.clone();
            std::thread::Builder::new()
                .name(format!("fastlane-send-{i}"))
                .spawn(move || sender_loop(&mut conn, &rx, warm))
                .map_err(|e| format!("spawn sender: {e}"))?;
        }
        Ok(SendPool { tx })
    }

    /// Queue a job (never blocks: a full queue is an error).
    pub fn submit(&self, job: Job) -> Result<(), String> {
        self.tx.try_send(job).map_err(|e| match e {
            mpsc::TrySendError::Full(_) => "send queue full".to_string(),
            mpsc::TrySendError::Disconnected(_) => "sender stopped".to_string(),
        })
    }
}

fn sender_loop(conn: &mut Conn, rx: &Mutex<Receiver<Job>>, warm: Duration) {
    // Open the connection right away (warm before the first trade).
    let _ = conn.call("eth_chainId", json!([]));
    let mut last_used = Instant::now();
    let mut warn_at: Option<Instant> = None;
    loop {
        // Only one thread waits on the queue at a time; others wait for the lock.
        let got = {
            let r = rx.lock().unwrap();
            r.recv_timeout(warm.saturating_sub(last_used.elapsed()).max(Duration::from_millis(10)))
        };
        match got {
            Ok(job) => {
                run_job(conn, job);
                last_used = Instant::now();
            }
            Err(RecvTimeoutError::Timeout) => {
                if last_used.elapsed() >= warm {
                    // Any reply, even an error, keeps the connection alive.
                    if let Err(e) = conn.call("eth_chainId", json!([])) {
                        if warn_at.map_or(true, |t| t.elapsed() > Duration::from_secs(60)) {
                            warn_at = Some(Instant::now());
                            eprintln!("[fastlane] send endpoint warm-up failed: {e}");
                        }
                    }
                    last_used = Instant::now();
                }
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

fn run_job(conn: &mut Conn, job: Job) {
    let body = format!(r#"{{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["{}"]}}"#, to_hex(&job.raw));
    let written = conn.write_with_retry(body.as_bytes());
    let handed_at = Instant::now();
    let handed_us = handed_at.duration_since(job.t0).as_micros() as u64;
    let result = match written {
        Ok(()) => {
            let _ = job.handed.try_send(Ok(handed_us));
            conn.read_response().and_then(|(st, b)| parse_rpc_reply(st, &b)).and_then(|v| {
                v.as_str().map(|s| s.to_string()).ok_or_else(|| "send endpoint: reply has no hash".to_string())
            })
        }
        Err(e) => {
            let _ = job.handed.try_send(Err(e.clone()));
            Err(e)
        }
    };
    let now = Instant::now();
    (job.done)(SendOutcome {
        nonce: job.nonce,
        hash: job.hash,
        result,
        reply_us: now.duration_since(job.t0).as_micros() as u64,
        wait_us: now.duration_since(handed_at).as_micros() as u64,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        let t = parse_url("https://sequencer.mainnet.chain.robinhood.com").unwrap();
        assert!(t.tls && t.port == 443 && t.path == "/");
        let t = parse_url("http://127.0.0.1:8545/abc?key=1").unwrap();
        assert!(!t.tls && t.port == 8545 && t.host == "127.0.0.1" && t.path == "/abc?key=1");
        let t = parse_url("https://x.example?k=v").unwrap();
        assert_eq!(t.path, "/?k=v");
        assert!(parse_url("ws://x").is_err());
        // Errors never echo the URL.
        let e = parse_url("ftp://secret-key-here").unwrap_err();
        assert!(!e.contains("secret"));
    }
}
