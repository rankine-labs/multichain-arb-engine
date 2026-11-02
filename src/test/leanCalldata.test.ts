import { getAddress } from 'ethers';
import {
  encodeExecuteRaw, encodeExecuteV3FlashRaw, encodeExecuteRawEthers, encodeExecuteV3FlashRawEthers,
  calldataLeanOn, ExecutorHop, KIND_V4, KIND_V4_HOOKED,
} from '../execution/executorCalldata';

// ============================================================================
// FREEZE FIX 9b (Nov 2): LEAN CALLDATA proof.
//   1. Same text as ethers for thousands of random execute() and
//      executeWithV3Flash() calls: 0-6 hops, V2/V3/V4 kinds, negative tick
//      spacing, lower / upper / checksum spellings, huge and zero numbers.
//   2. Unusual inputs (bad checksum, short address, out-of-range numbers,
//      non-bigint amounts) give exactly what ethers gives, including the
//      same error message when ethers refuses.
//   3. Timing: the lean encoder is much faster (TEST numbers).
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

let seed = 777;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pickOf = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const hexN = (n: number) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');
// A random address in one of the spellings ethers accepts.
const addr = (): string => {
  const lower = '0x' + hexN(40);
  const r = rnd();
  if (r < 0.4) return lower;
  if (r < 0.5) return '0x' + lower.slice(2).toUpperCase();
  return getAddress(lower); // checksum spelling
};
const big = (): bigint => pickOf([0n, 1n, 10n ** 18n, (1n << 256n) - 1n, BigInt('0x' + hexN(1 + Math.floor(rnd() * 64)))]);
const hop = (): ExecutorHop => {
  const kind = pickOf([0, 1, 2, KIND_V4, KIND_V4_HOOKED]);
  const v4 = kind === KIND_V4 || kind === KIND_V4_HOOKED;
  const h: ExecutorHop = { kind, pool: addr(), tokenIn: addr(), tokenOut: addr(), feeBps: Math.floor(rnd() * 65536) };
  if (v4 || rnd() < 0.3) {
    h.v4Fee = pickOf([0, 500, 3000, 0x800000, (1 << 24) - 1]);
    h.v4TickSpacing = pickOf([1, 10, 60, 200, -1, -60, -(1 << 23), (1 << 23) - 1]);
    h.v4Native = rnd() < 0.5;
  }
  if (rnd() < 0.2) h.v4PoolManager = addr(); // bot-only field: never encoded
  return h;
};
const trade = () => ({ token: addr(), amountIn: big(), minProfit: big(), maxBlock: big(), hops: Array.from({ length: Math.floor(rnd() * 7) }, hop) });

// Run both encoders; compare the text, or the error message when ethers refuses.
const outcome = (f: () => string) => { try { return 'ok:' + f(); } catch (e) { return 'err:' + (e as Error).message; } };

function sameTextTest() {
  assert(calldataLeanOn(), 'CALLDATA_LEAN on by default');
  let n = 0, bad = 0;
  for (let i = 0; i < 3000; i++) {
    const t = trade(), second = rnd() < 0.2 ? '0x0000000000000000000000000000000000000000' : addr();
    const a = outcome(() => encodeExecuteRaw(t, second)), b = outcome(() => encodeExecuteRawEthers(t, second));
    const c = outcome(() => encodeExecuteV3FlashRaw(t, second)), d = outcome(() => encodeExecuteV3FlashRawEthers(t, second));
    n += 2;
    if (a !== b) { bad++; if (bad < 3) console.error(`  execute differs:\n  lean   ${a.slice(0, 200)}\n  ethers ${b.slice(0, 200)}`); }
    if (c !== d) { bad++; if (bad < 3) console.error(`  executeWithV3Flash differs:\n  lean   ${c.slice(0, 200)}\n  ethers ${d.slice(0, 200)}`); }
  }
  assert(bad === 0, `LEAN CALLDATA: same text as ethers in all ${n} random calls`);
  // Default flash pool argument (zero address) too.
  const t = trade();
  assert(encodeExecuteRaw(t) === encodeExecuteRawEthers(t), 'LEAN CALLDATA: default flashPool argument same as ethers');
}

function oddInputsTest() {
  const base = () => ({ token: addr(), amountIn: 5n, minProfit: 1n, maxBlock: 9n, hops: [hop(), hop()] });
  const good = getAddress('0x' + 'ab'.repeat(20));
  const badChecksum = good.slice(0, 2) + (good[2] === good[2].toUpperCase() ? good[2].toLowerCase() : good[2].toUpperCase()) + good.slice(3);
  const cases: Array<[string, () => { t: ReturnType<typeof base>; s: string }]> = [
    ['bad checksum lender', () => ({ t: base(), s: badChecksum })],
    ['bad checksum coin', () => { const t = base(); t.token = badChecksum; return { t, s: addr() }; }],
    ['short address', () => ({ t: base(), s: '0x1234' })],
    ['address without 0x', () => ({ t: base(), s: 'ab'.repeat(20) })],
    ['negative amount', () => { const t = base(); t.amountIn = -1n; return { t, s: addr() }; }],
    ['amount over 256 bits', () => { const t = base(); t.amountIn = 1n << 256n; return { t, s: addr() }; }],
    ['amount as a number', () => { const t = base(); (t as unknown as { amountIn: number }).amountIn = 12345; return { t, s: addr() }; }],
    ['fee over 16 bits', () => { const t = base(); t.hops[0].feeBps = 70_000; return { t, s: addr() }; }],
    ['tick spacing over 24 bits', () => { const t = base(); t.hops[1].v4TickSpacing = 1 << 23; return { t, s: addr() }; }],
    ['kind over 8 bits', () => { const t = base(); t.hops[0].kind = 256; return { t, s: addr() }; }],
    ['fractional fee', () => { const t = base(); t.hops[0].feeBps = 1.5; return { t, s: addr() }; }],
    ['no hops', () => { const t = base(); t.hops = []; return { t, s: addr() }; }],
  ];
  let bad = 0;
  for (const [name, mk] of cases) {
    const { t, s } = mk();
    const a = outcome(() => encodeExecuteV3FlashRaw(t, s)), b = outcome(() => encodeExecuteV3FlashRawEthers(t, s));
    const c = outcome(() => encodeExecuteRaw(t, s)), d = outcome(() => encodeExecuteRawEthers(t, s));
    if (a !== b || c !== d) { bad++; console.error(`  ${name}: lean ${a.slice(0, 120)} / ethers ${b.slice(0, 120)}`); }
  }
  assert(bad === 0, `LEAN CALLDATA: ${cases.length} unusual inputs give exactly ethers' answer or ethers' error`);
}

function timingTest() {
  const ts = Array.from({ length: 300 }, () => ({ ...trade(), hops: [hop(), hop()] }));
  const lender = getAddress('0x' + 'cd'.repeat(20));
  const run = (f: (t: ReturnType<typeof trade>) => string) => { const t0 = performance.now(); let len = 0; for (let r = 0; r < 5; r++) for (const t of ts) len += f(t).length; return { ms: performance.now() - t0, len }; };
  run((t) => encodeExecuteV3FlashRawEthers(t, lender)); run((t) => encodeExecuteV3FlashRaw(t, lender)); // warm up
  const old = run((t) => encodeExecuteV3FlashRawEthers(t, lender));
  const neu = run((t) => encodeExecuteV3FlashRaw(t, lender));
  console.log(`  TEST numbers: 1,500 two-hop flash calls: ethers ${old.ms.toFixed(1)} ms (${(old.ms / 1500 * 1000).toFixed(0)} us each), lean ${neu.ms.toFixed(1)} ms (${(neu.ms / 1500 * 1000).toFixed(0)} us each), ${(old.ms / Math.max(neu.ms, 0.001)).toFixed(1)}x`);
  assert(old.len === neu.len, 'timing run: same output size');
  assert(neu.ms * 3 < old.ms, 'LEAN CALLDATA: at least 3x faster than ethers');
}

sameTextTest();
oddInputsTest();
timingTest();
