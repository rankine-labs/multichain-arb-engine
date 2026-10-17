// ============================================================================
// FEED PARSER BENCHMARK (measurement only; never trades, no keys).
//
// Compares two builds of src/chains/nitroFeed.ts on the SAME captured
// Robinhood feed frames:
//   A = the version on main (eager keccak256 hash per contract-call tx)
//   B = this branch (hash worked out lazily, on first read)
//
// Two ways of timing each frame:
//   "parse only"     : parseFeedFrame(frame) alone
//   "as live uses it": parseFeedFrame(frame) and then read tx.hash / tx.value
//                      for every tx, exactly like robinhoodChain.ts does when it
//                      builds the feed event (so the lazy hash gets computed).
//
// Usage (after compiling with tsc, see the report for the exact commands):
//   node --expose-gc bench-feed-parser.js <frames.json> <origModule> <newModule> [passes]
// frames.json = JSON array of raw frame strings (results/feed-frames.json).
// ============================================================================
import * as fs from 'fs';

type Parser = (frame: unknown) => any[];

// Percentile of a sorted array (nearest rank).
function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
const fmt = (ms: number) => ms.toFixed(3);

// Times one parser on one frame, in milliseconds.
function timeOne(parse: Parser, frame: unknown, readFields: boolean): number {
  const t0 = process.hrtime.bigint();
  const txs = parse(frame);
  if (readFields) {
    // Same reads as robinhoodChain.ts: { to, data, value, hash }.
    let sink = 0;
    for (const tx of txs) sink += tx.hash.length + tx.value.length + tx.to.length + tx.data.length;
    if (sink < 0) console.log(sink); // keeps the reads from being optimised away
  }
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

function main() {
  const [framesPath, origPath, newPath, passesArg] = process.argv.slice(2);
  const passes = Number(passesArg) || 30;
  const rawFrames: string[] = JSON.parse(fs.readFileSync(framesPath, 'utf8'));
  // The adapter JSON-parses each frame before calling the parser, so do it up front.
  const frames = rawFrames.map((f) => { try { return JSON.parse(f); } catch { return null; } }).filter(Boolean);
  const A: Parser = require(origPath).parseFeedFrame;
  const B: Parser = require(newPath).parseFeedFrame;
  const gc = (global as any).gc as (() => void) | undefined;

  // ---- Output equivalence + counts --------------------------------------
  let txTotal = 0, framesWithTx = 0, maxTxInFrame = 0, mismatches = 0, fromChecked = 0, fromMismatch = 0;
  for (const f of frames) {
    const a = A(f), b = B(f);
    txTotal += a.length;
    if (a.length) framesWithTx++;
    maxTxInFrame = Math.max(maxTxInFrame, a.length);
    if (a.length !== b.length) { mismatches++; continue; }
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      if (x.sequenceNumber !== y.sequenceNumber || x.hash !== y.hash || x.to !== y.to || x.data !== y.data || x.value !== y.value) mismatches++;
      if (!Object.keys(y).includes('hash')) mismatches++; // field still listed like a normal field
      if (fromChecked < 300) { fromChecked++; if (x.from !== y.from) fromMismatch++; } // sender is slow: sample it
    }
  }
  console.log(`frames: ${frames.length} (with contract-call txs: ${framesWithTx}) · txs: ${txTotal} · avg ${(txTotal / Math.max(1, frames.length)).toFixed(2)}/frame · max ${maxTxInFrame}/frame`);
  console.log(`equivalence: ${mismatches === 0 ? 'IDENTICAL' : mismatches + ' MISMATCHES'} (seq/hash/to/data/value on every tx; sender on ${fromChecked} txs, ${fromMismatch} mismatches)`);

  // ---- Timing ------------------------------------------------------------
  for (const readFields of [false, true]) {
    const label = readFields ? 'as live uses it (hash+value read)' : 'parse only';
    // Warm-up: let V8 optimise both versions before measuring.
    for (let w = 0; w < 5; w++) for (const f of frames) { A(f); B(f); }
    const ta: number[] = [], tb: number[] = [];
    const sumA: number[] = [], sumB: number[] = [];
    for (let p = 0; p < passes; p++) {
      if (gc) gc();
      // Alternate which version goes first each pass so drift hits both equally.
      const order: [Parser, number[], number[]][] = p % 2 ? [[B, tb, sumB], [A, ta, sumA]] : [[A, ta, sumA], [B, tb, sumB]];
      for (const [parse, out, sums] of order) {
        let s = 0;
        for (const f of frames) { const ms = timeOne(parse, f, readFields); out.push(ms); s += ms; }
        sums.push(s);
      }
    }
    ta.sort((x, y) => x - y); tb.sort((x, y) => x - y);
    const passWins = sumA.filter((s, i) => sumB[i] < s).length;
    const totA = sumA.reduce((x, y) => x + y, 0) / passes, totB = sumB.reduce((x, y) => x + y, 0) / passes;
    console.log(`\n[${label}] ${passes} passes x ${frames.length} frames`);
    console.log(`  A main   : p50 ${fmt(pct(ta, 50))} ms · p95 ${fmt(pct(ta, 95))} ms · max ${fmt(ta[ta.length - 1])} ms · per pass ${fmt(totA)} ms`);
    console.log(`  B branch : p50 ${fmt(pct(tb, 50))} ms · p95 ${fmt(pct(tb, 95))} ms · max ${fmt(tb[tb.length - 1])} ms · per pass ${fmt(totB)} ms`);
    console.log(`  B faster in ${passWins}/${passes} passes · per-pass total change ${(((totB - totA) / totA) * 100).toFixed(1)}%`);
  }

  // ---- Where the time goes inside the parser (main version) -------------
  const { Transaction, keccak256 } = require('ethers');
  const raws: string[] = [];
  for (const f of frames) for (const m of (f as any).messages ?? []) {
    const l2 = m?.message?.message?.l2Msg; if (typeof l2 !== 'string') continue;
    const walk = (b: Buffer, d: number) => {
      if (!b.length || d > 16) return;
      if (b[0] === 4) raws.push('0x' + b.subarray(1).toString('hex'));
      else if (b[0] === 3) { let i = 1; while (i + 8 <= b.length) { const n = Number(b.readBigUInt64BE(i)); i += 8; if (n <= 0 || i + n > b.length) break; walk(b.subarray(i, i + n), d + 1); i += n; } }
    };
    walk(Buffer.from(l2, 'base64'), 0);
  }
  const loop = (fn: () => void) => { for (let w = 0; w < 3; w++) fn(); const t0 = process.hrtime.bigint(); for (let r = 0; r < 10; r++) fn(); return Number(process.hrtime.bigint() - t0) / 1e6 / 10; };
  const tDecode = loop(() => { for (const r of raws) { try { Transaction.from(r); } catch { /* skip */ } } });
  const tHash = loop(() => { for (const r of raws) keccak256(r); });
  console.log(`\nbreakdown over all ${raws.length} signed txs (one pass): Transaction.from ${fmt(tDecode)} ms · keccak256 ${fmt(tHash)} ms (${((tHash / Math.max(1e-9, tDecode)) * 100).toFixed(0)}% of decode) · keccak per tx ${(tHash / Math.max(1, raws.length) * 1000).toFixed(1)} µs`);
}

main();
