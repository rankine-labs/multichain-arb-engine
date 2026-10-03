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

const testDir = join(__dirname, '..', '.test-build', 'test');
const files = readdirSync(testDir).filter(f => f.endsWith('.test.js')).sort();

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
