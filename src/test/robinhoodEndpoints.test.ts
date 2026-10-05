import { readCandidates, pickRobinhoodReadRpc, robinhoodSendRpc, alchemyKeyFrom, redact, ROBINHOOD_PUBLIC_RPC, ROBINHOOD_SEQUENCER_RPC } from '../config/robinhoodEndpoints';

// Checks endpoint choice: explicit setting first, then Alchemy from the key we
// already have, then public; a candidate only wins if it answers chain 4663.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

async function main() {
  const env = { AVALANCHE_ALCHEMY_WSS: 'wss://avax-mainnet.g.alchemy.com/v2/abcDEF123_-x' };
  assert(alchemyKeyFrom(env.AVALANCHE_ALCHEMY_WSS) === 'abcDEF123_-x', 'Alchemy key read from the Avalanche URL');
  const c = readCandidates(env);
  assert(c[0].url === 'https://robinhood-mainnet.g.alchemy.com/v2/abcDEF123_-x' && c[1].url === ROBINHOOD_PUBLIC_RPC, 'Alchemy Robinhood URL built, public as fallback');
  assert(readCandidates({ ROBINHOOD_RPC_HTTP: 'https://my.node', ...env })[0].url === 'https://my.node', 'explicit ROBINHOOD_RPC_HTTP comes first');

  const answers = (chainId: string | null) => (async () => ({ json: async () => (chainId ? { result: chainId } : { error: { message: 'network not enabled' } }) })) as unknown as typeof fetch;
  assert((await pickRobinhoodReadRpc(env, answers('0x1237'), 0)).label === 'Alchemy (your key)', 'Alchemy used when it answers chain 4663');
  assert((await pickRobinhoodReadRpc(env, answers(null), 0)).url === ROBINHOOD_PUBLIC_RPC, 'falls back to public when Alchemy refuses (network not enabled)');
  assert((await pickRobinhoodReadRpc(env, answers('0xa86a'), 0)).url === ROBINHOOD_PUBLIC_RPC, 'wrong chain -> not used');
  const throws = (async () => { throw new Error('timeout'); }) as unknown as typeof fetch;
  assert((await pickRobinhoodReadRpc(env, throws, 0)).url === ROBINHOOD_PUBLIC_RPC, 'unreachable auto-found key -> public');

  // Your own ROBINHOOD_RPC_HTTP: a blip at startup must not drop it.
  const mine = { ROBINHOOD_RPC_HTTP: 'https://robinhood-mainnet.g.alchemy.com/v2/MYKEY123' };
  const origWarn = console.warn; console.warn = () => {};
  assert((await pickRobinhoodReadRpc(mine, throws, 0)).url === mine.ROBINHOOD_RPC_HTTP, 'your ROBINHOOD_RPC_HTTP kept even if the startup check fails');
  console.warn = origWarn;
  assert((await pickRobinhoodReadRpc(mine, answers('0xa86a'), 0)).url === ROBINHOOD_PUBLIC_RPC, 'your ROBINHOOD_RPC_HTTP skipped only if it is the wrong chain');
  // Second try succeeds after a blip.
  let n = 0;
  const flaky = (async () => { if (n++ === 0) throw new Error('blip'); return { json: async () => ({ result: '0x1237' }) }; }) as unknown as typeof fetch;
  assert((await pickRobinhoodReadRpc(env, flaky, 0)).label === 'Alchemy (your key)' && n === 2, 'retries after a blip');

  assert(robinhoodSendRpc({}) === ROBINHOOD_SEQUENCER_RPC && robinhoodSendRpc({ ROBINHOOD_SEND_RPC: 'https://x' }) === 'https://x', 'sends to the sequencer unless overridden');
  assert(!redact('https://robinhood-mainnet.g.alchemy.com/v2/abcDEF123_-x').includes('abcDEF'), 'API key hidden in logs');
}
main().catch((e) => { console.error('FAIL: crashed', e); process.exitCode = 1; });
