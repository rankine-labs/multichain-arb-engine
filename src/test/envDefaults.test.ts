// Tests for config/envDefaults.ts: fill in missing settings from the saved
// Chainstack/QuickNode links, never override what .env already sets.
// (Each test file runs in its own process, so the import's side effect on
// process.env can't leak into other tests.)
import { applyEnvDefaults } from '../config/envDefaults';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const CS = 'https://robinhood-mainnet.core.chainstack.com/abc';
const QN = 'https://x.robinhood.quiknode.pro/def/';

// 1. Both links saved, nothing else set: everything filled in.
{
  const env: Record<string, string | undefined> = { CHAINSTACK_RPC_ROBINHOOD: CS, QUICKNODE_RPC_ROBINHOOD: QN };
  const notes = applyEnvDefaults(env);
  assert(env.CHECK_RPC_MAIN === CS && env.CHECK_RPC_MAIN_DAILY === '60000', 'checks move to Chainstack with a 60000/day allowance');
  assert(env.CHECK_RPC_FALLBACK === QN && env.CHECK_RPC_FALLBACK_DAILY === '14000', 'QuickNode becomes the backup with 14000/day');
  assert(env.LOOP_TRADER === '1', 'loop trader turned on');
  assert(notes.every((n) => !n.includes('http') && !n.includes('abc') && !n.includes('def')), 'notes never include the links or keys');
  assert(env.BLOCK_READER_WSS === undefined, 'WebSocket reader is NOT switched on');
}

// 2. Owner settings always win.
{
  const env: Record<string, string | undefined> = {
    CHAINSTACK_RPC_ROBINHOOD: CS, QUICKNODE_RPC_ROBINHOOD: QN,
    CHECK_RPC_MAIN: 'https://other.example/rpc', CHECK_RPC_MAIN_DAILY: '5', LOOP_TRADER: '0',
  };
  applyEnvDefaults(env);
  assert(env.CHECK_RPC_MAIN === 'https://other.example/rpc' && env.CHECK_RPC_MAIN_DAILY === '5', 'an existing CHECK_RPC_MAIN is left alone');
  assert(env.CHECK_RPC_FALLBACK === undefined, 'no fallback added when the owner chose the main node');
  assert(env.LOOP_TRADER === '0', 'LOOP_TRADER=0 keeps loops off');
}

// 3. No Chainstack link: checks unchanged (QuickNode/Alchemy as before).
{
  const env: Record<string, string | undefined> = { QUICKNODE_RPC_ROBINHOOD: QN };
  applyEnvDefaults(env);
  assert(env.CHECK_RPC_MAIN === undefined && env.CHECK_RPC_FALLBACK === undefined, 'without a Chainstack link nothing about checks changes');
}

// 4. Chainstack but no QuickNode: main only, no fallback.
{
  const env: Record<string, string | undefined> = { CHAINSTACK_RPC_ROBINHOOD: CS };
  applyEnvDefaults(env);
  assert(env.CHECK_RPC_MAIN === CS && env.CHECK_RPC_FALLBACK === undefined, 'Chainstack only: main set, no fallback');
}

// 5. Blank values count as not set.
{
  const env: Record<string, string | undefined> = { CHAINSTACK_RPC_ROBINHOOD: '  ', LOOP_TRADER: '' };
  applyEnvDefaults(env);
  assert(env.CHECK_RPC_MAIN === undefined && env.LOOP_TRADER === '1', 'blank Chainstack ignored; blank LOOP_TRADER treated as unset');
}
