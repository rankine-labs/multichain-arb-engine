// Avalanche adapter: refuses to "connect" with no endpoints configured, and
// no longer reports healthy when it has never received a pending tx.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

async function main() {
  // No endpoints in the environment -> placeholders -> clear error.
  delete process.env.AVALANCHE_ALCHEMY_WSS;
  delete process.env.AVALANCHE_QUICKNODE_WSS;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { AvalancheAdapter } = require('../chains/avalanche');
  const origLog = console.log, origWarn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    const a = new AvalancheAdapter();
    let err = '';
    try { await a.connect(); } catch (e: any) { err = String(e?.message); }
    console.log = origLog; console.warn = origWarn;
    assert(/not configured/.test(err), 'no endpoints -> "Avalanche not configured" error, not a silent bad connection');

    // Connected over a minute ago, zero pending txs -> unhealthy.
    (a as any).connectedAtMs = Date.now() - 61_000;
    (a as any).lastEventAtMs = 0;
    (a as any).lastCountLogAtMs = Date.now();
    const h = await a.healthCheck();
    assert(!h.healthy && /no pending transactions/.test(h.reason ?? ''), 'connected but silent for 60s -> unhealthy (was reported healthy forever)');

    // Within the first minute, give it time.
    (a as any).connectedAtMs = Date.now() - 10_000;
    assert((await a.healthCheck()).healthy, 'first minute after connecting -> still healthy (grace period)');

    // Receiving events -> healthy.
    (a as any).connectedAtMs = Date.now() - 120_000;
    (a as any).lastEventAtMs = Date.now() - 1_000;
    assert((await a.healthCheck()).healthy, 'recent pending txs -> healthy');
  } finally {
    console.log = origLog; console.warn = origWarn;
  }
}

main().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; });
