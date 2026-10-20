// Why not sent (report/whyNotSent.ts, Oct 20): every 10 min, live chances,
// sends and the plain reasons the rest stopped.
import { WhyNotSent, plainReason, formatWhyNotSent } from '../report/whyNotSent';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// Raw reasons exactly as the send path writes them.
assert(plainReason('check first: real check: would lose money') === 'real check said loss', 'check-first loss');
assert(plainReason('check first: real check: would fail') === 'real check said it would fail', 'check-first fail');
assert(plainReason('check first: real check: only $N after gas (under the $N minimum)') === 'real check: too small', 'check-first too small');
assert(plainReason('check first: followed trade not in a block in time') === 'followed trade too slow to land', 'trade not landed');
assert(plainReason('pool pair blocked for live (failed real check or live trade, 6 h)') === 'pair blocked (failed recently)', 'live block');
assert(plainReason('pool pair benched (practice checks keep losing)') === 'pair benched (keeps losing)', 'bench');
assert(plainReason('expected profit under the send minimum') === 'under minimum', 'send minimum');
assert(plainReason('own money too low and no approved lender') === 'no money/lender for it', 'no money / lender');
assert(plainReason('token 0x… not on the allowlist') === 'coin not on safe list', 'allowlist');
assert(plainReason('outlier profit (too good to be true), second check failed') === 'too good to be true', 'outlier');
assert(plainReason('exchange not live yet: up-cl practice only') === 'exchange not live yet', 'exchange not live');
assert(plainReason('daily loss cap $N reached') === 'daily loss cap reached', 'loss cap');
assert(plainReason('something brand new and very long that nobody expected at all') .length <= 40, 'unknown reason kept, shortened');

const w = new WhyNotSent();
assert(formatWhyNotSent(w.take(), 10) === null, 'nothing happened: no line (quiet)');
for (let i = 0; i < 12; i++) w.chance();
w.sent();
for (let i = 0; i < 6; i++) w.blocked('check first: real check: would lose money');
for (let i = 0; i < 3; i++) w.blocked('pool pair blocked for live (failed real check or live trade, 6 h)');
w.blocked('expected profit under the send minimum'); w.blocked('expected profit under the send minimum');
const line = formatWhyNotSent(w.take(), 10);
console.log('  ' + line);
assert(line === 'Live (last 10 min): 12 chances · 1 sent · 6 real check said loss · 3 pair blocked (failed recently) · 2 under minimum', 'the 10-min line, biggest reason first');
assert(formatWhyNotSent(w.take(), 10) === null, 'window starts fresh after each line');

// Bounded memory: never more than 50 different reasons.
for (let i = 0; i < 80; i++) w.blocked(`weird reason ${i}`);
assert(w.take().reasons.size <= 50, 'at most 50 reasons kept');

// --- live trade file gets the funding fields (status page "Paid with" column) ---
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LiveTradeLog } from '../execution/liveTradeLog';
{
  const file = join(mkdtempSync(join(tmpdir(), 'livelog-')), 'live-trades.jsonl');
  const log = new LiveTradeLog(file, 2_000_000, () => 1, 0);
  log.sent('0xaa', 'WETH/AI x>y', 385, 1.84, { kind: 'flash', feePct: 0.01, feeUsd: 0.0385 });
  log.sent('0xbb', 'WETH/USDG x>y', 49, 0.1, { kind: 'own' });
  log.sent('0xcc', 'OLD/USDG', 49, 0.1);
  log.result({ hash: '0xaa', label: 'WETH/AI x>y', status: 'profit', gasUsd: 0.02, profitUsd: 1.84, expectedProfitUsd: 1.84, funding: { kind: 'flash', feePct: 0.01, feeUsd: 0.0385 } });
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert(rows[0].funding === 'flash' && rows[0].loanFeePct === 0.01 && rows[0].loanFeeUsd === 0.0385, 'sent (flash): funding, fee % and fee $ in the file');
  assert(rows[1].funding === 'own' && rows[1].loanFeeUsd === undefined, 'sent (own money): funding only');
  assert(rows[2].funding === undefined, 'sent without funding info: unchanged (old format)');
  assert(rows[3].kind === 'result' && rows[3].funding === 'flash' && rows[3].loanFeeUsd === 0.0385, 'result carries the funding too');
  log.stop();
}
