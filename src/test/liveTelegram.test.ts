// Live-mode Telegram layout (report/liveTelegram.ts): per-trade messages,
// hourly, 4-hourly, the saved trade book and the wallet watch.
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  formatLiveTrade, formatLiveHourly, formatLive4h, LiveTradeBook, WalletWatch,
  splitLabel, signedUsd, bar, liveLayoutOn, gasLowSpec, walletChangedSpec,
} from '../report/liveTelegram';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const noEmDash = (s: string) => !s.includes('—');
const TZ = 'America/Toronto';
// 2026-10-18 14:00 Toronto (18:00 UTC).
const T0 = Date.UTC(2026, 9, 18, 18, 0, 0);

// ---- helpers ----------------------------------------------------------------
assert(liveLayoutOn({}) && !liveLayoutOn({ TELEGRAM_LIVE_LAYOUT: '0' }), 'switch: on by default, TELEGRAM_LIVE_LAYOUT=0 turns it off');
{
  const a = splitLabel('WETH/USDG uniswap-v3>sushiswap-v3');
  assert(a.pair === 'WETH/USDG' && a.route === 'bought on Uniswap V3, sold on SushiSwap V3', 'label: pair and plain route');
  assert(splitLabel('MSTR/USDG').route === null && splitLabel('').pair === 'unknown pair', 'label: no venues / empty');
  assert(signedUsd(0.384) === '+$0.38' && signedUsd(-0.02) === '-$0.02' && signedUsd(-0.001) === '+$0.00' && signedUsd(NaN) === 'n/a', 'signed dollars');
  assert(bar(0.7, 0.7) === '█' && bar(0.2, 0.7) === '▃' && bar(0, 0.7) === '' && bar(-1, 0.7) === '', 'bars scale to the best hour, nothing for zero or losses');
}

// ---- 1. per-trade messages ------------------------------------------------------
{
  const won = formatLiveTrade({ status: 'profit', label: 'WETH/USDG uniswap-v3>sushiswap-v3', gasUsd: 0.02, profitUsd: 0.40, sizeUsd: 200, today: { usd: 2.10, won: 6, missed: 3 } });
  assert(won.startsWith('🟢 LIVE\n✅ <b>TRADE WON  +$0.38</b>'), 'won: LIVE banner and kept after gas in the headline');
  assert(won.includes('Put in   $200.00') && won.includes('Got back $200.40') && won.includes('Gas      -$0.02'), 'won: put in / got back / gas');
  assert(won.includes('Today    +$2.10 (6 won, 3 missed)'), 'won: today line');
  const nosize = formatLiveTrade({ status: 'profit', label: 'WETH/USDG', gasUsd: 0.02, profitUsd: 0.40, today: { usd: 0.38, won: 1, missed: 0 } });
  assert(nosize.includes('Profit   +$0.40') && !nosize.includes('Put in'), 'won without a size: shows profit instead');
  const noprice = formatLiveTrade({ status: 'profit', label: 'X/USDG', gasUsd: 0.02, today: { usd: -0.02, won: 1, missed: 0 } });
  assert(noprice.includes('profit amount unknown') && !noprice.includes('n/a'), 'won with no price: honest headline');
  const miss = formatLiveTrade({ status: 'reverted', label: 'WETH/USDG a>b', gasUsd: 0.02, today: { usd: 2.08, won: 6, missed: 4 } });
  assert(miss.startsWith('🟢 LIVE\n❌ <b>MISSED  -$0.02</b>') && miss.includes('Your coins are safe') && miss.includes('(6 won, 4 missed)'), 'missed: gas only, coins safe, today line');
  const drop = formatLiveTrade({ status: 'dropped', label: 'WETH/USDG', gasUsd: 0, today: { usd: 0, won: 0, missed: 0 } });
  assert(drop.includes('NOT SENT THROUGH  $0.00') && drop.includes('No cost'), 'dropped: no cost');
  const evil = formatLiveTrade({ status: 'reverted', label: '<b>X</b>/USDG', gasUsd: 0.01, today: { usd: 0, won: 0, missed: 1 } });
  assert(evil.includes('&lt;b&gt;X&lt;/b&gt;') && [won, miss, drop].every(noEmDash), 'escapes HTML from labels, no em dashes');
}

// ---- 2. hourly ----------------------------------------------------------------
{
  const h = formatLiveHourly({
    tz: TZ, fromMs: T0, toMs: T0 + 3600_000, partial: null,
    hour: { usd: 0.85, won: 3, missed: 2 }, todayUsd: 2.08, sinceStartUsd: 5.4,
    wallet: [{ coin: 'USDG', now: 201.9, start: 200, digits: 2 }, { coin: 'WETH', now: 0.0067, start: 0.0067, digits: 4 }],
    gas: { eth: 0.0033, tradesLeft: 180 }, loss: { usedUsd: 0.12, capUsd: 25 }, biggestTrade: [{ coin: 'USDG', usd: 196 }, { coin: 'WETH', usd: 19.6 }],
    bot: { ok: true, text: 'all good' },
  });
  assert(h.startsWith('🟢 <b>LIVE · 2pm–3pm</b>'), 'hourly: LIVE banner and time range');
  assert(h.includes('This hour') && h.includes('+$0.85') && h.includes('(3 won, 2 missed)') && h.includes('Since start') && h.includes('+$5.40'), 'hourly: real money lines');
  assert(/USDG\s+201\.90\s+200\.00/.test(h) && /WETH\s+0\.0067\s+0\.0067/.test(h), 'hourly: wallet now vs started');
  assert(/Gas \(ETH\)\s+0\.0033\s+≈ 180 trades left/.test(h), 'hourly: gas and trades left');
  assert(h.includes('$0.12 used of $25.00') && h.includes('Biggest trade      USDG $196.00 · WETH $19.60 (your wallet)') && h.includes('✅ running, connected'), 'hourly: safety block');
  assert(!h.includes('Checked wins') && !h.includes('Could earn live') && noEmDash(h), 'hourly: no practice numbers, no em dashes');
  const bad = formatLiveHourly({
    tz: TZ, fromMs: T0, toMs: T0 + 1200_000, partial: 'bot restarted', hour: { usd: 0, won: 0, missed: 0 }, todayUsd: 0, sinceStartUsd: 0,
    wallet: [{ coin: 'USDG', now: null, start: null, digits: 2 }], gas: { eth: null, tradesLeft: null }, loss: { usedUsd: 0, capUsd: 25 },
    biggestTrade: [{ coin: 'USDG', usd: null }], bot: { ok: false, text: 'live trade feed down' },
  });
  assert(bad.includes('(bot restarted)') && /USDG\s+n\/a\s+n\/a/.test(bad) && bad.includes('n/a   n/a') && bad.includes('⚠️ live trade feed down') && bad.includes('USDG n/a (your wallet)'), 'hourly: partial, unknown numbers as n/a, health problem shown');
  assert(h.length < 4096, 'hourly fits in one Telegram message');
}

// ---- 3. 4-hour ----------------------------------------------------------------
{
  const r = formatLive4h({
    tz: TZ, fromMs: T0 - 4 * 3600_000, toMs: T0, keptUsd: 1.6, won: 9, missed: 5, best: { usd: 0.52, pair: 'WETH/USDG' }, gasUsd: 0.28,
    byHour: [0.2, 0.7, 0.4, 0.3].map((usd, i) => ({ startMs: T0 - (4 - i) * 3600_000, usd })),
    topPairs: [{ pair: 'WETH/USDG', usd: 1.1, n: 6 }, { pair: 'MSTR/USDG', usd: 0.5, n: 3 }], found: 40,
  });
  assert(r.startsWith('🟢 <b>LIVE · 4-HOUR REPORT (10am–2pm)</b>'), '4h: LIVE banner and range');
  assert(r.includes('+$1.60 kept after gas') && r.includes('Won 9 · Missed 5 · Win rate 64%') && r.includes('Best trade  +$0.52 WETH/USDG') && r.includes('Gas spent   $0.28'), '4h: money, win rate, best, gas');
  assert(/10am\s+\+\$0\.20 ▃/.test(r) && /11am\s+\+\$0\.70 █/.test(r), '4h: hours with bars');
  assert(/WETH\/USDG\s+\+\$1\.10\s+\(6 trades\)/.test(r) && r.includes('Chances found 40 · Won 9') && r.includes('(Missed 31: other bots faster or too small)'), '4h: top pairs and chances');
  const empty = formatLive4h({ tz: TZ, fromMs: T0, toMs: T0 + 1, keptUsd: 0, won: 0, missed: 0, best: null, gasUsd: 0, byHour: [], topPairs: [], found: null });
  assert(empty.includes('Win rate n/a') && empty.includes('none yet') && empty.includes('no real trades yet') && !empty.includes('Chances found'), '4h: empty period is honest');
  assert(noEmDash(r) && noEmDash(empty), '4h: no em dashes');
}

// ---- 4. alert text --------------------------------------------------------------
{
  const g = gasLowSpec(12, 0.00021);
  assert(g.title === 'Gas low: about 12 trades left' && g.critical === true && g.details[0].includes('0.00021 ETH'), 'alert: gas low');
  const w = walletChangedSpec('USDG', 15, 2);
  assert(w.title === 'Wallet changed unexpectedly' && w.meaning === 'USDG dropped 15.00 with no trade to explain it' && w.critical === true, 'alert: wallet changed');
}

// ---- 5. trade book ---------------------------------------------------------------
{
  let now = T0;
  const dir = mkdtempSync(join(tmpdir(), 'livetg-'));
  const file = join(dir, 'live-telegram.json');
  const book = new LiveTradeBook(file, TZ, () => now);
  book.add({ status: 'profit', label: 'WETH/USDG a>b', gasUsd: 0.02, profitUsd: 0.40 });
  now += 60_000; book.add({ status: 'reverted', label: 'WETH/USDG a>b', gasUsd: 0.02 });
  now += 60_000; book.add({ status: 'dropped', label: 'MSTR/USDG a>b', gasUsd: 0 });
  now += 3600_000; book.add({ status: 'profit', label: 'MSTR/USDG a>b', gasUsd: 0.03, profitUsd: 0.53 });
  const t = book.today();
  assert(Math.abs(t.usd - 0.86) < 1e-9 && t.won === 2 && t.missed === 1, 'book: today = profit minus all gas, dropped not counted as missed');
  const w = book.window(T0, T0 + 3600_000);
  assert(Math.abs(w.usd - 0.36) < 1e-9 && w.won === 1 && w.missed === 1 && Math.abs(w.gas - 0.04) < 1e-9, 'book: window');
  const b = book.breakdown(T0, now);
  assert(b.best?.pair === 'MSTR/USDG' && Math.abs(b.best.usd - 0.5) < 1e-9, 'book: best trade');
  assert(b.topPairs[0].pair === 'MSTR/USDG' && b.topPairs[1].n === 2 && b.byHour.length === 2, 'book: pairs (dropped left out) and hours');
  assert(existsSync(file), 'book: saved to disk');
  const again = new LiveTradeBook(file, TZ, () => now);
  assert(Math.abs(again.sinceStart() - 0.86) < 1e-9 && again.today().won === 2, 'book: survives a restart');
  // Old trades are pruned but still count toward "since start".
  now += 9 * 24 * 3600_000;
  again.add({ status: 'profit', label: 'WETH/USDG', gasUsd: 0, profitUsd: 1 });
  assert(Math.abs(again.sinceStart() - 1.86) < 1e-9 && again.today().won === 1, 'book: pruning keeps since-start right');
  assert(Math.abs(new LiveTradeBook(file, TZ, () => now).sinceStart() - 1.86) < 1e-9, 'book: pruned total survives a restart');
  // No file (practice): works in memory, never throws.
  const mem = new LiveTradeBook(null, TZ, () => now);
  mem.add({ status: 'profit', label: 'A/B', gasUsd: 0.01, profitUsd: NaN });
  assert(Math.abs(mem.sinceStart() + 0.01) < 1e-9, 'book: no file and a missing profit price are handled');
}

// ---- 6. wallet watch ---------------------------------------------------------------
{
  const book = new LiveTradeBook(null, TZ, () => T0);
  const drops: string[] = [];
  const ww = new WalletWatch(book, (coin, d) => drops.push(`${coin}:${d.toFixed(2)}`));
  ww.observe('USDG', 200);
  assert(book.startOf('USDG') === 200 && ww.now('USDG') === 200, 'wallet: first read sets started');
  ww.observe('USDG', 200.4);
  assert(drops.length === 0 && book.startOf('USDG') === 200, 'wallet: a trade profit is not a deposit');
  ww.observe('USDG', 185.4);
  assert(drops[0] === 'USDG:15.00' && book.startOf('USDG') === 185, 'wallet: unexplained drop alerts and lowers started');
  ww.observe('USDG', 185.39);
  assert(drops.length === 1, 'wallet: tiny wobble under 0.5% is not an alert');
  ww.observe('USDG', 285.39);
  assert(drops.length === 1 && Math.abs((book.startOf('USDG') ?? 0) - 285) < 1e-9, 'wallet: a deposit raises started, no alert');
  ww.observe('WETH', 0);
  ww.observe('WETH', 0.0067);
  assert(book.startOf('WETH') === 0.0067 && drops.length === 1, 'wallet: first deposit into an empty coin');
  ww.observe('USDG', NaN);
  assert(ww.now('USDG') === 285.39, 'wallet: a bad read is ignored');
}
