import { scrub, collectSecrets } from '../core/logSanitizer';
import { redact } from '../config/robinhoodEndpoints';
import { makeError } from 'ethers';

// Checks that API keys, tokens and private keys never survive into log text,
// including inside ethers error messages (which embed the request URL).

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// Fake values only (never real secrets in tests).
const env = {
  ROBINHOOD_RPC_HTTP: 'https://robinhood-mainnet.g.alchemy.com/v2/FAKEalchemyKey1234567890',
  QUICKNODE_URL: 'https://name.robinhood.quiknode.pro/fakequicknodekey0123456789abcdef/',
  TELEGRAM_BOT_TOKEN: '1234567890:FAKEtelegramTokenAbcdefghijklmnopqrstu',
  BOT_PRIVATE_KEY: '0x' + 'ab'.repeat(32),
  ROBINHOOD_SEND_RPC: 'https://sequencer.mainnet.chain.robinhood.com', // public, no secret
  CHAINS: 'robinhood',
};
const secrets = collectSecrets(env);

const err = makeError('server response 429', 'SERVER_ERROR', { info: { requestUrl: env.ROBINHOOD_RPC_HTTP, responseStatus: '429' } } as any);
const out = scrub(`[pairs] failed: ${err.message}`, secrets);
assert(!out.includes('FAKEalchemyKey1234567890'), 'Alchemy key removed from an ethers error message');
assert(out.includes('server response 429'), 'the useful part of the error is kept');

assert(!scrub(`url ${env.QUICKNODE_URL}`, secrets).includes('fakequicknodekey'), 'QuickNode key with trailing slash removed');
assert(!scrub(`token ${env.TELEGRAM_BOT_TOKEN}`, secrets).includes('FAKEtelegram'), 'Telegram token removed');
assert(!scrub(`pk=${env.BOT_PRIVATE_KEY}`, secrets).includes('abababab'), 'private key removed');
assert(scrub('sending to https://sequencer.mainnet.chain.robinhood.com', secrets).includes('sequencer.mainnet'), 'public URLs stay readable');
assert(scrub('tx 0x' + '12'.repeat(32), secrets).includes('0x1212'), 'tx hashes are not scrubbed');

// Pattern fallback for keys not in env (e.g. a URL typed elsewhere).
assert(!scrub('https://x.example.com/rpc?apikey=SomeLongKey12345', []).includes('SomeLongKey'), 'query-string apikey removed');
assert(!scrub('https://foo.quiknode.pro/0123456789abcdef0123456789abcdef/', []).includes('0123456789abcdef'), 'long path segment removed by pattern');

// redact() for URLs logged on purpose.
assert(!redact(env.QUICKNODE_URL).includes('fakequicknodekey'), 'redact() handles trailing slash');
assert(!redact('https://x.io/rpc?key=abcdefghijklmnop').includes('abcdefghijklmnop'), 'redact() handles query keys');
assert(redact(env.ROBINHOOD_RPC_HTTP).includes('alchemy.com'), 'redact() keeps the host');
