import { parentPort } from 'worker_threads';
import WebSocket from 'ws';
import { packFeedFrame, absNow, FeedWorkerState, ToFeedWorker, FromFeedWorker } from './feedWorkerShared';

// ============================================================================
// FEED HELPER THREAD (FEED_WORKER=1; Oct 26, owner approved)
//
// Plain English:
//   This file runs as a separate thread, started by the Robinhood adapter
//   (chains/robinhoodChain.ts) only when FEED_WORKER=1. It holds the
//   sequencer feed websocket and does the heavy reading of every feed
//   message (un-zip, JSON, unpack transactions, hashes, light read), then
//   sends the main thread one small package per message (see
//   chains/feedWorkerShared.ts). It makes NO decisions and never trades.
//
//   It only connects when the main thread says so ("connect"): the main
//   thread's chainManager stays the ONE place that decides when to
//   (re)connect, exactly as before (see the warning at the top of
//   robinhoodChain.ts about competing reconnect loops). If the socket dies
//   this thread just says "closed" and waits.
// ============================================================================

const port = parentPort;
if (!port) throw new Error('feedWorkerEntry must run as a worker thread');

const post = (m: FromFeedWorker) => { try { port.postMessage(m); } catch { /* main thread gone */ } };

// A problem in one async job must not end the thread.
process.on('unhandledRejection', (reason) => {
  post({ t: 'log', line: `[robinhood] feed helper: unhandled problem (keeps running): ${(reason as Error)?.message ?? String(reason)}`, level: 'warn' });
});

let url = '';
let connectTimeoutMs = 10_000;
let wantText = false;
let wantMsgs = false;
const st: FeedWorkerState = { lastSeq: 0 };
let ws: WebSocket | null = null;
let wsConn = 0; // connection number of `ws`

// Closes the current socket without any more messages from it (same clean-up
// as the old connect(): a no-op 'error' listener stays, so a socket that
// errors while closing can't crash this thread).
function dropSocket(): void {
  const old = ws;
  ws = null;
  if (!old) return;
  try { old.removeAllListeners(); old.on('error', () => { /* closing, ignore */ }); old.terminate(); } catch { /* already dead, fine */ }
}

function connect(c: number): void {
  dropSocket();
  let sock: WebSocket;
  try { sock = new WebSocket(url, { handshakeTimeout: connectTimeoutMs }); }
  catch (err) { post({ t: 'error', c, msg: (err as Error)?.message ?? String(err) }); post({ t: 'closed', c }); return; }
  ws = sock; wsConn = c;

  sock.on('open', () => post({ t: 'open', c }));

  sock.on('message', (raw: WebSocket.RawData) => {
    // Arrival times first (before any work), as the old code did.
    const at = Date.now();
    const recvAbs = absNow();
    try {
      const text = raw.toString();
      const out = packFeedFrame(text, st, { c, at, recvAbs, wantText, wantMsgs });
      // One package per feed message (never one per transaction).
      port.postMessage(out);
    } catch (err) {
      post({ t: 'log', line: `[robinhood] feed helper: could not handle a feed message (${(err as Error)?.message ?? err})`, level: 'warn' });
    }
  });

  sock.on('error', (err) => post({ t: 'error', c, msg: err?.message ?? String(err) }));
  sock.on('close', () => { if (ws === sock) ws = null; post({ t: 'closed', c }); });
}

port.on('message', (m: ToFeedWorker) => {
  try {
    switch (m.t) {
      case 'init':
        url = m.url; st.lastSeq = m.lastSeq; wantText = m.wantText; wantMsgs = m.wantMsgs; connectTimeoutMs = m.connectTimeoutMs;
        break;
      case 'taps': wantText = m.wantText; wantMsgs = m.wantMsgs; break;
      case 'connect': connect(m.c); break;
      case 'drop': if (wsConn === m.c) { const s = ws; dropSocket(); if (s) post({ t: 'closed', c: m.c }); } break;
      case 'close': { const s = ws; if (s) { try { s.close(); } catch { /* fine */ } } break; }
      // Tests only: fail on purpose (an uncaught error ends this thread).
      case 'crash': setImmediate(() => { throw new Error('feed helper crash (test)'); }); break;
    }
  } catch (err) {
    post({ t: 'log', line: `[robinhood] feed helper: ${(err as Error)?.message ?? err}`, level: 'warn' });
  }
});

post({ t: 'ready' });
