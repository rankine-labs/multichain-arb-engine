import { ethers } from 'ethers';

// ============================================================================
// RACE CHECK -- would we really have won each practice win?
//
// Plain English:
//   A practice win means "the profit was there when we looked". It does not
//   tell us whether another bot would have grabbed it first. For every
//   confirmed practice win this records:
//     - the two pools, when we spotted it and when we'd have been ready
//       to send (block numbers; a block is ~0.11 s on Robinhood Chain)
//   then watches those two pools for the next ~30 s (300 blocks) and asks:
//     - did another bot trade BOTH pools in one transaction (an arbitrage)?
//       If it landed BEFORE we'd have been ready -> we'd have LOST the race
//       (and by how many seconds); if not -> we'd have WON.
//     - if only a normal one-pool trade hit a pool before we were ready, the
//       gap may have closed some other way -> UNCLEAR.
//
// Cost: one log request every 5 s, only while a win is being watched, plus
// one request per lost race to see which bot beat us. Never trades.
// ============================================================================

const BLOCK_S = 0.11;            // Robinhood Chain block time (seconds)
const WATCH_BLOCKS = 300;        // ~33 s after we spotted it

const SWAP_TOPICS = [
  ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)'),                     // V2 / Solidly
  ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)'),                 // V3 / Algebra / Slipstream
  ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)'), // PancakeSwap V3 copies
];
const V4_SWAP = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');

export type Verdict = 'won' | 'lost' | 'unclear';

export interface RaceEntry {
  label: string;          // e.g. "PONS/USDG gap"
  pools: string[];        // two pool addresses, or V4 pool ids (32 bytes)
  spottedBlock: number;   // head block when we spotted it
  readyBlock: number;     // head block when we'd have been ready to send
  netUsd: number;         // confirmed practice profit
  source: 'gap' | 'trigger';
  ignoreTx?: string;      // the trade we reacted to (its own swap isn't a rival)
}

export interface RaceResult extends RaceEntry {
  verdict: Verdict;
  rival?: string;         // the bot contract that beat us (lost only)
  rivalLeadS?: number;    // how much earlier than our "ready" they landed (s)
  takenAfterS?: number;   // seconds after we spotted it that someone took it
  tx?: string;            // the rival's transaction
}

export interface RaceSummary { won: number; lost: number; unclear: number; wonUsd: number; lostUsd: number; avgLeadS: number | null }

type Log = { address: string; topics: string[]; blockNumber: string; transactionHash: string; logIndex?: string };
type Rpc = (method: string, params: unknown[]) => Promise<any>;

// Pure: decide the verdict for one entry from the swap logs on its pools.
export function judge(e: RaceEntry, logs: Log[], poolManager?: string): Omit<RaceResult, keyof RaceEntry> & { tx?: string } {
  const want = new Set(e.pools.map((p) => p.toLowerCase()));
  const pm = poolManager?.toLowerCase();
  const poolOf = (l: Log): string | null => {
    const t0 = l.topics?.[0];
    if (t0 === V4_SWAP && l.address.toLowerCase() === pm) return l.topics[1]?.toLowerCase() ?? null;
    if (SWAP_TOPICS.includes(t0)) return l.address.toLowerCase();
    return null;
  };
  // tx -> { block, pools touched }
  const byTx = new Map<string, { block: number; pools: Set<string> }>();
  for (const l of logs) {
    const p = poolOf(l);
    if (!p || !want.has(p)) continue;
    if (e.ignoreTx && l.transactionHash.toLowerCase() === e.ignoreTx.toLowerCase()) continue;
    const b = Number(BigInt(l.blockNumber));
    if (b < e.spottedBlock) continue;
    const t = byTx.get(l.transactionHash) ?? { block: b, pools: new Set<string>() };
    t.pools.add(p); byTx.set(l.transactionHash, t);
  }
  const txs = [...byTx.entries()].sort((a, b) => a[1].block - b[1].block);
  const arb = txs.find(([, t]) => t.pools.size >= 2);
  if (arb && arb[1].block < e.readyBlock) {
    return { verdict: 'lost', tx: arb[0], rivalLeadS: +((e.readyBlock - arb[1].block) * BLOCK_S).toFixed(2), takenAfterS: +((arb[1].block - e.spottedBlock) * BLOCK_S).toFixed(2) };
  }
  // No arbitrage before we were ready. A normal one-pool trade before then may
  // have closed the gap some other way: unclear.
  const early = txs.find(([, t]) => t.block < e.readyBlock);
  if (early) return { verdict: 'unclear' };
  return { verdict: 'won', ...(arb ? { takenAfterS: +((arb[1].block - e.spottedBlock) * BLOCK_S).toFixed(2) } : {}) };
}

export class RaceChecker {
  private pending: RaceEntry[] = [];
  private results: RaceResult[] = [];
  private busy = false;

  constructor(private readonly rpc: Rpc, private readonly poolManager: string, private readonly maxPending = 40) {}

  // Record a confirmed practice win. readyDelayMs = time from spotting to
  // being ready to send (our check time + signing).
  async record(e: Omit<RaceEntry, 'spottedBlock' | 'readyBlock'> & { readyDelayMs: number; spottedBlock?: number }) {
    if (this.pending.length >= this.maxPending) return;
    try {
      const head = Number(await this.rpc('eth_blockNumber', []));
      const back = Math.ceil(e.readyDelayMs / (BLOCK_S * 1000));
      const spottedBlock = e.spottedBlock ?? head - back;
      const readyBlock = e.spottedBlock !== undefined ? e.spottedBlock + Math.max(1, back) : head;
      this.pending.push({ label: e.label, pools: e.pools, netUsd: e.netUsd, source: e.source, spottedBlock, readyBlock, ...(e.ignoreTx ? { ignoreTx: e.ignoreTx } : {}) });
    } catch { /* node busy: skip this one */ }
  }

  // Called every few seconds: finish entries whose watch window has passed.
  async tick(): Promise<RaceResult[]> {
    if (this.busy || !this.pending.length) return [];
    this.busy = true;
    const done: RaceResult[] = [];
    try {
      const head = Number(await this.rpc('eth_blockNumber', []));
      const ripe = this.pending.filter((e) => head >= e.spottedBlock + WATCH_BLOCKS);
      if (!ripe.length) return [];
      const from = Math.min(...ripe.map((e) => e.spottedBlock));
      const to = Math.max(...ripe.map((e) => e.spottedBlock + WATCH_BLOCKS));
      const addrs = [...new Set(ripe.flatMap((e) => e.pools).filter((p) => p.length === 42).map((p) => p.toLowerCase()))];
      const ids = [...new Set(ripe.flatMap((e) => e.pools).filter((p) => p.length === 66).map((p) => p.toLowerCase()))];
      const q = (filter: object) => this.rpc('eth_getLogs', [{ ...filter, fromBlock: ethers.toQuantity(from), toBlock: ethers.toQuantity(to) }]) as Promise<Log[]>;
      const logs: Log[] = [];
      if (addrs.length) logs.push(...(await q({ address: addrs, topics: [SWAP_TOPICS] })));
      if (ids.length) logs.push(...(await q({ address: this.poolManager, topics: [V4_SWAP, ids] })));
      for (const e of ripe) {
        const j = judge(e, logs, this.poolManager);
        const r: RaceResult = { ...e, ...j };
        if (r.verdict === 'lost' && r.tx) {
          try { const tx = await this.rpc('eth_getTransactionByHash', [r.tx]); r.rival = tx?.to ? String(tx.to).toLowerCase() : undefined; } catch { /* fine */ }
        }
        done.push(r);
        console.log(`[race] ${r.label} $${r.netUsd.toFixed(2)}: ${r.verdict === 'won' ? 'WE WOULD HAVE WON' : r.verdict === 'lost' ? `LOST to ${r.rival ?? 'another bot'} (${r.rivalLeadS}s before we were ready, ${r.takenAfterS}s after we spotted it)` : 'unclear (a normal trade hit a pool first)'}${r.tx ? ` tx ${r.tx}` : ''}`);
      }
      this.pending = this.pending.filter((e) => !ripe.includes(e));
      this.results.push(...done);
      if (this.results.length > 2_000) { const cut = this.results.length - 1_000; this.results = this.results.slice(cut); this.hourFrom = Math.max(0, this.hourFrom - cut); }
    } catch { /* node busy: try next tick */ } finally {
      this.busy = false;
    }
    return done;
  }

  // Summary of results finished since `fromIdx`; returns the new index too.
  private hourFrom = 0;
  takeHour(): RaceSummary & { pending: number } {
    const s = summarizeRaces(this.results.slice(this.hourFrom));
    this.hourFrom = this.results.length;
    return { ...s, pending: this.pending.length };
  }
  pendingCount() { return this.pending.length; }
}

export function summarizeRaces(rs: RaceResult[]): RaceSummary {
  const won = rs.filter((r) => r.verdict === 'won'), lost = rs.filter((r) => r.verdict === 'lost');
  const leads = lost.map((r) => r.rivalLeadS ?? 0);
  return {
    won: won.length, lost: lost.length, unclear: rs.length - won.length - lost.length,
    wonUsd: won.reduce((a, r) => a + r.netUsd, 0), lostUsd: lost.reduce((a, r) => a + r.netUsd, 0),
    avgLeadS: leads.length ? +(leads.reduce((a, b) => a + b, 0) / leads.length).toFixed(2) : null,
  };
}
