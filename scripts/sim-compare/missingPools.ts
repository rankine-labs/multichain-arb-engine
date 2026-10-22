// ============================================================================
// MISSING POOLS (read only): which pools do rivals trade that the bot doesn't
// watch, what exactly are they, and would the bot find them with a setting?
//
// Plain English:
//   Reads a measureProfit --learn result (<dir>/per-arb.jsonl: each arbitrage
//   lists the pools we had to read from the chain, "learnedPools"). For every
//   such pool used in at least --min arbitrages:
//     - Uniswap V4 pool id: reads its exact settings (coins, fee, tick
//       spacing, hook) from a rival's own PoolManager call (callTracer), and
//       checks the settings hash to the pool id.
//     - pool contract: reads its coins and factory (which exchange made it).
//   Then says, per V4 pool without a hook, whether the bot's V4 finder already
//   looks up that fee/spacing (config/v4Tiers.ts). Pools at settings it does
//   NOT look up are the ones a RH_V4_MORE_TIERS line in .env would add.
//   Also counts, per pool, how our own replay did on it (from the same file).
//   Writes <dir>/missing-pools.json and prints a summary.
//
// Safety: reads only. From the bot's .env only CHAINSTACK_RPC_ROBINHOOD
// (never printed). Sends nothing.
//
// Run: node .scripts-build/scripts/sim-compare/missingPools.js --dir ~/sim-compare-runs/learn2 [--min 3]
// ============================================================================
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ethers } from 'ethers';
import { V4_LOOKUP_TIERS } from '../../src/config/v4Tiers';
import { ROBINHOOD_SCAN_FACTORIES, ROBINHOOD_TOKENS } from '../../src/config/knownAddresses';

const BOT_DIR = process.env.BOT_DIR || `${process.env.HOME}/multichain-arb-engine`;
const args = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const DIR = arg('dir', `${process.env.HOME}/sim-compare-runs/learn2`)!;
const MIN = Number(arg('min', '3'));
const lc = (s: string) => String(s ?? '').toLowerCase();
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const WETH = lc(ROBINHOOD_TOKENS.WETH), USDG = lc(ROBINHOOD_TOKENS.USDG);
const url = readFileSync(join(BOT_DIR, '.env'), 'utf8').match(/^\s*CHAINSTACK_RPC_ROBINHOOD\s*=\s*["']?([^"'\s#]+)/m)?.[1];
if (!url) { console.error('CHAINSTACK_RPC_ROBINHOOD missing'); process.exit(1); }
let rid = 0;
async function rpc(method: string, params: unknown[]): Promise<any> {
  try { return await (await fetch(url!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }), signal: AbortSignal.timeout(20_000) })).json(); }
  catch { return { error: { message: 'network' } }; }
}
const SWAP = new ethers.Interface(['function swap((address,address,uint24,int24,address) key,(bool,int256,uint160) params,bytes hookData)']);
const SWAP_SEL = SWAP.getFunction('swap')!.selector;
const POOL = new ethers.Interface(['function token0() view returns (address)', 'function token1() view returns (address)', 'function factory() view returns (address)', 'function fee() view returns (uint24)']);
const ERC20 = new ethers.Interface(['function symbol() view returns (string)']);
const FACTORY = new Map(ROBINHOOD_SCAN_FACTORIES.map((f) => [lc(f.factory), f.dex]));
const tiers = new Set(V4_LOOKUP_TIERS.map(([f, t]) => `${f}:${t}`));
const syms = new Map<string, string>();
async function sym(t: string): Promise<string> {
  t = lc(t); if (/^0x0+$/.test(t)) return 'ETH'; if (syms.has(t)) return syms.get(t)!;
  const r = await rpc('eth_call', [{ to: t, data: ERC20.encodeFunctionData('symbol') }, 'latest']);
  let s = t.slice(0, 8); try { s = String(ERC20.decodeFunctionResult('symbol', r.result)[0]).slice(0, 14); } catch { /* keep address */ }
  syms.set(t, s); return s;
}
async function call(to: string, fn: string): Promise<any> {
  const r = await rpc('eth_call', [{ to, data: POOL.encodeFunctionData(fn) }, 'latest']);
  try { return POOL.decodeFunctionResult(fn, r.result)[0]; } catch { return null; }
}

async function main() {
  const rows = readFileSync(join(DIR, 'per-arb.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // Per pool: arbitrages, one rival tx to read it from, our replay outcome.
  const per = new Map<string, { arbs: number; tx: string; supported: number; weProfit: number; ourNetUsd: number }>();
  for (const r of rows) for (const id of r.learnedPools ?? []) {
    const e = per.get(id) ?? { arbs: 0, tx: r.hash, supported: 0, weProfit: 0, ourNetUsd: 0 };
    e.arbs++;
    if (r.ours && r.ours.status !== 'not-ours') e.supported++;
    const w = r.ours?.withinCap; if (w?.status === 'profit' && (w.netUsd ?? 0) > 0) { e.weProfit++; e.ourNetUsd += w.netUsd; }
    per.set(id, e);
  }
  const out: any[] = [];
  for (const [id, e] of [...per.entries()].filter(([, e]) => e.arbs >= MIN).sort((a, b) => b[1].arbs - a[1].arbs)) {
    const o: any = { pool: id, arbs: e.arbs, ourRouteSupported: e.supported, weProfitAfterGas: e.weProfit, ourNetUsd: +e.ourNetUsd.toFixed(2) };
    if (id.length === 66) {
      const t = await rpc('debug_traceTransaction', [e.tx, { tracer: 'callTracer' }]);
      const calls: any[] = []; const walk = (c: any) => { if (!c) return; calls.push(c); for (const s of c.calls ?? []) walk(s); }; walk(t.result);
      for (const c of calls) {
        if (lc(c.to) !== PM || !String(c.input ?? '').startsWith(SWAP_SEL)) continue;
        let k: any; try { k = SWAP.decodeFunctionData('swap', c.input).key; } catch { continue; }
        const kid = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24', 'int24', 'address'], [k[0], k[1], k[2], k[3], k[4]]));
        if (lc(kid) !== id) continue;
        const fee = Number(k[2]), ts = Number(k[3]), hooked = !/^0x0+$/.test(lc(k[4]));
        const c0 = lc(k[0]), c1 = lc(k[1]);
        o.type = hooked ? 'V4 with hook' : 'V4 no hook';
        o.coins = `${await sym(c0)}/${await sym(c1)}`;
        o.fee = fee; o.tickSpacing = ts; o.hook = hooked ? lc(k[4]) : null;
        // The bot's V4 finder asks per pair against USDG or WETH (ETH), without hooks.
        const quoted = [c0, c1].some((x) => x === USDG || x === WETH || /^0x0+$/.test(x));
        o.botLooksUpThisSetting = !hooked && tiers.has(`${fee}:${ts}`);
        o.fixableWithMoreTiers = !hooked && quoted && !o.botLooksUpThisSetting;
        o.note = hooked ? 'hooked: the bot never looks these up (needs a code change and testing)'
          : !quoted ? 'neither coin is USDG/WETH: the pair finder does not ask for it'
          : o.botLooksUpThisSetting ? 'setting already looked up: pair probably not on the watch list (not on 2+ exchanges, or too little money)'
          : `add ${fee}:${ts} to RH_V4_MORE_TIERS`;
        break;
      }
      if (!o.type) o.type = 'V4 (settings not found)';
    } else {
      const [t0, t1, fac, fee] = [await call(id, 'token0'), await call(id, 'token1'), await call(id, 'factory'), await call(id, 'fee')];
      o.type = fee !== null ? 'V3-style' : 'V2-style';
      o.coins = t0 && t1 ? `${await sym(t0)}/${await sym(t1)}` : '?';
      o.exchange = fac ? FACTORY.get(lc(fac)) ?? `unknown factory ${lc(fac).slice(0, 10)}` : '?';
      o.note = FACTORY.has(lc(fac ?? '')) ? 'known exchange: pair probably not on the watch list' : 'exchange the bot does not know';
    }
    out.push(o);
  }
  const missingTiers = [...new Set(out.filter((o) => o.fixableWithMoreTiers).map((o) => `${o.fee}:${o.tickSpacing}`))];
  const summary = {
    poolsWithAtLeast: MIN, pools: out.length,
    byType: out.reduce<Record<string, number>>((m, o) => { m[o.type] = (m[o.type] ?? 0) + 1; return m; }, {}),
    fixableWithMoreTiers: out.filter((o) => o.fixableWithMoreTiers).length,
    arbsOnFixable: out.filter((o) => o.fixableWithMoreTiers).reduce((s, o) => s + o.arbs, 0),
    RH_V4_MORE_TIERS: missingTiers.join(','),
  };
  writeFileSync(join(DIR, 'missing-pools.json'), JSON.stringify({ summary, pools: out }, null, 1));
  console.log('SUMMARY ' + JSON.stringify(summary));
  for (const o of out.slice(0, 30)) console.log([o.arbs, o.type, o.coins, o.fee ?? o.exchange ?? '', o.tickSpacing ?? '', `ours ${o.weProfitAfterGas}/${o.ourRouteSupported} $${o.ourNetUsd}`, o.note].join(' | '));
}
main().catch((e) => { console.error('ERROR', e?.message ?? e); process.exit(1); });
