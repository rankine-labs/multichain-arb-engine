import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FastSender, InflightMarker } from '../execution/fastSender';

// DEPLOY LOCK (deploy/auto-deploy.sh): checks the decision logic with fake
// .env / state files in a temp folder. Never touches the real bot folder,
// data/ or pm2 (this test also runs on the server during a deploy).

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// Compiled to .test-build/test/, so the repo is two folders up.
const SCRIPT = join(__dirname, '..', '..', 'deploy', 'auto-deploy.sh');
const tmp = mkdtempSync(join(tmpdir(), 'deploylock-'));

// Runs one helper from auto-deploy.sh (loaded with AUTO_DEPLOY_FUNCTIONS_ONLY=1,
// which stops the script right after the helpers) and returns what it printed.
function helper(call: string, extraEnv: Record<string, string> = {}): string {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', AUTO_DEPLOY_FUNCTIONS_ONLY: '1', ...extraEnv };
  const r = spawnSync('bash', ['-c', `source "$1" || exit 9; ${call}`, 'test', SCRIPT], { env, encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) console.error(`helper "${call}" exited ${r.status}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

try {
  // --- the script itself parses (a syntax error would break every deploy) ---
  const syntax = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert(syntax.status === 0, `auto-deploy.sh has no syntax errors ${syntax.stderr ?? ''}`);
  // Loading the helpers must not run any deploy step (no lock file, no git).
  assert(helper('echo loaded') === 'loaded', 'helpers load without running the deploy');

  const app = (name: string, env: string | null) => {
    const d = join(tmp, name);
    mkdirSync(d, { recursive: true });
    if (env !== null) writeFileSync(join(d, '.env'), env);
    return d;
  };
  const decide = (dir: string, force = 0, extra: Record<string, string> = {}) => helper(`deploy_decision "${dir}" ${force}`, extra);

  // --- practice mode: exactly as before ---
  assert(decide(app('noenv', null)) === 'practice', 'no .env -> practice (deploys as always)');
  assert(decide(app('off', 'EXECUTION_ENABLED=false\n')) === 'practice', 'EXECUTION_ENABLED=false -> practice');
  assert(decide(app('unset', 'TELEGRAM_CHAT_ID=1\n')) === 'practice', 'EXECUTION_ENABLED missing -> practice');
  assert(decide(app('commented', '# EXECUTION_ENABLED=true\n')) === 'practice', 'commented-out line is ignored');

  // --- live: locked ---
  const live = app('live', 'BOT_PRIVATE_KEY=0xnotreal\nEXECUTION_ENABLED=true\nLIVE_SEND_CONFIRM=yes-real-money\n');
  assert(decide(live) === 'locked', 'EXECUTION_ENABLED=true -> locked');
  assert(decide(app('quoted', 'EXECUTION_ENABLED="true"  # live from Friday\n')) === 'locked', 'quotes + trailing comment still read as live');
  assert(decide(app('caps', 'EXECUTION_ENABLED=TRUE\n')) === 'locked', 'any capitals lock (errs on the safe side)');
  assert(decide(app('lastwins', 'EXECUTION_ENABLED=false\nEXECUTION_ENABLED=true\n')) === 'locked', 'last line wins, like the bot');
  assert(decide(app('lastwins2', 'EXECUTION_ENABLED=true\nEXECUTION_ENABLED=false\n')) === 'practice', 'last line wins (switched back off)');

  // --- owner overrides ---
  assert(decide(live, 1) === 'override', '--force lets one deploy through while live');
  assert(decide(live, 0, { DEPLOY_WHILE_LIVE: '1' }) === 'override', 'DEPLOY_WHILE_LIVE=1 lets it through');
  assert(decide(live, 0, { DEPLOY_WHILE_LIVE: '0' }) === 'locked', 'DEPLOY_WHILE_LIVE=0 does not');
  writeFileSync(join(live, 'DEPLOY_ALLOW_LIVE'), '');
  assert(decide(live) === 'override', 'DEPLOY_ALLOW_LIVE file lets it through');
  rmSync(join(live, 'DEPLOY_ALLOW_LIVE'));
  assert(decide(live) === 'locked', 'locked again once the file is gone');

  // --- in-flight trades (data/inflight.json) ---
  const now = Math.floor(Date.now() / 1000);
  const f = join(tmp, 'inflight.json');
  const count = (extra: Record<string, string> = {}) => helper(`inflight_count "${f}" ${now}`, extra);
  assert(count() === '0', 'no inflight file -> 0 in flight');
  writeFileSync(f, '{"count":2,"since":"x","sinceMs":1}\n');
  assert(count() === '2', 'reads the count');
  writeFileSync(f, '{"count":0,"since":null,"sinceMs":0}\n');
  assert(count() === '0', 'count 0 -> clear');
  writeFileSync(f, 'garbage');
  assert(count() === '1', 'unreadable file counts as busy');
  writeFileSync(f, '{"count":3}');
  utimesSync(f, now - 600, now - 600);
  assert(count() === '0', 'file untouched for 10 min is stale -> 0 (crashed bot cannot block deploys forever)');

  // wait_for_no_inflight: gives up when busy, succeeds when clear.
  writeFileSync(f, '{"count":1}');
  const busy = spawnSync('bash', ['-c', `source "$1"; wait_for_no_inflight "$2" && echo clear || echo busy`, 'test', SCRIPT, f],
    { env: { PATH: process.env.PATH ?? '', AUTO_DEPLOY_FUNCTIONS_ONLY: '1', INFLIGHT_WAIT_SECONDS: '2' }, encoding: 'utf8' });
  assert(busy.stdout.trim() === 'busy', 'still in flight after the wait -> skip this round');
  writeFileSync(f, '{"count":0}');
  const clear = spawnSync('bash', ['-c', `source "$1"; wait_for_no_inflight "$2" && echo clear || echo busy`, 'test', SCRIPT, f],
    { env: { PATH: process.env.PATH ?? '', AUTO_DEPLOY_FUNCTIONS_ONLY: '1', INFLIGHT_WAIT_SECONDS: '2' }, encoding: 'utf8' });
  assert(clear.stdout.trim() === 'clear', 'nothing in flight -> restart allowed');

  // --- bot side: InflightMarker writes what auto-deploy reads ---
  const mf = join(tmp, 'data', 'inflight.json');
  const m = new InflightMarker(mf, () => 1_000_000);
  assert(existsSync(mf) && JSON.parse(readFileSync(mf, 'utf8')).count === 0, 'marker starts at 0 on bot start (no stale count after a crash)');
  m.add('0xa'); m.add('0xb');
  const two = JSON.parse(readFileSync(mf, 'utf8'));
  assert(two.count === 2 && two.sinceMs === 1_000_000, 'two live trades in flight, with start time');
  assert(helper(`inflight_count "${mf}" $(date +%s)`) === '2', 'auto-deploy reads the bot\'s file');
  m.remove('0xa'); m.remove('0xnot-ours');
  assert(JSON.parse(readFileSync(mf, 'utf8')).count === 1, 'receipt clears one; unknown hash ignored');
  m.remove('0xb');
  const zero = JSON.parse(readFileSync(mf, 'utf8'));
  assert(zero.count === 0 && zero.since === null, 'all receipts in -> 0');
  assert(!existsSync(mf + '.tmp'), 'no temp file left behind');

  // Practice mode: the sender never writes the file (behaviour as before).
  const savedLive = process.env.EXECUTION_ENABLED;
  delete process.env.EXECUTION_ENABLED;
  const dry = new FastSender({} as any, 4663);
  const df = join(tmp, 'dry', 'inflight.json');
  dry.trackInflight(df); dry.settled('0xa');
  assert(!dry.live && !existsSync(df), 'practice mode writes no inflight file');
  if (savedLive !== undefined) process.env.EXECUTION_ENABLED = savedLive;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
