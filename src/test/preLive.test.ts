import { ethers } from 'ethers';
import { SafetyGate, FastSender, safetyConfigFromEnv, killSwitchOn } from '../execution/fastSender';

// Pre-live audit fixes: bad safety settings fail CLOSED, kill switch accepts
// common spellings, trade deadlines use the estimated CURRENT block, and two
// fires at once never reuse a nonce.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

async function main() {
  // --- safety settings ---------------------------------------------------
  const badCfg = safetyConfigFromEnv({ MAX_TRADE_USD: '5,000', DAILY_LOSS_CAP_USD: '25', MAX_SENDS_PER_MIN: 'six' });
  const gate = new SafetyGate({ ...badCfg, killFile: '/nonexistent/KILL' });
  gate.allowTokens(['0xa', '0xb']);
  const r = gate.check({ tradeSizeUsd: 1e9, tokens: ['0xa', '0xb'] });
  assert(!r.ok && 'reason' in r && /bad safety setting/.test(r.reason), 'mistyped limits block every send instead of switching limits off');
  assert(gate.problems.length === 2, 'both bad settings are named');
  const good = new SafetyGate({ ...safetyConfigFromEnv({}), killFile: '/nonexistent/KILL' });
  assert(good.problems.length === 0, 'defaults are valid');
  assert(killSwitchOn('ON') && killSwitchOn('true') && killSwitchOn('1') && killSwitchOn(' yes ') && !killSwitchOn('off') && !killSwitchOn(undefined), 'kill switch accepts on/true/1/yes in any case');

  // --- deadline block ----------------------------------------------------
  let blockNo = 1_000;
  const fake = {
    getBlock: async () => ({ number: blockNo, baseFeePerGas: 10_000_000n }),
    getFeeData: async () => ({}),
    getTransactionCount: async () => 7,
    call: async () => { throw new Error('no NodeInterface in tests'); },
    getBalance: async () => 0n,
  } as unknown as ethers.JsonRpcProvider;
  const dry = new FastSender(fake, 4663);
  assert(dry.deadlineBlock() === null, 'no block seen yet -> no deadline (do not send)');
  await dry.start(); dry.stop();
  const t = Date.now();
  const d0 = dry.deadlineBlock(20, t);
  assert(d0 === 1_020n, `fresh read: deadline = block + margin (got ${d0})`);
  const d1 = dry.deadlineBlock(20, t + 1_500);
  const dDefault = dry.deadlineBlock(undefined, t);
  assert(dDefault !== null && dDefault >= 1_050n, `default margin is time-based, ~3 s of blocks (got ${dDefault})`);
  assert(d1 !== null && d1 >= 1_030n, `1.5 s later the estimate moves forward with the block time (got ${d1})`);
  assert(dry.deadlineBlock(20, t + 11_000) === null, 'block info older than 10 s -> no deadline');

  // --- nonce: concurrent fires, one rejected ------------------------------
  // Throwaway key generated here, only to make the sender "live" against a
  // fake endpoint. Nothing leaves this process.
  const testKey = ethers.Wallet.createRandom().privateKey;
  process.env.EXECUTION_ENABLED = 'true';
  process.env.LIVE_SEND_CONFIRM = 'yes-real-money';
  process.env.BOT_PRIVATE_KEY = testKey;
  const seen: number[] = [];
  let calls = 0;
  const sendProv = {
    send: async (_m: string, [raw]: [string]) => {
      const tx = ethers.Transaction.from(raw);
      seen.push(tx.nonce);
      calls++;
      await new Promise((res) => setTimeout(res, 5));
      if (calls === 2) throw new Error('some transient send error');
      return tx.hash;
    },
  } as unknown as ethers.JsonRpcProvider;
  // Read node lags: still says 7 even after sends.
  const live = new FastSender(fake, 4663, sendProv);
  delete process.env.EXECUTION_ENABLED; delete process.env.LIVE_SEND_CONFIRM; delete process.env.BOT_PRIVATE_KEY;
  assert(live.live, 'test sender is live (fake endpoint)');
  await live.start(); live.stop();
  const results = await Promise.all([1, 2, 3, 4].map(() => live.fire('0x' + '11'.repeat(20), '0x1234')));
  const sentOk = results.filter((x) => x.txHash).map((_, i) => i);
  const okNonces = seen.filter((_, i) => i !== 1);
  assert(new Set(okNonces).size === okNonces.length, `no two accepted sends share a nonce (nonces tried: ${seen.join(',')})`);
  assert(seen[0] === 7 && seen[1] === 8 && seen[2] === 8 && seen[3] === 9, 'failed send\'s nonce is reused next, never skipped or doubled');
  assert(sentOk.length === 3, '3 of 4 sends accepted');
}
main().catch((e) => { console.error('FAIL: crashed', e); process.exitCode = 1; });
