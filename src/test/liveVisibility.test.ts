import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LiveTradeLog } from '../execution/liveTradeLog';
import { SafetyAlerts, pauseKindOf } from '../execution/safetyAlerts';
import { SafetyGate, safetyConfigFromEnv } from '../execution/fastSender';
import { LiveTradeTracker } from '../execution/liveTracker';

// Live visibility: the live trade file the status page reads, the Telegram
// safety alerts (loss cap 75% / hit, kill switch, bad setting; once per day),
// and the status page's "Live trades" section and footer.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const dir = mkdtempSync(join(tmpdir(), 'livevis-'));
const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// ---------------------------------------------------------------- trade log
let clock = Date.UTC(2026, 9, 16, 14, 0, 0); // Fri Oct 16 2026, 14:00 UTC
const file = join(dir, 'data', 'live-trades.jsonl');
const log = new LiveTradeLog(file, 2_000_000, () => clock, 0);
log.sent('0x' + 'ab'.repeat(32), 'WETH/USDG uniswap-v3>uniswap-v2', 1500.456, 0.42);
log.result({ hash: '0x' + 'ab'.repeat(32), label: 'WETH/USDG uniswap-v3>uniswap-v2', status: 'profit', gasUsd: 0.03, profitUsd: 0.5, expectedProfitUsd: 0.42 });
log.result({ hash: '0x' + 'cd'.repeat(32), label: 'X/USDG a>b', status: 'reverted', gasUsd: 0.04, expectedProfitUsd: 0.2 });
log.sendFailed('X/USDG a>b', 800, 'nonce too low');
let recs = lines(file);
assert(existsSync(file) && recs.length === 4, 'log: data folder created, one line per event');
assert(recs[0].kind === 'sent' && recs[0].sizeUsd === 1500.46 && recs[0].t === clock, 'log: sent line has time, size (rounded), hash');
assert(recs[1].status === 'won' && Math.abs(recs[1].netUsd - 0.47) < 1e-9, 'log: won result has profit after gas (0.50 - 0.03)');
assert(recs[2].status === 'reverted' && Math.abs(recs[2].netUsd + 0.04) < 1e-9, 'log: reverted result net = minus the gas');
assert(recs[3].kind === 'send_failed' && recs[3].error === 'nonce too low', 'log: refused send recorded');

// Blocked reasons are added up and written at most once a minute.
log.noteBlocked('send rate limit'); log.noteBlocked('send rate limit'); log.noteBlocked('daily loss cap $N reached');
assert(lines(file).length === 4, 'log: blocked counts held in memory (not one line per block)');
clock += 61_000;
log.noteBlocked('send rate limit');
recs = lines(file);
const b = recs[recs.length - 1];
assert(b.kind === 'blocked' && b.counts['send rate limit'] === 3 && b.counts['daily loss cap $N reached'] === 1, 'log: after a minute, one "blocked" line with counts by reason');
log.flushBlocked(); log.flushBlocked();
assert(lines(file).length === recs.length, 'log: empty flush writes nothing');

// Rotation: past the size cap the file moves to .1 and a new one starts.
const small = join(dir, 'small.jsonl');
const slog = new LiveTradeLog(small, 300, () => clock, 0);
for (let i = 0; i < 6; i++) slog.sent('0x' + String(i).repeat(64), 'A/B x>y', 100, 0.1);
assert(existsSync(small + '.1') && lines(small).length < 6, 'log: rotates to .1 past the size cap');

// Tracker hands each final result to the log listener.
const got: string[] = [];
const tr = new LiveTradeTracker({
  provider: { getTransactionReceipt: async () => null } as any, ethUsd: () => 3000, tokenUsd: () => null,
  recordLoss: () => {}, noteGasUsed: () => {}, notify: () => {}, onResult: (r) => got.push(r.status),
});
tr.record('0xr', { expectedProfitUsd: 1, label: 'A/B' }, { status: 0, gasUsed: 1n, gasPrice: 1n, logs: [] } as any);
assert(got.length === 1 && got[0] === 'reverted', 'tracker: onResult called with each result');

// ---------------------------------------------------------------- alerts
assert(pauseKindOf('daily loss cap $25 reached') === 'loss-cap' && pauseKindOf('kill switch on') === 'kill-switch'
  && pauseKindOf('bad safety setting: MAX_TRADE_USD=NaN') === 'bad-setting' && pauseKindOf('send rate limit') === null
  && pauseKindOf('token 0xabc not on the allowlist') === null, 'alerts: only "stops everything" reasons alert');

const msgs: string[] = [];
let aclock = Date.UTC(2026, 9, 16, 10, 0, 0);
const al = new SafetyAlerts((h) => { msgs.push(h); }, 20, 'robinhood', () => aclock);
al.onLoss(10);
assert(msgs.length === 0, 'alerts: 50% of cap, no alert');
al.onLoss(15);
assert(msgs.length === 1 && /LOSS CAP 75% USED/.test(msgs[0]) && /\$15\.00 of the \$20\.00/.test(msgs[0]), 'alerts: 75% early warning');
al.onLoss(16);
assert(msgs.length === 1, 'alerts: 75% warning only once a day');
al.onLoss(20.5);
assert(msgs.length === 2 && /DAILY LOSS CAP HIT/.test(msgs[1]) && /midnight UTC/.test(msgs[1]), 'alerts: cap hit alert');
al.onBlocked('daily loss cap $20 reached', 21);
al.onLoss(22);
assert(msgs.length === 2, 'alerts: cap hit only once a day (loss or gate)');
al.onBlocked('kill switch on', 0);
al.onBlocked('kill switch on', 0);
assert(msgs.length === 3 && /LIVE SENDING PAUSED/.test(msgs[2]) && /kill switch on/.test(msgs[2]) && /data\/KILL/.test(msgs[2]), 'alerts: kill switch pause alert, once');
al.onBlocked('send rate limit', 0);
al.onBlocked('size $30000 over max $20000', 0);
assert(msgs.length === 3, 'alerts: per-trade reasons never alert');
al.onBlocked('bad safety setting: DAILY_LOSS_CAP_USD=NaN', 0);
assert(msgs.length === 4 && /bad safety setting/.test(msgs[3]) && /\.env/.test(msgs[3]), 'alerts: bad setting pause alert');
assert(msgs.every((m) => !m.includes(String.fromCharCode(0x2014))), 'alerts: no em dashes in alert text');
aclock += 24 * 3600_000; // next UTC day: everything can alert again
al.onBlocked('daily loss cap $20 reached', 20);
assert(msgs.length === 5 && /DAILY LOSS CAP HIT/.test(msgs[4]), 'alerts: next UTC day, cap hit alerts again');
al.onLoss(16);
assert(msgs.length === 5, 'alerts: no 75% warning after the cap already hit today');

// Cap hit first via the gate on a fresh day (pending trades counted) still alerts.
const msgs2: string[] = [];
const al2 = new SafetyAlerts((h) => { msgs2.push(h); }, 10, 'robinhood', () => aclock);
al2.onBlocked('daily loss cap $10 reached', 10.2);
assert(msgs2.length === 1 && /\$10\.20/.test(msgs2[0]), 'alerts: gate-only cap trip (pending gas) alerts with the gate number');
// A failing notify never throws.
const al3 = new SafetyAlerts(() => { throw new Error('telegram down'); }, 10, 'robinhood', () => aclock);
let threw = false; try { al3.onLoss(11); } catch { threw = true; }
assert(!threw, 'alerts: a Telegram failure never breaks trading');

// SafetyGate: lossTodayUsd with and without pending, resets next UTC day.
let gclock = Date.UTC(2026, 9, 16, 12, 0, 0);
const gate = new SafetyGate({ ...safetyConfigFromEnv({}), killFile: join(dir, 'nokill') }, () => gclock);
gate.recordLoss(3); gate.reservePending('0xp', 2);
assert(gate.lossTodayUsd() === 3 && gate.lossTodayUsd(true) === 5, 'gate: loss today, with and without pending trades');
gclock += 24 * 3600_000;
gate.releasePending('0xp');
assert(gate.lossTodayUsd() === 0, 'gate: loss resets the next UTC day');

// ---------------------------------------------------------------- status page
// Plain JS helper file; loaded the same way the server runs it.
const status = require(join(__dirname, '..', '..', 'deploy', 'status-report.js'));

// Live detection: the bot's startup line wins; .env only when no line.
assert(status.detectLive(['[fire] robinhood sender ready (LIVE from 0xabc)'], {}) === true, 'status: LIVE startup line = live');
assert(status.detectLive(['[fire] robinhood sender ready (LIVE from 0xabc)', '[fire] robinhood sender ready (dry run)'], { EXECUTION_ENABLED: 'true', LIVE_SEND_CONFIRM: 'yes-real-money', hasKey: true }) === false, 'status: latest startup line (dry run) wins over .env');
assert(status.detectLive([], { EXECUTION_ENABLED: 'true', LIVE_SEND_CONFIRM: 'yes-real-money', hasKey: true }) === true, 'status: no startup line, full live .env = live');
assert(status.detectLive([], { EXECUTION_ENABLED: 'true', LIVE_SEND_CONFIRM: '', hasKey: true }) === false, 'status: half set up .env = practice (same rule as the bot)');
assert(/Practice mode: no real trades/.test(status.footerText(false)) && /LIVE: real money/.test(status.footerText(true)), 'status: footer wording');

// Live section from a sample file: 2 sends in the window, 1 earlier today, 1 yesterday.
const now = Date.UTC(2026, 9, 16, 15, 0, 0);
const win = now - 15 * 60_000;
const H = (c: string) => '0x' + c.repeat(64);
const sample = [
  { t: now - 30 * 3600_000, kind: 'result', hash: H('9'), label: 'OLD/USDG a>b', status: 'reverted', gasUsd: 5, netUsd: -5 }, // yesterday: not today
  { t: now - 3600_000, kind: 'sent', hash: H('1'), label: 'WETH/USDG uniswap-v3>uniswap-v2', sizeUsd: 1200 },
  { t: now - 3590_000, kind: 'result', hash: H('1'), label: 'WETH/USDG uniswap-v3>uniswap-v2', status: 'won', profitUsd: 1.1, gasUsd: 0.1, netUsd: 1.0 },
  { t: now - 600_000, kind: 'sent', hash: H('2'), label: 'AAPL/USDG v3>v2', sizeUsd: 900 },
  { t: now - 590_000, kind: 'result', hash: H('2'), label: 'AAPL/USDG v3>v2', status: 'reverted', gasUsd: 0.25, netUsd: -0.25 },
  { t: now - 300_000, kind: 'sent', hash: H('3'), label: 'NVDA/USDG v3>v2', sizeUsd: 400 },
  { t: now - 200_000, kind: 'blocked', counts: { 'send rate limit': 4, 'daily loss cap $N reached': 2 } },
  { t: now - 7200_000, kind: 'blocked', counts: { 'send rate limit': 1 } },
];
const sf = join(dir, 'sample.jsonl');
writeFileSync(sf, sample.map((r) => JSON.stringify(r)).join('\n') + '\n{broken line\n');
const read = status.readLiveRecords(sf);
assert(read.length === sample.length, 'status: reads the live file, skips a broken line');
const page: string = status.liveSection(read, { windowStart: win, now, capUsd: 1 }).join('\n');
assert(/### Live trades \(real money\)/.test(page), 'status: live section heading');
assert(/\| Sent \| 2 \| 3 \|/.test(page), 'status: sent this window (2) and today (3)');
assert(/\| Landed and won \(profit after gas\) \| 0 \(\$0\.00\) \| 1 \(\+\$1\.00\) \|/.test(page), 'status: won count + profit after gas');
assert(/\| Landed but reverted \(gas lost\) \| 1 \(\$0\.25\) \| 1 \(\$0\.25\) \|/.test(page), 'status: reverted count + gas lost (yesterday excluded)');
assert(/\| Not sent \(all reasons, see below\) \| 6 \| 7 \|/.test(page), 'status: not-sent stops (all reasons), window and today');
assert(/2x daily loss cap \$N reached/.test(page) && /4x send rate limit/.test(page), 'status: stops by reason');
assert(/Net today: \+\$0\.75/.test(page), 'status: net today (1.00 - 0.25)');
assert(/Daily loss used: \$0\.25 of \$1\.00 cap \(25%\)/.test(page), 'status: daily loss used vs cap');
assert(/NVDA\/USDG v3>v2 \| \$400 \| - \| waiting for receipt \| `0x333333…3333`/.test(page), 'status: newest trade first, pending, short hash (no funding info: -)');
assert(/AAPL\/USDG v3>v2 \| \$900 \| - \| reverted, gas lost \$0\.25/.test(page), 'status: reverted trade row');
assert(/won \+\$1\.00 after gas/.test(page), 'status: won trade row');
assert(!page.includes(String.fromCharCode(0x2014)), 'status: no em dashes in the section');
const capPage: string = status.liveSection(read, { windowStart: win, now, capUsd: 0.2 }).join('\n');
assert(/CAP HIT/.test(capPage), 'status: cap hit called out on the page');
const empty: string = status.liveSection([], { windowStart: win, now, capUsd: 25 }).join('\n');
assert(/no live sends yet/.test(empty) && /\| Sent \| 0 \| 0 \|/.test(empty), 'status: live with no sends yet shows zeros');
