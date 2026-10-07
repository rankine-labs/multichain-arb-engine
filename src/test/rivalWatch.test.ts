import { ethers } from 'ethers';
import { RivalWatch } from '../core/rivalWatch';
import { formatPlainHourly } from '../core/telegramFormatter';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const BOT = '0x00000000000000000000000000000000000000b0';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const P1 = '0x00000000000000000000000000000000000000a1';
const P2 = '0x00000000000000000000000000000000000000a2';
const topicAddr = (a: string) => '0x' + a.slice(2).padStart(64, '0');
const amt = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');
const T = ethers.id('Transfer(address,address,uint256)');
const V3 = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
// Bot sends 1 WETH to pool 1, gets USDG, sends USDG to pool 2, gets 1.01 WETH back.
const logs = [
  { address: WETH, topics: [T, topicAddr(BOT), topicAddr(P1)], data: amt(10n ** 18n) },
  { address: USDG, topics: [T, topicAddr(P1), topicAddr(BOT)], data: amt(3500n * 10n ** 6n) },
  { address: P1, topics: [V3, topicAddr(BOT), topicAddr(BOT)], data: '0x' },
  { address: USDG, topics: [T, topicAddr(BOT), topicAddr(P2)], data: amt(3500n * 10n ** 6n) },
  { address: WETH, topics: [T, topicAddr(P2), topicAddr(BOT)], data: amt(101n * 10n ** 16n) },
  { address: P2, topics: [V3, topicAddr(BOT), topicAddr(BOT)], data: '0x' },
];

async function main() {
  const t = RivalWatch.analyze(logs, BOT);
  assert(t.net.get(WETH) === 10n ** 16n && t.net.get(USDG) === 0n, 'net change: +0.01 WETH, USDG back to zero');
  assert(t.pools.length === 2 && t.pools.includes(P1) && t.pools.includes(P2), 'both pools found from Swap events');

  let clock = 0;
  const rw = new RivalWatch(
    async () => ({ result: { status: '0x1', logs } }),
    (tok, raw) => (tok === WETH ? (Number(raw) / 1e18) * 3500 : Number(raw) / 1e6),
    (tok) => (tok === WETH ? 'WETH' : 'USDG'),
    (pool) => pool === P1,
    () => clock, 0,
  );
  rw.addBot(BOT);
  rw.noteTx('0x0000000000000000000000000000000000000099', '0xabc'); // not a rival: ignored
  rw.noteTx(BOT, '0xdef');
  await new Promise((r) => setTimeout(r, 1_300));
  const h = rw.takeHour();
  assert(h.trades === 1 && h.wins === 1 && Math.abs(h.usd - 35) < 1e-6, 'one rival win worth about $35');
  assert(h.byPair[0][0] === 'USDG/WETH' && h.onOurPools === 0, 'pair named; not all pools watched by us');
  assert(rw.takeHour().trades === 0, 'hour resets');

  const msg = formatPlainHourly({
    windowLabel: 'x', live: false, feedOk: true, feedReconnects: 0, pairs: 1, spots: 1, pricesFrom: 'free', freeNodeBusy: 0,
    differencesFound: 0, checks: { done: 0, makeMoney: 0, loseMoney: 0, wouldFail: 0, nodeBusy: 0 }, checksAvailable: true,
    earned: { todayChecked: 0, todayCheckedCount: 0, todayUnchecked: 0, todayUncheckedCount: 0, weekChecked: 0 },
    reactionMs: { typical: 5, slowest5pct: 9 }, topDifferences: [],
    rivalWins: { ...h, botsKnown: 3 },
  });
  assert(msg.includes('What other bots won this hour') && msg.includes('USDG/WETH: 1x, about $35.00') && msg.includes('On trading spots we watch: 0 of 1'), 'Telegram shows rival wins');
}
main();
