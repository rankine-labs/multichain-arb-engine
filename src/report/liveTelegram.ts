import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';
import { esc, usd } from './hourlyReport';

// ============================================================================
// LIVE-MODE TELEGRAM LAYOUT (Oct 18, owner approved layout, reporting only)
//
// Plain English:
//   Once real money is on, Telegram shows REAL money first and nothing that
//   needs explaining. Four kinds of message:
//
//     1. Every real trade, instantly:  ✅ TRADE WON +$0.38   /   ❌ MISSED -$0.02
//     2. Hourly:   real money (hour / today / since start), wallet (now vs
//                  started), gas left in trades, loss limit used, bot health
//     3. 4-hourly: money kept, won / missed / win rate, best trade, gas,
//                  money by hour (little bars), top pairs, chances found
//     4. Alerts:   only when something is wrong (gas low, wallet changed
//                  with no trade to explain it; loss cap and offline alerts
//                  come from the existing alert center)
//
//   Every message starts with 🟢 LIVE. Practice messages keep their own
//   layout and say 🧪 PRACTICE, so the two can never be mixed up.
//   The detailed practice numbers (checked wins, could earn live, funnel,
//   loops, speed) stay on the GitHub status page.
//
//   Switch: TELEGRAM_LIVE_LAYOUT=0 keeps the old messages in live mode too.
//   Nothing here sends, trades or touches keys. Pure formatting plus one
//   small saved file (data/live-telegram.json) of real trade results and the
//   starting wallet, so "since start" survives restarts.
//   No em dashes anywhere. Numbers we don't have are shown as "n/a".
// ============================================================================

// On unless set to exactly "0" (only used when live sending is on).
export function liveLayoutOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.TELEGRAM_LIVE_LAYOUT !== '0';
}

// Exchange ids in plain words ("uniswap-v3" -> "Uniswap V3").
const DEX_NAMES: Record<string, string> = {
  'uniswap-v2': 'Uniswap V2', 'uniswap-v3': 'Uniswap V3', 'uniswap-v4': 'Uniswap V4',
  'pancakeswap-v2': 'PancakeSwap V2', 'pancakeswap-v3': 'PancakeSwap V3',
  'ramses-v2': 'Ramses V2', 'ramses-v3': 'Ramses V3', 'sushiswap-v3': 'SushiSwap V3',
};
export function dexPlain(id: string): string {
  const k = String(id).trim().toLowerCase();
  if (DEX_NAMES[k]) return DEX_NAMES[k];
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(k)) return k.split('-').map((p) => (/^v\d/.test(p) ? p.toUpperCase() : p[0]!.toUpperCase() + p.slice(1))).join(' ');
  return String(id).trim();
}

// A live trade label is "WETH/USDG uniswap-v3>sushiswap-v3" (shadowMain's
// tradeLabel). Split it into the pair and a plain "bought on X, sold on Y".
export function splitLabel(label: string): { pair: string; route: string | null } {
  const [pair, venues] = String(label ?? '').trim().split(/\s+/, 2);
  if (!venues) return { pair: pair || 'unknown pair', route: null };
  const parts = venues.split(/>|->/).filter(Boolean).map(dexPlain);
  if (parts.length === 2) return { pair, route: `bought on ${parts[0]}, sold on ${parts[1]}` };
  return { pair, route: parts.join(' → ') };
}

// +$0.38 / -$0.02 (always signed, for profit lines).
export function signedUsd(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return 'n/a';
  const r = Math.round(x * 100) / 100;
  return r < 0 ? usd(r) : `+${usd(r)}`;
}

const padR = (s: string, w: number) => (s.length >= w ? s : s + ' '.repeat(w - s.length));
const padL = (s: string, w: number) => (s.length >= w ? s : ' '.repeat(w - s.length) + s);
const pre = (lines: string[]) => '<pre>' + lines.map(esc).join('\n') + '</pre>';

// 2:00pm style, in the report zone.
function ampm(ms: number, tz: string): string {
  return new Date(ms).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase().replace(':00', '');
}

// A count of won / missed trades and the money kept, for one period.
export interface DayCount { usd: number; won: number; missed: number }
const countText = (c: DayCount) => `(${c.won} won, ${c.missed} missed)`;

// ----------------------------------------------------------------------------
// 1. EVERY REAL TRADE
// ----------------------------------------------------------------------------
export interface LiveTradeMsgIn {
  status: 'profit' | 'reverted' | 'dropped';
  label: string;
  gasUsd: number;
  profitUsd?: number;     // profit before gas (from the contract's Executed event); undefined = no price
  sizeUsd?: number;       // dollars put in (from the send), if known
  today: DayCount;        // running totals INCLUDING this trade
}

export function formatLiveTrade(t: LiveTradeMsgIn): string {
  const { pair, route } = splitLabel(t.label);
  const todayLine = `Today    ${signedUsd(t.today.usd)} ${countText(t.today)}`;
  if (t.status === 'profit') {
    const known = t.profitUsd !== undefined && Number.isFinite(t.profitUsd);
    const kept = known ? (t.profitUsd as number) - t.gasUsd : null;
    const head = known ? `✅ <b>TRADE WON  ${esc(signedUsd(kept))}</b>` : '✅ <b>TRADE WON</b> (profit amount unknown)';
    const lines: string[] = [];
    if (t.sizeUsd !== undefined && Number.isFinite(t.sizeUsd) && t.sizeUsd > 0) {
      lines.push(`Put in   ${usd(t.sizeUsd)}`);
      if (known) lines.push(`Got back ${usd(t.sizeUsd + (t.profitUsd as number))}`);
    } else if (known) {
      lines.push(`Profit   ${signedUsd(t.profitUsd)}`);
    }
    lines.push(`Gas      ${usd(-t.gasUsd)}`, todayLine);
    return ['🟢 LIVE', head, esc(pair + (route ? ` · ${route}` : '')), pre(lines)].join('\n');
  }
  if (t.status === 'reverted') {
    return ['🟢 LIVE', `❌ <b>MISSED  ${esc(usd(-t.gasUsd))}</b>`, esc(pair),
      'Another bot got there first (or the price moved).', 'Only gas was lost. Your coins are safe.', pre([todayLine])].join('\n');
  }
  // Dropped: never made it into a block, so nothing was paid.
  return ['🟢 LIVE', '⚪ <b>NOT SENT THROUGH  $0.00</b>', esc(pair),
    'The trade never made it onto the chain. No cost.', pre([todayLine])].join('\n');
}

// ----------------------------------------------------------------------------
// 2. HOURLY
// ----------------------------------------------------------------------------
export interface WalletRow { coin: string; now: number | null; start: number | null; digits: number }
export interface LiveHourlyIn {
  tz: string;
  fromMs: number; toMs: number;
  partial: string | null;           // null = full hour, else why it's short ("bot restarted")
  hour: DayCount;
  todayUsd: number;
  sinceStartUsd: number;
  wallet: WalletRow[];
  gas: { eth: number | null; tradesLeft: number | null };
  loss: { usedUsd: number; capUsd: number };
  // Biggest trade the bot can make right now, per start coin: what the wallet
  // holds (less the 2% cushion), capped by the own-money / trade limits. null = not read yet.
  biggestTrade: { coin: string; usd: number | null }[];
  bot: { ok: boolean; text: string };
}

const amt = (x: number | null, d: number) => (x === null || !Number.isFinite(x) ? 'n/a' : x.toFixed(d));

export function formatLiveHourly(h: LiveHourlyIn): string {
  const range = `${ampm(h.fromMs, h.tz)}–${ampm(h.toMs, h.tz)}`;
  const out: string[] = [`🟢 <b>LIVE · ${esc(range)}</b>${h.partial ? ` (${esc(h.partial)})` : ''}`, ''];

  const W0 = 15, W = 10;
  out.push('💰 <b>REAL MONEY</b>');
  out.push(pre([
    padR('This hour', W0) + padL(signedUsd(h.hour.usd), W) + `   ${countText(h.hour)}`,
    padR('Today', W0) + padL(signedUsd(h.todayUsd), W),
    padR('Since start', W0) + padL(signedUsd(h.sinceStartUsd), W),
  ]));

  out.push('💼 <b>WALLET</b>');
  const walletLines = [padR('', W0) + padL('now', W) + padL('started', 12)];
  for (const r of h.wallet) walletLines.push(padR(r.coin, W0) + padL(amt(r.now, r.digits), W) + padL(amt(r.start, r.digits), 12));
  const left = h.gas.tradesLeft === null ? 'n/a' : `≈ ${h.gas.tradesLeft} trades left`;
  walletLines.push(padR('Gas (ETH)', W0) + padL(amt(h.gas.eth, 4), W) + `   ${left}`);
  out.push(pre(walletLines));

  out.push('🛡️ <b>SAFETY</b>');
  out.push(pre([
    padR('Loss limit today', 19) + `${usd(h.loss.usedUsd)} used of ${usd(h.loss.capUsd)}`,
    padR('Biggest trade', 19) + (h.biggestTrade.length ? h.biggestTrade.map((b) => `${b.coin} ${b.usd === null ? 'n/a' : usd(b.usd)}`).join(' · ') : 'n/a') + ' (your wallet)',
    padR('Bot', 19) + (h.bot.ok ? '✅ running, connected' : `⚠️ ${h.bot.text}`),
  ]));
  return out.join('\n');
}

// ----------------------------------------------------------------------------
// 3. EVERY 4 HOURS
// ----------------------------------------------------------------------------
export interface Live4hIn {
  tz: string;
  fromMs: number; toMs: number;
  keptUsd: number;
  won: number; missed: number;
  best: { usd: number; pair: string } | null;
  gasUsd: number;
  byHour: { startMs: number; usd: number }[];
  topPairs: { pair: string; usd: number; n: number }[];
  found: number | null;             // chances the bot found (practice funnel), null = unknown
}

// One bar character per hour, scaled to the biggest hour ("▁▂▃▄▅▆▇█").
export function bar(x: number, max: number): string {
  const BARS = '▁▂▃▄▅▆▇█';
  if (!(max > 0) || !(x > 0)) return '';
  return BARS[Math.max(0, Math.min(7, Math.ceil((x / max) * 8) - 1))];
}

export function formatLive4h(r: Live4hIn): string {
  const range = `${ampm(r.fromMs, r.tz)}–${ampm(r.toMs, r.tz)}`;
  const tried = r.won + r.missed;
  const rate = tried ? `${Math.round((100 * r.won) / tried)}%` : 'n/a';
  const out: string[] = [`🟢 <b>LIVE · 4-HOUR REPORT (${esc(range)})</b>`, ''];
  out.push(`💰 <b>${esc(signedUsd(r.keptUsd))} kept after gas</b>`);
  out.push(pre([
    `Won ${r.won} · Missed ${r.missed} · Win rate ${rate}`,
    `Best trade  ${r.best ? `${signedUsd(r.best.usd)} ${r.best.pair}` : 'none yet'}`,
    `Gas spent   ${usd(r.gasUsd)}`,
  ]));

  out.push('📈 <b>BY HOUR</b>');
  const max = Math.max(0, ...r.byHour.map((b) => b.usd));
  out.push(pre(r.byHour.length
    ? r.byHour.map((b) => padR(ampm(b.startMs, r.tz), 7) + padL(signedUsd(b.usd), 8) + ' ' + bar(b.usd, max))
    : ['no real trades yet']));

  out.push('🏆 <b>TOP PAIRS</b>');
  out.push(pre(r.topPairs.length
    ? r.topPairs.slice(0, 5).map((p) => padR(p.pair, 12) + padL(signedUsd(p.usd), 8) + `  (${p.n} trade${p.n === 1 ? '' : 's'})`)
    : ['no real trades yet']));

  if (r.found !== null) {
    const notWon = Math.max(0, r.found - r.won);
    out.push(`💡 Chances found ${r.found} · Won ${r.won}`);
    out.push(esc(`(Missed ${notWon}: other bots faster or too small)`));
  }
  return out.join('\n');
}

// ----------------------------------------------------------------------------
// 4. ALERT TEXT (sent through the alert center, which handles spam limits)
// ----------------------------------------------------------------------------
export function gasLowSpec(tradesLeft: number, eth: number) {
  return {
    title: `Gas low: about ${tradesLeft} trades left`, severity: 'high' as const, critical: true,
    meaning: 'when gas runs out, real trades stop',
    happening: 'add ETH to the gas wallet to keep trading',
    details: [`Gas wallet: ${eth.toFixed(5)} ETH`],
  };
}
export function walletChangedSpec(coin: string, dropped: number, digits: number) {
  return {
    title: 'Wallet changed unexpectedly', severity: 'high' as const, critical: true,
    meaning: `${coin} dropped ${dropped.toFixed(digits)} with no trade to explain it`,
    happening: 'please check. If you withdrew it yourself, nothing to do',
  };
}

// ----------------------------------------------------------------------------
// THE BOOK: real trade results + starting wallet, saved to disk.
// ----------------------------------------------------------------------------
export interface LiveTradeRec { t: number; pair: string; kept: number; gas: number; status: 'profit' | 'reverted' | 'dropped' }
interface BookState { version: 1; startedAt: number | null; start: Record<string, number>; trades: LiveTradeRec[] }

export class LiveTradeBook {
  static KEEP_MS = 8 * 24 * 3600_000;   // keep 8 days of trades (bounded file)
  static MAX_TRADES = 20_000;           // and never more than this many
  private s: BookState = { version: 1, startedAt: null, start: {}, trades: [] };
  private sinceStartOld = 0;            // kept money from trades already pruned (so "since start" stays right)

  constructor(private readonly file: string | null, private readonly tz = 'America/Toronto', private readonly now: () => number = Date.now) {
    if (!file) return;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      if (j?.version === 1) {
        this.s.startedAt = Number.isFinite(j.startedAt) ? j.startedAt : null;
        for (const [k, v] of Object.entries(j.start ?? {})) if (Number.isFinite(Number(v))) this.s.start[k] = Number(v);
        if (Array.isArray(j.trades)) this.s.trades = j.trades.filter((x: any) => Number.isFinite(x?.t) && Number.isFinite(x?.kept));
        if (Number.isFinite(j.sinceStartOld)) this.sinceStartOld = j.sinceStartOld;
      }
    } catch { /* no file yet: start fresh */ }
  }

  // One final real result. Returns the record it stored.
  add(r: { status: 'profit' | 'reverted' | 'dropped'; label: string; gasUsd: number; profitUsd?: number }): LiveTradeRec {
    const gas = Number.isFinite(r.gasUsd) && r.gasUsd > 0 ? r.gasUsd : 0;
    // Same rule as the hourly ledger: won = profit minus gas, failed = minus gas, dropped = 0.
    const kept = r.status === 'profit' ? (Number.isFinite(r.profitUsd) ? (r.profitUsd as number) : 0) - gas : r.status === 'reverted' ? -gas : 0;
    const rec: LiveTradeRec = { t: this.now(), pair: splitLabel(r.label).pair, kept, gas, status: r.status };
    if (this.s.startedAt === null) this.s.startedAt = rec.t;
    this.s.trades.push(rec);
    this.prune();
    this.save();
    return rec;
  }

  private prune() {
    const cut = this.now() - LiveTradeBook.KEEP_MS;
    while (this.s.trades.length && (this.s.trades[0].t < cut || this.s.trades.length > LiveTradeBook.MAX_TRADES)) {
      this.sinceStartOld += this.s.trades.shift()!.kept;
    }
  }

  private dayKey(ms: number) { return new Date(ms).toLocaleDateString('en-CA', { timeZone: this.tz }); }

  // Won / missed / kept between two times. "Missed" = reverted (dropped cost nothing and isn't counted).
  window(fromMs: number, toMs: number): DayCount & { gas: number } {
    const c = { usd: 0, won: 0, missed: 0, gas: 0 };
    for (const x of this.s.trades) {
      if (x.t < fromMs || x.t > toMs) continue;
      c.usd += x.kept; c.gas += x.gas;
      if (x.status === 'profit') c.won++; else if (x.status === 'reverted') c.missed++;
    }
    return c;
  }

  // Today (report zone calendar day).
  today(): DayCount {
    const k = this.dayKey(this.now());
    const c = { usd: 0, won: 0, missed: 0 };
    for (const x of this.s.trades) {
      if (this.dayKey(x.t) !== k) continue;
      c.usd += x.kept;
      if (x.status === 'profit') c.won++; else if (x.status === 'reverted') c.missed++;
    }
    return c;
  }

  sinceStart(): number { return this.sinceStartOld + this.s.trades.reduce((a, x) => a + x.kept, 0); }

  // Per clock hour, per pair and the best trade, for the 4-hour report.
  breakdown(fromMs: number, toMs: number) {
    const hours = new Map<number, number>();
    for (let h = Math.floor(fromMs / 3600_000) * 3600_000; h < toMs; h += 3600_000) hours.set(h, 0);
    const pairs = new Map<string, { usd: number; n: number }>();
    let best: { usd: number; pair: string } | null = null;
    for (const x of this.s.trades) {
      if (x.t < fromMs || x.t > toMs || x.status === 'dropped') continue;
      const h = Math.floor(x.t / 3600_000) * 3600_000;
      hours.set(h, (hours.get(h) ?? 0) + x.kept);
      const p = pairs.get(x.pair) ?? { usd: 0, n: 0 };
      p.usd += x.kept; p.n++; pairs.set(x.pair, p);
      if (x.status === 'profit' && (!best || x.kept > best.usd)) best = { usd: x.kept, pair: x.pair };
    }
    return {
      byHour: [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([startMs, usd]) => ({ startMs, usd })),
      topPairs: [...pairs.entries()].map(([pair, v]) => ({ pair, ...v })).sort((a, b) => b.usd - a.usd),
      best,
    };
  }

  // Starting wallet (coin -> amount). Set once, on the first live read.
  startOf(coin: string): number | null { return Number.isFinite(this.s.start[coin]) ? this.s.start[coin] : null; }
  setStart(coin: string, amount: number) { this.s.start[coin] = amount; this.save(); }

  save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify({ ...this.s, sinceStartOld: this.sinceStartOld }));
      renameSync(tmp, this.file);
    } catch { /* reporting only: never affects trading */ }
  }
}

// ----------------------------------------------------------------------------
// WALLET WATCH: notices coin amounts in the trade contract that change with
// no trade to explain them.
//
//   - Own-money trades only ever ADD coins to the contract (a trade that
//     would end with less reverts), so a DROP of more than DROP_PCT is
//     never a trade: it is a withdrawal (or worse). Alert.
//   - A big RISE (more than RISE_PCT) is a deposit: the "started" amount is
//     raised by the same amount, so the wallet table stays honest.
//   - A drop also lowers "started" (after alerting), for the same reason.
//   Before the first read, "started" is set from the first read.
// ----------------------------------------------------------------------------
export class WalletWatch {
  static DROP_PCT = 0.005;   // a drop over 0.5% is never a trade
  static RISE_PCT = 0.02;    // a rise over 2% at once is a deposit, not a trade
  private last = new Map<string, number>();

  constructor(private readonly book: LiveTradeBook, private readonly onDrop: (coin: string, dropped: number) => void) {}

  observe(coin: string, amount: number) {
    if (!Number.isFinite(amount) || amount < 0) return;
    if (this.book.startOf(coin) === null) this.book.setStart(coin, amount);
    const prev = this.last.get(coin);
    this.last.set(coin, amount);
    if (prev === undefined) return;
    const diff = amount - prev;
    if (diff < 0 && -diff > prev * WalletWatch.DROP_PCT) {
      this.onDrop(coin, -diff);
      this.book.setStart(coin, Math.max(0, (this.book.startOf(coin) ?? 0) + diff));
    } else if (diff > 0 && diff > Math.max(prev, 1e-12) * WalletWatch.RISE_PCT) {
      this.book.setStart(coin, (this.book.startOf(coin) ?? 0) + diff);
    }
  }

  now(coin: string): number | null { return this.last.get(coin) ?? null; }
}
