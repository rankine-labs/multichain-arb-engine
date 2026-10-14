// Tests for the Oct 14 "freeze phase 2" changes (no trading decision changes):
//   1. Rival watch: the feed sender (a ~1-2 ms signature check) is only
//      worked out when it can matter, with a per-second limit. Old text
//      senders behave exactly as before.
//   2. Fast Multicall3 answer reader gives IDENTICAL answers to the ethers
//      reader on thousands of random bundles, and hands anything unusual
//      back to ethers. SCAN_FAST_DECODE=0 = ethers only.
//   2b. Fast bundle writer gives byte-for-byte the same text as ethers.
//   3. callMany takes a break between bundles; same answers.
//   4. Pacer + coin groups build: same result with and without breaks.
// No timing upper bounds (the server runs these during deploys).
import { ethers } from 'ethers';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RivalWatch } from '../core/rivalWatch';
import { fastDecodeAggregate3, ethersDecodeAggregate3, decodeAggregate3, decodeStats, makeCaller, fastEncodeAggregate3, encodeAggregate3 } from '../core/universeScan';
import type { ScanState, ScannedPool } from '../core/universeScan';
import { Pacer } from '../core/chunked';
import { buildTokenGroups } from '../core/tokenGroups';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Small seeded random numbers so every run tests the same cases.
let seed = 4242;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const randHex = (bytes: number) => { let s = '0x'; for (let i = 0; i < bytes; i++) s += Math.floor(rnd() * 256).toString(16).padStart(2, '0'); return s; };
const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');

const mc3 = new ethers.Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
]);
const encodeResults = (rs: { success: boolean; returnData: string }[]) => mc3.encodeFunctionResult('aggregate3', [rs]);

async function main() {
  // ===========================================================================
  // 1) Rival watch: lazy sender
  // ===========================================================================
  {
    const BOT = A(0xb0), OWNER = A(0xe0), STRANGER = A(0xf0), ROUTER = A(0xaa), NEWBOT = A(0xb9);
    let clock = 1_000_000;
    const mk = (opts: any = {}) => new RivalWatch(async () => ({}), () => null, () => '?', () => false, A(1), () => clock, 0, opts);
    // A lazy sender that counts how often it was worked out.
    let looks = 0;
    const lazy = (who: string) => () => { looks++; return who; };

    // a) No bot wallets known yet: the sender is never worked out.
    const rw = mk({ neverNewBot: (a: string) => a === ROUTER, senderMaxPerSec: 5 });
    rw.addBot(BOT, 'seed');
    for (let i = 0; i < 50; i++) rw.noteTx(NEWBOT, 'x' + i, lazy(OWNER));
    let st = rw.takeSenderStats();
    assert(looks === 0 && st.noOwners === 50, `no bot wallets known: 0 sender checks for 50 txs (${looks})`);

    // b) Tx straight to a bot we follow: queued, sender never worked out.
    (rw as any).owners.set(OWNER, BOT);
    rw.noteTx(BOT, 'k1', lazy(OWNER));
    st = rw.takeSenderStats();
    assert(looks === 0 && st.knownBot === 1 && (rw as any).queued.has('k1'), 'tx to a known bot is queued without a sender check');

    // c) Already queued: no sender check (same hash to some other contract).
    rw.noteTx(NEWBOT, 'k1', lazy(OWNER));
    st = rw.takeSenderStats();
    assert(looks === 0 && st.dupOrFull === 1, 'already queued hash: no sender check');

    // d) Router / pool / coin: never a new bot, no sender check.
    rw.noteTx(ROUTER, 'r1', lazy(OWNER));
    st = rw.takeSenderStats();
    assert(looks === 0 && st.neverBot === 1 && !(rw as any).queued.has('r1'), 'tx to a router: skipped, no sender check');

    // e) Unknown contract from a known bot wallet: sender worked out, queued as a probe.
    rw.noteTx(NEWBOT, 'o1', lazy(OWNER.toUpperCase().replace('0X', '0x')));
    st = rw.takeSenderStats();
    const job = (rw as any).queue.find((j: any) => j.hash === 'o1') ?? null;
    assert(looks === 1 && st.looked === 1 && (rw as any).queued.has('o1'), 'owner wallet sends to a new contract: sender checked once, tx queued');
    assert(!job || job.probe === true, 'queued as an owner probe (same as the old text sender)');

    // f) Stranger to an unknown contract: checked, not queued.
    rw.noteTx(NEWBOT, 's1', lazy(STRANGER));
    assert(looks === 2 && !(rw as any).queued.has('s1'), 'stranger: sender checked, not queued');

    // g) Per-second limit: at most 5 checks this second, the rest counted.
    looks = 0; rw.takeSenderStats();
    clock += 1_000; // new second
    for (let i = 0; i < 30; i++) rw.noteTx(NEWBOT, 'c' + i, lazy(STRANGER));
    st = rw.takeSenderStats();
    assert(looks === 5 && st.looked === 5 && st.overCap === 25, `per-second limit: 5 checks, 25 skipped (${looks}/${st.overCap})`);
    clock += 1_000;
    rw.noteTx(NEWBOT, 'd1', lazy(STRANGER));
    assert(looks === 6, 'limit resets the next second');

    // g2) Coin transfers / approvals to a coin NOT on our list, and ETH sends
    // with no call: skipped, so they can't use up the per-second limit.
    looks = 0; rw.takeSenderStats();
    clock += 1_000;
    const COIN = A(0xc0);
    rw.noteTx(COIN, 'm1', lazy(OWNER), undefined, '0xa9059cbb');                    // transfer (selector only)
    rw.noteTx(COIN, 'm2', lazy(OWNER), undefined, '0x095EA7B3' + '00'.repeat(64));  // approve (full data, upper case)
    rw.noteTx(COIN, 'm3', lazy(OWNER), undefined, '0x23b872dd' + '00'.repeat(96));  // transferFrom
    rw.noteTx(NEWBOT, 'm4', lazy(OWNER), undefined, '0x');                          // ETH send, no call
    rw.noteTx(NEWBOT, 'm5', lazy(OWNER), undefined, '');                            // ETH send, no call
    st = rw.takeSenderStats();
    assert(looks === 0 && st.coinMove === 5 && !['m1', 'm2', 'm3', 'm4', 'm5'].some((h) => (rw as any).queued.has(h)), 'coin transfer/approve/transferFrom and empty-data sends: no sender check, not queued');
    for (let i = 0; i < 100; i++) rw.noteTx(COIN, 'flood' + i, lazy(STRANGER), undefined, '0x095ea7b3');
    rw.noteTx(NEWBOT, 'real1', lazy(OWNER), undefined, '0x12345678');               // a real owner-wallet call
    assert(looks === 1 && (rw as any).queued.has('real1'), 'a flood of approvals does not use up the limit: the real owner-wallet tx is still caught');
    // Bot we follow: queued whatever the call is (selector skip is only for the sender check).
    rw.noteTx(BOT, 'm6', lazy(OWNER), undefined, '0xa9059cbb');
    assert((rw as any).queued.has('m6'), 'tx to a known bot is queued even if it looks like a coin transfer');
    // No data given (older callers): no selector skip.
    rw.noteTx(NEWBOT, 'm7', lazy(OWNER));
    assert(looks === 2 && (rw as any).queued.has('m7'), 'no call data given: checked as before');

    // h) Queue full: no sender check.
    looks = 0;
    const q = mk({ senderMaxPerSec: 100 });
    (q as any).owners.set(OWNER, BOT);
    (q as any).busy = true; // keep the fake jobs from being worked on
    (q as any).queue = Array.from({ length: 100 }, (_, i) => ({ hash: 'f' + i, bot: BOT, dueAt: 0 }));
    q.noteTx(NEWBOT, 'full1', lazy(OWNER));
    assert(looks === 0 && q.takeSenderStats().dupOrFull === 1, 'queue full: no sender check');

    // i) A sender function that throws is treated as "no sender" (never crashes).
    const t = mk();
    (t as any).owners.set(OWNER, BOT);
    let threw = false;
    try { t.noteTx(NEWBOT, 'e1', () => { throw new Error('bad signature'); }); } catch { threw = true; }
    assert(!threw && !(t as any).queued.has('e1'), 'sender check that throws: ignored, nothing queued');

    // j) Old text senders: exactly the old rules (owner match queues, no stats counted).
    const old = mk();
    (old as any).owners.set(OWNER, BOT);
    old.noteTx(ROUTER, 't1', OWNER);   // text form: no router skip (old behaviour)
    old.noteTx(NEWBOT, 't2', STRANGER);
    old.noteTx(NEWBOT, 't3', undefined);
    old.noteTx(A(0xc1), 't4', OWNER, undefined, '0xa9059cbb'); // text form: no coin-move skip (old behaviour)
    const ost = old.takeSenderStats();
    assert((old as any).queued.has('t1') && (old as any).queued.has('t4') && !(old as any).queued.has('t2') && !(old as any).queued.has('t3'), 'text sender: same answers as before');
    assert(ost.looked === 0 && ost.noOwners === 0, 'text sender: no lazy-sender counters touched');
    // Let the few queued jobs finish so the test can exit (1 s pause per job).
  }

  // ===========================================================================
  // 2) Fast Multicall3 answer reader == ethers reader
  // ===========================================================================
  {
    // Sizes that matter: empty, odd lengths, exactly a word, a word +/- 1, big.
    const sizes = [0, 1, 2, 3, 20, 31, 32, 33, 63, 64, 65, 95, 96, 97, 128, 1000, 4097];
    const randomResult = () => {
      const success = rnd() < 0.8;
      const r = rnd();
      const len = r < 0.6 ? 32 : r < 0.95 ? sizes[Math.floor(rnd() * sizes.length)] : Math.floor(rnd() * 6_000);
      return { success, returnData: randHex(len) };
    };
    let allSame = true, allFast = true, bundles = 0, items = 0;
    for (let b = 0; b < 200; b++) {
      const n = b === 0 ? 0 : b === 1 ? 1 : b % 50 === 0 ? 400 : Math.floor(rnd() * 60);
      const rs = Array.from({ length: n }, randomResult);
      const enc = encodeResults(rs);
      const fast = fastDecodeAggregate3(enc);
      const slow = ethersDecodeAggregate3(enc);
      if (!fast) allFast = false;
      if (!same(fast, slow)) allSame = false;
      // Expected straight from the inputs too (null when failed or empty).
      const want = rs.map((r) => (r.success && r.returnData !== '0x' ? r.returnData : null));
      if (!same(fast, want)) allSame = false;
      bundles++; items += n;
    }
    assert(allFast, `fast reader handled all ${bundles} normal bundles (none handed back to ethers)`);
    assert(allSame, `fast reader == ethers reader on ${bundles} random bundles (${items} answers, empty/failed/odd/large included)`);

    // Every answer failed, every answer empty, and a 400 x 32-byte bundle.
    for (const [label, rs] of [
      ['all failed', Array.from({ length: 40 }, () => ({ success: false, returnData: randHex(32) }))],
      ['all empty', Array.from({ length: 40 }, () => ({ success: true, returnData: '0x' }))],
      ['400 x 32 bytes', Array.from({ length: 400 }, () => ({ success: true, returnData: randHex(32) }))],
    ] as [string, { success: boolean; returnData: string }[]][]) {
      const enc = encodeResults(rs);
      assert(same(fastDecodeAggregate3(enc), ethersDecodeAggregate3(enc)), `fast == ethers: ${label}`);
    }

    // Upper-case hex from a node: same (lower-case) answers as ethers.
    {
      const enc = encodeResults([{ success: true, returnData: '0xabcdef' }, { success: true, returnData: randHex(40) }]);
      const up = '0x' + enc.slice(2).toUpperCase();
      assert(same(fastDecodeAggregate3(up), ethersDecodeAggregate3(up)), 'upper-case hex: same answers as ethers');
    }

    // Unusual / broken text: the fast reader gives up (null) and the
    // combined reader gives exactly what ethers gives (or throws like it).
    const good = encodeResults([{ success: true, returnData: randHex(33) }, { success: false, returnData: '0x' }, { success: true, returnData: randHex(64) }]);
    const word = (n: number) => n.toString(16).padStart(64, '0');
    const setWord = (hex: string, wordIdx: number, v: string) => hex.slice(0, 2 + wordIdx * 64) + v + hex.slice(2 + (wordIdx + 1) * 64);
    const cases: [string, string][] = [
      ['truncated', good.slice(0, good.length - 64)],
      ['one hex char short', good.slice(0, good.length - 1)],
      ['extra word on the end', good + '0'.repeat(64)],
      ['flag = 2', setWord(good, 5, word(2))],          // word 5 = first pair's flag (0x20 + 0x20 + 3 x 0x20 = byte 160)
      ['huge list length', setWord(good, 1, 'f'.repeat(64))],
      ['list start not 32', setWord(good, 0, word(64))],
      ['not hex at all', 'hello'],
      ['empty', '0x'],
    ];
    for (const [label, txt] of cases) {
      const fast = fastDecodeAggregate3(txt);
      let slow: unknown, slowErr = false, comb: unknown, combErr = false;
      try { slow = ethersDecodeAggregate3(txt); } catch { slowErr = true; }
      try { comb = decodeAggregate3(txt); } catch { combErr = true; }
      assert(fast === null, `unusual answer (${label}): fast reader hands it to ethers`);
      assert(slowErr === combErr && (slowErr || same(slow, comb)), `unusual answer (${label}): combined reader == ethers${slowErr ? ' (both throw)' : ''}`);
    }
    // Sanity on the flag case: it really was the flag word we changed.
    assert(good.slice(2 + 5 * 64, 2 + 6 * 64) === word(1), 'test check: word 5 is the first pair\'s "worked?" flag');

    // Switch: SCAN_FAST_DECODE=0 uses ethers only.
    const f0 = decodeStats.fast;
    process.env.SCAN_FAST_DECODE = '0';
    const r0 = decodeAggregate3(good);
    delete process.env.SCAN_FAST_DECODE;
    assert(decodeStats.fast === f0 && same(r0, ethersDecodeAggregate3(good)), 'SCAN_FAST_DECODE=0: ethers reader only, same answers');
    decodeAggregate3(good);
    assert(decodeStats.fast === f0 + 1, 'default: fast reader used');
  }

  // ===========================================================================
  // 2b) Fast bundle writer == ethers writer (byte for byte)
  // ===========================================================================
  {
    const ethersEnc = (calls: { target: string; data: string }[]) =>
      mc3.encodeFunctionData('aggregate3', [calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))]);
    const lens = [0, 1, 4, 31, 32, 33, 36, 68, 100, 500];
    let allSame = true, total = 0;
    for (let b = 0; b < 150; b++) {
      const n = b === 0 ? 0 : b === 1 ? 1 : b % 30 === 0 ? 400 : Math.floor(rnd() * 50);
      const calls = Array.from({ length: n }, () => {
        let target = randHex(20);
        if (rnd() < 0.3) target = ethers.getAddress(target);                 // checksum (mixed case)
        let data = randHex(lens[Math.floor(rnd() * lens.length)]);
        if (rnd() < 0.2) data = '0x' + data.slice(2).toUpperCase();          // upper-case data
        return { target, data };
      });
      const fast = fastEncodeAggregate3(calls);
      if (fast !== ethersEnc(calls)) allSame = false;
      total += n;
    }
    assert(allSame, `fast bundle writer == ethers on 150 random bundles (${total} reads, empty/odd/upper-case data included)`);
    // Unusual input goes to ethers (which then behaves as before).
    const bad = [{ target: 'not-an-address', data: '0x12' }];
    assert(fastEncodeAggregate3(bad) === null, 'bad address: fast writer hands it to ethers');
    assert(fastEncodeAggregate3([{ target: A(5), data: '0x123' }]) === null, 'half-byte call data: fast writer hands it to ethers');
    let e1 = false, e2 = false;
    try { encodeAggregate3(bad); } catch { e1 = true; }
    try { ethersEnc(bad); } catch { e2 = true; }
    assert(e1 === e2, 'bad address: combined writer behaves like ethers');
    // Switch: SCAN_FAST_DECODE=0 uses ethers to write too (same text anyway).
    const sample = [{ target: A(7), data: '0x70a08231' + '00'.repeat(32) }];
    process.env.SCAN_FAST_DECODE = '0';
    const w0 = encodeAggregate3(sample);
    delete process.env.SCAN_FAST_DECODE;
    assert(w0 === ethersEnc(sample) && encodeAggregate3(sample) === w0, 'SCAN_FAST_DECODE=0: ethers writer, same text');
  }

  // ===========================================================================
  // 3) callMany: a break between bundles, same answers
  // ===========================================================================
  {
    // Fake node with Multicall3: each read answers with its own target + data.
    const answer = (target: string, data: string) => (data === '0xdead' ? null : '0x' + target.slice(2).toLowerCase() + data.slice(2));
    let requests = 0;
    const provider: any = {
      getCode: async () => '0x6080',
      call: async ({ data }: { data: string }) => {
        requests++;
        const [calls] = mc3.decodeFunctionData('aggregate3', data);
        return encodeResults(calls.map((c: any) => {
          const a = answer(c.target, c.callData);
          return a === null ? { success: false, returnData: '0x' } : { success: true, returnData: a };
        }));
      },
    };
    const { callMany, multicall } = await makeCaller(provider);
    const calls = Array.from({ length: 1000 }, (_, i) => ({ target: A(0x1000 + i), data: i % 7 === 0 ? '0xdead' : '0x' + i.toString(16).padStart(8, '0') }));
    // Count event-loop turns while it runs: breaks between bundles let these through.
    let turns = 0, running = true;
    const tick = () => { if (running) { turns++; setImmediate(tick); } };
    setImmediate(tick);
    const res = await callMany(calls);
    running = false;
    const want = calls.map((c) => answer(c.target, c.data));
    assert(multicall && requests === 3, `1,000 reads = 3 bundles (${requests})`);
    assert(same(res, want), 'callMany answers unchanged (failed reads = null)');
    assert(turns >= 2, `the bot gets turns between bundles (${turns})`);
    const one = await callMany(calls.slice(0, 10));
    assert(same(one, want.slice(0, 10)), 'small read (one bundle): same answers');
  }

  // ===========================================================================
  // 4) Pacer and the coin groups build
  // ===========================================================================
  {
    const off = new Pacer('test', 0, false);
    let anyDue = false;
    for (let i = 0; i < 2000; i++) if (off.due()) anyDue = true;
    assert(!anyDue, 'Pacer switched off: never asks for a break');
    const on = new Pacer('test', 0, true);
    let dues = 0;
    for (let i = 0; i < 1024; i++) if (on.due()) dues++;
    assert(dues === 4, `Pacer looks at the clock every 256 calls (${dues} of 1024)`);
  }
  await coinGroupsSame();
}

// The coin groups build gives the same list with and without breaks.
async function coinGroupsSame() {
  const SEL_SYMBOL = '0x95d89b41', SEL_DECIMALS = '0x313ce567', SEL_BALANCE = '0x70a08231', SEL_RESERVES = '0x0902f1ac';
  const word = (x: bigint) => x.toString(16).padStart(64, '0');
  const encStr = (s: string) => '0x' + word(32n) + word(BigInt(s.length)) + Buffer.from(s).toString('hex').padEnd(64, '0');
  const usdg = A(1), weth = A(2);
  const names = ['USDT', 'USDC', 'WBTC', 'cbBTC', 'PEPE', 'TSLAx', 'bTSLA', 'DOGE'];
  const N = 6000;
  const coins = Array.from({ length: N }, (_, i) => A(1000 + i));
  const sym = new Map<string, string>(coins.map((c, i) => [c, names[i % names.length]]));
  sym.set(usdg, 'USDG'); sym.set(weth, 'WETH');
  // Pools: one per coin against USDG or WETH; amounts so some are deep.
  type P = { pool: string; t0: string; t1: string; a0: bigint; a1: bigint };
  const ps: P[] = [{ pool: A(0x900000), t0: weth, t1: usdg, a0: 100n * 10n ** 18n, a1: 300_000n * 10n ** 6n }];
  coins.forEach((c, i) => {
    const q = i % 2 ? usdg : weth;
    const deep = i % 37 === 0;
    const qAmt = q === usdg ? (deep ? 50_000n : 100n) * 10n ** 6n : (deep ? 20n : 1n) * 10n ** 16n;
    ps.push({ pool: A(0x910000 + i), t0: c, t1: q, a0: 10_000n * 10n ** 18n, a1: qAmt });
  });
  const byPool = new Map(ps.map((p) => [p.pool.toLowerCase(), p]));
  const callMany = async (calls: { target: string; data: string }[]) => calls.map((c) => {
    const t = c.target.toLowerCase();
    if (c.data === SEL_SYMBOL) return encStr(sym.get(t) ?? 'X');
    if (c.data === SEL_DECIMALS) return '0x' + word(t === usdg ? 6n : 18n);
    if (c.data.startsWith(SEL_BALANCE)) {
      const p = byPool.get('0x' + c.data.slice(-40)); if (!p) return '0x' + word(0n);
      return '0x' + word(t === p.t0 ? p.a0 : t === p.t1 ? p.a1 : 0n);
    }
    if (c.data === SEL_RESERVES) { const p = byPool.get(t); return p ? '0x' + word(p.a0) + word(p.a1) + word(0n) : null; }
    return null;
  });
  const state: ScanState = {
    version: 1, lastBlock: {}, factories: ['uniswap-v2|v2|' + A(9)],
    tokens: [usdg, weth, ...coins],
    pools: [],
  } as unknown as ScanState;
  const pools: ScannedPool[] = ps.map((p) => ({ dex: 'uniswap-v2', kind: 'v2', pool: p.pool, token0: p.t0, token1: p.t1 } as unknown as ScannedPool));

  // Count the breaks taken (Pacer.rest calls).
  let rests = 0;
  const origRest = Pacer.prototype.rest;
  Pacer.prototype.rest = function (this: Pacer) { rests++; return origRest.call(this); };
  const run = async (paced: boolean, paceMs: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'groups2-'));
    rests = 0;
    const r = await buildTokenGroups({ callMany, state, pools, usdg, weth, symbolCacheFile: join(dir, 's.json'), outFile: join(dir, 'g.json'), pauseMs: 0, paced, paceMs });
    return { r: { members: r.members, rejected: r.rejected }, rests };
  };
  const a = await run(false, 5);
  const b = await run(true, 0); // break at every clock look (every 256 items)
  Pacer.prototype.rest = origRest;
  assert(a.r.members.length > 0, `coin groups test chain builds a list (${a.r.members.length} verified)`);
  assert(same(a.r, b.r), 'coin groups: same list with and without breaks');
  assert(a.rests === 0 && b.rests >= 50, `coin groups: breaks only when paced (${a.rests} vs ${b.rests})`);
}

main().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; });
