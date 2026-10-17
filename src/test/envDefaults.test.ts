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
  assert(env.CHECK_RPC_MAIN === CS && env.CHECK_RPC_MAIN_DAILY === '120000', 'checks move to Chainstack with a 120000/day allowance');
  assert(env.CHECK_RPC_FALLBACK === QN && env.CHECK_RPC_FALLBACK_DAILY === '14000', 'QuickNode becomes the backup with 14000/day');
  assert(env.LOOP_TRADER === '0', 'loop trader off by default (Oct 14)');
  assert(env.FEED_DECODE_UR_V4 === '1', 'fuller Router V4 reader on by default (Oct 16)');
  assert(notes.every((n) => !n.includes('http') && !n.includes('abc') && !n.includes('def')), 'notes never include the links or keys');
  assert(env.BLOCK_READER_WSS === undefined, 'no WSS link saved: WebSocket reader not switched on');
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
  assert(env.CHECK_RPC_MAIN === undefined && env.LOOP_TRADER === '0', 'blank Chainstack ignored; blank LOOP_TRADER treated as unset (off)');
}

// 6. WSS link saved: WebSocket reader on; 'off' keeps it off; an explicit one wins.
{
  const env: Record<string, string | undefined> = { CHAINSTACK_WSS_ROBINHOOD: 'wss://cs.example/k' };
  const notes = applyEnvDefaults(env);
  assert(env.BLOCK_READER_WSS === 'wss://cs.example/k', 'WebSocket reader uses the saved Chainstack WSS link');
  assert(notes.every((n) => !n.includes('wss://')), 'WSS link never appears in the notes');
  const off: Record<string, string | undefined> = { CHAINSTACK_WSS_ROBINHOOD: 'wss://cs.example/k', BLOCK_READER_WSS: 'off' };
  applyEnvDefaults(off);
  assert(off.BLOCK_READER_WSS === undefined, 'BLOCK_READER_WSS=off keeps the WebSocket off');
  const own: Record<string, string | undefined> = { CHAINSTACK_WSS_ROBINHOOD: 'wss://cs.example/k', BLOCK_READER_WSS: 'wss://other.example/z' };
  applyEnvDefaults(own);
  assert(own.BLOCK_READER_WSS === 'wss://other.example/z', 'an explicit BLOCK_READER_WSS wins');
}

// 7. Owner can still turn loops on.
{
  const env: Record<string, string | undefined> = { LOOP_TRADER: '1', FEED_DECODE_UR_V4: '0' };
  applyEnvDefaults(env);
  assert(env.LOOP_TRADER === '1', 'LOOP_TRADER=1 in .env keeps loops on');
  assert(env.FEED_DECODE_UR_V4 === '0', 'FEED_DECODE_UR_V4=0 in .env keeps the fuller V4 reader off');
}
