import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ethers } from 'ethers';
import { SafetyGate, FastSender } from '../execution/fastSender';

// Checks the safety gate (kill switch, size cap, daily loss cap, rate limit,
// token allowlist) and that the sender is dry-run by default and signs fast.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  let clock = Date.parse('2026-10-04T12:00:00Z');
  const gate = new SafetyGate({ maxTradeUsd: 5000, dailyLossCapUsd: 25, maxSendsPerMinute: 2, killFile: join(dir, 'KILL') }, () => clock);
  const trade = { tradeSizeUsd: 1000, tokens: ['0xAAA', '0xBBB'] };

  assert(!gate.check(trade).ok, 'tokens not on the allowlist are refused');
  gate.allowTokens(['0xaaa', '0xbbb']);
  assert(gate.check(trade).ok, 'vetted tokens, normal size -> allowed');
  assert(!gate.check({ ...trade, tradeSizeUsd: 6000 }).ok, 'over max size -> refused');
  assert(gate.check(trade).ok && !gate.check(trade).ok, 'send rate limit kicks in');
  clock += 61_000;
  gate.recordLoss(30);
  const capped = gate.check(trade);
  assert(!capped.ok && 'reason' in capped && /loss cap/.test(capped.reason), 'daily loss cap stops sending');
  clock += 24 * 3600_000;
  assert(gate.check(trade).ok, 'loss cap resets the next day');
  writeFileSync(join(dir, 'KILL'), '');
  assert(!gate.check(trade).ok, 'kill switch file stops everything');

  // Sender: dry run by default even with EXECUTION_ENABLED set.
  process.env.EXECUTION_ENABLED = 'true';
  delete process.env.LIVE_SEND_CONFIRM;
  const fake = { getBlock: async () => ({ baseFeePerGas: 10_000_000n }), getFeeData: async () => ({}), getTransactionCount: async () => 7 } as unknown as ethers.JsonRpcProvider;
  const sender = new FastSender(fake, 4663);
  assert(!sender.live, 'dry run unless LIVE_SEND_CONFIRM and BOT_PRIVATE_KEY are also set');
  await sender.start();
  const runs: number[] = [];
  let r;
  for (let i = 0; i < 20; i++) { r = await sender.fire('0x' + '11'.repeat(20), '0x2448659a' + '00'.repeat(600)); runs.push(r.signMs); }
  sender.stop();
  runs.sort((a, b) => a - b);
  assert(r!.live === false && !r!.txHash, 'dry run never broadcasts');
  assert(runs[10] < 20, `build + sign is fast (median ${runs[10].toFixed(2)} ms)`);
}
main().catch((e) => { console.error('FAIL: crashed', e); process.exitCode = 1; });
