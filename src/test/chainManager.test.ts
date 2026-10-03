import { ChainManager } from '../core/chainManager';
import { ChainCapability, RawChainEvent, PreparedTransaction, FireResult } from '../core/types';

// Proves the supervisor backs off on a FLAPPING chain (connects fine, dies
// seconds later) instead of reconnecting every 15s forever, clears backoff
// only after sustained health, and never runs two health cycles at once.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// A fake chain whose health we control by hand and that counts reconnects.
class FakeAdapter implements ChainCapability {
  readonly chain = 'monad' as const;
  readonly hasPendingMempool = false;
  readonly orderingModel = 'auction' as const;
  healthy = true;
  connectCalls = 0;
  connectShouldFail = false;
  connectDelayMs = 0;
  async connect() {
    this.connectCalls++;
    if (this.connectDelayMs) await new Promise((r) => setTimeout(r, this.connectDelayMs));
    if (this.connectShouldFail) throw new Error('nope');
    this.healthy = true;
  }
  async disconnect() {}
  onEvent(_h: (e: RawChainEvent) => void) {}
  async healthCheck() { return this.healthy ? { healthy: true } : { healthy: false, reason: 'socket died' }; }
  async fireTransaction(_tx: PreparedTransaction): Promise<FireResult> { throw new Error('unused'); }
}

// Silence the supervisor's own logging so test output stays readable.
const origWarn = console.warn, origErr = console.error, origLog = console.log;
function quiet<T>(fn: () => Promise<T>): Promise<T> {
  console.warn = () => {}; console.error = () => {};
  const restore = () => { console.warn = origWarn; console.error = origErr; console.log = origLog; };
  return fn().finally(restore);
}

async function main() {
  // ---------------------------------------------------------------------------
  // 1. Flapping: reconnect "succeeds" every time but dies before the next check.
  // ---------------------------------------------------------------------------
  let clock = 1_000_000;
  const cm = new ChainManager(() => clock);
  const a = new FakeAdapter();
  cm.register(a);
  await quiet(() => cm.startAll());

  // Simulate 10 minutes of a feed that dies every 15s, checked every 15s.
  for (let i = 0; i < 40; i++) {
    clock += 15_000;
    a.healthy = false;
    await quiet(() => cm.runHealthChecks());
  }
  // Old behaviour: ~40 reconnects (one every tick). Escalating backoff
  // (30s, 60s, 120s, 240s, 300s...) should cut that to a handful.
  assert(a.connectCalls <= 6, `flapping feed reconnects with backoff, not every tick (got ${a.connectCalls} reconnects in 10 min)`);
  assert((cm.getBackoff('monad')?.failCount ?? 0) >= 3, `flap streak is counted (failCount ${cm.getBackoff('monad')?.failCount})`);

  // ---------------------------------------------------------------------------
  // 2. Sustained health clears the backoff; a single good tick does not.
  // ---------------------------------------------------------------------------
  // Jump past any backoff window and let it reconnect cleanly.
  clock += 10 * 60_000;
  a.healthy = false;
  await quiet(() => cm.runHealthChecks()); // reconnects, a.healthy -> true
  clock += 15_000;
  await quiet(() => cm.runHealthChecks()); // one healthy tick
  assert(cm.getBackoff('monad') !== undefined, 'one healthy tick does NOT clear the backoff');
  for (let i = 0; i < 10; i++) { clock += 15_000; await quiet(() => cm.runHealthChecks()); }
  assert(cm.getBackoff('monad') === undefined, 'backoff clears after staying healthy 2+ minutes');
  assert(cm.isHealthy('monad'), 'chain reported healthy after recovering');

  // ---------------------------------------------------------------------------
  // 3. Hard failures still back off (reconnect throws).
  // ---------------------------------------------------------------------------
  const cm2 = new ChainManager(() => clock);
  const b = new FakeAdapter();
  b.healthy = false;
  b.connectShouldFail = true;
  cm2.register(b);
  for (let i = 0; i < 20; i++) { clock += 15_000; await quiet(() => cm2.runHealthChecks()); }
  assert(b.connectCalls <= 5, `failing reconnects back off (got ${b.connectCalls} attempts in 5 min)`);

  // ---------------------------------------------------------------------------
  // 4. Overlapping cycles: a slow reconnect must not get a second reconnect
  //    fired on top of it by the next interval tick.
  // ---------------------------------------------------------------------------
  const cm3 = new ChainManager(() => clock);
  const c = new FakeAdapter();
  c.healthy = false;
  c.connectDelayMs = 50;
  cm3.register(c);
  await quiet(() => Promise.all([cm3.runHealthChecks(), cm3.runHealthChecks(), cm3.runHealthChecks()]));
  assert(c.connectCalls === 1, `concurrent health cycles fire only one reconnect (got ${c.connectCalls})`);

  // ---------------------------------------------------------------------------
  // 5. A healthCheck that throws is treated as unhealthy, not a crash.
  // ---------------------------------------------------------------------------
  const cm4 = new ChainManager(() => clock);
  const d = new FakeAdapter();
  d.healthCheck = async () => { throw new Error('boom'); };
  d.connectShouldFail = true; // so the reconnect doesn't mask the result
  cm4.register(d);
  let threw = false;
  try { await quiet(() => cm4.runHealthChecks()); } catch { threw = true; }
  assert(!threw && !cm4.isHealthy('monad'), 'throwing healthCheck marks chain unhealthy without crashing');
}

main().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; });
