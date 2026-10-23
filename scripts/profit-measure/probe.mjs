// ============================================================================
// PROFIT MEASURE - step 0 probe (read-only).
//
// Plain English:
//   Before the big measurement we check what the PUBLIC Robinhood node can
//   give us: how far back it still has swap logs and receipts, whether it
//   accepts batched requests, how fast we may ask, and whether the public
//   explorer (Blockscout) answers from GitHub's machines. Nothing is sent,
//   nothing is signed. Writes results/profit-measure/probe.json.
// ============================================================================
import { writeFileSync, mkdirSync } from 'fs';

const RPC = process.env.PM_RPC || 'https://rpc.mainnet.chain.robinhood.com';
const OUT = 'results/profit-measure';
const SWAP_V3 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const SWAP_V4 = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';            // Uniswap V4 PoolManager
const V4_INIT = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const OUR_SENDER = '0x09b4fb908ff646afa9c9878c082add7e4b3784d6';
const OUR_EXEC = '0x7e0f847dd429e7c15ab08686d28710389c1f7837';
const hex = (n) => '0x' + n.toString(16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { rpc: 'public node', at: new Date().toISOString(), checks: {} };

// One JSON-RPC call; returns {ok, result|error, ms}.
async function call(method, params, timeout = 30000) {
  const t = Date.now();
  try {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeout) });
    const txt = await r.text();
    let j; try { j = JSON.parse(txt); } catch { return { ok: false, error: `HTTP ${r.status} ${txt.slice(0, 160)}`, ms: Date.now() - t }; }
    if (j.error) return { ok: false, error: JSON.stringify(j.error).slice(0, 240), ms: Date.now() - t };
    return { ok: true, result: j.result, ms: Date.now() - t };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 200), ms: Date.now() - t }; }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const latestN = parseInt((await call('eth_blockNumber', [])).result, 16);
  const latest = (await call('eth_getBlockByNumber', [hex(latestN), false])).result;
  const old = (await call('eth_getBlockByNumber', [hex(latestN - 100000), false])).result;
  const bps = old ? 100000 / (parseInt(latest.timestamp, 16) - parseInt(old.timestamp, 16)) : null;
  out.latest = { block: latestN, ts: parseInt(latest.timestamp, 16), blocksPerSec: bps };

  // History depth: at each age, can we read logs, a receipt and the block?
  const ages = [0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24, 36, 48, 72, 168];
  out.checks.history = [];
  for (const h of ages) {
    const b = latestN - Math.round(h * 3600 * (bps ?? 10));
    const blk = await call('eth_getBlockByNumber', [hex(b), true]);
    const logs = await call('eth_getLogs', [{ fromBlock: hex(b), toBlock: hex(b + 50), topics: [[SWAP_V3, SWAP_V4]] }]);
    let rc = null;
    const tx = blk.ok && blk.result?.transactions?.find((t) => t.to);
    if (tx) rc = await call('eth_getTransactionReceipt', [tx.hash]);
    const br = await call('eth_getBlockReceipts', [hex(b)]);
    const nonce = await call('eth_getTransactionCount', [OUR_SENDER, hex(b)]);
    out.checks.history.push({ hoursAgo: h, block: b, block_ok: blk.ok && !!blk.result, ts: blk.result ? parseInt(blk.result.timestamp, 16) : null,
      txs: blk.result?.transactions?.length ?? null, logs_ok: logs.ok, logs_n: logs.ok ? logs.result.length : logs.error,
      receipt_ok: rc ? rc.ok && !!rc.result : 'no tx', blockReceipts_ok: br.ok ? (br.result ? br.result.length : 'null') : br.error,
      ourNonce: nonce.ok ? parseInt(nonce.result, 16) : nonce.error });
    console.log(JSON.stringify(out.checks.history.at(-1)));
  }

  // Big log ranges: how many blocks of swap logs in one call?
  out.checks.logRange = [];
  for (const span of [500, 2000, 5000, 20000]) {
    const r = await call('eth_getLogs', [{ fromBlock: hex(latestN - 30000), toBlock: hex(latestN - 30000 + span), topics: [[SWAP_V3, SWAP_V4]] }], 60000);
    out.checks.logRange.push({ span, ok: r.ok, n: r.ok ? r.result.length : r.error, ms: r.ms });
  }
  // V4 pool creation events, whole history (needed to name V4 pools).
  const init = await call('eth_getLogs', [{ address: PM, fromBlock: '0x0', toBlock: hex(latestN), topics: [V4_INIT] }], 90000);
  out.checks.v4InitAll = { ok: init.ok, n: init.ok ? init.result.length : init.error, ms: init.ms };
  // Our executor's logs over recent history (does it emit anything?).
  const ex = await call('eth_getLogs', [{ address: OUR_EXEC, fromBlock: hex(latestN - 400000), toBlock: hex(latestN) }], 60000);
  out.checks.ourExecutorLogs = { ok: ex.ok, n: ex.ok ? ex.result.length : ex.error, sample: ex.ok ? ex.result.slice(0, 3) : null };

  // Batches: 20 receipts in one request.
  const blk = (await call('eth_getBlockByNumber', [hex(latestN - 2000), true])).result;
  const hs = (blk?.transactions ?? []).slice(0, 20).map((t) => t.hash);
  const t0 = Date.now();
  try {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(hs.map((h, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'eth_getTransactionReceipt', params: [h] }))) });
    const j = await r.json();
    out.checks.batch = { asked: hs.length, answers: Array.isArray(j) ? j.length : 'not array', errors: Array.isArray(j) ? j.filter((x) => x.error).map((x) => x.error.message).slice(0, 3) : JSON.stringify(j).slice(0, 200), ms: Date.now() - t0 };
  } catch (e) { out.checks.batch = { error: String(e) }; }

  // Rate: 60 single calls at about 20 per second, count refusals.
  const res = [];
  for (let i = 0; i < 60; i++) { res.push(call('eth_blockNumber', [])); await sleep(50); }
  const all = await Promise.all(res);
  out.checks.rate20 = { ok: all.filter((x) => x.ok).length, errors: [...new Set(all.filter((x) => !x.ok).map((x) => x.error))].slice(0, 3) };

  // Explorer (Blockscout) from here?
  for (const [k, u] of [['blockscoutStats', 'https://robinhoodchain.blockscout.com/api/v2/stats'],
    ['blockscoutSenderTxs', `https://robinhoodchain.blockscout.com/api/v2/addresses/${OUR_SENDER}/transactions`],
    ['blockscoutSenderCounters', `https://robinhoodchain.blockscout.com/api/v2/addresses/${OUR_SENDER}/counters`]]) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
      const txt = await r.text();
      out.checks[k] = { status: r.status, body: txt.slice(0, k === 'blockscoutSenderTxs' ? 3000 : 600) };
    } catch (e) { out.checks[k] = { error: String(e).slice(0, 200) }; }
  }
  writeFileSync(`${OUT}/probe.json`, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1).slice(0, 6000));
}
main().catch((e) => { console.error(e); process.exit(1); });
