import { CrossQuoteMonitor } from '../core/crossQuoteMonitor';
import { formatMarketOpenReport } from '../core/telegramFormatter';

// Tokens with a USDG pool and an ETH pool: the monitor measures how far the
// two prices disagree (before/after fees), separately for the market-open
// window and the rest of the day, and the report explains it in plain English.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const AMZN = '0x00000000000000000000000000000000000000aa'; // sorts below both quotes -> token0
const PU = '0x00000000000000000000000000000000000000b1';   // AMZN/USDG v2
const PW = '0x00000000000000000000000000000000000000b2';   // AMZN/WETH v2
const MEME = '0x00000000000000000000000000000000000000cc';
const PM = '0x00000000000000000000000000000000000000b3';   // MEME/USDG only: skipped

const w = (v: bigint) => v.toString(16).padStart(64, '0');
let wethPoolAmzn = 1_000n; // AMZN in the ETH pool (changes to make a gap)
async function callMany(calls: { target: string; data: string }[]) {
  return calls.map((c) => {
    const sel = c.data.slice(0, 10);
    if (sel === '0x70a08231') { // balanceOf(pool): quote side
      const pool = '0x' + c.data.slice(-40);
      return '0x' + w(pool === PU ? 200_000n * 10n ** 6n : 60n * 10n ** 18n);
    }
    if (sel === '0x313ce567') return '0x' + w(18n);
    if (sel === '0x95d89b41') return '0x' + w(32n) + w(4n) + Buffer.from('AMZN').toString('hex').padEnd(64, '0');
    if (sel === '0x0902f1ac') { // getReserves: token0 = AMZN
      if (c.target === PU) return '0x' + w(1_000n * 10n ** 18n) + w(200_000n * 10n ** 6n) + w(0n); // $200
      return '0x' + w(wethPoolAmzn * 10n ** 18n) + w(50n * 10n ** 18n) + w(0n);                // 0.05 ETH each
    }
    return null;
  });
}

async function main() {
  let clock = 0;
  const m = new CrossQuoteMonitor(callMany, USDG, WETH, () => 4_000, () => clock);
  const n = await m.setup([
    { dex: 'uniswap-v2', kind: 'v2', pool: PU, token0: AMZN, token1: USDG },
    { dex: 'uniswap-v2', kind: 'v2', pool: PW, token0: AMZN, token1: WETH },
    { dex: 'uniswap-v2', kind: 'v2', pool: PM, token0: MEME, token1: USDG },
  ]);
  assert(n === 1 && m.tokenCount() === 1, 'only tokens with BOTH a USDG and an ETH pool are watched');

  // Same price both sides: 0.05 ETH x $4,000 = $200.
  await m.tick(false, '2026-10-08'); clock += 15_000;
  await m.tick(false, '2026-10-08');
  let r = m.rows()[0];
  assert(r.symbol === 'AMZN' && r.rest.maxGapPct < 0.01, 'pools agree: no gap');

  // At the open the ETH pool lags: AMZN there is ~5% cheaper.
  wethPoolAmzn = 1_052n;
  clock += 5_000; await m.tick(true, '2026-10-08');
  clock += 5_000; await m.tick(true, '2026-10-08');
  r = m.rows()[0];
  assert(r.open.maxGapPct > 4.5 && r.open.maxGapPct < 5.5, `open gap ~5% (got ${r.open.maxGapPct.toFixed(2)}%)`);
  assert(Math.abs(r.open.maxNetPct - (r.open.maxGapPct - 0.65)) < 1e-9, 'after fees = gap minus 0.3% + 0.3% + 0.05%');
  assert(r.open.secondsProfitable >= 5, 'time worth trading is counted');

  const msg = formatMarketOpenReport({ dateLabel: '2026-10-08', tokens: 1, rows: m.rows() });
  assert(msg.includes('MARKET OPEN REPORT') && msg.includes('AMZN: gap up to') && msg.includes('rest of day max'), 'report lists tokens with open vs rest of day');
  assert(msg.includes('Verdict'), 'report has a verdict');

  await m.tick(false, '2026-10-09');
  assert(m.rows()[0].open.samples === 0, 'new day starts fresh');
}
main();
