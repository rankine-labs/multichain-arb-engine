import { PairWatcher } from '../core/pairWatcher';
import { PoolCache } from '../core/poolCache';

// ============================================================================
// DISCOVERY BACKOFF (Nov 1, PAIR_DISCOVERY_BACKOFF). Plain English: live, the
// free node refuses bursts ("exceeded maximum retry limit"), and every trade
// on a pair whose lookup had failed asked again at once and printed another
// "robinhood discovery failed" warning. Checks:
//   - a failed pair waits (30 s, doubling to 15 min) instead of retrying on
//     the next trade; a pair that never failed is looked up as before;
//   - one success clears the wait;
//   - warnings are grouped: the first of a kind at once (no node address in
//     it), then one summary line every 5 min with counts;
//   - PAIR_DISCOVERY_BACKOFF=0: exactly the old behaviour (retry at once,
//     one warning per failure).
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const T = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const ERR = 'exceeded maximum retry limit (request={  }, response={  }, error=null, info={ "requestUrl": "https://rpc.example.com/secret-key", "requestMethod": "POST" })';

// A watcher whose node lookups fail while `failing` is true; counts lookups.
function watcher() {
  const w = new PairWatcher('robinhood', {} as any, [], new PoolCache(), () => {}, {});
  const st = { calls: 0, failing: true };
  // Round-1 lookups (token symbol / decimals: no venues here): fail or answer "6 decimals".
  (w as any).discoveryCallMany = async (calls: unknown[]) => {
    st.calls++;
    if (st.failing) throw new Error(ERR);
    return calls.map(() => '0x' + '0'.repeat(63) + '6');
  };
  return { w, st };
}

async function main() {
  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
  try {
    assert(PairWatcher.failWaitMs(1) === 30_000 && PairWatcher.failWaitMs(2) === 60_000 && PairWatcher.failWaitMs(6) === 900_000 && PairWatcher.failWaitMs(50) === 900_000, 'wait: 30 s, doubling, at most 15 min');

    // ---- backoff on (default) ----
    delete process.env.PAIR_DISCOVERY_BACKOFF;
    const { w, st } = watcher();
    w.touch(T(1), T(2)); await settle();
    assert(st.calls === 1, 'first trade on a new pair: one lookup');
    assert(warns.length === 1 && warns[0].includes('robinhood discovery failed: exceeded maximum retry limit') && !warns[0].includes('rpc.example') && !warns[0].includes('secret'), `first failure: one short warning, no node address (${warns[0]})`);
    for (let i = 0; i < 25; i++) { w.touch(T(1), T(2)); await settle(); }
    assert(st.calls === 1 && warns.length === 1, `25 more trades on that pair while it waits: no lookup, no warning (lookups ${st.calls}, warnings ${warns.length})`);
    assert(w.failWaitCount() === 1, 'the pair is waiting');
    // Another pair that never failed is looked up at once, as before.
    w.touch(T(3), T(4)); await settle();
    assert(st.calls === 2, 'a different pair is not held back');
    assert(warns.length === 1, 'same kind of failure on another pair: counted, not printed again');
    // The wait is over: tried again; still failing -> waits longer.
    (w as any).failWait.get((w as any).key(T(1), T(2))).until = 0;
    w.touch(T(1), T(2)); await settle();
    assert(st.calls === 3, 'after the wait the pair is tried again');
    assert((w as any).failWait.get((w as any).key(T(1), T(2))).n === 2, 'second failure in a row: the wait doubles');
    // 5-minute summary.
    (w as any).failLogAt = Date.now() - 6 * 60_000;
    (w as any).failWait.get((w as any).key(T(3), T(4))).until = 0;
    w.touch(T(3), T(4)); await settle();
    const sum = warns.find((x) => x.includes('discovery failed') && x.includes('in the last'));
    assert(!!sum && /failed 4x in the last 6 min/.test(sum) && /exceeded maximum retry limit 4x/.test(sum) && /25 trade\(s\) did not retry/.test(sum) && !sum.includes('rpc.example'), `summary line with counts (${sum})`);
    // Success clears the wait.
    st.failing = false;
    (w as any).failWait.get((w as any).key(T(1), T(2))).until = 0;
    w.touch(T(1), T(2)); await settle();
    assert(!(w as any).failWait.has((w as any).key(T(1), T(2))), 'a lookup that worked clears the wait');

    // ---- backoff off: the old behaviour ----
    warns.length = 0;
    process.env.PAIR_DISCOVERY_BACKOFF = '0';
    const old = watcher();
    for (let i = 0; i < 3; i++) { old.w.touch(T(1), T(2)); await settle(); }
    assert(old.st.calls === 3 && warns.length === 3 && warns.every((x) => x.startsWith('[pairs] robinhood discovery failed:')), `PAIR_DISCOVERY_BACKOFF=0: retried on every trade, one warning each (lookups ${old.st.calls}, warnings ${warns.length})`);
    assert(old.w.failWaitCount() === 0, 'PAIR_DISCOVERY_BACKOFF=0: nothing waits');
  } finally {
    console.warn = realWarn;
    delete process.env.PAIR_DISCOVERY_BACKOFF;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
