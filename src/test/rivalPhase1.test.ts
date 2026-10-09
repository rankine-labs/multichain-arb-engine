import { ethers } from 'ethers';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RivalWatch, summarize, RivalRec, bucketOf, VERIFIED_BOT_WINS } from '../core/rivalWatch';
import { formatRivalDaily, formatPlainHourly } from '../core/telegramFormatter';
import { PoolCache } from '../core/poolCache';
import { PriceOracle, registerStablecoin } from '../core/priceOracle';
import { V3BalanceBook } from '../core/v3BalanceBook';
import { PoolState } from '../core/types';

// ============================================================================
// Phase 1 fixes (Oct 8): the rival report must add up, never present an
// unknown dollar result as a profit or loss, flag suspicious valuations, and
// keep an audit trail. One block per audit bug.
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

const BOT = '0x00000000000000000000000000000000000000b0';
const BOT2 = '0x00000000000000000000000000000000000000b2';
const OWNER = '0x00000000000000000000000000000000000000e0';
const STRANGER = '0x00000000000000000000000000000000000000f0';
const PM = '0x00000000000000000000000000000000000000dd'; // V4 PoolManager
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const P1 = '0x00000000000000000000000000000000000000a1';
const P2 = '0x00000000000000000000000000000000000000a2';
const V4ID = '0x' + 'ab'.repeat(32);
const ta = (a: string) => '0x' + a.slice(2).padStart(64, '0');
const amt = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');
const T = ethers.id('Transfer(address,address,uint256)');
const V3 = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
const V4 = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const DEP = ethers.id('Deposit(address,uint256)');
const E18 = 10n ** 18n, E6 = 10n ** 6n;
const px = (tok: string, raw: bigint) => (tok === WETH ? (Number(raw) / 1e18) * 3500 : tok === USDG ? Number(raw) / 1e6 : null);
const sym = (x: string) => (x === WETH ? 'WETH' : 'USDG');
// 1 WETH -> P1 -> 3500 USDG -> P2 -> 1.0001 WETH  (+0.0001 WETH = $0.35 profit, a realistic size)
const arb = (who: string) => [
  { address: WETH, topics: [T, ta(who), ta(P1)], data: amt(E18) },
  { address: USDG, topics: [T, ta(P1), ta(who)], data: amt(3500n * E6) },
  { address: P1, topics: [V3, ta(who), ta(who)], data: '0x' },
  { address: USDG, topics: [T, ta(who), ta(P2)], data: amt(3500n * E6) },
  { address: WETH, topics: [T, ta(P2), ta(who)], data: amt(E18 + 10n ** 14n) },
  { address: P2, topics: [V3, ta(who), ta(who)], data: '0x' },
];
// 200k gas at 0.05 gwei = 0.00001 ETH = $0.035
const rcpt = (logs: any[], extra: Record<string, unknown> = {}) => ({ status: '0x1', blockNumber: '0x64', gasUsed: '0x30d40', effectiveGasPrice: '0x2faf080', transactionHash: '0x' + '12'.repeat(32), logs, ...extra });

async function main() {
  let clock = 1_000_000;
  const mk = (opts: any = {}, rpc: any = async () => ({})) => new RivalWatch(rpc, px, sym, () => false, WETH, () => clock, 0, opts);

  // --- Bug 1: gas reconciles, including failed and unpriced trades -------------
  const rw = mk({ v4IsNative: () => false, v4PoolManager: PM });
  const win = rw.toRec(rcpt(arb(BOT)), BOT)!;
  assert(win.conf === 'confirmed' && close(win.grossUsd!, 0.35) && close(win.gasUsd!, 0.035), 'plain 2-pool arb: confirmed, $0.35 before gas, $0.035 gas');
  const recs: RivalRec[] = [
    win,                                                                   // confirmed +0.315
    { ...win, grossUsd: 0.01, gasUsd: 0.02 },                              // confirmed -0.01
    { ...win, failed: true, pools: 0, grossUsd: null, gasUsd: 0.05, pair: '(failed)', conf: undefined }, // failed
    { ...win, grossUsd: null, gasUsd: 0.04, conf: 'unpriced' },            // unpriced: gas counted, no P&L
    { ...win, grossUsd: 0.5, gasUsd: 0.03, conf: 'uncertain', why: ['v4-native-leg'] }, // uncertain
    { ...win, grossUsd: 300, sizeUsd: 1000, gasUsd: 0.01 },                // junk (30% "profit")
  ];
  const s = summarize(recs);
  assert(close(s.gasUsd, s.gasConfirmedUsd + s.gasFailedUsd + s.gasUnknownUsd), 'gas total = confirmed + failed + unknown');
  assert(close(s.gasUnknownUsd, 0.04 + 0.03 + 0.01), 'gas on unpriced, uncertain and junk trades is counted (was missing from the net)');
  assert(close(s.netUsd, s.grossUsd - s.gasConfirmedUsd - s.gasFailedUsd), 'kept = made - gas on confirmed - failed gas');
  assert(close(s.grossUsd, 0.36) && close(s.netUsd, 0.36 - 0.055 - 0.05), 'only confirmed trades count as made');
  assert(close(s.netWorstUsd, s.netUsd - 0.08), '"if unknowns made nothing" subtracts their gas');
  assert(s.uncertain === 1 && s.junk === 1 && s.unpriced === 1 && s.failed === 1 && s.wins === 1, 'every trade in exactly one bucket');
  assert(s.whyUncertain.some(([w, n]) => w === 'v4-native-leg' && n === 1) && s.whyUncertain.some(([w]) => w === 'junk-price'), 'uncertain reasons are counted');

  // --- Bug 2: suspicious valuations flagged, not silently accepted ------------
  assert(bucketOf({ ...win, grossUsd: 104, sizeUsd: 120 }) === 'junk', 'ORBIO-style 87% "profit" -> junk');
  const junkRec = rw.toRec(rcpt([...arb(BOT).slice(0, 4), { address: WETH, topics: [T, ta(P2), ta(BOT)], data: amt(2n * E18) }, arb(BOT)[5]]), BOT)!;
  assert(junkRec.conf === 'uncertain' && junkRec.why!.includes('junk-price'), 'impossible profit is saved as uncertain with reason junk-price');

  // --- Bug 3: V3 depth capped by the coins really in the pool ----------------
  {
    const cache = new PoolCache();
    const W = '0xweth3', U = '0xusd3';
    registerStablecoin('robinhood', U);
    const dec = (_c: string, t: string) => (t === W ? 18 : 6);
    // Narrow-band V3 pool: liquidity says ~$40k virtual, but it holds ~$600 of USD.
    const sqrtP = Math.sqrt(3500 * 1e6 / 1e18); // price of WETH in USD units, raw
    const L = 40_000 * 1e6 / sqrtP / 1;          // b = L * sqrtP ~= $40k of USD side
    const pool: PoolState = { chain: 'robinhood', dex: 'uniswap-v3', poolAddress: '0x00000000000000000000000000000000000000c3', poolType: 'v3',
      tokenA: W, tokenB: U, sqrtPriceX96: BigInt(Math.floor(sqrtP * 2 ** 96)), liquidity: BigInt(Math.floor(L)), feeBps: 5, lastUpdatedBlock: 1, lastUpdatedMs: 0 };
    cache.upsert(pool);
    const book = new V3BalanceBook();
    const oracle = new PriceOracle(cache, dec, 0, () => 0);
    const before = oracle.getUsdPriceInfo('robinhood', W)!;
    assert(before.depthSource === 'virtual' && before.depthUsd > 50_000, `without balances: virtual depth (~$80k), labelled virtual (got $${before.depthUsd.toFixed(0)})`);
    const n = await book.refresh(async (calls) => calls.map((c) => (c.target === U ? amt(600n * E6) : amt(E18 / 10n))), cache.allForChain('robinhood'));
    oracle.useBalances(book);
    const after = oracle.getUsdPriceInfo('robinhood', W)!;
    assert(n === 2 && after.depthSource === 'real-balance' && close(after.depthUsd, 1_200, 1), `with real balances: depth capped at 2 x $600 = $1,200 (got $${after.depthUsd.toFixed(0)})`);
    assert(close(after.px, before.px), 'price itself unchanged; only the depth confidence changes');
    const thinRw = mk({ priceDepthUsd: (t: string) => (t === USDG ? Infinity : after.depthUsd) });
    assert(thinRw.toRec(rcpt(arb(BOT)), BOT)!.why?.includes('junk-price') === true, 'trade priced from that pool is flagged (thin price)');
  }

  // --- Bug 4: failed trades are not routes ------------------------------------
  assert(s.routes.two === 5 && s.byBot[0].avgPools === 2, 'the failed trade is not counted as a 2-pool route; avg pools stays 2');

  // --- Bug 5: native ETH, WETH wrap, V4 native pools, external wallets --------
  // WETH wrap before the trade: Deposit has no Transfer; the plain-ETH side has no log. Net must be just the profit.
  const wrapped = RivalWatch.analyze([{ address: WETH, topics: [DEP, ta(BOT)], data: amt(E18) }, ...arb(BOT)], BOT);
  assert(wrapped.wrapped && wrapped.net.get(WETH) === 10n ** 14n, 'WETH wrap is accounting-neutral: net stays +0.0001 WETH');
  // Profit swept to the owner wallet in the same tx.
  const swept = [...arb(BOT), { address: WETH, topics: [T, ta(BOT), ta(OWNER)], data: amt(10n ** 14n) }];
  const noOwner = rw.toRec(rcpt(swept), BOT)!;
  const withOwner = rw.toRec(rcpt(swept, { from: OWNER }), BOT)!;
  assert(noOwner.conf !== 'confirmed' && noOwner.why!.includes('profit-sent-elsewhere'), 'without the sender wallet: profit looks sent elsewhere -> uncertain');
  assert(withOwner.conf === 'confirmed' && close(withOwner.grossUsd!, 0.35), 'with the sender wallet included: bot -> owner is internal, profit confirmed');
  // V4 legs.
  const v4logs = [...arb(BOT).slice(0, 3), { address: PM, topics: [V4, V4ID, ta(BOT)], data: '0x' }, { address: USDG, topics: [T, ta(BOT), ta(PM)], data: amt(3500n * E6) }, { address: WETH, topics: [T, ta(PM), ta(BOT)], data: amt(E18 + 10n ** 14n) }];
  const v4Native = mk({ v4IsNative: () => true, v4PoolManager: PM }).toRec(rcpt(v4logs), BOT)!;
  const v4Unknown = mk({ v4PoolManager: PM }).toRec(rcpt(v4logs), BOT)!;
  const v4Erc20 = mk({ v4IsNative: () => false, v4PoolManager: PM }).toRec(rcpt(v4logs), BOT)!;
  assert(v4Native.conf === 'uncertain' && v4Native.why!.includes('v4-native-leg'), 'V4 pool holding plain ETH -> uncertain (invisible leg)');
  assert(v4Unknown.conf === 'uncertain' && v4Unknown.why!.includes('v4-pool-unknown'), 'V4 pool we can\'t check -> uncertain');
  assert(v4Erc20.conf === 'confirmed' && v4Erc20.pools === 2, 'V4 pool known to be token-only -> confirmed; PoolManager is not "elsewhere"');
  // Plain ETH carried by the transaction.
  assert(rw.toRec(rcpt(arb(BOT)), BOT, clock, { value: 5n })!.why?.includes('native-eth-sent') === true, 'tx carrying plain ETH -> uncertain');
  // Open position: ends with less USDG and more WETH (a swap, not a loop).
  const open = [arb(BOT)[0], arb(BOT)[1], arb(BOT)[2], { address: USDG, topics: [T, ta(BOT), ta(P2)], data: amt(3600n * E6) }, arb(BOT)[4], arb(BOT)[5]];
  const openRec = rw.toRec(rcpt(open), BOT)!;
  assert(openRec.closedLoop === false && openRec.why!.includes('open-position'), 'ends with less of a coin -> not a closed loop, uncertain');

  // --- Flash loans vs ordinary V3 mechanics -----------------------------------
  // V3 pays the bot FIRST, then the bot pays in the callback: no Flash event -> not a loan.
  const payFirst = [arb(BOT)[1], arb(BOT)[0], arb(BOT)[2], arb(BOT)[4], arb(BOT)[3], arb(BOT)[5]];
  assert(!RivalWatch.analyze(payFirst, BOT).flash, 'V3 pay-first-then-callback is NOT counted as a flash loan');

  // --- Bug 8: audit trail saved ----------------------------------------------
  assert(withOwner.hash === '0x' + '12'.repeat(32) && withOwner.block === 100 && withOwner.from === OWNER, 'tx hash, block and sender saved');
  assert(withOwner.route!.length === 2 && withOwner.deltas!.some(([k, v]) => k === WETH && v === (10n ** 14n).toString()), 'route and coin amounts saved');
  const failedRec = rw.toRec({ ...rcpt([]), status: '0x0' }, BOT)!;
  assert(failedRec.failed && failedRec.hash !== undefined && bucketOf(failedRec) === 'failed', 'failed trade keeps its hash too');

  // --- Bug 7: seed list validated (verified vs unproven) ---------------------
  const v = mk({ v4IsNative: () => false });
  v.addBot(BOT, 'seed'); v.addBot(BOT2, 'seed');
  for (let i = 0; i < VERIFIED_BOT_WINS; i++) v.add({ ...win });
  v.add({ ...win, bot: BOT2, grossUsd: null, conf: 'unpriced' });
  const st = v.botStatus();
  assert(st.verified === 1 && st.unproven === 1 && st.bySource.seed.total === 2 && st.bySource.seed.verified === 1, 'seed bots: one verified by 3 confirmed wins, one unproven');
  const vs = v.summary(0, clock + 1);
  assert(vs.byBot.find((b) => b.bot === BOT)!.verified && !vs.byBot.find((b) => b.bot === BOT2)!.verified && vs.verifiedBots === 1, 'report knows which bots are verified');
  // Save + load (and old string-list format still loads).
  const dir = mkdtempSync(join(tmpdir(), 'rw-'));
  v.save(join(dir, 'b.json'), join(dir, 'r.json'));
  const v2 = mk(); v2.load(join(dir, 'b.json'), join(dir, 'r.json'));
  assert(v2.botStatus().verified === 1 && v2.botStatus().bySource.seed.total === 2, 'bot track record survives a restart');
  writeFileSync(join(dir, 'old.json'), JSON.stringify([BOT]));
  const v3 = mk(); v3.load(join(dir, 'old.json'), join(dir, 'none.json'));
  assert(v3.botCount() === 1, 'old bots file (plain list) still loads');

  // --- Bug 6: better rival identification ------------------------------------
  // a) A known bot's owner wallet sends to a NEW contract: two confirmed loop wins make it a bot.
  const NEWBOT = '0x00000000000000000000000000000000000000b9';
  const receipts: Record<string, any> = {
    h1: rcpt(arb(BOT), { from: OWNER }),
    h2: rcpt(arb(NEWBOT), { from: OWNER, transactionHash: '0xh2' }),
    h3: rcpt(arb(NEWBOT), { from: OWNER, transactionHash: '0xh3' }),
    h4: rcpt(arb(NEWBOT), { from: STRANGER, transactionHash: '0xh4' }),
  };
  const id = mk({ v4IsNative: () => false }, async (_m: string, p: any[]) => receipts[p[0]]);
  id.addBot(BOT, 'seed');
  id.noteTx(BOT, 'h1', OWNER); id.noteTx(BOT, 'h1', OWNER); // duplicate hash ignored
  await new Promise((r) => setTimeout(r, 1_200));
  assert(id.summary(0, clock + 1).trades === 1, 'same tx hash noted twice is counted once');
  id.noteTx(NEWBOT, 'h2', OWNER); id.noteTx(NEWBOT, 'h3', OWNER); id.noteTx(NEWBOT, 'h4', STRANGER);
  await new Promise((r) => setTimeout(r, 2_500));
  assert(id.botCount() === 2 && id.botStatus().bySource.owner.total === 1, 'new contract run by a known bot\'s wallet joins after 2 confirmed loop wins');
  // b) Sampler: a trading app (user ends with less USDG, more WETH) is not a rival; a loop is. Coverage counted.
  const app = mk();
  const block = [
    { ...rcpt(open), to: STRANGER, from: OWNER },               // swap-like: not a closed loop
    { ...rcpt(arb(BOT)), to: BOT, from: OWNER },                // rival-style loop by an unknown bot
  ];
  const sampler = mk({ v4IsNative: () => false }, async () => block);
  await sampler.sampleBlock('0x10'); await sampler.sampleBlock('0x11');
  const sh = sampler.takeHour();
  assert(sampler.botCount() === 1 && sh.sample!.blocks === 2 && sh.sample!.arbs === 2 && sh.sample!.followed === 0, 'sampler: loop bot added after 2 hits, app ignored, coverage counted');
  void app;

  // --- Reports reconcile and show uncertainty -------------------------------
  const rep = formatRivalDaily({ dateLabel: '2026-10-08', hours: 24, summary: s, botsKnown: 9, botsVerified: 3 });
  assert(rep.includes('= kept') && rep.includes('Gas on uncertain/unpriced trades') && rep.includes('3 verified'), 'daily report shows the reconciling money line, unknown gas and verified bots');
  assert(rep.includes('plain-ETH pool leg') && !rep.includes('$300'), 'uncertain reason in plain English; the junk "$300" never shown as money');
  const hourly = formatPlainHourly({
    windowLabel: 'x', live: false, feedOk: true, feedReconnects: 0, pairs: 1, spots: 1, pricesFrom: 'free', freeNodeBusy: 0,
    differencesFound: 0, checks: { done: 0, makeMoney: 0, loseMoney: 0, wouldFail: 0, nodeBusy: 0 }, checksAvailable: true,
    earned: { todayChecked: 0, todayCheckedCount: 0, todayUnchecked: 0, todayUncheckedCount: 0, weekChecked: 0 },
    reactionMs: { typical: 5, slowest5pct: 9 }, topDifferences: [], rivalWins: { ...sh, botsKnown: 1, botsVerified: 0 },
  });
  assert(hourly.includes('Chain sample: 2 blocks read, 2 rival-style trades, 0% by bots we follow'), 'hourly shows chain coverage');
}
main();
