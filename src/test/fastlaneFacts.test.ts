import { fastlaneFacts, fastlaneFactsFp, fastlaneFactsOn, entrySettings, EntryCandidate } from '../execution/trigEntry';

// FAST LANE FACTS (execution/trigEntry.ts): with FASTLANE=practice|live the
// one-trip candidate table also carries, per route, what the Rust standing-gap
// scanner (sim/src/fastlane/scan.rs) needs to value a result in dollars: the
// start coin's price and decimals, the gas estimate and the lender's fee.
// Off (the default) nothing is added: the table is exactly as before.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const cand = (fx?: EntryCandidate['fx'], gasUsd = 0.0512345678912): EntryCandidate => ({
  label: 'WETH/USDG uniswap-v3>fables', buyPool: '0xa', sellPool: '0xb', tokenIn: '0xc', tokens: ['0xc', '0xd'], keys: ['0xa', '0xb'],
  maxSizeUsd: 400, gasUsd, build: () => null, usdOf: (u) => Number(u), fx,
});

assert(!fastlaneFactsOn({}) && !fastlaneFactsOn({ FASTLANE: 'off' }) && !fastlaneFactsOn({ FASTLANE: 'bogus' }), 'off by default, unknown = off');
assert(fastlaneFactsOn({ FASTLANE: 'practice' }) && fastlaneFactsOn({ FASTLANE: ' LIVE ' }) && fastlaneFactsOn({ FASTLANE: 'shadow' }), 'practice / live (same words as the Rust mode.rs)');
assert(entrySettings({}).fastlaneFacts === false && entrySettings({ FASTLANE: 'practice' }).fastlaneFacts === true, 'entry settings carry the switch');

const f = fastlaneFacts(cand({ px: 3456.123456789123, d: 18, lp: 500 }))!;
assert(f !== null && f.l === 'WETH/USDG uniswap-v3>fables' && f.d === 18 && f.lp === 500, 'label, decimals, loan pips');
assert(f.px === 3456.12346 && f.g === 0.0512345679, 'price and gas kept to 9 significant digits');
assert(fastlaneFacts(cand(undefined)) === null, 'no facts given = none sent');
assert(fastlaneFacts(cand({ px: 0, d: 6 })) === null && fastlaneFacts(cand({ px: NaN, d: 6 })) === null, 'no price = none (never valued wrongly)');
assert(fastlaneFacts(cand({ px: 1, d: 37 })) === null && fastlaneFacts(cand({ px: 1, d: 1.5 })) === null, 'bad decimals = none');
assert(fastlaneFacts(cand({ px: 1, d: 6 }, NaN)) === null, 'bad gas = none');
assert(!('lp' in fastlaneFacts(cand({ px: 1, d: 6 }))!), 'loan pips optional');

// Review H2: tiny price / gas moves don't change the pool's fingerprint (no resend every refresh).
const fpA = fastlaneFactsFp(fastlaneFacts(cand({ px: 3456.12, d: 18, lp: 500 }), )!);
const fpB = fastlaneFactsFp(fastlaneFacts(cand({ px: 3457.9, d: 18, lp: 500 }, 0.0512))!);
const fpC = fastlaneFactsFp(fastlaneFacts(cand({ px: 3600, d: 18, lp: 500 }))!);
assert(fpA === fpB, 'price within 0.1% and gas within 2 digits: same fingerprint');
assert(fpA !== fpC, 'a real price move changes the fingerprint');
