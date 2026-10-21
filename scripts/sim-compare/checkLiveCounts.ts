// ============================================================================
// COUNT CHECK (read only): did the live timing test (liveLatency) only count
// trades on OUR pools?
//
// Plain English: the timing test saw ~12 trades/s on our pools, but history
// says ~3/s. This takes a random sample of the trades it recorded
// (<dir>/per-trade.jsonl), reads each receipt, and counts how many really
// swapped on one of our pools (pairs on 2+ exchanges). If many did not, the
// node's push sent more than we asked for and the count was too high (the
// timing numbers are not affected: the delay is the same for any pool).
//
// Safety: reads only; from .env only CHAINSTACK_RPC_ROBINHOOD (never printed).
// Run: node .scripts-build/scripts/sim-compare/checkLiveCounts.js [--dir DIR] [--n 40]
// ============================================================================
import { readFileSync } from 'fs';
import { join } from 'path';
import { decodeSwapLog } from '../../src/core/followMoney';

const BOT_DIR = process.env.BOT_DIR || `${process.env.HOME}/multichain-arb-engine`;
const args = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const DIR = arg('dir', `${process.env.HOME}/sim-compare-runs/latency1`)!;
const N = Number(arg('n', '40'));
const lc = (s: string) => String(s ?? '').toLowerCase();
const url = readFileSync(join(BOT_DIR, '.env'), 'utf8').match(/^\s*CHAINSTACK_RPC_ROBINHOOD\s*=\s*["']?([^"'\s#]+)/m)?.[1];
if (!url) { console.error('CHAINSTACK_RPC_ROBINHOOD missing'); process.exit(1); }

const watch = JSON.parse(readFileSync(join(BOT_DIR, 'data', 'watched-pools.json'), 'utf8'));
const byPair = new Map<string, any[]>();
for (const p of watch.pools || []) if (p?.chain === 'robinhood' && p.poolAddress && p.tokenA && p.tokenB) { const k = [lc(p.tokenA), lc(p.tokenB)].sort().join('/'); (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(p); }
const ours = new Set<string>();
for (const l of byPair.values()) if (new Set(l.map((p) => p.dex)).size >= 2) for (const p of l) ours.add(lc(p.poolAddress));

async function main() {
  const rows = readFileSync(join(DIR, 'per-trade.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const sample = rows.sort(() => Math.random() - 0.5).slice(0, N);
  let onOurs = 0, notOurs = 0, noReceipt = 0;
  const strangers = new Map<string, number>();
  for (const r of sample) {
    const res: any = await (await fetch(url!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [r.h] }) })).json();
    if (!res.result) { noReceipt++; continue; }
    const pools = (res.result.logs as any[]).map((l) => decodeSwapLog(l)?.pool).filter(Boolean).map(lc);
    if (pools.some((p) => ours.has(p))) onOurs++; else { notOurs++; for (const p of pools) strangers.set(p, (strangers.get(p) ?? 0) + 1); }
  }
  console.log('SUMMARY ' + JSON.stringify({ recorded: rows.length, sampled: sample.length, onOurPools: onOurs, notOnOurPools: notOurs, noReceipt, topOtherPools: [...strangers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5) }));
}
main().catch((e) => { console.error('ERROR', e?.message ?? e); process.exit(1); });
