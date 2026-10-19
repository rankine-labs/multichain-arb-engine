// Check first, then send (core/checkFirst.ts, Oct 19). Live "follow a trade"
// sends go out only after the followed trade landed AND the real check of our
// exact trade says it makes money after gas.
import { waitForTrade, decideCheckFirst, checkFirstOn } from '../core/checkFirst';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const HASH = '0x' + 'ab'.repeat(32);
const noSleep = async () => {};

(async () => {
  // --- waitForTrade ---
  {
    let calls = 0;
    const rpc = async () => { calls++; return { result: calls >= 3 ? { blockNumber: '0x10' } : null }; };
    assert(await waitForTrade(rpc, HASH, 1, 12, noSleep) && calls === 3, 'waits until the followed trade is in a block (3rd poll)');
  }
  {
    let calls = 0;
    const rpc = async () => { calls++; return { result: null }; };
    assert(!(await waitForTrade(rpc, HASH, 1, 5, noSleep)) && calls === 5, 'never lands in time: gives up after the limit (not sent)');
  }
  assert(!(await waitForTrade(async () => ({ error: { message: 'boom' } }), HASH, 1, 5, noSleep)), 'node error: not sent');
  {
    let calls = 0;
    const rpc = async () => { calls++; return { result: { blockNumber: '0x1' } }; };
    assert(!(await waitForTrade(rpc, '', 1, 5, noSleep)) && !(await waitForTrade(rpc, '0xPLACEHOLDER', 1, 5, noSleep)) && calls === 0, 'no real trade hash: not sent, node not even asked');
  }

  // --- decideCheckFirst (gas $0.02, send minimum $0.25) ---
  const G = 0.02, MIN = 0.25;
  // The first live day: the guess said $2.94, the real check said LOSS.
  {
    const v = decideCheckFirst({ status: 'loss', reason: 'x' }, G, MIN, 2.94);
    assert(!v.send && v.blockPair, 'real check says loss: NOT sent, pair blocked (the GLXY case)');
  }
  {
    const v = decideCheckFirst({ status: 'fail', reason: 'ZeroAmount()' }, G, MIN, 0.45);
    assert(!v.send && v.blockPair, 'real check says it would fail: NOT sent, pair blocked (the MKMK case)');
  }
  {
    const v = decideCheckFirst({ status: 'rate_limited' }, G, MIN, 5);
    assert(!v.send && !v.blockPair, 'node busy: not sent, pair NOT blocked (not the pair\'s fault)');
  }
  {
    const v = decideCheckFirst({ status: 'skipped', reason: 'unknown decimals' }, G, MIN, 5);
    assert(!v.send && !v.blockPair, 'check skipped: not sent');
  }
  {
    const v = decideCheckFirst({ status: 'profit', usd: 0.2 }, G, MIN, 3);
    assert(!v.send && !v.blockPair, 'real profit $0.18 after gas: under the $0.25 minimum, not sent (still positive, not blocked)');
  }
  {
    const v = decideCheckFirst({ status: 'profit', usd: 0.01 }, G, MIN, 3);
    assert(!v.send && v.blockPair, 'real profit smaller than gas: not sent, pair blocked');
  }
  {
    const v = decideCheckFirst({ status: 'profit', usd: 1.02 }, G, MIN, 3);
    assert(v.send && Math.abs(v.netUsd - 1.0) < 1e-9, 'real check $1.00 after gas, guess $3: SENT on $1.00 (never the bigger guess)');
  }
  {
    const v = decideCheckFirst({ status: 'profit', usd: 5 }, G, MIN, 0.6);
    assert(v.send && Math.abs(v.netUsd - 0.6) < 1e-9, 'check higher than the guess: sent on the smaller guess');
  }
  {
    const v = decideCheckFirst({ status: 'profit', usd: NaN }, G, MIN, 1);
    assert(!v.send, 'broken check number: not sent');
  }

  // --- switch ---
  const old = process.env.TRIGGER_CHECK_FIRST;
  delete process.env.TRIGGER_CHECK_FIRST;
  assert(checkFirstOn(), 'on by default');
  process.env.TRIGGER_CHECK_FIRST = '0';
  assert(!checkFirstOn(), 'TRIGGER_CHECK_FIRST=0 turns it off');
  if (old === undefined) delete process.env.TRIGGER_CHECK_FIRST; else process.env.TRIGGER_CHECK_FIRST = old;
})();
