// ============================================================================
// client.js — times the FULL round trip the bot would pay:
//   Node builds request -> Unix socket -> revm sidecar runs the call -> answer
//   comes back -> Node decodes it.
//
// Plain English: this is the number that matters. The Rust "bench" mode shows
// how fast revm itself is; this shows how fast it is when the Node bot asks.
//
// Usage:
//   node client.js <socket> <fixture.json> [--n 5000] [--chain-a chain-a.hex]
//     (start the sidecar first:  ./target/release/revm-bench serve <fixture> <socket>)
//
// Wire protocol (must match src/main.rs, all integers little-endian):
//   request : u32 len | u8 count | count x [from20 | to20 | u64 gas | value32(BE) | u32 dlen | data]
//   response: u32 len | u8 count | count x [u8 status | u64 gas | u32 olen | output] | u64 exec_ns
// ============================================================================
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');

const [, , SOCK, FIXTURE, ...rest] = process.argv;
if (!SOCK || !FIXTURE) {
  console.error('usage: node client.js <socket> <fixture.json> [--n 5000] [--chain-a file.hex]');
  process.exit(2);
}
const opt = (name, def) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : def; };
const N = Number(opt('--n', 5000));
const CHAIN_A = opt('--chain-a', null);

const fx = JSON.parse(fs.readFileSync(path.resolve(FIXTURE), 'utf8'));
const hexBuf = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');

// ---- encode one tx: from | to | gas | value | data ----
function encodeTx({ from, to, gas, value, data }) {
  const d = hexBuf(data);
  const b = Buffer.allocUnsafe(84 + d.length);
  hexBuf(from).copy(b, 0);
  hexBuf(to).copy(b, 20);
  b.writeBigUInt64LE(BigInt(gas), 40);
  const v = BigInt(value || '0x0').toString(16).padStart(64, '0');
  Buffer.from(v, 'hex').copy(b, 48);
  b.writeUInt32LE(d.length, 80);
  d.copy(b, 84);
  return b;
}
// ---- wrap 1..n txs in a request frame ----
function encodeRequest(txs) {
  const parts = txs.map(encodeTx);
  const bodyLen = 1 + parts.reduce((s, p) => s + p.length, 0);
  const head = Buffer.allocUnsafe(5);
  head.writeUInt32LE(bodyLen, 0);
  head[4] = txs.length;
  return Buffer.concat([head, ...parts]);
}
// ---- decode a response body ----
function decodeResponse(body) {
  const n = body[0];
  let p = 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const status = body[p];
    const gas = body.readBigUInt64LE(p + 1);
    const olen = body.readUInt32LE(p + 9);
    const output = '0x' + body.subarray(p + 13, p + 13 + olen).toString('hex');
    p += 13 + olen;
    out.push({ success: status === 1, status, gasUsed: Number(gas), output });
  }
  out.execNs = Number(body.readBigUInt64LE(p)); // time the sidecar spent running the EVM
  return out;
}

// ---- tiny request/response helper on one persistent connection ----
function connect(sock) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sock);
    s.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let waiting = null;
    s.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      if (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (buf.length >= 4 + len) {
          const body = buf.subarray(4, 4 + len);
          buf = buf.subarray(4 + len);
          const w = waiting; waiting = null;
          w(body);
        }
      }
    });
    s.on('error', reject);
    s.on('connect', () => resolve({
      // send a request, resolve with the decoded results
      call(reqBuf) {
        return new Promise((res) => { waiting = (body) => res(decodeResponse(body)); s.write(reqBuf); });
      },
      close() { s.end(); },
    }));
  });
}

function stats(us) {
  const first = us[0];
  const v = [...us].sort((a, b) => a - b);
  const q = (p) => v[Math.round((v.length - 1) * p)];
  const r2 = (x) => Math.round(x * 100) / 100;
  return { n: v.length, first_us: r2(first), median_us: r2(q(0.5)), p90_us: r2(q(0.9)), p99_us: r2(q(0.99)),
    max_us: r2(v[v.length - 1]), min_us: r2(v[0]) };
}

// Time `n` round trips. `build` = whether to include encoding the request in the timing
// (the bot has to build the request each time, so yes by default).
async function timeLoop(c, txs, n) {
  const times = [];
  const exec = [];
  let first;
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    const req = encodeRequest(txs); // encoding counted: the bot pays it too
    const r = await c.call(req);
    times.push(Number(process.hrtime.bigint() - t0) / 1e3);
    exec.push(r.execNs / 1e3);
    if (i === 0) first = r;
  }
  // transport overhead = round trip minus EVM time, per request
  const overhead = times.map((t, i) => t - exec[i]);
  return { first, stats: { ...stats(times), evm_inside_sidecar: stats(exec), transport_overhead: stats(overhead) } };
}

(async () => {
  const c = await connect(SOCK);
  const txB = { from: fx.tx.from, to: fx.tx.to, gas: fx.tx.gas, value: fx.tx.value, data: fx.tx.data };

  // 1) single check, full round trip
  const single = await timeLoop(c, [txB], N);
  const r = single.first[0];
  const exp = fx.expected;
  const correctness = {
    success: { sidecar: r.success, expected: exp.success },
    output_match: r.output === exp.output.toLowerCase(),
    gas: { sidecar_tx_level: r.gasUsed, expected: Number(BigInt(exp.gasUsed)), diff: r.gasUsed - Number(BigInt(exp.gasUsed)) },
  };

  // 2) chained: A (state-changing) then B on post-A state, ONE round trip
  let chained = null;
  if (CHAIN_A) {
    const txA = { ...txB, data: fs.readFileSync(CHAIN_A, 'utf8').trim() };
    const ch = await timeLoop(c, [txA, txB], Math.min(N, 2000));
    chained = {
      A: { success: ch.first[0].success, gasUsed: ch.first[0].gasUsed },
      B_after_A: { success: ch.first[1].success, gasUsed: ch.first[1].gasUsed, output: ch.first[1].output.slice(0, 74) + '...' },
      timing_round_trip: ch.stats,
    };
  }

  // 3) a "do-nothing" floor: same socket, empty-calldata tx to an address with no code
  //    = pure socket + framing overhead with ~zero EVM work.
  const empty = await timeLoop(c, [{ from: txB.from, to: '0x00000000000000000000000000000000deadbeef', gas: '0x5208', value: '0x0', data: '0x' }], N);

  c.close();
  console.log(JSON.stringify({
    fixture: fx.name, transport: 'unix socket, length-prefixed binary, 1 persistent connection, sequential requests',
    correctness,
    round_trip_single: single.stats,
    round_trip_chained_A_plus_B: chained,
    round_trip_noop_floor: empty.stats,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
