import { CompetitorTracker } from '../core/competitorTracker';

// Checks the rival-arb finder: picks the first OTHER tx after the trigger
// that touched two pools of the pair, ignores single-pool trades and txs
// before the trigger; and the summary maths.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const P1 = '0xpool1', P2 = '0xpool2', OTHER = '0xother';
const log = (h: string, b: number, i: number, a: string) => ({ transactionHash: h, blockNumber: b, transactionIndex: i, address: a });
const logs = [
  log('0xtrigger', 100, 5, P1),          // the big trade (one pool)
  log('0xearly', 100, 2, P1), log('0xearly', 100, 2, P2),   // arb BEFORE the trigger: not a response
  log('0xretail', 100, 6, P2),           // someone trading one pool only
  log('0xarb', 100, 7, P1), log('0xarb', 100, 7, P2),       // the rival arb
  log('0xarb2', 101, 0, P1), log('0xarb2', 101, 0, P2),     // a later arb
  log('0xnoise', 100, 8, OTHER), log('0xnoise', 100, 8, P1),// touches a pool outside the pair
];
const r = CompetitorTracker.findRivalArb(logs, [P1, P2], { hash: '0xtrigger', block: 100, index: 5 });
assert(r?.hash === '0xarb' && r.index === 7, 'first two-pool tx after the trigger is the rival arb');
assert(CompetitorTracker.findRivalArb(logs.filter((l) => !l.transactionHash.startsWith('0xarb')), [P1, P2], { hash: '0xtrigger', block: 100, index: 5 }) === null,
  'no two-pool tx after the trigger -> no rival');

// Summary: their 12ms vs our 30ms; their 50ms vs our 20ms -> we beat one.
const t = new CompetitorTracker({} as any);
t.results = [
  { found: true, theirMs: 12, ourReadyMs: 30, txGap: 1, bot: '0xbot', profitUsd: 40 },
  { found: true, theirMs: 50, ourReadyMs: 20, txGap: 3, bot: '0xbot', profitUsd: 25 },
  { found: true, theirMs: 9, ourReadyMs: 25, txGap: 1, bot: '0xother', profitUsd: 60 },
  { found: false, ourReadyMs: 22, profitUsd: 10 },
];
const s = t.summary();
assert(s.checked === 4 && s.found === 3, 'counts checked vs found');
assert(s.theirMedianMs === 12 && s.theirFastestMs === 9, `their median/fastest (${s.theirMedianMs}/${s.theirFastestMs})`);
assert(s.beatCount === 1 && s.comparable === 3, 'we would have beaten 1 of 3');
assert(s.rightBehind === 2 && s.bots === 2 && s.topBotShare === 67, 'position and bot share');
t.noteFeedTx('0xABC', 5);
assert((t as any).seen.get('0xabc') === 5, 'feed tx times stored by lowercase hash');
