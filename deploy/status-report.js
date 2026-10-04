#!/usr/bin/env node
// ============================================================================
// STATUS PAGE -- posts a short bot health summary to a GitHub issue
//
// Plain English:
//   GitHub can't see the server, so the server reports to GitHub. Every 15
//   minutes this rewrites one GitHub issue ("Bot status") with: is the bot
//   running, which chains are connected, what it found, and any errors since
//   the last report. You (or Claude) check the issue instead of logging in.
//
// Runs from auto-deploy.sh (every 2 min), but only actually reports every
// STATUS_EVERY_MIN minutes. Never touches the bot. Needs no npm packages.
//
// Setup (once): create a GitHub fine-grained token for THIS repo only with
// "Issues: Read and write", then add to the bot's .env:
//     GH_STATUS_TOKEN=github_pat_...
// Optional: GH_STATUS_ISSUE=15 (issue number), STATUS_EVERY_MIN=15
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const APP_DIR = path.resolve(__dirname, '..');
const STATE_FILE = path.join(__dirname, '.status-state.json');
const REPO = 'rankine-labs/multichain-arb-engine';
const PM2_NAME = process.env.PM2_NAME || 'dex-arb-shadow';
const LOG_DIR = path.join(os.homedir(), '.pm2', 'logs');
const OUT_LOG = path.join(LOG_DIR, `${PM2_NAME}-out.log`);
const ERR_LOG = path.join(LOG_DIR, `${PM2_NAME}-error.log`);
const MAX_READ = 5 * 1024 * 1024; // never read more than 5 MB of new log per run

// Reads ONLY the keys we need from .env (wallet keys never enter this script).
function envValue(key) {
  try {
    const line = fs.readFileSync(path.join(APP_DIR, '.env'), 'utf8')
      .split('\n').filter((l) => l.startsWith(key + '=')).pop();
    return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '') : '';
  } catch { return ''; }
}

const TOKEN = envValue('GH_STATUS_TOKEN');
const ISSUE = envValue('GH_STATUS_ISSUE') || '15';
const EVERY_MIN = Number(envValue('STATUS_EVERY_MIN') || 15);

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { lastRun: 0, out: 0, err: 0 }; }
}

// Log text written since the last report (handles pm2 log rotation).
function newText(file, offset) {
  try {
    const size = fs.statSync(file).size;
    let start = size < offset ? 0 : offset;       // file shrank = rotated: start over
    if (size - start > MAX_READ) start = size - MAX_READ;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return { text: buf.toString('utf8'), size };
  } catch { return { text: '', size: offset }; }
}

const sh = (cmd) => { try { return execSync(cmd, { cwd: APP_DIR, encoding: 'utf8', timeout: 15000 }).trim(); } catch { return ''; } };
const strip = (l) => l.replace(/^\s*\d+\|[^|]*\|\s*/, '').trim(); // drop pm2 "0|name |" prefix
const lastMatch = (lines, re) => [...lines].reverse().find((l) => re.test(l));
const count = (lines, re) => lines.filter((l) => re.test(l)).length;

async function main() {
  const state = loadState();
  const now = Date.now();
  if (!TOKEN) return;                                    // not set up yet
  if (now - state.lastRun < EVERY_MIN * 60_000 - 30_000) return; // not due

  // --- bot process ----------------------------------------------------------
  let proc = null;
  try { proc = JSON.parse(sh('pm2 jlist') || '[]').find((p) => p.name === PM2_NAME) || null; } catch {}
  const running = proc && proc.pm2_env.status === 'online';
  const upMin = proc ? Math.round((now - proc.pm2_env.pm_uptime) / 60000) : 0;
  const memMb = proc ? Math.round(proc.monit.memory / 1048576) : 0;
  const restarts = proc ? proc.pm2_env.restart_time : 0;
  const restartsSince = state.restarts === undefined ? 0 : Math.max(0, restarts - state.restarts);

  // --- what happened since the last report ---------------------------------
  const out = newText(OUT_LOG, state.out);
  const err = newText(ERR_LOG, state.err);
  const outL = out.text.split('\n').map(strip).filter(Boolean);
  const errL = err.text.split('\n').map(strip).filter((l) => l && !/^at |^\}|^\{|^[a-zA-Z]+: /.test(l));

  // Chain health: last word from each chain in this window.
  // Health is checked every 15s (60x per 15 min), so the number of
  // UNHEALTHY lines says how much of the window the chain was down.
  const chainLine = (c) => {
    const badCount = count(errL, new RegExp(`${c} UNHEALTHY|${c} (failed to start|reconnect failed)`));
    const last = lastMatch(errL, new RegExp(`${c} (UNHEALTHY|failed to start|reconnect failed)|\\[${c}\\] feed (error|closed)`));
    if (badCount === 0) return `✅ ${c}: connected the whole time`;
    if (badCount < 20) return `⚠️ ${c}: mostly up, ${badCount} blip(s). Last: ${(last || '').slice(0, 100)}`;
    return `❌ ${c}: down most of this window (${badCount}x). Last: ${(last || '').slice(0, 100)}`;
  };
  const chainsLine = lastMatch(sh(`tail -c 3000000 "${OUT_LOG}"`).split('\n').map(strip), /\[chains\] enabled:/) || '';
  const chains = (chainsLine.split('enabled:')[1] || 'robinhood').split(',').map((s) => s.trim()).filter(Boolean);

  const lastScan = lastMatch(sh(`tail -c 8000000 "${OUT_LOG}"`).split('\n').map(strip), /\[scan\] robinhood (now watching|:)|\[scan\] robinhood scan failed/) || 'no scan yet';
  const simProfit = count(outL, /\[sim\].*REAL PROFIT/);
  const simLoss = count(outL, /\[sim\].*real: LOSS/);
  const simFail = count(outL, /\[sim\].*real: FAILS/);
  const newPairs = outL.filter((l) => /\[pairs\] .* watching /.test(l)).map((l) => l.replace(/^\[pairs\] \w+ watching /, '').split(':')[0]);
  const poolLookups = count(outL, /\[discovery\] rejected/);

  // Errors: distinct messages with counts (noise trimmed).
  const errCounts = new Map();
  for (const l of errL) {
    if (/UNHEALTHY/.test(l)) continue; // already summarised per chain
    const k = l.replace(/0x[0-9a-fA-F]{6,}/g, '0x…').replace(/\d{3,}/g, 'N').slice(0, 140);
    errCounts.set(k, (errCounts.get(k) || 0) + 1);
  }
  const topErrors = [...errCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  const sha = sh('git log -1 --format="%h %s"');
  const deploy = sh('tail -n 1 deploy/auto-deploy.log').replace(/<[^>]+>/g, '').slice(0, 160);
  const stamp = new Date(now).toLocaleString('en-CA', { timeZone: 'America/Toronto', hour12: false });

  const body = [
    `## ${running ? '🟢 Bot running' : '🔴 Bot NOT running'}`,
    `_Updated ${stamp} (Toronto). Covers the last ${Math.round((now - (state.lastRun || now)) / 60000) || EVERY_MIN} min. Refreshes every ${EVERY_MIN} min._`,
    '',
    '### Bot',
    `- Up ${upMin} min · ${memMb} MB memory · ${restartsSince} restart(s) since last report`,
    `- Code: \`${sha}\``,
    `- Last deploy: ${deploy || 'n/a'}`,
    '',
    '### Chains',
    ...chains.map((c) => `- ${chainLine(c)}`),
    '',
    '### Robinhood',
    `- Pool scan: ${lastScan}`,
    `- New pairs picked up this window: ${newPairs.length ? newPairs.slice(0, 10).join(', ') : 'none'}`,
    `- Trades that needed a pool lookup: ${poolLookups}`,
    `- Real-chain test runs: ${simProfit} profitable · ${simLoss} losing · ${simFail} would fail`,
    '',
    '### Errors this window',
    ...(topErrors.length ? topErrors.map(([m, n]) => `- ${n}x \`${m.replace(/`/g, "'")}\``) : ['- none']),
    '',
    '<sub>Posted by deploy/status-report.js on the server. Shadow mode: no real trades.</sub>',
  ].join('\n');

  const res = await fetch(`https://api.github.com/repos/${REPO}/issues/${ISSUE}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'arb-status' },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) { console.error(`[status] GitHub said ${res.status}: ${(await res.text()).slice(0, 200)}`); return; }

  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastRun: now, out: out.size, err: err.size, restarts }));
  console.log(`[status] updated issue #${ISSUE}`);
}

main().catch((e) => console.error('[status] failed:', e.message));
