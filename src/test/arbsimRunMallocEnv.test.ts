import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, copyFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ARBSIM RUNNER, MALLOC_* PASS-THROUGH (fix 13, Nov 2): deploy/arbsim-run.sh
// now passes four glibc malloc tuning names from .env to arbsim (only plain
// numbers). Runs the real script against a temp bot folder with a fake
// bin/arbsim that prints what it received. Never touches the real bot folder,
// pm2 or the real program.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// Compiled to .test-build/test/, so the repo is two folders up.
const DEPLOY = join(__dirname, '..', '..', 'deploy');
const tmp = mkdtempSync(join(tmpdir(), 'arbsimrun-'));

// Prints the MALLOC_* / ARBSIM_ALLOC values the fake program got, one per line.
const NAMES = ['MALLOC_ARENA_MAX', 'MALLOC_MMAP_THRESHOLD_', 'MALLOC_TRIM_THRESHOLD_', 'MALLOC_TOP_PAD_', 'MALLOC_PERTURB_', 'ARBSIM_ALLOC',
  // Keeper thrift (Nov 3): its switches must reach arbsim too.
  'FASTLANE_AHEAD_KEEP_THRIFT', 'FASTLANE_AHEAD_KEEP_UNITS_DAY', 'FASTLANE_AHEAD_KEEP_SEED_GATHER_MS'];

function run(env: string, inherited: Record<string, string> = {}): Record<string, string> {
  const app = mkdtempSync(join(tmp, 'app-'));
  // The runner lives in <app>/deploy and finds the bot folder one up.
  mkdirSync(join(app, 'deploy'));
  for (const f of ['arbsim-run.sh', 'arbsim-lib.sh']) copyFileSync(join(DEPLOY, f), join(app, 'deploy', f));
  mkdirSync(join(app, 'bin'));
  const fake = join(app, 'bin', 'arbsim');
  writeFileSync(fake, `#!/usr/bin/env bash\nfor n in ${NAMES.join(' ')}; do echo "$n=\${!n-<unset>}"; done\n`);
  chmodSync(fake, 0o755);
  writeFileSync(join(app, 'bin', 'arbsim.build_info'), 'source_commit=0000000test\n');
  writeFileSync(join(app, '.env'), env);
  const r = spawnSync('bash', [join(app, 'deploy', 'arbsim-run.sh')], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ARBSIM_SOCKET: join(app, 'test.sock'), ...inherited },
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (r.status !== 0) console.error(`runner exited ${r.status}: ${r.stderr}`);
  const out: Record<string, string> = {};
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

try {
  const syntax = spawnSync('bash', ['-n', join(DEPLOY, 'arbsim-run.sh')], { encoding: 'utf8' });
  assert(syntax.status === 0, `arbsim-run.sh has no syntax errors ${syntax.stderr ?? ''}`);

  // Nothing in .env: exactly as before (2 arenas, the rest unset).
  const none = run('ARBSIM_ALLOC=system\n');
  assert(none.MALLOC_ARENA_MAX === '2', `default MALLOC_ARENA_MAX stays 2 (got ${none.MALLOC_ARENA_MAX})`);
  assert(none.MALLOC_MMAP_THRESHOLD_ === '<unset>', 'MALLOC_MMAP_THRESHOLD_ not set when .env has none');
  assert(none.ARBSIM_ALLOC === 'system', 'ARBSIM_* lines still pass as before');

  // The four names pass, with quotes / comments stripped like other lines.
  const all = run('MALLOC_ARENA_MAX=1\nMALLOC_MMAP_THRESHOLD_="262144"  # big blocks own mapping\nexport MALLOC_TRIM_THRESHOLD_=67108864\nMALLOC_TOP_PAD_=0\n');
  assert(all.MALLOC_ARENA_MAX === '1', `.env MALLOC_ARENA_MAX wins over the default 2 (got ${all.MALLOC_ARENA_MAX})`);
  assert(all.MALLOC_MMAP_THRESHOLD_ === '262144', `MALLOC_MMAP_THRESHOLD_ passed (got ${all.MALLOC_MMAP_THRESHOLD_})`);
  assert(all.MALLOC_TRIM_THRESHOLD_ === '67108864', `MALLOC_TRIM_THRESHOLD_ passed with "export" (got ${all.MALLOC_TRIM_THRESHOLD_})`);
  assert(all.MALLOC_TOP_PAD_ === '0', `MALLOC_TOP_PAD_=0 passed (got ${all.MALLOC_TOP_PAD_})`);

  // Not a plain number: ignored. Other MALLOC_ names: never passed.
  const bad = run('MALLOC_MMAP_THRESHOLD_=256k\nMALLOC_ARENA_MAX=two\nMALLOC_PERTURB_=85\n');
  assert(bad.MALLOC_MMAP_THRESHOLD_ === '<unset>', 'non-number MALLOC_MMAP_THRESHOLD_ ignored');
  assert(bad.MALLOC_ARENA_MAX === '2', 'non-number MALLOC_ARENA_MAX ignored (default 2 kept)');
  assert(bad.MALLOC_PERTURB_ === '<unset>', 'names outside the list are never passed');

  // Keeper thrift switches (Nov 3) pass like the other keeper settings.
  const th = run('FASTLANE_AHEAD_KEEP_THRIFT=on\nFASTLANE_AHEAD_KEEP_UNITS_DAY=800000\n');
  assert(th.FASTLANE_AHEAD_KEEP_THRIFT === 'on', `FASTLANE_AHEAD_KEEP_THRIFT passed (got ${th.FASTLANE_AHEAD_KEEP_THRIFT})`);
  assert(th.FASTLANE_AHEAD_KEEP_UNITS_DAY === '800000', `FASTLANE_AHEAD_KEEP_UNITS_DAY passed (got ${th.FASTLANE_AHEAD_KEEP_UNITS_DAY})`);
  assert(th.FASTLANE_AHEAD_KEEP_SEED_GATHER_MS === '<unset>', 'a keeper name not in .env stays unset');

  // A value already in the environment is replaced only by a .env line.
  const inh = run('', { MALLOC_ARENA_MAX: '4' });
  assert(inh.MALLOC_ARENA_MAX === '4', `inherited MALLOC_ARENA_MAX kept when .env has none (got ${inh.MALLOC_ARENA_MAX})`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
