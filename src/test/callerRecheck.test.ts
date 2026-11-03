import { ethers } from 'ethers';
import { makeCaller, callerRecheckOn } from '../core/universeScan';

// ============================================================================
// MULTICALL CHECK FIX (Nov 3, CALLER_RECHECK, default on; =0 = old).
//
// Live Nov 3 13:42: after a restart the tick windows loaded 0 pools in 30
// minutes. A caller is made once and kept for the bot's life; it asks the
// node once whether Multicall3 is there, and a node hiccup at that moment
// made it decide "no" forever (slow one-by-one reads that kept failing).
// This test uses a fake node whose FIRST "is it there?" answer fails.
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const mc3 = new ethers.Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);

// A fake node: getCode fails the first `failCodes` times; eth_call answers
// Multicall3 bundles (each inner call returns its own data back) and single
// calls (returns the data back). Counts what was asked.
function fakeNode(failCodes: number) {
  const seen = { getCode: 0, bundles: 0, singles: 0 };
  const p = {
    async getCode(addr: string) {
      seen.getCode++;
      if (seen.getCode <= failCodes) throw new Error('node hiccup');
      return addr.toLowerCase() === MC3.toLowerCase() ? '0x6080604052' : '0x';
    },
    async call(tx: { to: string; data: string }) {
      if (tx.to.toLowerCase() === MC3.toLowerCase()) {
        seen.bundles++;
        const [calls] = mc3.decodeFunctionData('aggregate3', tx.data);
        return mc3.encodeFunctionResult('aggregate3', [calls.map((c: any) => [true, c.callData])]);
      }
      seen.singles++;
      return tx.data;
    },
  };
  return { p: p as unknown as ethers.JsonRpcProvider, seen };
}

const calls = Array.from({ length: 30 }, (_, i) => ({ target: '0x' + (0x1000 + i).toString(16).padStart(40, '0'), data: '0x70a08231' + i.toString(16).padStart(64, '0') }));
const want = JSON.stringify(calls.map((c) => c.data));

(async () => {
  assert(callerRecheckOn({}) && !callerRecheckOn({ CALLER_RECHECK: '0' }), 'switch: on by default, CALLER_RECHECK=0 turns it off');

  // 1. Healthy node: bundles from the start (same as before).
  {
    const { p, seen } = fakeNode(0);
    const c = await makeCaller(p);
    const out = await c.callMany(calls);
    assert(c.multicall && JSON.stringify(out) === want && seen.bundles === 1 && seen.singles === 0, 'healthy node: one bundle, right answers (unchanged)');
  }

  // 2. Hiccup at the check: the first use throws ("try again later"), the
  //    next use asks again and bundles. Never falls to one-by-one reads.
  {
    const { p, seen } = fakeNode(1);
    const c = await makeCaller(p);
    let threw = false;
    try { await c.callMany(calls); } catch { threw = true; }
    // (The first use asked again and got an answer, so it may already succeed.)
    const out = await c.callMany(calls);
    assert(JSON.stringify(out) === want && seen.singles === 0 && seen.bundles >= 1, `hiccup at the check: asked again (${seen.getCode} checks), bundled reads, no one-by-one reads (first use threw: ${threw})`);
  }
  {
    const { p, seen } = fakeNode(2);
    const c = await makeCaller(p);
    let threw = false;
    try { await c.callMany(calls); } catch { threw = true; }
    const out = await c.callMany(calls);
    assert(threw && JSON.stringify(out) === want && seen.singles === 0 && seen.bundles === 1, 'node still down at the first use: that use throws (caller retries later), the next one bundles');
  }

  // 3. Old behaviour with CALLER_RECHECK=0: a hiccup means one-by-one reads for good.
  {
    process.env.CALLER_RECHECK = '0';
    try {
      const { p, seen } = fakeNode(1);
      const c = await makeCaller(p);
      const out = await c.callMany(calls);
      assert(!c.multicall && JSON.stringify(out) === want && seen.singles === 30 && seen.bundles === 0, 'CALLER_RECHECK=0: old behaviour (one-by-one reads after a hiccup)');
    } finally { delete process.env.CALLER_RECHECK; }
  }

  // 4. A chain with no Multicall3 (getCode answers "no code"): one-by-one, as before.
  {
    const { p, seen } = fakeNode(0);
    (p as any).getCode = async () => { seen.getCode++; return '0x'; };
    const c = await makeCaller(p);
    const out = await c.callMany(calls);
    assert(!c.multicall && JSON.stringify(out) === want && seen.singles === 30 && seen.getCode === 1, 'no Multicall3 on the chain: one-by-one reads, asked only once (unchanged)');
  }
})();
