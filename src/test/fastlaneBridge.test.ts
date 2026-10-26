import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ethers } from 'ethers';
import {
  fastlaneModeFromEnv, buildFastlaneState, FastlaneStateWriter, FastlaneSendsFollower, parseSendLine, pairRows, routePairs,
  StateSources, RustSendRecord,
} from '../execution/fastlaneBridge';
import { FastSender, RUST_IS_SENDER, rustSenderOn, SafetyGate } from '../execution/fastSender';
import { LiveTradeTracker } from '../execution/liveTracker';
import { LiveTradeLog } from '../execution/liveTradeLog';
import { LiveRouteBlock } from '../core/routeScore';

// Fast lane bridge (Node side): FASTLANE parsing, the state file Rust reads,
// the follower of Rust's send log (live record -> tracked like our own send;
// practice -> only counted), and RUST_SENDER=on stopping every Node broadcast
// at the one lowest-level send point (fastSender).

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const dir = mkdtempSync(join(tmpdir(), 'fastlane-'));

// ---- mode parsing -----------------------------------------------------------
assert(fastlaneModeFromEnv({}) === 'off', 'FASTLANE unset = off');
assert(fastlaneModeFromEnv({ FASTLANE: ' Practice ' }) === 'practice' && fastlaneModeFromEnv({ FASTLANE: 'live' }) === 'live', 'practice / live parsed');
assert(fastlaneModeFromEnv({ FASTLANE: 'liev' }) === 'off', 'unknown value = off');
assert(!rustSenderOn({}) && rustSenderOn({ RUST_SENDER: 'on' }) && rustSenderOn({ RUST_SENDER: 'YES' }) && !rustSenderOn({ RUST_SENDER: 'off' }), 'RUST_SENDER on/off values');

// ---- state file -------------------------------------------------------------
const NOW = Date.parse('2026-10-26T12:00:00Z');
const gate = new SafetyGate({ maxTradeUsd: 20_000, dailyLossCapUsd: 25, maxSendsPerMinute: 6, killFile: join(dir, 'KILL') }, () => NOW);
gate.allowTokens(['0xAAA', '0xBBB']);
gate.recordLoss(3);
gate.reservePending('0xh', 0.5);
const fails = new LiveRouteBlock(30 * 60_000, () => NOW);
fails.block('0xP1', '0xP2', 'failed');
const sources = (over: Partial<StateSources> = {}): StateSources => ({
  now: () => NOW,
  lossTodayUsd: () => gate.lossTodayUsd(),
  lossWithPendingUsd: () => gate.lossTodayUsd(true),
  limits: () => ({ maxTradeUsd: 20_000, dailyLossCapUsd: 25, maxSendsPerMin: 6, minNetUsd: 0.25, autoVetMaxTradeUsd: 300, loopMaxTradeUsd: 10_000, loopLossCapUsd: 2 }),
  problems: () => [],
  allowlist: () => gate.allowedTokens(),
  autoVetted: () => ['0xBBB'],
  liveBlocks: () => [],
  failBlocks: () => pairRows(fails.entries(), NOW),
  livePools: () => ['0xP1', '0xP2'],
  paused: () => ({ gap: null, loop: null }),
  loopLossUsd: () => 0.1,
  loopPaused: () => false,
  liveReady: () => true,
  liveProblems: () => [],
  approvedLenders: () => ['0xL'],
  ownMoney: () => ({ readMs: NOW - 5_000, balances: { '0xAAA': 123n } }),
  killed: () => false,
  followedMs: () => 42,
  ...over,
});
const st = buildFastlaneState(sources());
assert(st.writtenMs === NOW && st.lossDay === '2026-10-26', 'written time and UTC loss day');
assert(st.lossUsd === 3 && Math.abs(st.pendingUsd - 0.5) < 1e-9, 'loss today and gas held for sends in flight');
assert(st.allowlist.includes('0xaaa') && st.allowlist.includes('0xbbb') && st.autoVetted[0] === '0xbbb', 'allowlist and auto-vetted coins, lowercase');
assert(st.failBlocks.length === 2 && st.failBlocks.some((r) => r[0] === '0xp1' && r[1] === '0xp2' && r[2] === NOW + 30 * 60_000), 'pair blocks with expiry, both directions');
assert(st.ownMoney.balances['0xaaa'] === '123' && st.ownMoney.readMs === NOW - 5_000, 'own money as decimal strings');
assert(st.followedMs === 42 && st.liveReady && st.livePools[0] === '0xp1', 'followed mark, readiness, live pools');
const broken = buildFastlaneState(sources({ lossTodayUsd: () => { throw new Error('x'); }, allowlist: () => { throw new Error('x'); }, killed: () => { throw new Error('x'); } }));
assert(broken.lossUsd >= 1e9 && broken.problems.includes('loss figure unreadable'), 'unreadable loss -> blocks (huge loss + problem), never "nothing lost"');
assert(broken.allowlist.length === 0 && broken.killed, 'a failing source gives the SAFE value (empty allowlist, killed)');

const stateFile = join(dir, 'fastlane-state.json');
const writer = new FastlaneStateWriter(stateFile, sources());
assert(writer.writeNow() && !existsSync(stateFile + '.tmp'), 'state file written via temp file + rename');
const back = JSON.parse(readFileSync(stateFile, 'utf8'));
assert(back.v === 1 && back.lossUsd === 3 && Array.isArray(back.failBlocks), 'state file is the JSON Rust reads (camelCase)');

// ---- sends follower ---------------------------------------------------------
const sendsFile = join(dir, 'fastlane-sends.jsonl');
const rec = (over: Partial<RustSendRecord>): RustSendRecord => ({
  t: NOW, mode: 'practice', label: 'USDG/X a>b', block: 1, tokenIn: '0xaaa', amountIn: '1000', sizeUsd: 500, expectedNetUsd: 1.2, gasUsd: 0.02,
  pools: ['0xP1', '0xP2'], kinds: [1, 2], totalUs: 12_000, timingsUs: { sign: 300 }, ...over,
});
assert(parseSendLine('{bad') === null && parseSendLine(JSON.stringify(rec({}))) !== null, 'bad lines skipped, good ones parsed');

// The follower's live hook does what shadowMain does: the bot's own tracker + log.
const losses: number[] = [];
const liveLogFile = join(dir, 'live-trades.jsonl');
const liveLog = new LiveTradeLog(liveLogFile, 2_000_000, () => NOW, 0);
const receipts = new Map<string, unknown>();
const tracker = new LiveTradeTracker({
  provider: { getTransactionReceipt: async (h: string) => receipts.get(h) ?? null } as any,
  ethUsd: () => 3000, tokenUsd: () => null,
  recordLoss: (u) => { gate.recordLoss(u); losses.push(u); },
  noteGasUsed: () => {}, notify: () => {}, pollMs: 5, timeoutMs: 2_000,
  onSettled: (h) => gate.releasePending(h),
  onResult: (r) => liveLog.result(r),
});
const tracked: string[] = [], failed: string[] = [], practice: RustSendRecord[] = [];
const follower = new FastlaneSendsFollower(sendsFile, {
  onLiveSent: (r) => { tracked.push(r.hash!); liveLog.sent(r.hash!, `rust ${r.label}`, r.sizeUsd, r.expectedNetUsd, { kind: 'own' }, 'rust'); gate.reservePending(r.hash!, 2 * r.gasUsd); tracker.track(r.hash!, { expectedProfitUsd: r.expectedNetUsd, label: `rust ${r.label}`, sizeUsd: r.sizeUsd }); },
  onLiveSendFailed: (r) => { failed.push(r.error ?? ''); liveLog.sendFailed(`rust ${r.label}`, r.sizeUsd, r.error ?? '', 'rust'); },
  onPractice: (r) => practice.push(r),
}, join(dir, 'fastlane-follow.json'), () => NOW + 1_000);

async function main() {
  const hash = '0x' + 'ab'.repeat(32);
  appendFileSync(sendsFile, JSON.stringify(rec({ t: NOW + 1, mode: 'practice' })) + '\n');
  appendFileSync(sendsFile, JSON.stringify(rec({ t: NOW + 2, mode: 'live', hash })) + '\n');
  appendFileSync(sendsFile, JSON.stringify(rec({ t: NOW + 3, mode: 'live', error: 'nonce too low' })) + '\n');
  appendFileSync(sendsFile, '{"t":'); // half a line: waits for the rest
  assert(follower.poll() === 3, 'three complete records handled');
  assert(practice.length === 1 && tracked.length === 1 && tracked[0] === hash && failed[0] === 'nonce too low', 'practice counted only; live hash tracked; refused send logged');
  assert(Math.abs(gate.lossTodayUsd(true) - (3 + 0.5 + 0.04)) < 1e-9, 'live Rust send holds 2x gas against the daily loss cap (like our own)');
  assert(follower.followedMs === NOW + 3, 'followed mark moves to the newest record');
  appendFileSync(sendsFile, `${NOW + 4},"mode":"practice","label":"x","pools":[],"totalUs":20000}\n`);
  assert(follower.poll() === 1 && practice.length === 2, 'the rest of a half-written line is read on the next poll');

  // Receipt: reverted -> gas charged to the loss cap, result line says src rust.
  receipts.set(hash, { status: 0, gasUsed: 200_000n, gasPrice: 10_000_000n, logs: [] });
  await new Promise((r) => setTimeout(r, 40));
  assert(losses.length === 1 && Math.abs(losses[0] - 0.006) < 1e-9, 'Rust send result goes into the daily loss cap');
  liveLog.stop();
  const lines = readFileSync(liveLogFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const sent = lines.find((l) => l.kind === 'sent'), res = lines.find((l) => l.kind === 'result'), sf = lines.find((l) => l.kind === 'send_failed');
  assert(sent?.src === 'rust' && res?.src === 'rust' && res?.status === 'reverted' && sf?.src === 'rust', 'live-trades.jsonl: sent / result / send_failed carry "src":"rust"');
  assert(Math.abs(gate.lossTodayUsd(true) - (3 + 0.006 + 0.5)) < 1e-9, 'pending hold released when the receipt arrived');

  // Restart: a new follower continues after the saved mark (nothing counted twice).
  const tracked2: string[] = [];
  const f2 = new FastlaneSendsFollower(sendsFile, { onLiveSent: (r) => tracked2.push(r.hash!), onLiveSendFailed: () => {} }, join(dir, 'fastlane-follow.json'));
  assert(f2.followedMs === NOW + 4 && f2.poll() === 0 && tracked2.length === 0, 'restart: already-handled records are not handled again');

  // Rotation: Rust renames the file to .1 and starts a new one; nothing is missed.
  appendFileSync(sendsFile, JSON.stringify(rec({ t: NOW + 5 })) + '\n');
  renameSync(sendsFile, sendsFile + '.1');
  writeFileSync(sendsFile, JSON.stringify(rec({ t: NOW + 6 })) + '\n');
  assert(f2.poll() === 2, 'after rotation: the end of the old file and the new file are both read');
  const hl = follower.hourLine(true);
  assert(/practice would send 2/.test(hl) && /feed -> send p50 [\d.]+ ms, p90 20\.0 ms/.test(hl) && /live sent 1/.test(hl), `hourly line: ${hl}`);

  assert(routePairs(['A', 'B']).length === 1 && routePairs(['a', 'b', 'c']).map((p) => p.join('>')).join(',') === 'a>b,b>c,c>a', 'route pairs (loops close back to the start)');

  // ---- RUST_SENDER=on: Node never broadcasts (lowest level) -----------------
  const keyWallet = ethers.Wallet.createRandom();
  const env = { ...process.env };
  process.env.EXECUTION_ENABLED = 'true';
  process.env.LIVE_SEND_CONFIRM = 'yes-real-money';
  process.env.BOT_PRIVATE_KEY = keyWallet.privateKey;
  process.env.RUST_SENDER = 'on';
  let sends = 0;
  const read = { getBlock: async () => ({ number: 10, baseFeePerGas: 10_000_000n }), getFeeData: async () => ({}), getTransactionCount: async () => 7, call: async () => '0x' } as unknown as ethers.JsonRpcProvider;
  const sendP = { send: async (m: string) => { if (m === 'eth_sendRawTransaction') sends++; return '0x' + '11'.repeat(32); } } as unknown as ethers.JsonRpcProvider;
  for (const parallel of [false, true]) {
    const s = new FastSender(read, 4663, sendP, 1_500_000n, { parallel, log: () => {} });
    await s.start();
    const r = await s.fire('0x' + '22'.repeat(20), '0x1234');
    const r2 = await s.fire('0x' + '22'.repeat(20), '0x1234');
    s.stop();
    assert(s.live && s.rustIsSender, `(${parallel ? 'parallel' : 'one at a time'}) sender is live but Rust is the sender`);
    assert(sends === 0 && !r.txHash && r.skipped === RUST_IS_SENDER && r.error === RUST_IS_SENDER && r.signMs >= 0 && r2.skipped === RUST_IS_SENDER, `(${parallel ? 'parallel' : 'one at a time'}) RUST_SENDER=on: nothing broadcast, "${RUST_IS_SENDER}"`);
  }
  // Same settings, RUST_SENDER off: it broadcasts as before.
  process.env.RUST_SENDER = 'off';
  const s3 = new FastSender(read, 4663, sendP, 1_500_000n, { log: () => {} });
  await s3.start();
  const r3 = await s3.fire('0x' + '22'.repeat(20), '0x1234');
  s3.stop();
  assert(sends === 1 && !!r3.txHash && !r3.skipped && r3.nonce === 7, 'RUST_SENDER=off: Node broadcasts exactly as before');
  process.env = env;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
