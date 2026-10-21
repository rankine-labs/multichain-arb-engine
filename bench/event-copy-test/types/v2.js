// ============================================================================
// POOL TYPE 1: Uniswap V2 pair (real UniswapV2Pair bytecode, npm v2-core 1.0.1)
//
// Pair storage (slot: what):
//   0 totalSupply (LP coins)   1 LP balances (mapping)   2 LP allowances
//   3 DOMAIN_SEPARATOR         4 permit nonces          5 factory
//   6 token0  7 token1
//   8 reserve0 | reserve1 | blockTimestampLast   (packed in one slot)
//   9 price0CumulativeLast    10 price1CumulativeLast
//  11 kLast (only used when the factory's protocol fee is on)
//  12 unlocked (re-entry lock)
//
// How the copy follows it from EVENTS only:
//   Sync(r0, r1)       -> slot 8 = r0 | r1 | (block time mod 2^32)
//                         slots 9/10: the pair adds old-price x seconds since
//                         the last Sync; we know the old reserves and old time,
//                         so we compute the same numbers (exact integer math).
//   Transfer (LP coin) -> LP balances + totalSupply (mint = from 0, burn = to 0)
//   Approval (LP coin) -> allowance slot
//   Coin Transfer      -> the pair's coin balances (see common.js)
//   Mint/Burn/Swap     -> nothing extra (Sync + Transfers carry all changes)
//   kLast              -> stays 0 (protocol fee off; would need a re-read or
//                         the Sync-time formula if the factory fee were on)
// ============================================================================
const L = require('../lib');
const C = require('./common');
const { ethers, lc } = L;

const v2f = require('@uniswap/v2-core/build/UniswapV2Factory.json');
const v2p = require('@uniswap/v2-core/build/UniswapV2Pair.json');
const SYNC = ethers.id('Sync(uint112,uint112)');
const pairIface = new ethers.Interface(v2p.abi);
const H = () => L.helpers();
const traderIface = () => new ethers.Interface(H().Trader.abi);

async function setup(chain, rng) {
  const base = await C.setupBase(chain, rng);
  const f = await L.deploy(chain, v2f.abi, '0x' + v2f.bytecode.replace(/^0x/, ''), chain.me);
  await (await f.createPair(base.U, base.W)).wait();
  const pair = lc(await f.getPair(base.U, base.W));
  // Starting liquidity: 400 WETH + 1,000,000 USD (price 2500).
  await (await base.traderC.mintV2(pair, ...(BigInt(base.U) < BigInt(base.W) ? [1_000_000n * C.Q(6), 400n * C.Q(18)] : [400n * C.Q(18), 1_000_000n * C.Q(6)]))).wait();
  const ctx = { ...base, pair, factory: lc(await f.getAddress()) };
  ctx.namer = C.makeNamer(base, { pair });
  ctx.namer.label.set(pair, 'v2pair');
  for (const [i, n] of ['LP.totalSupply', 'LP.balances(root)', 'LP.allowances(root)', 'DOMAIN_SEPARATOR', 'nonces', 'factory', 'token0', 'token1', 'reserves+blockTimestampLast', 'price0CumulativeLast', 'price1CumulativeLast', 'kLast', 'unlocked'].entries()) ctx.namer.add(pair, i, n);
  for (const [hn, h] of Object.entries({ trader: base.trader, pair, zero: ethers.ZeroAddress })) ctx.namer.add(pair, L.mapSlot('address', h, 1), `LP.balance[${hn}]`);
  return ctx;
}

const copiedAccounts = (ctx) => [ctx.pair, ctx.U, ctx.W, ...ctx.refs.map((r) => r.addr)];
async function initCopy() {}
// Every pair slot is derivable from events: nothing is a known unknown.
const policyUnknown = () => new Map();
const slotName = (ctx, a, k) => ctx.namer.name(a, k);
const label = (ctx, a) => ctx.namer.label.get(a) ?? a;

function checkSpecs(ctx) {
  return C.checkSpecs(ctx, (tin, tout) => L.hop(0, ctx.pair, tin, tout, { feeBps: 30 }));
}

// Random market activity on the truth chain.
async function randomOp(rng, ctx) {
  const ti = traderIface();
  const r = rng.next();
  const T = ctx.trader;
  if (r < 0.70) { // swap, either way, $1 .. $400k
    const usd = rng.logBig(1n, 400_000n);
    const inU = rng.next() < 0.5;
    const amt = inU ? usd * C.Q(6) : (usd * C.Q(18)) / 2500n;
    return { kind: 'swap', to: T, data: ti.encodeFunctionData('swapV2', [ctx.pair, inU ? ctx.U : ctx.W, amt, false]) };
  }
  if (r < 0.80) { // donation straight to the pair (no Sync until the next action)
    const inU = rng.next() < 0.5;
    const amt = inU ? rng.logBig(1n, 20_000n) * C.Q(6) : (rng.logBig(1n, 20_000n) * C.Q(18)) / 2500n;
    return { kind: 'donate', to: T, data: ti.encodeFunctionData('donate', [inU ? ctx.U : ctx.W, ctx.pair, amt]) };
  }
  if (r < 0.88) { // add liquidity (roughly at the pool ratio)
    const usd = rng.logBig(100n, 300_000n);
    const amtU = usd * C.Q(6), amtW = (usd * C.Q(18)) / 2500n;
    const [a0, a1] = BigInt(ctx.U) < BigInt(ctx.W) ? [amtU, amtW] : [amtW, amtU];
    return { kind: 'mint', to: T, data: ti.encodeFunctionData('mintV2', [ctx.pair, a0, a1]) };
  }
  if (r < 0.94) { // remove 1%..30% of our LP coins
    return { kind: 'burn', to: T, data: ti.encodeFunctionData('burnV2', [ctx.pair, BigInt(rng.int(1, 30)) * 10n ** 16n]) };
  }
  if (r < 0.97) return { kind: 'sync', to: ctx.pair, data: pairIface.encodeFunctionData('sync', []) };
  return { kind: 'skim', to: ctx.pair, data: pairIface.encodeFunctionData('skim', [ctx.me]) };
}

// Apply one block's events to the copy.
async function applyLogs(copy, logs, blk, ctx, io) {
  for (const log of logs) {
    if (await C.applyTokenLog(copy, log, ctx, io)) continue;
    if (lc(log.address) !== ctx.pair) continue;
    const t0 = log.topics[0];
    if (t0 === SYNC) {
      io.countEvent('Pair.Sync');
      const [r0, r1] = ethers.AbiCoder.defaultAbiCoder().decode(['uint112', 'uint112'], log.data);
      const old = await copy.getSlot(ctx.pair, 8n);
      const o0 = old & ((1n << 112n) - 1n), o1 = (old >> 112n) & ((1n << 112n) - 1n), oTs = old >> 224n;
      const ts = BigInt(blk.timestamp) % (1n << 32n);
      const elapsed = BigInt.asUintN(32, ts - oTs);
      // Same math as the pair: price cumulatives grow by (old price) x seconds.
      if (elapsed > 0n && o0 !== 0n && o1 !== 0n) {
        const p0 = await copy.getSlot(ctx.pair, 9n), p1 = await copy.getSlot(ctx.pair, 10n);
        await copy.setSlot(ctx.pair, 9n, BigInt.asUintN(256, p0 + ((o1 << 112n) / o0) * elapsed));
        await copy.setSlot(ctx.pair, 10n, BigInt.asUintN(256, p1 + ((o0 << 112n) / o1) * elapsed));
      }
      await copy.setSlot(ctx.pair, 8n, r0 | (r1 << 112n) | (ts << 224n));
    } else if (t0 === C.TRANSFER) { // LP coin
      io.countEvent('Pair.Transfer(LP)');
      const from = '0x' + log.topics[1].slice(26), to = '0x' + log.topics[2].slice(26);
      const v = BigInt(log.data);
      if (BigInt(from) === 0n) await C.addTo(copy, ctx.pair, 0n, v); else await C.addTo(copy, ctx.pair, L.mapSlot('address', from, 1), -v);
      if (BigInt(to) === 0n) await C.addTo(copy, ctx.pair, 0n, -v); else await C.addTo(copy, ctx.pair, L.mapSlot('address', to, 1), v);
    } else if (t0 === C.APPROVAL) {
      io.countEvent('Pair.Approval(LP)');
      const o = '0x' + log.topics[1].slice(26), s = '0x' + log.topics[2].slice(26);
      const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'bytes32'], [s, L.mapSlot('address', o, 2)]));
      await copy.setSlot(ctx.pair, slot, BigInt(log.data));
    } else {
      io.countEvent('Pair.' + (pairIface.parseLog(log)?.name ?? 'unknown'));
    }
  }
}

// For the negative control: one swap the copy is NOT told about.
function swapOp(ctx) {
  return { to: ctx.trader, data: traderIface().encodeFunctionData('swapV2', [ctx.pair, ctx.U, 20_000n * C.Q(6), false]) };
}

module.exports = { setup, copiedAccounts, initCopy, policyUnknown, slotName, label, checkSpecs, randomOp, applyLogs, swapOp };
