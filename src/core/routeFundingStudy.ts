// ============================================================================
// ROUTE + FUNDING STUDY (research only, never trades, never signs anything)
//
// Plain English:
//   Rival bots on Robinhood Chain make many small arbitrage trades. Some go
//   through 2 pools (buy here, sell there), some through 3 or 4 pools in a
//   loop (USDG -> coin -> WETH -> USDG). They also pay for the trade in
//   different ways: a flash loan (borrow, trade, repay in one go, for a fee),
//   or their own money sitting in the bot.
//
//   This file holds the plain maths used by the route/funding probe
//   (scripts/probe-routes-funding.ts) to answer:
//     - how many wins of each route length there are, and how big;
//     - how many would still make money if WE paid a loan fee (1, 5 or
//       9 basis points of the trade size) and somewhat more gas than them;
//     - how much of our own money (USDG, WETH) would cover the trade sizes
//       rivals actually use.
//   Everything here is pure (no network), so it is unit tested.
// ============================================================================

// One arbitrage-shaped trade read from a block (a rival's, never ours).
export interface StudyTrade {
  block: number;
  bot: string;                  // the contract the rival called
  pools: number;                // pools swapped through (2, 3, 4...)
  flashLoan: boolean;           // a flash-loan event was in the receipt
  poolPaidFirst: boolean;       // a pool sent coins to the bot before the bot paid anything
  verified: boolean;            // gained only WETH and/or USDG (we can price it reliably)
  gainToken: 'USDG' | 'WETH' | 'both' | 'other';
  grossUsd: number;             // value gained before gas (verified trades only)
  gasUsd: number;               // gas the rival paid
  sizeUsd: number;              // biggest USDG/WETH amount the bot paid out (0 = could not price)
  sizeToken: 'USDG' | 'WETH' | null; // which coin that biggest payment was in
  executable: boolean;          // every pool is a type our contract can trade (known factory or V4)
  unknownFactory: boolean;      // at least one pool comes from a factory we do not know
  shape: string;                // short route description, e.g. "uni-v3 USDG/GME > V4 > ..."
}

// A way of paying for the trade, as WE would have to (not the rival).
export interface FundingSetting {
  label: string;
  feeBps: number;               // loan fee as basis points of the trade size (0 = own money)
  gasMult: number;              // our gas compared with the rival's (1 = same)
}

export const FUNDING_SETTINGS: FundingSetting[] = [
  { label: 'own money, rival gas', feeBps: 0, gasMult: 1 },
  { label: 'own money, our gas (1.5x)', feeBps: 0, gasMult: 1.5 },
  { label: 'V3 pool loan 1 bps, our gas', feeBps: 1, gasMult: 1.5 },
  { label: 'V3 pool loan 5 bps, our gas', feeBps: 5, gasMult: 1.5 },
  { label: 'loan 9 bps (planner today), our gas', feeBps: 9, gasMult: 1.5 },
];

// Junk: a gain that is impossible for its size (same rule as the rival
// report: more than 5% of the size, or more than $5 with no known size).
// These are usually a broken or brand-new pool and say nothing about the
// everyday market, so they are reported on their own.
export function isJunkWin(t: Pick<StudyTrade, 'grossUsd' | 'sizeUsd'>): boolean {
  return t.sizeUsd > 0 ? t.grossUsd > 0.05 * t.sizeUsd : t.grossUsd > 5;
}

// What the same win would have left US under one funding setting.
// null = the size is unknown, so a loan fee cannot be worked out.
export function netUnder(t: Pick<StudyTrade, 'grossUsd' | 'gasUsd' | 'sizeUsd'>, s: FundingSetting): number | null {
  if (s.feeBps > 0 && !(t.sizeUsd > 0)) return null;
  return t.grossUsd - t.gasUsd * s.gasMult - t.sizeUsd * (s.feeBps / 10_000);
}

// Percentile of a list (nearest rank). Empty list = 0.
export function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export type RouteBucket = '2' | '3' | '4+';
export const bucketOf = (pools: number): RouteBucket => (pools <= 2 ? '2' : pools === 3 ? '3' : '4+');

export interface BucketStats {
  arbs: number;                 // all arbitrage-shaped trades
  flashLoan: number;
  poolPaidFirst: number;
  verified: number;             // gained only WETH/USDG, positive after gas
  junk: number;                 // verified but impossible for its size (left out below)
  grossSum: number; grossP50: number; grossP90: number;
  netSum: number; netP50: number; netP90: number;   // rival's own net (after their gas)
  gasP50: number;
  sized: number;                // verified, non-junk, with a known size
  sizeP50: number; sizeP90: number; sizeMax: number;
  executable: number;           // verified, non-junk, every pool tradable by our contract
  unknownFactory: number;       // verified, non-junk, at least one unknown-factory pool
  // Per funding setting: how many sized wins stay above $0, and the total kept.
  funding: { label: string; positive: number; keptUsd: number }[];
}

export function bucketStats(trades: StudyTrade[], settings = FUNDING_SETTINGS): BucketStats {
  const wins = trades.filter((t) => t.verified && t.grossUsd - t.gasUsd > 0);
  const clean = wins.filter((t) => !isJunkWin(t));
  const sized = clean.filter((t) => t.sizeUsd > 0);
  const gross = clean.map((t) => t.grossUsd), net = clean.map((t) => t.grossUsd - t.gasUsd), size = sized.map((t) => t.sizeUsd);
  return {
    arbs: trades.length,
    flashLoan: trades.filter((t) => t.flashLoan).length,
    poolPaidFirst: trades.filter((t) => t.poolPaidFirst).length,
    verified: wins.length,
    junk: wins.length - clean.length,
    grossSum: sum(gross), grossP50: pct(gross, 0.5), grossP90: pct(gross, 0.9),
    netSum: sum(net), netP50: pct(net, 0.5), netP90: pct(net, 0.9),
    gasP50: pct(clean.map((t) => t.gasUsd), 0.5),
    sized: sized.length,
    sizeP50: pct(size, 0.5), sizeP90: pct(size, 0.9), sizeMax: size.length ? Math.max(...size) : 0,
    executable: clean.filter((t) => t.executable).length,
    unknownFactory: clean.filter((t) => t.unknownFactory).length,
    funding: settings.map((s) => {
      const kept = sized.map((t) => netUnder(t, s)!).filter((n) => n > 0);
      return { label: s.label, positive: kept.length, keptUsd: sum(kept) };
    }),
  };
}

// Own money needed per coin: the trade sizes (in USD) of clean, sized wins
// that started in that coin. A trade gives its money back in the same
// transaction, so the money needed is the biggest single trade, not the sum.
export interface CapitalNeed { token: 'USDG' | 'WETH'; wins: number; p50: number; p90: number; p99: number; max: number }

export function capitalNeeds(trades: StudyTrade[]): CapitalNeed[] {
  const clean = trades.filter((t) => t.verified && t.grossUsd - t.gasUsd > 0 && !isJunkWin(t) && t.sizeUsd > 0 && t.sizeToken);
  return (['USDG', 'WETH'] as const).map((token) => {
    const xs = clean.filter((t) => t.sizeToken === token).map((t) => t.sizeUsd);
    return { token, wins: xs.length, p50: pct(xs, 0.5), p90: pct(xs, 0.9), p99: pct(xs, 0.99), max: xs.length ? Math.max(...xs) : 0 };
  });
}

// Short plain-text report (fits in one GitHub annotation).
export function formatStudy(trades: StudyTrade[], meta: { blocks: number; txs: number; chainMinutes: number; windows: number }): string {
  const f2 = (x: number) => x.toFixed(2), f4 = (x: number) => x.toFixed(4), usd0 = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
  const perHour = meta.chainMinutes > 0 ? 60 / meta.chainMinutes : 0;
  const lines: string[] = [];
  lines.push(`Read ${meta.windows} windows, ${meta.blocks} blocks, ${meta.txs} txs, ${f2(meta.chainMinutes)} min of chain time. Rival bots: ${new Set(trades.map((t) => t.bot)).size}.`);
  for (const b of ['2', '3', '4+'] as RouteBucket[]) {
    const s = bucketStats(trades.filter((t) => bucketOf(t.pools) === b));
    lines.push(`[${b} pools] arbs ${s.arbs} (flash loan ${s.flashLoan}, pool paid first ${s.poolPaidFirst}) | verified wins ${s.verified} (junk ${s.junk}) | gross sum $${f2(s.grossSum)} p50 $${f4(s.grossP50)} p90 $${f4(s.grossP90)} | rival net sum $${f2(s.netSum)} p50 $${f4(s.netP50)} p90 $${f4(s.netP90)} | gas p50 $${f4(s.gasP50)}`);
    lines.push(`   sized ${s.sized}: size p50 ${usd0(s.sizeP50)} p90 ${usd0(s.sizeP90)} max ${usd0(s.sizeMax)} | our contract can trade all pools: ${s.executable} | unknown factory: ${s.unknownFactory} | per chain-hour: ${f2(s.verified * perHour)} wins, $${f2(s.netSum * perHour)} rival net`);
    lines.push(`   still > $0 for us: ${s.funding.map((x) => `${x.label}: ${x.positive} ($${f2(x.keptUsd)})`).join('; ')}`);
  }
  for (const c of capitalNeeds(trades)) lines.push(`Own money ${c.token}: ${c.wins} sized wins, size p50 ${usd0(c.p50)} p90 ${usd0(c.p90)} p99 ${usd0(c.p99)} max ${usd0(c.max)}`);
  // Loop shapes (3+ pools), most common first.
  const loops = trades.filter((t) => t.pools >= 3 && t.verified && t.grossUsd - t.gasUsd > 0);
  const shapes = new Map<string, { n: number; net: number }>();
  for (const t of loops) { const k = t.shape; const v = shapes.get(k) ?? { n: 0, net: 0 }; v.n++; v.net += t.grossUsd - t.gasUsd; shapes.set(k, v); }
  const top = [...shapes.entries()].sort((a, b) => b[1].n - a[1].n || b[1].net - a[1].net).slice(0, 10);
  if (top.length) lines.push('Loop wins by shape (count, rival net):');
  for (const [k, v] of top) lines.push(`   ${v.n}x $${f4(v.net)} ${k}`);
  const junk = trades.filter((t) => t.verified && t.grossUsd - t.gasUsd > 0 && isJunkWin(t));
  for (const t of junk.slice(0, 5)) lines.push(`Junk win (left out): ${t.pools} pools, gross $${f2(t.grossUsd)} on size ${usd0(t.sizeUsd)}, block ${t.block}, ${t.shape}`);
  return lines.join('\n');
}
