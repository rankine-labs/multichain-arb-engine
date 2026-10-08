import { ethers } from 'ethers';
import { RivalWatch, summarize, RivalRec, isJunkProfit } from '../core/rivalWatch';
import { formatPlainHourly, formatRivalDaily, rivalVerdict, rivalLessons } from '../core/telegramFormatter';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const BOT = '0x00000000000000000000000000000000000000b0';
const USER = '0x00000000000000000000000000000000000000c0';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const P1 = '0x00000000000000000000000000000000000000a1';
const P2 = '0x00000000000000000000000000000000000000a2';
const ta = (a: string) => '0x' + a.slice(2).padStart(64, '0');
const amt = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');
const T = ethers.id('Transfer(address,address,uint256)');
const V3 = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
const FLASH = ethers.id('Flash(address,address,uint256,uint256,uint256,uint256)');
// Bot: 1 WETH -> pool 1 -> 3500 USDG -> pool 2 -> 1.01 WETH.
const arbLogs = (who: string) => [
  { address: WETH, topics: [T, ta(who), ta(P1)], data: amt(10n ** 18n) },
  { address: USDG, topics: [T, ta(P1), ta(who)], data: amt(3500n * 10n ** 6n) },
  { address: P1, topics: [V3, ta(who), ta(who)], data: '0x' },
  { address: USDG, topics: [T, ta(who), ta(P2)], data: amt(3500n * 10n ** 6n) },
  { address: WETH, topics: [T, ta(P2), ta(who)], data: amt(101n * 10n ** 16n) },
  { address: P2, topics: [V3, ta(who), ta(who)], data: '0x' },
];
const px = (tok: string, raw: bigint) => (tok === WETH ? (Number(raw) / 1e18) * 3500 : tok === USDG ? Number(raw) / 1e6 : null);

async function main() {
  // --- one trade, from its receipt ------------------------------------------
  const t = RivalWatch.analyze(arbLogs(BOT), BOT);
  assert(t.net.get(WETH) === 10n ** 16n && t.net.get(USDG) === 0n && t.pools.length === 2 && !t.flash, 'net +0.01 WETH, 2 pools, no flash');
  const flashT = RivalWatch.analyze([...arbLogs(BOT), { address: P1, topics: [FLASH, ta(BOT), ta(BOT)], data: '0x' }], BOT);
  assert(flashT.flash, 'flash loan detected');

  let clock = 1_000_000;
  const rw = new RivalWatch(async () => ({}), px, (x) => (x === WETH ? 'WETH' : 'USDG'), (p) => p === P1, WETH, () => clock, 0);
  // gas: 200k gas at 0.05 gwei = 1e13 wei = 0.00001 ETH = $0.035
  const rec = rw.toRec({ status: '0x1', blockNumber: '0x1', gasUsed: '0x30d40', effectiveGasPrice: '0x2faf080', logs: arbLogs(BOT) }, BOT)!;
  assert(Math.abs(rec.grossUsd! - 35) < 1e-6 && Math.abs(rec.gasUsd! - 0.035) < 1e-6, 'profit $35 before gas, gas $0.035');
  assert(Math.abs(rec.sizeUsd! - 3500) < 1e-6 && rec.pools === 2 && !rec.ours, 'size $3,500, 2 pools, not all pools watched');
  const failed = rw.toRec({ status: '0x0', blockNumber: '0x1', gasUsed: '0x30d40', effectiveGasPrice: '0x2faf080', logs: [] }, BOT)!;
  assert(failed.failed && Math.abs(failed.gasUsd! - 0.035) < 1e-6, 'failed trade still paid gas');
  assert(rw.toRec({ status: '0x1', blockNumber: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1', logs: arbLogs(BOT).slice(0, 3) }, BOT) === null, 'one-pool trade is not an arbitrage');

  // --- summary ----------------------------------------------------------------
  const recs: RivalRec[] = [
    { ...rec, t: clock },
    { ...rec, t: clock, grossUsd: 0.1, gasUsd: 0.01, sizeUsd: 300, pools: 3, flash: true, ours: true, pair: 'AMZN/USDG/WETH' },
    { ...rec, t: clock, grossUsd: 0.0, gasUsd: 0.01, sizeUsd: 200, pools: 4 },
    { ...failed, t: clock, gasUsd: 0.01 },
    { ...rec, t: clock, grossUsd: null, gasUsd: 0.01, bot: '0x00000000000000000000000000000000000000b1' },
  ];
  const s = summarize(recs);
  assert(s.trades === 5 && s.wins === 2 && s.failed === 1 && s.unpriced === 1, 'counts: 2 wins, 1 failed, 1 unpriced');
  assert(Math.abs(s.netUsd - (34.965 + 0.09 - 0.01 - 0.01)) < 1e-6, 'kept after gas adds up (failed trades count their gas)');
  assert(s.routes.two === 2 && s.routes.three === 1 && s.routes.fourPlus === 1 && s.flash === 1 && s.onOurPools === 1, 'routes (failed trades left out), flash and watched counted');
  assert(s.bots === 2 && s.byBot[0].bot === BOT, 'bots ranked by money kept');

  // --- sampler finds new bots, ignores trading apps -----------------------------
  const blockRcpts = [
    { status: '0x1', to: BOT, logs: arbLogs(BOT) },
    // A trading app: takes the user's WETH, ends with nothing (passes USDG on).
    { status: '0x1', to: '0x00000000000000000000000000000000000000d0', logs: [
      { address: WETH, topics: [T, ta(USER), ta('0x00000000000000000000000000000000000000d0')], data: amt(10n ** 18n) },
      { address: WETH, topics: [T, ta('0x00000000000000000000000000000000000000d0'), ta(P1)], data: amt(10n ** 18n) },
      { address: P1, topics: [V3, ta(USER), ta(USER)], data: '0x' },
      { address: P2, topics: [V3, ta(USER), ta(USER)], data: '0x' },
      { address: USDG, topics: [T, ta(P2), ta(USER)], data: amt(3500n * 10n ** 6n) },
    ] },
  ];
  const sampler = new RivalWatch(async () => ({ result: blockRcpts }), px, () => 'X', () => false, WETH, () => clock, 0);
  await sampler.sampleBlock('0x1');
  assert(sampler.botCount() === 0, 'one sighting is not enough');
  await sampler.sampleBlock('0x2');
  assert(sampler.botCount() === 1, 'second profitable multi-pool trade: bot added; trading app never added');

  // --- Telegram -------------------------------------------------------------------
  const hourly = formatPlainHourly({
    windowLabel: 'x', live: false, feedOk: true, feedReconnects: 0, pairs: 1, spots: 1, pricesFrom: 'free', freeNodeBusy: 0,
    differencesFound: 0, checks: { done: 0, makeMoney: 0, loseMoney: 0, wouldFail: 0, nodeBusy: 0 }, checksAvailable: true,
    earned: { todayChecked: 0, todayCheckedCount: 0, todayUnchecked: 0, todayUncheckedCount: 0, weekChecked: 0 },
    reactionMs: { typical: 5, slowest5pct: 9 }, topDifferences: [], rivalWins: { ...s, botsKnown: 8 },
  });
  assert(hourly.includes('What other bots did this hour') && hourly.includes('failed but still paid gas: 1') && hourly.includes('Routes (trades that went through): 2 pools 50%, 3 pools 25%, 4+ pools 25%'), 'hourly section shows trades, failures, routes');
  const daily = formatRivalDaily({ dateLabel: '2026-10-08', hours: 24, summary: s, botsKnown: 8 });
  assert(daily.includes('RIVAL BOT REPORT') && daily.includes('Top bots') && daily.includes('What we learn') && daily.includes('Verdict'), 'daily report has all parts');
  assert(rivalLessons(s).some((l) => l.includes('3+ pool loops')), 'lessons mention loops');
  assert(rivalVerdict(s, 24).startsWith('⏳'), 'too few trades -> wait');
  const many = summarize(Array.from({ length: 50 }, () => ({ ...rec, grossUsd: 0.5, gasUsd: 0.01 })));
  assert(rivalVerdict(many, 1).startsWith('✅'), 'big pie and cheap gas -> worth building');
  const small = summarize(Array.from({ length: 50 }, () => ({ ...rec, grossUsd: 0.02, gasUsd: 0.01 })));
  assert(rivalVerdict(small, 24).startsWith('⚠️ Small pie'), 'small pie -> warning');

  // --- junk coin prices (ORBIO-like cases, Oct 8 report) -------------------------
  const ORBIO_BOT = '0x00000000000000000000000000000000000000b9';
  const base: RivalRec = { t: clock, bot: ORBIO_BOT, pair: 'ORBIO/WETH', pools: 2, sizeUsd: 120, grossUsd: 104.8, gasUsd: 0.01, failed: false, flash: false, ours: false };
  // 1) $104.80 "profit" on $120 put in: 87%, impossible for arbitrage.
  assert(isJunkProfit(base), 'profit 87% of trade size -> not trusted');
  // 2) Size unknown and "profit" over $5: not trusted. Under $5: fine.
  assert(isJunkProfit({ ...base, sizeUsd: null, grossUsd: 40 }) && !isJunkProfit({ ...base, sizeUsd: null, grossUsd: 0.4 }), 'no size: over $5 not trusted, small profit kept');
  // 3) Hugely negative from a distorted price (the -$24,742 day) is junk too.
  assert(isJunkProfit({ ...base, grossUsd: -24_000, sizeUsd: 300 }), 'impossible LOSS is junk too');
  // 4) Priced from a shallow pool: junk even if the ratio looks fine.
  assert(isJunkProfit({ ...base, grossUsd: 0.5, sizeUsd: 300, thinPrice: true }), 'shallow price pool -> not trusted');
  // 5) A normal small win stays.
  assert(!isJunkProfit({ ...base, grossUsd: 0.6, sizeUsd: 300 }), 'normal 0.2% win is trusted');
  assert(!isJunkProfit({ ...base, failed: true, grossUsd: null }), 'failed trades are never "junk"');

  // 96 ORBIO "wins" of ~$104.84 (the fake $10,065) + 30 real small wins + 10 failures.
  const orbio: RivalRec[] = [
    ...Array.from({ length: 96 }, () => ({ ...base })),
    ...Array.from({ length: 30 }, () => ({ ...base, bot: BOT, pair: 'USDG/WETH', grossUsd: 0.5, sizeUsd: 2_000 })),
    ...Array.from({ length: 10 }, () => ({ ...base, failed: true, pools: 0, grossUsd: null, sizeUsd: null, pair: '(failed)' })),
  ];
  const clean = summarize(orbio);
  assert(clean.junk === 96 && clean.wins === 30 && clean.failed === 10 && clean.trades === 136, 'junk counted separately; real wins and failures kept');
  assert(Math.abs(clean.grossUsd - 15) < 1e-6, 'money totals ignore the fake $10,065');
  assert(Math.abs(clean.netUsd - (30 * 0.49 - 10 * 0.01)) < 1e-6, 'kept = real wins after gas minus failed gas');
  assert(!clean.byPair.some(([p]) => p === 'ORBIO/WETH'), 'ORBIO not listed as a winning pair');
  const ob = clean.byBot.find((b) => b.bot === ORBIO_BOT)!;
  assert(Math.abs(ob.netUsd + 0.1) < 1e-6 && ob.trades === 106, 'ORBIO bot keeps only its real gas losses');
  assert(ob.avgPools === 2, 'avg pools ignores failed trades (would be 1.8 with them)');
  assert(clean.medianSizeUsd === 2_000 && ob.medianSizeUsd === null, 'junk trades\' sizes are left out of "typical trade"');
  const thin = summarize([{ ...base, grossUsd: 0.3, sizeUsd: 999_999, thinPrice: true }]);
  assert(thin.medianSizeUsd === null && thin.junk === 1, 'size priced from a shallow pool is not used');
  const rep = formatRivalDaily({ dateLabel: '2026-10-08', hours: 24, summary: clean, botsKnown: 9 });
  assert(rep.includes('dollar result uncertain (left out of the money below): 96 (junk coin price 96)') && !rep.includes('10,065') && !rep.includes('$10065'), 'report says 96 not trusted, no fake money');
  assert(rep.includes('Verdict') && rivalVerdict(clean, 24).startsWith('⚠️ Small pie'), 'verdict judged on cleaned numbers');
  // Mostly junk: verdict waits rather than judging on a handful of real trades.
  const mostlyJunk = summarize([...Array.from({ length: 96 }, () => ({ ...base })), ...Array.from({ length: 5 }, () => ({ ...base, grossUsd: 5, sizeUsd: 1_000 }))]);
  assert(rivalVerdict(mostlyJunk, 24).startsWith('⏳'), 'too few trustworthy trades -> wait');

  // toRec flags coins priced from shallow pools (depth callback).
  const thinRw = new RivalWatch(async () => ({}), px, (x) => (x === WETH ? 'WETH' : 'USDG'), () => false, WETH, () => clock, 0,
    (tok) => (tok === USDG ? Infinity : 3_000));
  const thinRec = thinRw.toRec({ status: '0x1', blockNumber: '0x1', gasUsed: '0x30d40', effectiveGasPrice: '0x2faf080', logs: arbLogs(BOT) }, BOT)!;
  assert(thinRec.thinPrice === true && isJunkProfit(thinRec), 'WETH priced from a $3k pool -> flagged');
  const deepRw = new RivalWatch(async () => ({}), px, (x) => (x === WETH ? 'WETH' : 'USDG'), () => false, WETH, () => clock, 0, () => 1e6);
  assert(!deepRw.toRec({ status: '0x1', blockNumber: '0x1', gasUsed: '0x30d40', effectiveGasPrice: '0x2faf080', logs: arbLogs(BOT) }, BOT)!.thinPrice, 'deep price pools -> not flagged');
}
main();
