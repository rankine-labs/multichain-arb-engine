// Fit a trade to the wallet (core/ownMoney.ts fitTradeToWallet, Oct 18):
// live, own money, no loans. A best size bigger than the wallet is shrunk to
// the wallet and re-priced with the same pool maths the bot sized it with.
import { fitTradeToWallet } from '../core/ownMoney';
import { roundTripQuote, findOptimalTradeSize } from '../core/profitCalculator';
import { PoolState } from '../core/types';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// Addresses: USDG sorts before WETH here (USDG = token0 on pool A, token1 on pool B to test both orders).
const USDG = '0x1000000000000000000000000000000000000001';
const WETH = '0x2000000000000000000000000000000000000002';
// V2 pool, 18 decimals both sides for simplicity, human reserves.
const v2 = (addr: string, a: string, b: string, ra: number, rb: number): PoolState => ({
  chain: 'robinhood', dex: 'uniswap-v2', poolAddress: addr, poolType: 'v2', tokenA: a, tokenB: b,
  reserveA: BigInt(Math.round(ra * 1e6)) * 10n ** 12n, reserveB: BigInt(Math.round(rb * 1e6)) * 10n ** 12n,
  feeBps: 30, lastUpdatedBlock: 0, lastUpdatedMs: 0,
});

// WETH cheap on A (1 WETH = 3,000 USDG), dear on B (1 WETH = 3,060 USDG). Deep enough
// that the best size is well over $200.
const A = v2('0xa000000000000000000000000000000000000001', USDG, WETH, 3_000_000, 1_000);   // token0 USDG
const B = v2('0xb000000000000000000000000000000000000002', WETH, USDG, 1_000, 3_060_000);   // token0 WETH (other order)
const quote = roundTripQuote(A, B, USDG, 1, 18);

// 1) roundTripQuote = the sizing maths (same gross at the same size).
{
  const best = findOptimalTradeSize(A, B, {} as any, true, 50_000, 1, 0, 0.02, 18);
  const q = quote(best.optimalTradeSizeUsd);
  assert(best.optimalTradeSizeUsd > 200, `best size is over the wallet ($${Math.round(best.optimalTradeSizeUsd)})`);
  assert(q !== null && Math.abs(q - best.grossProfitUsd) < 1e-9, 'roundTripQuote gives the same profit as the sizing maths (pool order handled)');
  assert(quote(0) === null && roundTripQuote(A, B, USDG, 0, 18)(100) === null, 'no size or no price: no quote');
}

// 2) Too big for the wallet: shrunk to the wallet, profit re-priced.
{
  const best = findOptimalTradeSize(A, B, {} as any, true, 50_000, 1, 0, 0.02, 18);
  const gas = 0.02, margin = 0.05;
  const net = best.grossProfitUsd - gas - margin;
  const fit = fitTradeToWallet({ sizeUsd: best.optimalTradeSizeUsd, netUsd: net, capUsd: 196, quote, gasUsd: gas });
  assert(fit !== null && fit.sizeUsd === 196, 'trade shrunk to the wallet ($196 after the 2% cushion on $200)');
  const expectGross = quote(196)!;
  const keep = (net + gas) / best.grossProfitUsd;
  assert(fit !== null && Math.abs(fit.grossUsd - expectGross) < 1e-9 && Math.abs(fit.netUsd - (expectGross * keep - gas)) < 1e-9, 'profit at the smaller size = new gross x same share kept, minus the full gas');
  assert(fit !== null && fit.netUsd > 0.25 && fit.netUsd < net, `smaller trade still clears $0.25 here, and makes less than the full size ($${fit!.netUsd.toFixed(2)} vs $${net.toFixed(2)})`);
}

// 2b) The worked example from the code comment: 80% kept, $2.10 gross -> $1.66.
{
  const q = (x: number) => (x === 1_000 ? 10 : x === 200 ? 2.1 : null);
  const fit = fitTradeToWallet({ sizeUsd: 1_000, netUsd: 7.98, capUsd: 200, quote: q, gasUsd: 0.02 });
  assert(fit !== null && Math.abs(fit.netUsd - 1.66) < 1e-9, 'worked example: $1.66');
}

// 3) Nothing changes when it fits, the wallet is empty, or numbers are bad.
{
  assert(fitTradeToWallet({ sizeUsd: 150, netUsd: 0.5, capUsd: 196, quote, gasUsd: 0.02 }) === null, 'fits already: unchanged');
  assert(fitTradeToWallet({ sizeUsd: 150, netUsd: 0.5, capUsd: 150, quote, gasUsd: 0.02 }) === null, 'exactly the wallet: unchanged');
  assert(fitTradeToWallet({ sizeUsd: 600, netUsd: 1, capUsd: 0, quote, gasUsd: 0.02 }) === null, 'empty wallet: unchanged (the usual own-money check refuses it)');
  assert(fitTradeToWallet({ sizeUsd: 600, netUsd: NaN, capUsd: 196, quote, gasUsd: 0.02 }) === null, 'broken profit number: unchanged');
  assert(fitTradeToWallet({ sizeUsd: 600, netUsd: 1, capUsd: 196, quote: () => null, gasUsd: 0.02 }) === null, "pools can't price it: unchanged");
}

// 4) A small wallet can turn a good trade into one under the send minimum:
//    the caller's normal $0.25 check then refuses it (never sent at a loss).
{
  const g = quote(5_000)!;
  const fit = fitTradeToWallet({ sizeUsd: 5_000, netUsd: g * 0.8 - 0.02, capUsd: 5, quote, gasUsd: 0.02 });
  assert(fit !== null && fit.netUsd < 0.25 && fit.netUsd > -0.03, `tiny wallet ($5): new profit $${fit!.netUsd.toFixed(2)} is under $0.25 (send minimum refuses it), and the estimate is sane, not a big fake loss`);
}

// 5) Never more than the pool maths says, and a losing estimate stays losing.
{
  const g = quote(1_000)!;
  const over = fitTradeToWallet({ sizeUsd: 1_000, netUsd: g + 5, capUsd: 196, quote, gasUsd: 0.02 });
  assert(over !== null && Math.abs(over.netUsd - (quote(196)! - 0.02)) < 1e-9, 'estimate above the maths: capped at the maths minus gas (no extra profit invented)');
  const neg = fitTradeToWallet({ sizeUsd: 1_000, netUsd: -5, capUsd: 196, quote, gasUsd: 0.02 });
  assert(neg !== null && Math.abs(neg.netUsd + 0.02) < 1e-9, 'losing estimate: smaller trade is not made to look profitable');
  assert(fitTradeToWallet({ sizeUsd: 1_000, netUsd: 1, capUsd: 196, quote: (x) => (x === 1_000 ? 0 : 1), gasUsd: 0.02 }) === null, 'no gross at full size: unchanged');
}
