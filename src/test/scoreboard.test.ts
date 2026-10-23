import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Scoreboard, scoreSettings, totals, bucketsOf, assumptionKinds, standingGapFailBlock, ScoreRecord } from '../report/scoreboard';
import { LiveRouteBlock } from '../core/routeScore';

// SCOREBOARD (report/scoreboard.ts): live-money truth per path / confidence /
// assumption, the hourly text, the file, the self-adjusting bucket pause and
// the overall step back of trigger-first, and the standing-gap fail block.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

function board(env: Record<string, string> = {}, t = { now: 1_800_000_000_000 }) {
  const dir = mkdtempSync(join(tmpdir(), 'score-'));
  const file = join(dir, 'scoreboard.jsonl');
  const notes: string[] = [];
  const steps: Array<{ until: number; why: string }> = [];
  const sb = new Scoreboard({ settings: scoreSettings({ SCOREBOARD_FILE: file, ...env }), now: () => t.now, log: () => {}, notify: (m) => notes.push(m), onStepBack: (until, why) => steps.push({ until, why }) });
  return { sb, file, notes, steps, t };
}
let n = 0;
const hash = () => '0x' + (++n).toString(16).padStart(64, '0');

// ---- settings ----------------------------------------------------------------
{
  const s = scoreSettings({});
  assert(s.bucketMinSends === 12 && s.bucketPauseH === 6 && s.stepBackUsd === 1.5 && s.stepBackWindowH === 3 && s.stepBackH === 6 && s.selfAdjust && s.file === 'data/scoreboard.jsonl', 'defaults: 12 sends, 6 h pause, -$1.50 over 3 h -> 6 h step back, file data/scoreboard.jsonl');
  assert(!scoreSettings({ SCORE_SELF_ADJUST: '0' }).selfAdjust, 'SCORE_SELF_ADJUST=0: report only');
  assert(assumptionKinds(['skipped_unrelated:2', 'sender_funds']).join() === 'sender_funds,skipped_unrelated' && assumptionKinds([]).join() === 'exact', 'assumption kinds without counts; none = exact');
  assert(bucketsOf({ path: 'trig_first', confidence: 'medium', assumptions: ['sender_funds', 'recent_fill'] }).join() === 'trig_first|medium|recent_fill,trig_first|medium|sender_funds', 'a send with two assumptions is in two buckets');
  assert(bucketsOf({ path: 'node' }).join() === 'node|-|exact', 'other paths: one bucket');
}

// ---- the math -------------------------------------------------------------------
{
  const { sb, file } = board();
  const h1 = hash(), h2 = hash(), h3 = hash(), h4 = hash();
  sb.noteSend({ hash: h1, path: 'trig_first', confidence: 'medium', assumptions: ['sender_funds'], expectedUsd: 0.5, label: 'A', pools: ['0xa', '0xb'] });
  sb.noteSend({ hash: h2, path: 'trig_first', confidence: 'high', expectedUsd: 0.4 });
  sb.noteSend({ hash: h3, path: 'node', expectedUsd: 0.3 });
  sb.noteSend({ hash: h4, path: 'gap', expectedUsd: 0.6 });
  const r1 = sb.noteResult({ hash: h1, status: 'profit', gasUsd: 0.03, gasEth: 0.0000088, profitUsd: 0.6, expectedProfitUsd: 0.5 });
  const r2 = sb.noteResult({ hash: h2, status: 'reverted', gasUsd: 0.03, gasEth: 0.0000088, expectedProfitUsd: 0.4 });
  const r3 = sb.noteResult({ hash: h3, status: 'profit', gasUsd: 0.03, gasEth: 0.0000088, expectedProfitUsd: 0.3 }); // profit not priced
  const r4 = sb.noteResult({ hash: h4, status: 'dropped', gasUsd: 0, expectedProfitUsd: 0.6 });
  assert(r1?.status === 'won' && r1.wonFrom === 'event' && near(r1.netUsd, 0.57) && r1.path === 'trig_first' && r1.confidence === 'medium', 'won: profit from the Executed event, net = won - gas, path / confidence kept');
  assert(r2?.status === 'failed' && r2.wonUsd === 0 && near(r2.netUsd, -0.03), 'failed on chain: only gas lost');
  assert(r3?.status === 'won' && r3.wonFrom === 'expected' && near(r3.wonUsd, 0.3), 'won but profit not priced: counted at the expected profit, marked');
  assert(r4?.status === 'dropped', 'never mined: dropped');
  const t = totals([r1!, r2!, r3!, r4!]);
  assert(t.sends === 3 && t.wins === 2 && near(t.winRate!, 2 / 3) && near(t.wonUsd, 0.9) && near(t.gasUsd, 0.09) && near(t.netUsd, 0.81) && t.dropped === 1, 'totals: dropped sends are not sends; wins, win rate, won, gas, NET');
  assert(near(t.gasEth, 3 * 0.0000088), 'gas in ETH too');
  assert(near(t.breakEvenWinRate!, 0.03 / 0.45), 'break-even win rate = average gas per send / average profit per win');
  const noWin = totals([r2!]);
  assert(near(noWin.breakEvenWinRate!, 0.03 / 0.43), 'no win yet: the expected profit (before gas) stands in');
  const text = sb.hourText(0) ?? '';
  assert(/this hour 3 sent, 2 won \(67%\)/.test(text) && /NET \+\$0\.81/.test(text) && /break-even win rate 7%/.test(text), `hour text: ${text}`);
  assert(/by path: trig_first 2 \(won 1, net \+\$0\.54\)/.test(text) && /trigger-first by confidence: /.test(text) && /today 3 sent/.test(text), 'per path, per confidence and today');
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert(lines.length === 4 && lines.every((l) => l.k === 'send') && lines[0].assumptions[0] === 'sender_funds', 'one line per settled send in data/scoreboard.jsonl');
  const unknown = sb.noteResult({ hash: hash(), status: 'reverted', gasUsd: 0.02, expectedProfitUsd: 0.3 });
  assert(unknown?.path === 'unknown', 'a result for a send we never saw (restart): path unknown, still counted');
}

// ---- restart: reload from the file ------------------------------------------------
{
  const { sb, file, t } = board();
  sb.noteSend({ hash: hash(), path: 'copy2', expectedUsd: 0.3 });
  sb.noteResult({ hash: '0x' + n.toString(16).padStart(64, '0'), status: 'profit', gasUsd: 0.03, profitUsd: 0.4, expectedProfitUsd: 0.3 });
  const again = new Scoreboard({ settings: scoreSettings({ SCOREBOARD_FILE: file }), now: () => t.now, log: () => {} });
  assert((again.hourText(0) ?? '').includes('1 sent, 1 won'), 'a restart keeps the day\'s sends');
}

// ---- self-adjusting: bucket pause ---------------------------------------------------------
{
  const { sb, notes, t } = board();
  const send = (status: 'profit' | 'reverted', a: string[] = ['recent_fill']) => {
    const h = hash();
    sb.noteSend({ hash: h, path: 'trig_first', confidence: 'medium', assumptions: a, expectedUsd: 0.3 });
    t.now += 1_000;
    sb.noteResult({ hash: h, status, gasUsd: 0.03, profitUsd: status === 'profit' ? 0.3 : undefined, expectedProfitUsd: 0.3 });
  };
  for (let i = 0; i < 11; i++) send('reverted');
  assert(sb.pausedWhy('trig_first', 'medium', ['recent_fill']) === null, 'under 12 sends: never paused, however bad');
  send('reverted');
  const why = sb.pausedWhy('trig_first', 'medium', ['recent_fill']);
  assert(!!why && /recent_fill/.test(why), `12 losing sends: the bucket stops sending (${why})`);
  assert(notes.some((m) => /stopped sending from "trig_first \/ medium \/ recent_fill" for 6 h/.test(m)), 'Telegram note');
  assert(sb.pausedWhy('trig_first', 'medium', ['sender_funds']) === null, 'other buckets keep sending');
  assert(sb.pausedWhy('trig_first', 'medium', ['sender_funds', 'recent_fill']) !== null, 'a send in a paused bucket is held even if its other bucket is fine');
  assert(/PAUSED: trig_first\/medium\/recent_fill/.test(sb.hourText(0) ?? ''), 'shown in the hourly text');
  t.now += 6 * 3_600_000 + 1;
  assert(sb.pausedWhy('trig_first', 'medium', ['recent_fill']) === null, 'after 6 h it sends again');
  for (let i = 0; i < 11; i++) send('reverted');
  assert(sb.pausedWhy('trig_first', 'medium', ['recent_fill']) === null, 'after a pause it counts from zero (11 new sends: not yet)');
  // A bucket that wins enough is never paused: 3 wins of $0.30 pay for 9 fails of $0.03.
  const { sb: sb2, t: t2 } = board();
  for (let i = 0; i < 12; i++) {
    const h = hash();
    sb2.noteSend({ hash: h, path: 'node', expectedUsd: 0.3 });
    t2.now += 1_000;
    sb2.noteResult({ hash: h, status: i % 4 === 0 ? 'profit' : 'reverted', gasUsd: 0.03, profitUsd: i % 4 === 0 ? 0.3 : undefined, expectedProfitUsd: 0.3 });
  }
  assert(sb2.pausedWhy('node') === null, 'net positive at a 25% win rate (break-even ~10%): keeps sending');
  const { sb: sb3, t: t3 } = board({ SCORE_SELF_ADJUST: '0' });
  for (let i = 0; i < 20; i++) { const h = hash(); sb3.noteSend({ hash: h, path: 'loop', expectedUsd: 0.3 }); t3.now += 1; sb3.noteResult({ hash: h, status: 'reverted', gasUsd: 0.03, expectedProfitUsd: 0.3 }); }
  assert(sb3.pausedWhy('loop') === null, 'SCORE_SELF_ADJUST=0: never pauses');
}

// ---- self-adjusting: overall step back ----------------------------------------------------
{
  const { sb, steps, notes, t, file } = board({ SCORE_BUCKET_MIN_SENDS: '1000' });
  const lose = (gas: number) => { const h = hash(); sb.noteSend({ hash: h, path: 'trig_first', confidence: 'high', expectedUsd: 0.3 }); t.now += 60_000; sb.noteResult({ hash: h, status: 'reverted', gasUsd: gas, expectedProfitUsd: 0.3 }); };
  for (let i = 0; i < 5; i++) lose(0.25);
  assert(steps.length === 0, '-$1.25 in 3 h: within the limit');
  // Old losses roll out of the 3 h window.
  t.now += 3 * 3_600_000;
  lose(0.5);
  assert(steps.length === 0, 'losses older than 3 h no longer count');
  for (let i = 0; i < 3; i++) lose(0.5);
  assert(steps.length === 1 && near(steps[0].until, t.now + 6 * 3_600_000), 'over -$1.50 in the last 3 h: trigger-first back to practice for 6 h');
  assert(notes.some((m) => /TRIGGER-FIRST stepped back to practice for 6 h/.test(m)), 'Telegram alert');
  assert(sb.stepBackActiveUntil() === steps[0].until, 'step back active');
  lose(1);
  assert(steps.length === 1, 'not stepped back twice while active');
  const again = new Scoreboard({ settings: scoreSettings({ SCOREBOARD_FILE: file }), now: () => t.now, log: () => {} });
  assert(again.stepBackActiveUntil() === steps[0].until, 'a restart keeps the step back (the bot re-applies it to trigger-first)');
  t.now = steps[0].until + 1;
  assert(sb.stepBackActiveUntil() === 0, 'over after 6 h');
}

// ---- standing-gap fail block (30 min) ---------------------------------------------------------
{
  let now = 0;
  const blocks = new LiveRouteBlock(30 * 60_000, () => now);
  const rec = (path: ScoreRecord['path'], status: ScoreRecord['status']): ScoreRecord => ({ hash: '0x1', path, status, expectedUsd: 0.5, wonUsd: 0, wonFrom: null, gasEth: 0, gasUsd: 0.03, netUsd: -0.03, settledMs: 0, pools: ['0xAA', '0xBB'] });
  assert(!standingGapFailBlock(rec('gap', 'won'), (a, b, w) => blocks.block(a, b, w)) && !standingGapFailBlock(rec('node', 'failed'), (a, b, w) => blocks.block(a, b, w)), 'only a FAILED standing-gap send blocks');
  assert(standingGapFailBlock(rec('gap', 'failed'), (a, b, w) => blocks.block(a, b, w)), 'a standing gap failed live on chain: blocked');
  assert(!!blocks.reason('0xAA', '0xBB') && !!blocks.reason('0xbb', '0xaa'), 'that pool pair, both directions');
  now += 29 * 60_000;
  assert(!!blocks.reason('0xAA', '0xBB'), 'still blocked after 29 min');
  now += 2 * 60_000;
  assert(blocks.reason('0xAA', '0xBB') === null, 'free again after 30 min');
}

