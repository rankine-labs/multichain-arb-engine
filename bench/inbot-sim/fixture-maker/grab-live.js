// ============================================================================
// REAL TEST-DATA GRABBER (runs on the EC2 server, READ ONLY)
//
// Plain English:
//   Takes the real trades the bot sent (data/live-trades.jsonl, "sent" lines),
//   and for each one asks our paid node two read-only questions:
//     1. "What exact state did this trade see?"  (debug_traceTransaction,
//        prestateTracer = every account and storage slot it touched, as it
//        was right before the trade ran, at its exact spot in the block)
//     2. "What did the contract answer?"         (callTracer = output + gas)
//   It saves one file per trade in the fixtures folder. The test engines must
//   then reproduce the chain's own answer from that file alone.
//
// Safety:
//   - Only reads. Sends nothing, signs nothing.
//   - From .env it reads ONLY the node URL lines listed in NODE_VARS below,
//     never the bot's key, and never prints a URL (they contain API keys).
//
// Run (on the server):  node grab-live.js [max=40]
// ============================================================================
const fs = require('fs');
const path = require('path');

const BOT_DIR = process.env.BOT_DIR || `${process.env.HOME}/multichain-arb-engine`;
const OUT = path.join(__dirname, '..', 'fixtures');
const MAX = Number(process.argv[2] || 40);
const NODE_VARS = ['SIM_RPC_ROBINHOOD', 'QUICKNODE_RPC_ROBINHOOD', 'ROBINHOOD_RPC_HTTP'];
const ARBSYS = '0x0000000000000000000000000000000000000064';

// Read just the node URL lines out of .env (nothing else is looked at).
function nodeUrls() {
  const urls = [];
  let text = '';
  try { text = fs.readFileSync(path.join(BOT_DIR, '.env'), 'utf8'); } catch { /* none */ }
  for (const v of NODE_VARS) {
    const fromEnv = process.env[v];
    const m = text.match(new RegExp(`^\\s*${v}\\s*=\\s*["']?([^"'\\s#]+)`, 'm'));
    const url = fromEnv || (m && m[1]);
    if (url && url.startsWith('http') && !urls.some((u) => u.url === url)) urls.push({ name: v, url });
  }
  return urls;
}

let id = 0;
async function rpc(url, method, params) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

// The "sent" trade hashes from the live log (newest file last).
function sentHashes() {
  const out = [];
  for (const f of ['live-trades.jsonl.1', 'live-trades.jsonl']) {
    let text = '';
    try { text = fs.readFileSync(path.join(BOT_DIR, 'data', f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      try { const r = JSON.parse(line); if (r.kind === 'sent' && r.hash) out.push({ hash: r.hash, label: r.label }); } catch { /* skip */ }
    }
  }
  return out;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const nodes = nodeUrls();
  if (!nodes.length) throw new Error(`no node URL found (looked for ${NODE_VARS.join(', ')})`);
  // Use the first node that supports the tracer we need.
  let node = null;
  const hashes = sentHashes();
  console.log(`found ${hashes.length} sent trades in the live log`);
  if (!hashes.length) return;
  for (const n of nodes) {
    try { await rpc(n.url, 'debug_traceTransaction', [hashes[0].hash, { tracer: 'prestateTracer' }]); node = n; break; }
    catch (e) { console.log(`node ${n.name}: tracer not usable (${e.message.slice(0, 80)})`); }
  }
  if (!node) throw new Error('no node supports debug_traceTransaction prestateTracer');
  console.log(`using node from ${node.name} (URL not shown)`);

  let saved = 0;
  for (const { hash, label } of hashes.slice(-MAX)) {
    try {
      const tx = await rpc(node.url, 'eth_getTransactionByHash', [hash]);
      if (!tx || !tx.blockNumber) { console.log(`${hash.slice(0, 12)}: not mined, skipped`); continue; }
      const blk = await rpc(node.url, 'eth_getBlockByNumber', [tx.blockNumber, false]);
      const pre = await rpc(node.url, 'debug_traceTransaction', [hash, { tracer: 'prestateTracer' }]);
      const ct = await rpc(node.url, 'debug_traceTransaction', [hash, { tracer: 'callTracer' }]);
      for (const k of Object.keys(pre)) if (k.toLowerCase() === ARBSYS) delete pre[k];
      for (const a of Object.values(pre)) { a.balance ??= '0x0'; a.nonce ??= 0; a.code ??= '0x'; a.storage ??= {}; }
      // Arbitrum: the NUMBER opcode gives the PARENT chain block (header.l1BlockNumber);
      // ArbSys.arbBlockNumber() gives the chain's own block (header.number).
      const fx = {
        name: `live-${tx.blockNumber}-${hash.slice(2, 10)}`,
        source: `Robinhood mainnet tx ${hash} (${label ?? ''}), block ${BigInt(tx.blockNumber)}, index ${BigInt(tx.transactionIndex)}`,
        chainId: 4663,
        block: { number: blk.l1BlockNumber ?? blk.number, timestamp: blk.timestamp, baseFee: blk.baseFeePerGas ?? '0x0',
          coinbase: blk.miner, gasLimit: blk.gasLimit, prevrandao: blk.mixHash ?? '0x' + '0'.repeat(64), difficulty: blk.difficulty ?? '0x1' },
        l2BlockNumber: blk.number,
        tx: { from: tx.from, to: tx.to, data: tx.input, gas: tx.gas, value: tx.value, gasPrice: '0x0' },
        prestate: pre,
        expected: { success: !ct.error, output: ct.output ?? '0x', gasUsed: ct.gasUsed, error: ct.error ?? null,
          note: 'real chain answer; Arbitrum gasUsed may include L1 posting gas, so compare output exactly and execution gas approximately' },
      };
      fs.writeFileSync(path.join(OUT, fx.name + '.json'), JSON.stringify(fx));
      saved++;
      console.log(`${fx.name}: ok, success=${fx.expected.success} out=${fx.expected.output.slice(0, 10)} gas=${BigInt(ct.gasUsed)} accounts=${Object.keys(pre).length}`);
    } catch (e) {
      console.log(`${hash.slice(0, 12)}: failed (${e.message.slice(0, 100)})`);
    }
  }
  console.log(`saved ${saved} real fixtures to ${OUT}`);
}
main().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
