import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ethers } from 'ethers';
import {
  fastlaneModeFromEnv, buildFastlaneState, FastlaneStateWriter, FastlaneSendsFollower, parseSendLine, pairRows, practiceHourSummary, routePairs,
  StateSources, RustSendRecord, RustSendStats,
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
  ackSeq: () => 42,
  rustSender: () => true,
  dropsSeen: () => 2,
  maxGasUsed: () => 910_000,
  ...over,
});
const st = buildFastlaneState(sources());
assert(st.writtenMs === NOW && st.lossDay === '2026-10-26', 'written time and UTC loss day');
assert(st.lossUsd === 3 && Math.abs(st.pendingUsd - 0.5) < 1e-9, 'loss today and gas held for sends in flight');
assert(st.allowlist.includes('0xaaa') && st.allowlist.includes('0xbbb') && st.autoVetted[0] === '0xbbb', 'allowlist and auto-vetted coins, lowercase');
assert(st.failBlocks.length === 2 && st.failBlocks.some((r) => r[0] === '0xp1' && r[1] === '0xp2' && r[2] === NOW + 30 * 60_000), 'pair blocks with expiry, both directions');
assert(st.ownMoney.balances['0xaaa'] === '123' && st.ownMoney.readMs === NOW - 5_000, 'own money as decimal strings');
assert(st.ackSeq === 42 && st.liveReady && st.livePools[0] === '0xp1', 'ack seq, readiness, live pools');
assert(st.rustSender === true && st.dropsSeen === 2 && st.maxGasUsed === 910_000, 'rustSender (ours), drops seen, most gas used');
assert(buildFastlaneState(sources({ rustSender: () => false })).rustSender === false, 'RUST_SENDER off here -> rustSender false (Rust will not broadcast)');
assert(buildFastlaneState(sources({ rustSender: () => { throw new Error('x'); } })).rustSender === false, 'rustSender unreadable -> false (fail closed)');
// M6: a loop-loss read error must block loops, never read as "nothing lost".
const loopBroken = buildFastlaneState(sources({ loopLossUsd: () => { throw new Error('x'); } }));
assert(loopBroken.loopLossUsd >= 1e9 && loopBroken.loopPaused === true, 'loop loss unreadable -> huge loop loss + loops paused (fail closed)');
const loopNaN = buildFastlaneState(sources({ loopLossUsd: () => NaN }));
assert(loopNaN.loopLossUsd >= 1e9 && loopNaN.loopPaused === true, 'loop loss NaN -> blocks loops');
assert(buildFastlaneState(sources()).loopLossUsd === 0.1 && !buildFastlaneState(sources()).loopPaused, 'good loop loss passes through');
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
let seqN = 0;
const rec = (over: Partial<RustSendRecord>): RustSendRecord => ({
  seq: ++seqN,
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
  seqN = 0;
  const hash = '0x' + 'ab'.repeat(32);
  appendFileSync(sendsFile, JSON.stringify(rec({ t: NOW + 1, mode: 'practice' })) + '\n');
  appendFileSync(sendsFile, JSON.stringify(rec({ t: NOW + 2, mode: 'live', hash })) + '\n');
  appendFileSync(sendsFile, JSON.stringify(rec({ t: NOW + 3, mode: 'live', error: 'nonce too low' })) + '\n');
  appendFileSync(sendsFile, '{"seq":4,"t":'); // half a line: waits for the rest
  seqN = 4;
  assert(follower.poll() === 3, 'three complete records handled');
  assert(practice.length === 1 && tracked.length === 1 && tracked[0] === hash && failed[0] === 'nonce too low', 'practice counted only; live hash tracked; refused send logged');
  assert(Math.abs(gate.lossTodayUsd(true) - (3 + 0.5 + 0.04)) < 1e-9, 'live Rust send holds 2x gas against the daily loss cap (like our own)');
  assert(follower.ackSeq === 3, 'ack seq moves to the newest record handled');
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
  assert(f2.ackSeq === 4 && f2.poll() === 0 && tracked2.length === 0, 'restart: already-handled records are not handled again');

  // Rotation: Rust renames the file to .1 and starts a new one; nothing is missed.
  appendFileSync(sendsFile, JSON.stringify(rec({ t: NOW + 5 })) + '\n');
  renameSync(sendsFile, sendsFile + '.1');
  writeFileSync(sendsFile, JSON.stringify(rec({ t: NOW + 6 })) + '\n');
  assert(f2.poll() === 2, 'after rotation: the end of the old file and the new file are both read');
  const hl = follower.hourLine(true);
  assert(/practice would send 2/.test(hl) && /feed -> send p50 [\d.]+ ms, p90 20\.0 ms/.test(hl) && /live sent 1/.test(hl), `hourly line: ${hl}`);

  await followerEdgeCases();

  // Drops / most gas counters (H4 prep).
  const stats = new RustSendStats();
  stats.noteResult('profit'); stats.noteResult('dropped'); stats.noteResult('dropped'); stats.noteGas(700_000n); stats.noteGas(650_000n);
  assert(stats.dropsSeen === 2 && stats.maxGasUsed === 700_000, 'drops seen counts dropped results; most gas used kept');

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

// ---- follower edge cases (review C1 / M3) ------------------------------------
async function followerEdgeCases() {
  const d = join(dir, 'edge');
  mkdirSync(d, { recursive: true });
  const T = Date.now();
  const mk = (seq: number, t: number, hash?: string): string => JSON.stringify(rec({ seq, t, mode: 'live', hash: hash ?? '0x' + seq.toString(16).padStart(64, '0') })) + '\n';
  const fresh = (tag: string) => {
    const f = join(d, `${tag}-fastlane-sends.jsonl`);
    const prog = join(d, `${tag}-follow.json`);
    const got: number[] = [];
    const make = () => new FastlaneSendsFollower(f, { onLiveSent: (r) => got.push(r.seq!), onLiveSendFailed: (r) => got.push(r.seq!) }, prog, () => T);
    return { f, prog, got, make };
  };

  // 1. Six records in the SAME millisecond: all six tracked (the old follower took 3).
  {
    const x = fresh('samems');
    const fl = x.make();
    appendFileSync(x.f, mk(1, T) + mk(2, T) + mk(3, T));
    fl.poll();
    appendFileSync(x.f, mk(4, T) + mk(5, T) + mk(6, T));
    fl.poll();
    assert(x.got.join(',') === '1,2,3,4,5,6' && fl.ackSeq === 6, `same-ms records: all 6 tracked (${x.got.join(',')})`);
  }
  // 2. Out-of-order times: every record tracked once.
  {
    const x = fresh('order');
    const fl = x.make();
    appendFileSync(x.f, mk(1, T + 50) + mk(2, T + 10) + mk(3, T + 50));
    fl.poll();
    appendFileSync(x.f, mk(4, T - 5));
    fl.poll();
    assert(x.got.join(',') === '1,2,3,4', `out-of-order times: all tracked once (${x.got.join(',')})`);
  }
  // 3. Restart mid-file (incl. a half line at the end): continue exactly at the byte offset.
  {
    const x = fresh('restart');
    const f1 = x.make();
    appendFileSync(x.f, mk(1, T) + mk(2, T) + mk(3, T).slice(0, 20));
    f1.poll();
    f1.stop();
    appendFileSync(x.f, mk(3, T).slice(20) + mk(4, T));
    const f2 = x.make();
    f2.poll();
    assert(x.got.join(',') === '1,2,3,4' && f2.ackSeq === 4, `restart mid-file: nothing missed or doubled (${x.got.join(',')})`);
  }
  // 4. Rotation while Node is down: the rest of the .1 file then the new file.
  {
    const x = fresh('rotdown');
    const f1 = x.make();
    appendFileSync(x.f, mk(1, T) + mk(2, T));
    f1.poll();
    // Node down: Rust writes 3, rotates, writes 4 and 5.
    appendFileSync(x.f, mk(3, T));
    renameSync(x.f, x.f + '.1');
    appendFileSync(x.f, mk(4, T) + mk(5, T));
    const f2 = x.make();
    f2.poll();
    assert(x.got.join(',') === '1,2,3,4,5', `rotation while Node down: .1 rest then new file (${x.got.join(',')})`);
    // And again while running: rotate with an unread line in the old file.
    appendFileSync(x.f, mk(6, T));
    renameSync(x.f, x.f + '.1');
    appendFileSync(x.f, mk(7, T));
    f2.poll();
    assert(x.got.join(',') === '1,2,3,4,5,6,7', `rotation while running (${x.got.join(',')})`);
  }
  // 5. Both files replaced while down (place unknown): only seq above ackSeq taken.
  {
    const x = fresh('lost');
    const f1 = x.make();
    appendFileSync(x.f, mk(1, T) + mk(2, T));
    f1.poll();
    unlinkSync(x.f);
    writeFileSync(x.f + '.1', mk(2, T) + mk(3, T));
    writeFileSync(x.f, mk(4, T));
    const f2 = x.make();
    f2.poll();
    assert(x.got.join(',') === '1,2,3,4', `files replaced while down: newer seqs only, none twice (${x.got.join(',')})`);
  }
  // 6. Duplicate backstop: the same line written twice (same seq / same hash) is handled once.
  {
    const x = fresh('dup');
    const fl = x.make();
    appendFileSync(x.f, mk(1, T, '0x' + 'cd'.repeat(32)) + mk(1, T, '0x' + 'cd'.repeat(32)) + mk(2, T, '0x' + 'cd'.repeat(32)));
    fl.poll();
    assert(x.got.join(',') === '1' && fl.hour.dup === 2, `duplicates (same seq or same hash) skipped (${x.got.join(',')})`);
  }
  // 7. First start ever: lines older than 90 s skipped, new ones taken.
  {
    const x = fresh('first');
    appendFileSync(x.f, mk(1, T - 200_000) + mk(2, T - 1_000));
    const fl = x.make();
    fl.poll();
    appendFileSync(x.f, mk(3, T - 500_000));
    fl.poll();
    assert(x.got.join(',') === '2,3', `first start: only recent lines; after that every new line (${x.got.join(',')})`);
  }
  rmSync(d, { recursive: true, force: true });
}

// ---- integration: the Rust send log as the fast lane writes it ----------------
// sim/tests/fixtures/fastlane-sends-e2e.jsonl is written by the Rust end-to-end
// test (sim/tests/fastlane_e2e.rs, practice + live against a fake endpoint):
// a practice would-send, a live send with its hash, and the sequencer's reply.
function integration() {
  const fx = join(__dirname, '..', '..', 'sim', 'tests', 'fixtures', 'fastlane-sends-e2e.jsonl');
  if (!existsSync(fx)) { assert(false, 'Rust e2e send log fixture present (run cargo test --release --test fastlane_e2e)'); return; }
  const d = mkdtempSync(join(tmpdir(), 'fastlane-e2e-'));
  const f = join(d, 'fastlane-sends.jsonl');
  // Re-stamp times to "now" (first start skips lines older than 90 s).
  const now = Date.now();
  writeFileSync(f, readFileSync(fx, 'utf8').split('\n').filter(Boolean).map((l) => JSON.stringify({ ...JSON.parse(l), t: now })).join('\n') + '\n');
  const live: RustSendRecord[] = []; const prac: RustSendRecord[] = []; const replies: RustSendRecord[] = []; const failed: RustSendRecord[] = [];
  const fl = new FastlaneSendsFollower(f, { onLiveSent: (r) => live.push(r), onLiveSendFailed: (r) => failed.push(r), onPractice: (r) => prac.push(r), onLiveReply: (r) => replies.push(r) }, join(d, 'follow.json'));
  fl.poll();
  assert(prac.length >= 1 && prac.every((r) => r.mode === 'practice' && (r.seq ?? 0) > 0 && typeof r.hash === 'string'), `practice would-send picked up with seq + hash (${prac.length})`);
  assert(live.length === 1 && /^0x[0-9a-f]{64}$/.test(live[0].hash ?? '') && (live[0].seq ?? 0) > 0 && live[0].pools.length === 2, 'live Rust send picked up once, with hash, seq and pools (tracked like our own)');
  assert(failed.length === 0, 'a reply line is never read as a failed send');
  assert(replies.length === 1 && replies[0].replyTo === live[0].seq && (replies[0].replyHash ?? '').toLowerCase() === (live[0].hash ?? '').toLowerCase(), 'the sequencer reply points at the live send (seq + hash)');
  assert(fl.ackSeq >= (live[0].seq ?? 0), `ackSeq covers the live send (${fl.ackSeq})`);
  // Practice summary line from the practice file.
  const pf = join(d, 'fastlane-practice.jsonl');
  writeFileSync(pf, JSON.stringify({ kind: 'score', t: now }) + '\n' + JSON.stringify({ kind: 'hour', t: now, scored: 10, realPct: 60, takenPct: 30, handP50Us: 4200, handP90Us: 9100, agreementPct: 97.5, estUsd: 3.25 }) + '\n');
  const ps = practiceHourSummary(pf, 7_200_000, now);
  assert(ps.includes('real 60%') && ps.includes('taken by others 30%') && ps.includes('p50 4.2 ms') && ps.includes('agreement 98%') && ps.includes('$3.25'), `practice summary line (${ps})`);
  assert(practiceHourSummary(pf, 1_000, now + 10_000) === '' && practiceHourSummary(join(d, 'none.jsonl')) === '', 'old or missing practice summary = nothing');
  rmSync(d, { recursive: true, force: true });
}
integration();

main().catch((e) => { console.error(e); process.exitCode = 1; });
