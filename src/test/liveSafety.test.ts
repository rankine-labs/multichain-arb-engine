// Tests for the Oct 17 go-live safety pieces:
//   - the live coin rule (core/liveCoins.ts): only USDG/WETH, official
//     Robinhood stock tokens (name AND beacon) and LIVE_EXTRA_COINS;
//   - the tested-venues gate (config/robinhoodVenues.ts): fork-tested
//     exchanges become live only when switched on after a contract match,
//     never Abyss (meme coins), never untested venues;
//   - the contract match (execution/contractMatch.ts): same code by hash.
import { LiveCoinRule, ROBINHOOD_TOKEN_BEACON } from '../core/liveCoins';
import { isExecutableIn, ROBINHOOD_VENUES, setTestedVenuesLive, isExecutableVenue } from '../config/robinhoodVenues';
import { sameCode } from '../execution/contractMatch';
import { ARB_EXECUTOR_RUNTIME_CODE } from '../execution/arbExecutorBytecode';
import { ethers } from 'ethers';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

async function main() {
  // ---- live coin rule ------------------------------------------------------
  const USDG = '0x' + '11'.repeat(20), WETH = '0x' + '22'.repeat(20);
  const NVDA = '0x' + '33'.repeat(20), FAKE = '0x' + '44'.repeat(20), MEME = '0x' + '55'.repeat(20), CBBTC = '0x' + '66'.repeat(20);
  const word = (a: string) => '0x' + '0'.repeat(24) + a.slice(2);
  const nameRet = (n: string) => ethers.AbiCoder.defaultAbiCoder().encode(['string'], [n]);
  const fake = {
    getStorage: async (a: string) => (a === NVDA || a === FAKE ? word(a === NVDA ? ROBINHOOD_TOKEN_BEACON : '0x' + '99'.repeat(20)) : '0x' + '0'.repeat(64)),
    call: async (tx: { to: string }) => nameRet(tx.to === NVDA ? 'NVIDIA • Robinhood Token' : tx.to === FAKE ? 'NVIDIA • Robinhood Token' : 'CASHCAT'),
  };
  const rule = new LiveCoinRule(fake, [USDG, WETH], { LIVE_EXTRA_COINS: CBBTC });
  assert(rule.on, 'rule is on by default');
  assert(rule.verdict(USDG) === 'allowed' && rule.verdict(WETH) === 'allowed', 'USDG and WETH always allowed');
  assert(rule.verdict(CBBTC) === 'allowed', 'LIVE_EXTRA_COINS allowed');
  assert(rule.verdict(NVDA) === 'unknown' && rule.blocker([USDG, NVDA]) !== null, 'unchecked coin: not allowed yet (never delays a trade)');
  await rule.lookup(NVDA); await rule.lookup(FAKE); await rule.lookup(MEME);
  assert(rule.verdict(NVDA) === 'allowed', 'official Robinhood stock token (name + beacon) allowed');
  assert(rule.verdict(FAKE) === 'refused', 'copycat with the right name but another beacon refused');
  assert(rule.verdict(MEME) === 'refused', 'meme coin refused');
  assert(rule.blocker([USDG, NVDA]) === null && /not on the live coin list/.test(rule.blocker([USDG, MEME]) ?? ''), 'blocker: NVDA/USDG ok, meme/USDG refused');
  const off = new LiveCoinRule(fake, [USDG, WETH], { LIVE_COIN_RULE: 'off' });
  assert(!off.on && off.verdict(MEME) === 'allowed', 'LIVE_COIN_RULE=off: old behaviour');

  // ---- tested venues gate --------------------------------------------------
  assert(ROBINHOOD_VENUES.every((v) => !isExecutableIn(ROBINHOOD_VENUES, v.id, false)), 'switched off: every extra venue refused (as before)');
  const liveWhenOn = ROBINHOOD_VENUES.filter((v) => isExecutableIn(ROBINHOOD_VENUES, v.id, true)).map((v) => v.id).sort();
  assert(liveWhenOn.join(',') === ['alandale', 'fables', 'giga-cl', 'kittenswap-algebra', 'raphael-cl', 'sushiswap-v3', 'swaphood-v3', 'topaz-cl', 'up-cl'].join(','),
    `switched on: exactly the fork-tested venues, no Abyss, nothing untested (${liveWhenOn.join(',')})`);
  assert(isExecutableIn(ROBINHOOD_VENUES, 'uniswap-v3', false) && isExecutableIn(ROBINHOOD_VENUES, 'uniswap-v3', true), 'core exchanges always pass');
  assert(!isExecutableVenue('up-cl'), 'default (process state): UP refused');
  setTestedVenuesLive(true);
  assert(isExecutableVenue('up-cl') && !isExecutableVenue('abyss-cl') && !isExecutableVenue('metric'), 'after the contract check: UP live, Abyss and untested venues still refused');
  setTestedVenuesLive(false);

  // ---- contract match ------------------------------------------------------
  assert(sameCode(ARB_EXECUTOR_RUNTIME_CODE), 'tested code matches itself');
  assert(sameCode(ARB_EXECUTOR_RUNTIME_CODE.toUpperCase().replace('0X', '0x')), 'case does not matter');
  assert(!sameCode(ARB_EXECUTOR_RUNTIME_CODE.slice(0, -2) + '00') && !sameCode('0x'), 'any different byte (or no code) is not a match');
}
main();
