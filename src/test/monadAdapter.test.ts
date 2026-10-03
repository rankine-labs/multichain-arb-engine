import { WebSocketServer, WebSocket } from 'ws';
import { AddressInfo } from 'net';

// Runs the real MonadAdapter against a fake local websocket server to prove:
//   - connect() only succeeds once eth_subscribe is ACCEPTED
//   - a rejected subscribe (e.g. quota exhausted) makes connect() fail
//   - a server that never answers makes connect() time out instead of hang
//   - after repeated short-lived connections it switches to the fallback

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

type Mode = 'accept' | 'reject' | 'silent' | 'accept-then-drop';

// Starts a fake Monad RPC websocket server whose behaviour we can switch.
function startServer(initial: Mode) {
  const wss = new WebSocketServer({ port: 0 });
  const state = { mode: initial, connections: 0 };
  wss.on('connection', (sock: WebSocket) => {
    state.connections++;
    sock.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method !== 'eth_subscribe') return;
      if (state.mode === 'accept' || state.mode === 'accept-then-drop') {
        sock.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: '0xsub' }));
        if (state.mode === 'accept-then-drop') setTimeout(() => sock.close(4000, 'test drop'), 20);
      } else if (state.mode === 'reject') {
        sock.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32007, message: 'daily request limit reached' } }));
        sock.close(1008, 'quota');
      }
      // 'silent': never answer
    });
  });
  const port = (wss.address() as AddressInfo).port;
  return { wss, state, url: `ws://127.0.0.1:${port}` };
}

async function main() {
  const primary = startServer('accept');
  const fallback = startServer('accept');

  // The adapter reads its endpoints when the module loads, so set env first.
  process.env.MONAD_QUICKNODE_WSS = primary.url;
  process.env.MONAD_FALLBACK_WSS = fallback.url;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { MonadAdapter } = require('../chains/monad');

  // Keep adapter logging out of the test output.
  const origLog = console.log, origWarn = console.warn, origErr = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  const results: Array<[boolean, string]> = [];
  const check = (c: boolean, m: string) => results.push([c, m]);

  try {
    const adapter = new MonadAdapter();

    // 1. Accepted subscription -> connect resolves, health is good.
    await adapter.connect();
    const h1 = await adapter.healthCheck();
    check(h1.healthy === true, 'connect resolves after subscription is accepted, health OK');

    // 2. Rejected subscription -> connect rejects (counts as a failure upstream).
    primary.state.mode = 'reject';
    let rejected = false;
    try { await adapter.connect(); } catch { rejected = true; }
    check(rejected, 'rejected eth_subscribe makes connect() fail instead of reporting success');
    check((await adapter.healthCheck()).healthy === false, 'adapter reports unhealthy after a rejected subscribe');

    // 3. Silent server -> connect times out (10s cap) rather than hanging forever.
    primary.state.mode = 'silent';
    const t0 = Date.now();
    let timedOut = false;
    try { await adapter.connect(); } catch (e: any) { timedOut = /timed out/.test(String(e?.message)); }
    const took = Date.now() - t0;
    check(timedOut && took < 12_000, `silent server times out instead of hanging (took ${took}ms)`);

    // One more rejected attempt -> 3 primary failures in a row.
    primary.state.mode = 'reject';
    try { await adapter.connect(); } catch { /* expected */ }

    // 4. Primary has now failed 3 times in a row -> next connect uses fallback.
    const fallbackBefore = fallback.state.connections;
    await adapter.connect();
    check(fallback.state.connections === fallbackBefore + 1, 'switches to fallback after repeated primary failures');
    check((await adapter.healthCheck()).healthy === true, 'healthy on fallback');

    // 5. Drop on fallback is detected as unhealthy (no self-reconnect).
    fallback.state.mode = 'accept-then-drop';
    await adapter.connect();
    await new Promise((r) => setTimeout(r, 100));
    const connsAfterDrop = fallback.state.connections;
    await new Promise((r) => setTimeout(r, 200));
    check((await adapter.healthCheck()).healthy === false, 'dropped socket reports unhealthy');
    check(fallback.state.connections === connsAfterDrop, 'adapter does NOT reconnect on its own (chainManager owns that)');

    await adapter.disconnect();
  } finally {
    console.log = origLog; console.warn = origWarn; console.error = origErr;
    primary.wss.close();
    fallback.wss.close();
  }

  for (const [c, m] of results) assert(c, m);
}

main().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; });
