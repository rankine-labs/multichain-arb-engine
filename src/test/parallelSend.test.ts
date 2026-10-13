import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ethers } from 'ethers';
import { FastSender, SafetyGate, parallelSendFromEnv, FireResult } from '../execution/fastSender';

// SPEED_PARALLEL_SEND: the next fire no longer waits for the previous send's
// reply. Nonces are taken in strict order at sign time; a failed send pauses
// new signing until the nonce is re-synced. Nothing here sends anything real:
// a fake "sequencer" below plays the chain (throwaway test key).

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TO = '0x' + '11'.repeat(20);

// Fake Nitro-style sequencer (first come, first served):
//   - a tx is judged when it ARRIVES (the moment send() is called); the
//     reply comes back after a per-call delay (slow network = slow reply)
//   - exact next nonce: accepted; lower: "nonce too low"
//   - higher (a gap): held up to holdMs for the missing one (like Nitro's
//     short nonce-gap queue), then refused with "nonce too high"
//   - scripted failures (consumed in arrival order) are refused at arrival
class FakeChain {
  nonce = 7;                         // wallet's next nonce on chain
  accepted: number[] = [];           // nonces that made it in, in order
  attempts: number[] = [];           // every nonce we were asked to send (arrival order)
  delays: number[] = [];             // reply delay per call (ms), default 5
  failNext: string[] = [];           // scripted refusals for the next arrivals ('' = no failure)
  acceptButError = false;            // next accepted tx replies with an error (e.g. timed out after it got in)
  holdMs = 60;
  countGate: Promise<void> | null = null; // when set, nonce reads wait on it (to catch a re-sync in the act)
  private held = new Map<number, () => void>();
  readProvider(): ethers.JsonRpcProvider {
    return {
      getBlock: async () => ({ number: 1_000, baseFeePerGas: 10_000_000n }),
      getFeeData: async () => ({}),
      getTransactionCount: async () => { if (this.countGate) await this.countGate; return this.nonce; },
      call: async () => { throw new Error('no NodeInterface in tests'); },
      getBalance: async () => 0n,
    } as unknown as ethers.JsonRpcProvider;
  }
  private accept(n: number) {
    this.nonce++;
    this.accepted.push(n);
    const next = this.held.get(this.nonce);
    if (next) { this.held.delete(this.nonce); next(); }
  }
  // Judge a tx on arrival. Resolves to null (accepted) or an error message.
  private arrive(n: number): Promise<string | null> {
    const scripted = this.failNext.shift();
    if (scripted) return Promise.resolve(scripted);
    if (n < this.nonce) return Promise.resolve('nonce too low');
    if (n === this.nonce) { this.accept(n); return Promise.resolve(null); }
    return new Promise((res) => {
      const t = setTimeout(() => { this.held.delete(n); res('nonce too high'); }, this.holdMs);
      this.held.set(n, () => { clearTimeout(t); this.accept(n); res(null); });
    });
  }
  sendProvider(): ethers.JsonRpcProvider {
    return {
      send: async (_m: string, [raw]: [string]) => {
        const tx = ethers.Transaction.from(raw);
        const i = this.attempts.length;
        this.attempts.push(tx.nonce);
        const outcome = this.arrive(tx.nonce);
        const [err] = await Promise.all([outcome, sleep(this.delays[i] ?? 5)]);
        if (err) throw new Error(err);
        if (this.acceptButError) { this.acceptButError = false; throw new Error('request timed out'); }
        return tx.hash;
      },
    } as unknown as ethers.JsonRpcProvider;
  }
}

// A live sender against the fake chain (env only set while constructing).
async function liveSender(chain: FakeChain, parallel: boolean, logs: string[] = []): Promise<FastSender> {
  process.env.EXECUTION_ENABLED = 'true';
  process.env.LIVE_SEND_CONFIRM = 'yes-real-money';
  process.env.BOT_PRIVATE_KEY = ethers.Wallet.createRandom().privateKey;
  const s = new FastSender(chain.readProvider(), 4663, chain.sendProvider(), undefined, { parallel, log: (l) => logs.push(l) });
  delete process.env.EXECUTION_ENABLED; delete process.env.LIVE_SEND_CONFIRM; delete process.env.BOT_PRIVATE_KEY;
  await s.start(); s.stop();
  return s;
}
const nonceOf = (r: FireResult) => r.nonce;

async function main() {
  assert(!parallelSendFromEnv({}) && parallelSendFromEnv({ SPEED_PARALLEL_SEND: '1' }), 'SPEED_PARALLEL_SEND is OFF unless set to 1');

  // 1. N quick fires get consecutive, unique nonces (in call order).
  {
    const chain = new FakeChain();
    const s = await liveSender(chain, true);
    assert(s.live && s.parallel, 'test sender is live + parallel (fake chain)');
    const rs = await Promise.all([0, 1, 2, 3, 4].map(() => s.fire(TO, '0x1234')));
    assert(JSON.stringify(rs.map(nonceOf)) === '[7,8,9,10,11]', `5 quick fires -> nonces 7..11 in call order (got ${rs.map(nonceOf)})`);
    assert(rs.every((r) => r.txHash) && JSON.stringify(chain.accepted) === '[7,8,9,10,11]', 'all 5 accepted, no gaps, no reuse');
  }

  // 2. A slow send does not delay the next sign.
  {
    const chain = new FakeChain();
    chain.delays = [300, 5];
    const s = await liveSender(chain, true);
    const first = s.fire(TO, '0x01');
    await sleep(10);
    const t = Date.now();
    const second = s.fire(TO, '0x02');
    const r2 = await second;
    const r1 = await first;
    assert(r2.signedAtMs! - t < 100, `second trade signed ${r2.signedAtMs! - t} ms after it was asked for, while the first send was still waiting (300 ms)`);
    assert((r2.queueMs ?? 999) < 50, `second trade's queue wait ${r2.queueMs?.toFixed(1)} ms (not ~300)`);
    assert(r1.nonce === 7 && r2.nonce === 8 && !!r1.txHash && !!r2.txHash, 'both accepted with nonces 7 and 8');

    // Same thing in one-at-a-time mode: the second waits for the first send.
    const chain2 = new FakeChain();
    chain2.delays = [300, 5];
    const s2 = await liveSender(chain2, false);
    const f1 = s2.fire(TO, '0x01');
    await sleep(10);
    const r2b = await s2.fire(TO, '0x02');
    await f1;
    assert((r2b.queueMs ?? 0) > 200, `one-at-a-time mode (switch off) still waits for the previous send (queue ${r2b.queueMs?.toFixed(0)} ms): unchanged`);
  }

  // 3. A failed send pauses signing and re-syncs, without duplicate nonces.
  {
    const chain = new FakeChain();
    const logs: string[] = [];
    chain.delays = [5, 30, 40, 40];         // nonce 8's send fails; 9 and 10 are already on their way
    chain.failNext = ['', 'some transient send error'];
    const s = await liveSender(chain, true, logs);
    const batch1 = await Promise.all([0, 1, 2, 3].map(() => s.fire(TO, '0x1234')));
    assert(JSON.stringify(batch1.map(nonceOf)) === '[7,8,9,10]', 'first batch took 7..10 in order');
    assert(!!batch1[0].txHash && !batch1[1].txHash, 'nonce 7 accepted, nonce 8 failed');
    assert(!batch1[2].txHash && !batch1[3].txHash, 'nonces 9 and 10 refused by the sequencer (gap at 8)');
    assert(logs.length === 1 && /next nonce 8/.test(logs[0]), `ONE re-sync for the whole burst, logged (${logs.join(' | ')})`);
    // Fires during a re-sync wait for it; then carry on from the right nonce.
    const batch2 = await Promise.all([0, 1, 2].map(() => s.fire(TO, '0x1234')));
    assert(JSON.stringify(batch2.map(nonceOf)) === '[8,9,10]' && batch2.every((r) => r.txHash), `after the re-sync: 8, 9, 10 accepted (got ${batch2.map(nonceOf)})`);
    assert(JSON.stringify(chain.accepted) === '[7,8,9,10]', `chain got 7,8,9,10 exactly once each (got ${chain.accepted})`);

    // Re-sync really pauses: a fire asked for DURING the re-sync is not
    // signed or sent until the re-sync has finished.
    const chain3 = new FakeChain();
    const s3 = await liveSender(chain3, true);
    let release: () => void = () => {};
    chain3.countGate = new Promise<void>((r) => { release = r; }); // hold the re-sync's nonce read
    chain3.failNext = ['boom'];
    const a = s3.fire(TO, '0x01');              // refused -> re-sync starts, waits on the gate
    await sleep(30);
    assert(s3.resyncing, 'a failed send starts a re-sync');
    const b = s3.fire(TO, '0x02');
    await sleep(30);
    assert(chain3.attempts.length === 1, 'a fire asked for during the re-sync waits (nothing signed/sent yet)');
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert(!ra.txHash && rb.nonce === 7 && !!rb.txHash, `after the re-sync it re-uses the failed nonce 7 (got ${rb.nonce})`);
  }

  // 4. A send that "failed" but actually got in (e.g. timed out after the
  //    sequencer took it): a LATER accepted nonce proves it, so neither is reused.
  {
    const chain = new FakeChain();
    const logs: string[] = [];
    chain.acceptButError = true;            // nonce 7 gets in, but we see an error
    chain.delays = [5, 30];                 // ...and nonce 8 is still on its way when that error arrives
    const s = await liveSender(chain, true, logs);
    const rs = await Promise.all([s.fire(TO, '0x01'), s.fire(TO, '0x02')]);
    assert(!rs[0].txHash && !!rs[1].txHash, 'nonce 7 reported an error, nonce 8 accepted');
    const r3 = await s.fire(TO, '0x03');
    assert(r3.nonce === 9 && !!r3.txHash, `next nonce is 9: never re-uses 7 or 8 (got ${r3.nonce})`);
    assert(new Set(chain.accepted).size === chain.accepted.length, `no nonce accepted twice (${chain.accepted})`);
  }

  // 5. "nonce too low" (already used elsewhere) moves past it; a dropped trade resyncs to the chain.
  {
    const chain = new FakeChain();
    const s = await liveSender(chain, true);
    chain.nonce = 9;                        // two nonces used outside this sender (read node lag etc.)
    const r = await s.fire(TO, '0x01');     // tries 7 -> too low -> re-sync
    assert(!r.txHash && /too low/.test(r.error ?? ''), 'stale nonce refused as too low');
    const r2 = await s.fire(TO, '0x02');
    assert(r2.nonce === 9 && !!r2.txHash, `re-sync jumps to the chain's count, 9 (got ${r2.nonce})`);
    const r3 = await s.fire(TO, '0x03');
    assert(r3.nonce === 10 && !!r3.txHash, 'then 10');
    // Dropped trade: nonce 10 was never mined after all (the chain count goes
    // back to 10). resyncNonce follows the chain, like the one-at-a-time mode.
    chain.nonce = 10; chain.accepted.pop();
    await s.resyncNonce();
    const r4 = await s.fire(TO, '0x04');
    assert(r4.nonce === 10 && !!r4.txHash, `after a dropped trade its nonce is used again (got ${r4.nonce})`);
  }

  // 6. Safety gates still block BEFORE any signing (same order as shadowMain's fireTrade).
  {
    const dir = mkdtempSync(join(tmpdir(), 'par-'));
    const gate = new SafetyGate({ maxTradeUsd: 5_000, dailyLossCapUsd: 25, maxSendsPerMinute: 3, killFile: join(dir, 'KILL') });
    gate.allowTokens(['0xa', '0xb']);
    const chain = new FakeChain();
    const s = await liveSender(chain, true);
    const tryFire = async (g: SafetyGate) => { const ok = g.check({ tradeSizeUsd: 100, tokens: ['0xa', '0xb'] }); return ok.ok ? s.fire(TO, '0x01') : null; };
    const burst = await Promise.all([0, 1, 2, 3, 4].map(() => tryFire(gate)));
    assert(burst.filter((r) => r?.txHash).length === 3 && chain.attempts.length === 3, 'MAX_SENDS_PER_MIN (3 here) still caps a parallel burst');
    const capGate = new SafetyGate({ maxTradeUsd: 5_000, dailyLossCapUsd: 1, maxSendsPerMinute: 100, killFile: join(dir, 'KILL') });
    capGate.allowTokens(['0xa', '0xb']);
    const two = await Promise.all([tryFire(capGate), tryFire(capGate)]);
    for (const r of two) if (r?.txHash) capGate.reservePending(r.txHash, 0.6); // 2 x $0.60 in flight = over the $1 cap
    const capped = await tryFire(capGate);
    assert(two.every((r) => r?.txHash) && capped === null && chain.attempts.length === 5, 'daily loss cap (in-flight gas included) still blocks the next fire');
    const gate2 = new SafetyGate({ maxTradeUsd: 5_000, dailyLossCapUsd: 25, maxSendsPerMinute: 100, killFile: join(dir, 'KILL') });
    gate2.allowTokens(['0xa', '0xb']);
    writeFileSync(join(dir, 'KILL'), '');
    assert(!gate2.check({ tradeSizeUsd: 100, tokens: ['0xa', '0xb'] }).ok, 'kill switch still blocks');
  }

  // 7. Practice mode (dry run): equivalent to before. Never sends, same nonce every time.
  {
    process.env.EXECUTION_ENABLED = 'true';
    delete process.env.LIVE_SEND_CONFIRM;
    const chain = new FakeChain();
    const dryPar = new FastSender(chain.readProvider(), 4663, chain.sendProvider(), undefined, { parallel: true });
    const drySeq = new FastSender(chain.readProvider(), 4663, chain.sendProvider(), undefined, { parallel: false });
    delete process.env.EXECUTION_ENABLED;
    await dryPar.start(); dryPar.stop(); await drySeq.start(); drySeq.stop();
    const a = await Promise.all([0, 1, 2].map(() => dryPar.fire(TO, '0x01')));
    const b = await Promise.all([0, 1, 2].map(() => drySeq.fire(TO, '0x01')));
    assert(a.every((r) => !r.live && !r.txHash && r.signedAtMs) && b.every((r) => !r.live && !r.txHash), 'dry run: signed, never sent, in both modes');
    assert(chain.attempts.length === 0, 'dry run: nothing reached the send endpoint');
  }
}
main().catch((e) => { console.error('FAIL: crashed', e); process.exitCode = 1; });
