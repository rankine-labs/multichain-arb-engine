// ============================================================================
// MISSED GAPS - which fee setting does each hook-free V4 pool use, and can the
// bot's pair watcher find it?
//
// Plain English:
//   The pair watcher (src/core/pairWatcher.ts) finds a pair's Uniswap V4 pools
//   by computing pool ids for the fee settings in src/config/v4Tiers.ts
//   (V4_LOOKUP_TIERS: 4 standard + 27 extra) and asking V4 if each exists.
//   A pool at any other setting is never found, so the bot never sees it.
//   Pool id = keccak(coin0, coin1, fee, tickSpacing, hooks = 0), so the
//   setting can be recovered locally (no node needed):
//     1. the bot's own 31 settings first (match = the bot CAN find it)
//     2. then the "fee = k x tickSpacing" families (k = 100, 50, 25, ...,
//        spacing 1-4000), which is where every unmatched pool turned out to be
//   A pool that matches none of the bot's settings is invisible to the bot.
//   node scripts/missed-gaps/v4tiers.mjs <pools-in.json> <out.json>
// ============================================================================
import { readFileSync, writeFileSync } from 'fs';
import { keccak_256 } from '@noble/hashes/sha3';

// Same list the bot uses (copied from src/config/v4Tiers.ts: standard + extra).
const LOOKUP = [[500, 10], [3000, 60], [10000, 200], [100, 1],
  [200, 4], [310, 3], [450, 9], [460, 9], [500, 1], [500, 5], [800, 5], [1000, 2], [1000, 10], [1200, 15], [1500, 15],
  [2000, 20], [2300, 23], [2400, 24], [2500, 25], [2690, 54], [3000, 30], [5000, 50], [7500, 75], [8000, 80], [9000, 90],
  [9900, 99], [10000, 100], [19000, 190], [25000, 250], [28000, 280], [32000, 320]];

// Candidate settings in search order: the bot's list, then the families.
function* candidates() {
  for (const [f, t] of LOOKUP) yield [f, t, true];
  for (let t = 1; t <= 4000; t++) for (const k of [100, 50, 25, 200, 10, 20, 5, 1, 2, 4, 40, 250, 500]) {
    const f = k * t;
    if (f < 1_000_000) yield [f, t, false];
  }
}

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = {};
for (const p of input.pools.filter((x) => x.kind === 'v4')) {
  // Pool key bytes: coin0 | coin1 | fee | tickSpacing | hooks (each a 32-byte word).
  const [c0, c1] = BigInt(p.t0) < BigInt(p.t1) ? [p.t0, p.t1] : [p.t1, p.t0];
  const buf = new Uint8Array(160);
  buf.set(Buffer.from(c0.slice(2).padStart(64, '0'), 'hex'), 0);
  buf.set(Buffer.from(c1.slice(2).padStart(64, '0'), 'hex'), 32);
  const want = Buffer.from(p.id.slice(2), 'hex');
  let hit = null;
  for (const [f, t, bot] of candidates()) {
    buf[93] = (f >> 16) & 0xff; buf[94] = (f >> 8) & 0xff; buf[95] = f & 0xff;
    buf[125] = (t >> 16) & 0xff; buf[126] = (t >> 8) & 0xff; buf[127] = t & 0xff;
    if (Buffer.compare(Buffer.from(keccak_256(buf)), want) === 0) { hit = { fee: f, tickSpacing: t, botFinds: bot }; break; }
  }
  // No match at all: still not one of the bot's settings (tried first).
  out[p.id] = hit ?? { fee: null, tickSpacing: null, botFinds: false };
}
writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
const v = Object.values(out);
console.log(`V4 pools ${v.length}: setting found ${v.filter((x) => x.fee !== null).length}, bot can find ${v.filter((x) => x.botFinds).length}, bot CANNOT find ${v.filter((x) => !x.botFinds).length}`);
