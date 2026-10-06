import { CompetitorTracker } from '../core/competitorTracker';

// Rival timing on a pair where one pool is Uniswap V4 (a 32-byte pool id in
// the PoolManager): the rival's arb must be found through PoolManager Swap
// events instead of failing on eth_getLogs.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const V3 = '0x' + '33'.repeat(20);
const V4ID = '0x' + '44'.repeat(32);
const TRIGGER = '0x' + 'aa'.repeat(32), RIVAL = '0x' + 'bb'.repeat(32);
const queries: any[] = [];
const fake = {
  getTransactionReceipt: async () => ({ blockNumber: 100, index: 3 }),
  getTransaction: async () => ({ to: '0x' + 'cc'.repeat(20) }),
  send: async (_m: string, [f]: any[]) => {
    queries.push(f);
    if (Array.isArray(f.address)) {
      if (f.address.some((a: string) => a.length === 66)) throw new Error('invalid address');
      return [{ transactionHash: RIVAL, transactionIndex: '4', blockNumber: '0x64', address: V3, topics: [] }];
    }
    return [{ transactionHash: RIVAL, transactionIndex: '4', blockNumber: '0x64', address: PM, topics: ['0xswap', V4ID] }];
  },
} as any;

async function main() {
  let t = 0;
  const tr = new CompetitorTracker(fake, () => t, PM);
  tr.noteFeedTx(TRIGGER, 1_000);
  tr.noteFeedTx(RIVAL, 1_120);
  tr.watch({ triggerHash: TRIGGER, triggerSeenMs: 1_000, pools: [V3, V4ID], ourReadyMs: 50, profitUsd: 30 });
  t = 10_000; // past the 4 s delay
  await new Promise((r) => setTimeout(r, 4_200));
  const r = tr.results[0];
  assert(!queries.some((q) => Array.isArray(q.address) && q.address.some((a: string) => a.length === 66)), 'V4 pool id is never sent as an address');
  assert(queries.some((q) => q.address === PM && Array.isArray(q.topics) && q.topics[1]?.[0] === V4ID), 'V4 swaps read from PoolManager by pool id');
  assert(!!r && r.found && r.theirMs === 120 && r.txGap === 1, `rival arb across V3 + V4 found (theirs ${r?.theirMs} ms, ${r?.txGap} tx behind)`);
}
main().catch((e) => { console.error('FAIL: crashed', e); process.exitCode = 1; });
