// ============================================================================
// TEST RUNNER
// Runs every compiled test file in .test-build/test/ one at a time.
// Each test file prints PASS/FAIL lines and sets a non-zero exit code on any
// failure. This runner fails (exit 1) if ANY test file fails, so CI and the
// auto-deploy script can refuse to ship broken code.
//
// Usage: npm test   (compiles TypeScript first, then runs this)
// ============================================================================

const { readdirSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');

const { existsSync } = require('fs');
const testDir = join(__dirname, '..', '.test-build', 'test');
const srcDir = join(__dirname, '..', 'src', 'test');
// Only tests that still have a source file. The build folder is never wiped,
// so a deleted test's old compiled copy would otherwise keep running (Oct 9:
// a reverted feature's stale test failed the server's deploy check and
// blocked the revert itself).
const all = readdirSync(testDir).filter(f => f.endsWith('.test.js')).sort();
const files = all.filter(f => existsSync(join(srcDir, f.replace(/\.js$/, '.ts'))));
const stale = all.filter(f => !files.includes(f));
if (stale.length) console.log(`Skipping ${stale.length} stale compiled test(s) with no source: ${stale.join(', ')}`);

if (files.length === 0) {
  console.error('No test files found in', testDir);
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  console.log(`\n=== ${file}`);
  const result = spawnSync(process.execPath, [join(testDir, file)], { stdio: 'inherit' });
  if (result.status !== 0) {
    failed++;
    console.error(`>>> ${file} FAILED (exit ${result.status})`);
  }
}

console.log(`\n${files.length - failed}/${files.length} test files passed`);
process.exit(failed > 0 ? 1 : 0);
