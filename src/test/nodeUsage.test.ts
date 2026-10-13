import { NodeUsageCounter } from '../core/nodeUsage';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadNodeUsage, registerUrlBudget } from '../core/nodeBudget';

// Per-node usage counter: requests and pushed WebSocket messages per node per
// day, reset at midnight UTC, and the lines it adds to the hourly report.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// 23:59:00 UTC on Oct 12.
let clock = Date.UTC(2026, 9, 12, 23, 59, 0);
const u = new NodeUsageCounter(() => clock);

assert(u.reportLines().length === 0, 'nothing configured: adds nothing to the report');

u.countRequest('Chainstack (checks)', 1, true);
u.countRequest('Chainstack (checks)', 2, true);
u.countWsMessage('Chainstack WebSocket');
u.countWsMessage('Chainstack WebSocket', 4);
u.countRequest('free node (block reader gap fills)', 2);
const s = u.summary();
const checks = s.find((r) => r.label === 'Chainstack (checks)')!;
const ws = s.find((r) => r.label === 'Chainstack WebSocket')!;
assert(checks.requests === 3 && checks.wsMessages === 0, 'requests counted per node (batch of 2 counts 2)');
assert(ws.wsMessages === 5 && ws.requests === 0, 'WebSocket messages counted separately from requests');

const lines = u.reportLines();
assert(lines.some((l) => l.name === 'Chainstack WebSocket (pushed messages)' && l.used === 5 && l.daily === Infinity), 'report: pushed messages line for the WebSocket node');
assert(lines.some((l) => l.name === 'free node (block reader gap fills) (requests)' && l.used === 2), 'report: requests for a node with no allowance');
assert(!lines.some((l) => l.name.startsWith('Chainstack (checks)')), 'report: metered node not repeated (its allowance line already shows it)');
assert(u.text().includes('Chainstack WebSocket') && u.text().includes('5 msgs'), 'one-line text for logs');

// Midnight UTC: everything back to zero, nodes still listed.
clock = Date.UTC(2026, 9, 13, 0, 0, 1);
const after = u.summary();
assert(after.length === 3 && after.every((r) => r.requests === 0 && r.wsMessages === 0), 'midnight UTC: all counts reset to 0, nodes kept');
u.countWsMessage('Chainstack WebSocket');
assert(u.summary().find((r) => r.label === 'Chainstack WebSocket')!.wsMessages === 1, 'counting resumes on the new day');
assert(u.reportLines().some((l) => l.name === 'Chainstack WebSocket (pushed messages)' && l.used === 1), 'report shows the new day only');

// Same day, a few seconds later: no reset.
clock += 5_000;
assert(u.summary().find((r) => r.label === 'Chainstack WebSocket')!.wsMessages === 1, 'no reset within the same UTC day');

// Exact-URL allowances survive a restart (usage file loaded before the
// check nodes are set up, then picked up when they register).
{
  const dir = mkdtempSync(join(tmpdir(), 'nodeusage-'));
  const file = join(dir, 'node-usage.json');
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(file, JSON.stringify({ 'Example (checks)': { day: today, used: 1234 }, 'Old (checks)': { day: '2000-01-01', used: 99 } }));
  loadNodeUsage(file);
  const b = registerUrlBudget('https://rpc.example.org/KEY', 'Example (checks)', 4, 10_000);
  assert(b.usedToday === 1234, 'restart: today\'s usage restored for an any-provider node');
  const old = registerUrlBudget('https://rpc.old.example/KEY', 'Old (checks)', 4, 10_000);
  assert(old.usedToday === 0, 'restart: usage from an earlier day is not restored');
}
