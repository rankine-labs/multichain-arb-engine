// Compact printer for diag1.json: one short line per pool, then comparisons.
const d = require(process.env.HOME + '/rx/stockpx/diag1.json');
const what = process.argv[2] || 'pools';
const s = (x) => x === undefined ? '-' : String(x);
const big = (x) => x === undefined ? '-' : (String(x).length > 12 ? Number(x).toExponential(3) : String(x));
if (what === 'pools') {
  console.log('block', d.block, 'done', !!d.done, d.fatal || '');
  for (const [k, p] of Object.entries(d.pools)) {
    const b = p.bot || {}, c = p.chainNow || {}, a = p.chainAtBotBlock || {};
    console.log([k, (p.dex || '').replace('uniswap-', ''), s(p.symA) + '/' + s(p.symB), 'dec', s(p.decA_bot) + '=' + s(p.decA_chain), s(p.decB_bot) + '=' + s(p.decB_chain),
      'fee', s(p.feeBot) + '|' + s(p.feeChain), 'ts', s(p.tickSpacing), 'hk', s(p.hooks).slice(0, 8), p.hookFlags ? Object.entries(p.hookFlags).filter((e) => e[1]).map((e) => e[0]).join('+') : '',
      'id', s(p.keyIdMatches), 'Lb', big(b.L), 'La', big(a.L), 'Ln', big(c.L), 'sqEq', s(b.sqrtP === a.sqrtP), 'nT', s(p.edges?.nTicks),
      'dn%', p.edges?.pctToNextDown?.toFixed(2), 'up%', p.edges?.pctToNextUp?.toFixed(2), (p.err || a.err || c.err || p.windowErr || '').slice(0, 50)].join(' '));
  }
} else {
  const p = d.pools[what]; console.log(what, p.symA + '/' + p.symB, 'coinUsd', p.coinUsd?.toFixed(3));
  for (const r of p.cmp || []) console.log(r.usd, r.in, 'guess', r.guessUsd?.toFixed?.(2), 'tick', r.tickUsd?.toFixed?.(2), 'x', s(r.crossed), r.left ? 'LEFT' : '', 'quoter', typeof r.quoterUsd === 'number' ? r.quoterUsd.toFixed(2) : String(r.quoterUsd).slice(0, 40), r.exactMatch ? 'EXACT' : '');
}
