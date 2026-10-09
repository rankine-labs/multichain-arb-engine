import { ethers } from 'ethers';
import { judge, RaceChecker, summarizeRaces, RaceEntry, RaceResult } from '../core/raceCheck';
import { formatPlainHourly } from '../core/telegramFormatter';

// Race check: would we really have won each practice win?

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const V3 = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
const V2 = ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)');
const V4 = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const PM = '0x00000000000000000000000000000000000000dd';
const A = '0x00000000000000000000000000000000000000a1', B = '0x00000000000000000000000000000000000000b2';
const ID = '0x' + 'cd'.repeat(32);
const q = (n: number) => '0x' + n.toString(16);
const swap = (pool: string, block: number, tx: string, topic = V3) => ({ address: pool, topics: [topic], blockNumber: q(block), transactionHash: tx });
const e: RaceEntry = { label: 'PONS/USDG gap', pools: [A, B], spottedBlock: 1000, readyBlock: 1010, netUsd: 7.36, source: 'gap' };

async function main() {
  // Lost: a rival hit both pools in one tx at block 1004, before we were ready (1010).
  const lost = judge(e, [swap(A, 1004, '0xr1'), swap(B, 1004, '0xr1', V2)]);
  assert(lost.verdict === 'lost' && lost.tx === '0xr1' && Math.abs(lost.rivalLeadS! - 0.66) < 1e-9 && Math.abs(lost.takenAfterS! - 0.44) < 1e-9, 'rival arbitrage before we were ready -> lost, 0.66 s ahead, 0.44 s after we spotted it');
  // Won: rival arrives after we'd have been ready.
  const won = judge(e, [swap(A, 1015, '0xr2'), swap(B, 1015, '0xr2')]);
  assert(won.verdict === 'won' && Math.abs(won.takenAfterS! - 1.65) < 1e-9, 'rival only after we were ready -> won (they took it 1.65 s after we spotted it)');
  assert(judge(e, []).verdict === 'won', 'nobody touched it -> won');
  // Unclear: a normal one-pool trade before we were ready.
  assert(judge(e, [swap(A, 1003, '0xu')]).verdict === 'unclear', 'one-pool trade first -> unclear');
  // Swaps before we spotted it don't count; other pools don't count.
  assert(judge(e, [swap(A, 990, '0xold'), swap(B, 990, '0xold'), swap('0x' + 'ee'.repeat(20), 1002, '0xx')]).verdict === 'won', 'older swaps and other pools ignored');
  // V4 pool ids: swaps come from the PoolManager with the id in topic 1.
  const v4e: RaceEntry = { ...e, pools: [A, ID] };
  const v4lost = judge(v4e, [swap(A, 1005, '0xr3'), { address: PM, topics: [V4, ID], blockNumber: q(1005), transactionHash: '0xr3' }], PM);
  assert(v4lost.verdict === 'lost', 'V4 leg recognised through the PoolManager');
  // The trade we reacted to isn't a rival.
  const trig: RaceEntry = { ...e, source: 'trigger', ignoreTx: '0xtrigger' };
  assert(judge(trig, [swap(A, 1000, '0xtrigger')]).verdict === 'won', 'the trigger trade itself is ignored');

  // Trades earlier in the trigger's own block were already in the state we tested.
  const early = { address: A, topics: [V3], blockNumber: q(1000), transactionHash: '0xbefore', transactionIndex: '0x2' };
  assert(judge({ ...trig, afterTxIndex: 5 }, [early]).verdict === 'won', 'trades before the trigger in its block are ignored');
  assert(judge({ ...trig, afterTxIndex: 1 }, [early]).verdict === 'unclear', 'a one-pool trade after the trigger, before we were ready -> unclear');

  // Summary.
  const rs: RaceResult[] = [
    { ...e, verdict: 'won' }, { ...e, netUsd: 2, verdict: 'won' },
    { ...e, netUsd: 1, verdict: 'lost', rivalLeadS: 0.4 }, { ...e, netUsd: 1, verdict: 'lost', rivalLeadS: 0.6 }, { ...e, verdict: 'unclear' },
  ];
  const s = summarizeRaces(rs);
  assert(s.won === 2 && s.lost === 2 && s.unclear === 1 && Math.abs(s.wonUsd - 9.36) < 1e-9 && s.avgLeadS === 0.5, 'summary: counts, money, average rival lead');

  // Checker end to end with a fake node.
  let head = 2000;
  const calls: string[] = [];
  const rpc = async (m: string, p: any[]) => {
    calls.push(m);
    if (m === 'eth_blockNumber') return q(head);
    if (m === 'eth_getLogs') return p[0].address === PM ? [] : [swap(A, 1999, '0xrival'), swap(B, 1999, '0xrival')];
    if (m === 'eth_getTransactionByHash') return { to: '0x00000000000000000000000000000000000000b0' };
    return null;
  };
  const rc = new RaceChecker(rpc, PM);
  await rc.record({ label: 'X/USDG gap', pools: [A, B], netUsd: 3, source: 'gap', readyDelayMs: 1100 }); // spotted 10 blocks ago, ready now
  assert(rc.pendingCount() === 1, 'win recorded and being watched');
  assert((await rc.tick()).length === 0, 'not judged before the ~30 s window ends');
  head = 2400;
  const out = await rc.tick();
  assert(out.length === 1 && out[0].verdict === 'lost' && out[0].rival === '0x00000000000000000000000000000000000000b0', 'judged after the window: lost, rival bot named');
  assert(calls.filter((c) => c === 'eth_getLogs').length === 1, 'one log request for the batch');
  const hour = rc.takeHour();
  assert(hour.lost === 1 && hour.pending === 0, 'hourly summary taken');

  // Hourly report line.
  const txt = formatPlainHourly({
    windowLabel: 'x', live: false, feedOk: true, feedReconnects: 0, pairs: 1, spots: 1, pricesFrom: 'free', freeNodeBusy: 0,
    differencesFound: 0, checks: { done: 0, makeMoney: 0, loseMoney: 0, wouldFail: 0, nodeBusy: 0 }, checksAvailable: true,
    earned: { todayChecked: 0, todayCheckedCount: 0, todayUnchecked: 0, todayUncheckedCount: 0, weekChecked: 0 },
    reactionMs: { typical: 5, slowest5pct: 9 }, topDifferences: [], race: { ...s, pending: 1 },
  });
  assert(txt.includes("Race check</b>: 5 wins checked → we'd have won 2 ($9.36), lost 2 ($2.00), rival 0.5s faster on average, unclear 1 · 1 still being watched"), 'hourly Telegram shows the race check');
}
main();
