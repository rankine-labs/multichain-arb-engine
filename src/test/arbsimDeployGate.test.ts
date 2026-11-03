import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

// ARBSIM DEPLOY GATE (Nov 3): "keep the old arbsim running until the new
// program is downloaded and ready, then swap with one quick restart".
//
// Plain English: checks, in a temp folder only (never the real bot folder,
// GitHub or pm2; this test also runs on the server during a deploy):
//   1. auto-deploy.sh's rule: go / wait / timeout, and that 0 = old way;
//   2. arbsim-update.sh --prefetch against a FAKE "GitHub" (a local git
//      repo with an arbsim-bin branch) and a FAKE pm2 (records calls):
//        - not built yet -> exit 20, nothing touched, no second download
//          of the same build
//        - built -> staged in bin/.arbsim-staged, the running program and
//          pm2 untouched
//        - after the "deploy" (sim/ changed): the normal update installs
//          the staged program by renaming (no download) and restarts once
//        - LOCAL_SIM off -> exit 21 (nothing to wait for)
//        - bad checksum -> exit 1, nothing staged

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// Compiled to .test-build/test/, so the repo is two folders up.
const DEPLOY = join(__dirname, '..', '..', 'deploy');
const AUTO = join(DEPLOY, 'auto-deploy.sh');
const UPDATE = join(DEPLOY, 'arbsim-update.sh');
const tmp = mkdtempSync(join(tmpdir(), 'arbsimgate-'));

function sh(cmd: string, cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', cmd], {
    cwd, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...env },
  });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function decide(rc: number, now: number, first: string, waitMin: string): string {
  const r = spawnSync('bash', ['-c', `source "$1" || exit 9; arbsim_wait_decision ${rc} ${now} "${first}" "${waitMin}"`, 'test', AUTO], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', AUTO_DEPLOY_FUNCTIONS_ONLY: '1' }, encoding: 'utf8', timeout: 20_000,
  });
  return (r.stdout ?? '').trim();
}

try {
  // ---- 1. the rule ----
  assert(spawnSync('bash', ['-n', UPDATE]).status === 0, 'arbsim-update.sh has no syntax errors');
  assert(decide(0, 1000, '', '30') === 'go', 'program staged -> deploy now');
  assert(decide(21, 1000, '', '30') === 'go', 'LOCAL_SIM off / pinned -> nothing to wait for');
  assert(decide(20, 1000, '', '30') === 'wait', 'not built yet, wait just starting -> wait');
  assert(decide(20, 1000 + 29 * 60, '1000', '30') === 'wait', 'not built after 29 of 30 min -> still wait');
  assert(decide(20, 1000 + 30 * 60, '1000', '30') === 'timeout', 'not built after 30 min -> deploy the old way');
  assert(decide(1, 1000 + 60, '1000', '30') === 'wait', 'a broken build waits (until the time limit), never deploys over the sidecar early');
  assert(decide(20, 1000, '', '0') === 'go', 'ARBSIM_DEPLOY_WAIT_MIN=0 -> the old behaviour (never wait)');
  assert(decide(20, 1000 + 60, '1000', 'abc') === 'wait', 'a garbled setting falls back to the 30 min default');

  // ---- 2. prefetch / staged install, with a fake GitHub and fake pm2 ----
  const hasGit = sh('git --version', tmp).code === 0;
  if (!hasGit) {
    console.log('SKIP: no git on this machine (prefetch part)');
  } else {
    // The bot folder: a git repo with deploy/ (copied) and sim/.
    const app = join(tmp, 'app');
    mkdirSync(join(app, 'deploy'), { recursive: true });
    mkdirSync(join(app, 'sim'), { recursive: true });
    for (const f of ['arbsim-lib.sh', 'arbsim-update.sh', 'arbsim-pm2.sh']) {
      writeFileSync(join(app, 'deploy', f), readFileSync(join(DEPLOY, f)));
    }
    writeFileSync(join(app, '.env'), 'LOCAL_SIM=shadow\n');
    writeFileSync(join(app, '.gitignore'), '.env\nbin/\n');
    writeFileSync(join(app, 'sim', 'code.rs'), 'old\n');
    sh('git init -q -b main . && git add -A && git commit -qm old', app);
    const oldTree = sh('git rev-parse HEAD:sim', app).out;
    // What the NEXT commit's sim/ will be (not deployed yet).
    writeFileSync(join(app, 'sim', 'code.rs'), 'new\n');
    sh('git add -A && git commit -qm new && git branch next && git reset -q --hard HEAD~1', app);
    const newTree = sh('git rev-parse next:sim', app).out;
    assert(newTree !== '' && newTree !== oldTree, 'test setup: the next commit changes sim/');

    // A fake arbsim: prints the usage line and exits 2 (what smoke_test wants).
    const fakeBin = (tag: string) => `#!/bin/sh\necho "usage: arbsim serve (${tag})" >&2\nexit 2\n`;
    // The installed (running) program: built for the OLD code.
    const bin = join(app, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'arbsim'), fakeBin('old'));
    chmodSync(join(bin, 'arbsim'), 0o755);
    writeFileSync(join(bin, 'arbsim.build_info'), `sim_tree=${oldTree}\n`);

    // Fake GitHub: a repo whose arbsim-bin branch we publish builds to.
    const gh = join(tmp, 'gh');
    mkdirSync(gh, { recursive: true });
    sh('git init -q -b main . && git commit -q --allow-empty -m init', gh);
    const publish = (tree: string, tag: string, badSum = false) => {
      const body = fakeBin(tag);
      const sum = badSum ? '0'.repeat(64) : createHash('sha256').update(body).digest('hex');
      writeFileSync(join(tmp, 'arbsim.pub'), body);
      sh(`git checkout -q -B arbsim-bin && git rm -q -rf --ignore-unmatch . >/dev/null; cp ../arbsim.pub arbsim && chmod 755 arbsim && printf '%s  arbsim\\n' ${sum} > arbsim.sha256 && printf 'sim_tree=%s\\nsource_commit=abc1234\\n' ${tree} > BUILD_INFO && git add -A && git commit -qm build-${tag} && git checkout -q main`, gh);
    };

    // Fake pm2: records every call; "jlist" says arbsim is online.
    const fakePath = join(tmp, 'fakebin');
    mkdirSync(fakePath, { recursive: true });
    const pm2Log = join(tmp, 'pm2.log');
    writeFileSync(join(fakePath, 'pm2'), `#!/bin/sh\necho "$*" >> "${pm2Log}"\nif [ "$1" = jlist ]; then echo '[{"name":"arbsim","pm2_env":{"status":"online","max_memory_restart":1887436800,"kill_timeout":30000}}]'; fi\nexit 0\n`);
    chmodSync(join(fakePath, 'pm2'), 0o755);
    const env = { APP_DIR: app, ARBSIM_REMOTE: gh, PATH: `${fakePath}:${process.env.PATH}` };
    const pm2Calls = () => (existsSync(pm2Log) ? readFileSync(pm2Log, 'utf8') : '');
    const update = (args: string) => sh(`bash deploy/arbsim-update.sh ${args}`, app, env);

    // (a) GitHub has only the OLD build: not ready, nothing touched.
    publish(oldTree, 'old');
    let r = update(`--prefetch ${newTree}`);
    assert(r.code === 20, `not built yet -> exit 20 (got ${r.code} ${r.err})`);
    assert(!existsSync(join(bin, '.arbsim-staged')), 'nothing staged');
    assert(readFileSync(join(bin, 'arbsim'), 'utf8').includes('(old)'), 'running program untouched');
    assert(!/restart|delete|start /.test(pm2Calls()), 'pm2 not restarted / stopped while waiting');
    // Same GitHub build again: answered from the note, no new download.
    r = update(`--prefetch ${newTree}`);
    assert(r.code === 20, 'asked again (same build): still 20');
    assert(sh('ls bin | grep -c arbsim-pf', app).out === '0', 'no download folder left behind');

    // (b) A bad build (checksum wrong): exit 1, nothing staged.
    publish(newTree, 'new', true);
    r = update(`--prefetch ${newTree}`);
    assert(r.code === 1, `bad checksum -> exit 1 (got ${r.code})`);
    assert(!existsSync(join(bin, '.arbsim-staged')), 'bad build not staged');

    // (c) The good build appears: staged, running program + pm2 untouched.
    publish(newTree, 'new');
    r = update(`--prefetch ${newTree}`);
    assert(r.code === 0, `built -> exit 0 (got ${r.code} ${r.err})`);
    assert(readFileSync(join(bin, '.arbsim-staged', 'arbsim'), 'utf8').includes('(new)'), 'new program staged in bin/.arbsim-staged');
    assert(readFileSync(join(bin, 'arbsim'), 'utf8').includes('(old)'), 'running program still the old one');
    assert(!/restart|delete|start /.test(pm2Calls()), 'pm2 still untouched after the prefetch');
    assert(update(`--prefetch ${newTree}`).code === 0, 'asked again: ready (no new download needed)');

    // (d) The deploy pulls the new code; the normal update swaps it in
    //     from the staged copy WITHOUT GitHub (remote made unreachable).
    sh('git merge -q --ff-only next', app);
    const r2 = sh('bash deploy/arbsim-update.sh', app, { ...env, ARBSIM_REMOTE: join(tmp, 'no-such-remote') });
    assert(r2.code === 10, `installed after the deploy -> exit 10 (got ${r2.code} ${r2.out} ${r2.err})`);
    assert(readFileSync(join(bin, 'arbsim'), 'utf8').includes('(new)'), 'bin/arbsim is the new program');
    assert(readFileSync(join(bin, 'arbsim.prev'), 'utf8').includes('(old)'), 'old program kept as bin/arbsim.prev (rollback)');
    assert(readFileSync(join(bin, 'arbsim.build_info'), 'utf8').includes(newTree), 'build info names the new sim/ code');
    assert(!existsSync(join(bin, '.arbsim-staged')), 'staged copy used up');
    assert(/installed the prefetched program/.test(r2.out), 'log says it came from the prefetch (no download)');
    assert((pm2Calls().match(/^restart arbsim/gm) ?? []).length === 1, `exactly one quick pm2 restart of arbsim (calls: ${pm2Calls().replace(/\n/g, ' | ')})`);
    assert(!/^delete arbsim/m.test(pm2Calls()), 'arbsim never taken out of pm2');

    // (e) LOCAL_SIM off: nothing to wait for.
    writeFileSync(join(app, '.env'), 'LOCAL_SIM=off\n');
    assert(update(`--prefetch ${oldTree}x`).code === 21, 'LOCAL_SIM off -> exit 21 (deploy does not wait)');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
