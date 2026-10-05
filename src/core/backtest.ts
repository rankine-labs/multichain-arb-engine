// ============================================================================
// BACKTEST ENGINE -- replays past pool events and finds the arbs that existed
//
// Plain English:
//   Every swap leaves a record with the pool's price right after it
//   (V3: sqrtPriceX96 + liquidity in the Swap event; V2: reserves in Sync).
//   We replay those records in order, keep each pool's latest state, and
//   after every event ask: "for this token pair, is there a gap between two
//   pools big enough to profit after fees?" The bot's question, asked over
//   the past week.
//
//   An "opportunity" = a stretch of time where the best arb for a pair stays
//   above the profit threshold. We record its peak profit and how long it
//   lasted. Closed in the SAME block it opened = almost certainly another bot
//   took it (on Robinhood, backruns land right behind the trade).
//
// Approximations (stated in the report):
//   - V3 pools are treated as constant-product within their current price
//     range (virtual reserves). Accurate for moderate sizes; trade size is
//     also capped (maxTradeUsd) so a thin range can't fake a huge profit.
//   - V3 fees are each pool's current fee.
// ============================================================================

export type PoolKind = 'v2' | 'solidly' | 'v3';

export interface BtPool {
  address: string;      // lowercase
  dex: string;
  kind: PoolKind;
  token0: string;       // lowercase
  token1: string;       // lowercase
  dec0: number;
  dec1: number;
  fee: number;          // fraction, e.g. 0.0005
}

// Latest known state of a pool (raw on-chain numbers).
type PoolState = { kind: 'v2'; r0: bigint; r1: bigint } | { kind: 'v3'; sqrtPriceX96: bigint; liquidity: bigint };

export interface BtEvent {
  block: number;
  logIndex: number;
  pool: string;         // lowercase
  state: PoolState;
  txHash?: string;      // transaction that produced this event (for competitor tracking)
  txIndex?: number;     // its position in the block (Robinhood orders first come, first served)
}

export interface Opportunity {
  pair: string;         // "BASE/QUOTE" symbols
  startBlock: number;
  endBlock: number;     // block of the event that closed it (or last block if still open)
  peakUsd: number;
  peakSizeUsd: number;
  buyDex: string;
  sellDex: string;
  closedSameBlock: boolean;
  stillOpen: boolean;
  poolsInPair: string[]; // every watched pool of this pair (to recognise an arb touching two of them)
  openTx?: string;       // trade that created the gap
  openTxIndex?: number;
  closeTx?: string;      // trade that closed it (often the competitor's arb)
  closeTxIndex?: number;
}

const Q96 = 2 ** 96;

// Human-unit reserves for a pool in (base, quote) orientation.
// V3: virtual reserves of the current range: x = L/sqrtP, y = L*sqrtP.
export function reserves(pool: BtPool, st: PoolState, base: string): { base: number; quote: number } | null {
  let x: number, y: number; // token0, token1 in human units
  if (st.kind === 'v2') {
    x = Number(st.r0) / 10 ** pool.dec0;
    y = Number(st.r1) / 10 ** pool.dec1;
  } else {
    const sqrtP = Number(st.sqrtPriceX96) / Q96;
    const L = Number(st.liquidity);
    if (!(sqrtP > 0) || !(L > 0)) return null;
    x = L / sqrtP / 10 ** pool.dec0;
    y = (L * sqrtP) / 10 ** pool.dec1;
  }
  if (!(x > 0) || !(y > 0) || !isFinite(x) || !isFinite(y)) return null;
  return base === pool.token0 ? { base: x, quote: y } : { base: y, quote: x };
}

// Best two-pool arb: pay QUOTE into poolBuy for BASE, sell that BASE into
// poolSell for QUOTE. Both modelled as constant product.
//   out(dx) = a*dx / (b + c*dx), profit = out - (1+flash)*dx
//   optimum dx* = (sqrt(a*b/(1+flash)) - b) / c
// Returns the input size and profit in QUOTE units (0/0 if no arb).
export function bestArb(
  buy: { base: number; quote: number }, feeBuy: number,
  sell: { base: number; quote: number }, feeSell: number,
  flashFee: number, maxDx = Infinity,
): { dx: number; profit: number } {
  const g1 = 1 - feeBuy, g2 = 1 - feeSell;
  const a = sell.quote * g2 * g1 * buy.base;
  const b = sell.base * buy.quote;
  const c = sell.base * g1 + g2 * g1 * buy.base;
  const k = 1 + flashFee;
  if (a / b <= k) return { dx: 0, profit: 0 };     // marginal rate doesn't beat costs
  let dx = (Math.sqrt((a * b) / k) - b) / c;
  if (!(dx > 0)) return { dx: 0, profit: 0 };
  dx = Math.min(dx, maxDx);
  const profit = (a * dx) / (b + c * dx) - k * dx;
  return profit > 0 ? { dx, profit } : { dx: 0, profit: 0 };
}

interface PairInfo {
  key: string;
  label: string;
  base: string;
  quote: string;
  quoteUsd: number;
  pools: BtPool[];
  open?: Opportunity;
}

export interface EngineOptions {
  minProfitUsd: number;   // opportunity threshold (bot uses $20)
  flashFee: number;       // fraction
  gasUsd: number;         // per arb
  maxTradeUsd: number;    // cap on trade size
}

export class BacktestEngine {
  private state = new Map<string, PoolState>();
  private poolMeta = new Map<string, BtPool>();
  private pairOf = new Map<string, PairInfo>();
  readonly opportunities: Opportunity[] = [];
  eventsApplied = 0;

  constructor(
    pools: BtPool[],
    // quote token per pair (lowercase) and its USD price; pairs without one are skipped
    pickQuote: (t0: string, t1: string) => { quote: string; usd: number } | null,
    symbol: (t: string) => string,
    private readonly opts: EngineOptions,
  ) {
    const pairs = new Map<string, PairInfo>();
    for (const p of pools) {
      const key = [p.token0, p.token1].sort().join('/');
      let info = pairs.get(key);
      if (!info) {
        const q = pickQuote(p.token0, p.token1);
        if (!q) continue;
        const base = q.quote === p.token0 ? p.token1 : p.token0;
        info = { key, base, quote: q.quote, quoteUsd: q.usd, label: `${symbol(base)}/${symbol(q.quote)}`, pools: [] };
        pairs.set(key, info);
      }
      info.pools.push(p);
      this.poolMeta.set(p.address, p);
      this.pairOf.set(p.address, info);
    }
  }

  // Known starting state (e.g. read at the first block of the window).
  setState(pool: string, st: PoolState) { if (this.poolMeta.has(pool)) this.state.set(pool, st); }

  // evaluate=false: just record the new state (used for all but the last
  // event of a transaction, so a trade that touches two pools in one go is
  // never mistaken for a gap someone else could have taken mid-trade).
  apply(ev: BtEvent, evaluate = true) {
    const pair = this.pairOf.get(ev.pool);
    if (!pair) return;
    this.state.set(ev.pool, ev.state);
    this.eventsApplied++;
    if (evaluate) this.evaluate(ev);
  }

  // Re-check the pair that `ev.pool` belongs to, as of the end of ev's transaction.
  evaluate(ev: BtEvent) {
    const pair = this.pairOf.get(ev.pool);
    if (!pair) return;

    // Best arb across every ordered pair of pools for this token pair.
    let best = { usd: 0, sizeUsd: 0, buy: '', sell: '' };
    const maxDx = this.opts.maxTradeUsd / pair.quoteUsd;
    for (const pb of pair.pools) {
      const sb = this.state.get(pb.address);
      if (!sb) continue;
      const rb = reserves(pb, sb, pair.base);
      if (!rb) continue;
      for (const ps of pair.pools) {
        if (ps === pb) continue;
        const ss = this.state.get(ps.address);
        if (!ss) continue;
        const rs = reserves(ps, ss, pair.base);
        if (!rs) continue;
        const r = bestArb(rb, pb.fee, rs, ps.fee, this.opts.flashFee, maxDx);
        const usd = r.profit * pair.quoteUsd - this.opts.gasUsd;
        if (usd > best.usd) best = { usd, sizeUsd: r.dx * pair.quoteUsd, buy: pb.dex, sell: ps.dex };
      }
    }

    const o = pair.open;
    if (best.usd >= this.opts.minProfitUsd) {
      if (!o) {
        pair.open = { pair: pair.label, startBlock: ev.block, endBlock: ev.block, peakUsd: best.usd, peakSizeUsd: best.sizeUsd,
          buyDex: best.buy, sellDex: best.sell, closedSameBlock: false, stillOpen: true,
          poolsInPair: pair.pools.map((p) => p.address), openTx: ev.txHash, openTxIndex: ev.txIndex };
      } else if (best.usd > o.peakUsd) {
        o.peakUsd = best.usd; o.peakSizeUsd = best.sizeUsd; o.buyDex = best.buy; o.sellDex = best.sell;
      }
    } else if (o) {
      o.endBlock = ev.block;
      o.closedSameBlock = ev.block === o.startBlock;
      o.closeTx = ev.txHash;
      o.closeTxIndex = ev.txIndex;
      o.stillOpen = false;
      this.opportunities.push(o);
      pair.open = undefined;
    }
  }

  // Close the books: opportunities still open at the end of the window.
  finish(lastBlock: number) {
    for (const p of new Set(this.pairOf.values())) {
      if (p.open) { p.open.endBlock = lastBlock; this.opportunities.push(p.open); p.open = undefined; }
    }
  }
}

// ----------------------------------------------------------------------------
// Event decoding (raw logs -> pool state). Pure, unit-tested.
//   V2/Solidly Sync: 1 topic, data = (reserve0, reserve1)
//   V3 Swap: 3 topics, data = (amount0, amount1, sqrtPriceX96, liquidity, tick
//            [, protocolFees0, protocolFees1 on PancakeSwap])  -> 5 or 7 words
//   Mint/Burn/Collect have 4 topics; Flash has 4 data words -> ignored.
// ----------------------------------------------------------------------------
export function decodePoolEvent(kind: PoolKind, log: { topics: readonly string[]; data: string }): PoolState | null {
  const hex = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
  if (hex.length % 64 !== 0) return null;
  const words = hex.length / 64;
  const w = (i: number) => BigInt('0x' + hex.slice(i * 64, i * 64 + 64));
  if (kind === 'v3') {
    if (log.topics.length !== 3 || (words !== 5 && words !== 7)) return null;
    const sqrtPriceX96 = w(2), liquidity = w(3);
    if (sqrtPriceX96 === 0n || sqrtPriceX96 >= 1n << 160n || liquidity >= 1n << 128n) return null;
    return { kind: 'v3', sqrtPriceX96, liquidity };
  }
  if (log.topics.length !== 1 || words !== 2) return null;
  return { kind: 'v2', r0: w(0), r1: w(1) };
}
