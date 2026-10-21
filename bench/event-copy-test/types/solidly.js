// ============================================================================
// POOL TYPE 6: Solidly-style V2 pair (Velodrome V2 Pool, the design Ramses
// and Aerodrome copy). REAL source from github velodrome-finance/contracts,
// compiled by velo-build/build.js with their own settings. Volatile pool
// (x*y), fee 0.30% read from the factory on every swap. The pool is a
// "clone" (tiny proxy) of one implementation contract, like on mainnet.
//
// Pool storage (slot: what), from the compiler's storage layout:
//   0 LP balances  1 LP allowances  2 LP totalSupply  3/4 name/symbol (ERC20)
//   5/6 EIP712 fallbacks  7 permit nonces  8/9 _name/_symbol
//   10 stable|token0  11 token1  12 poolFees  13 factory
//   14 observations[] (length; entries at keccak(14)+3i: time, r0Cum, r1Cum)
//   15/16 decimals0/1  17 reserve0  18 reserve1  19 blockTimestampLast
//   20/21 reserve0/1CumulativeLast  22/23 index0/1 (fee per LP coin)
//   24/25 supplyIndex0/1[holder]  26/27 claimable0/1[holder]
//   (re-entry lock is in TRANSIENT storage: nothing to copy)
// Factory storage the swap READS: 0 isPaused, 2 volatileFee, 8 customFee[pool].
//
// How the copy follows it from EVENTS only (all exact, no node reads):
//   Fees(amount0, amount1) -> index0/1 += amount*1e18/totalSupply
//   LP Transfer            -> first the pool's own "_updateFor(from), _updateFor(to)"
//                             bookkeeping (supplyIndex / claimable of both
//                             holders), then balances / totalSupply
//   Sync(r0, r1)           -> cumulatives += old reserve x seconds, maybe a new
//                             observation (every >30 min), reserves, time
//   Claim                  -> _updateFor(sender) then its claimable = 0
//   Approval (LP)          -> allowance
//   Factory changes (fee / pause) would come with the factory's own events
//   (SetCustomFee, SetPauseState); none happen in this workload.
// ============================================================================
const L = require('../lib');
const C = require('./common');
const { ethers, abi, hex32, lc } = L;

const V = require('../velo-build/velo.json');
const poolIface = new ethers.Interface(V.Pool.abi);
const traderIface = () => new ethers.Interface(L.helpers().Trader.abi);
const E18 = 10n ** 18n;
const map = (key, slot) => BigInt(L.mapSlot('address', key, slot));
const obsBase = BigInt(ethers.keccak256(abi.encode(['uint256'], [14])));

async function setup(chain, rng) {
  const base = await C.setupBase(chain, rng);
  const impl = await L.deploy(chain, V.Pool.abi, V.Pool.bytecode);
  const F = await L.deploy(chain, V.PoolFactory.abi, V.PoolFactory.bytecode, await impl.getAddress());
  await (await F['createPool(address,address,bool)'](base.U, base.W, false)).wait();
  const pair = lc(await F['getPool(address,address,bool)'](base.U, base.W, false));
  const amtU = 1_000_000n * C.Q(6), amtW = 400n * C.Q(18);
  await (await base.traderC.mintV2(pair, ...(BigInt(base.U) < BigInt(base.W) ? [amtU, amtW] : [amtW, amtU]))).wait();
  const ctx = { ...base, pair, factory: lc(await F.getAddress()), impl: lc(await impl.getAddress()), holders: new Set() };
  ctx.namer = C.makeNamer(base, { pair, poolFees: lc(await new ethers.Contract(pair, V.Pool.abi, chain.provider).poolFees()) });
  ctx.namer.label.set(pair, 'solidlyPair');
  ctx.namer.label.set(ctx.factory, 'factory');
  for (const [k, n] of [[2, 'LP.totalSupply'], [14, 'observations.length'], [17, 'reserve0'], [18, 'reserve1'], [19, 'blockTimestampLast'],
    [20, 'reserve0CumulativeLast'], [21, 'reserve1CumulativeLast'], [22, 'index0'], [23, 'index1']]) ctx.namer.add(pair, k, n);
  return ctx;
}

const copiedAccounts = (ctx) => [ctx.pair, ctx.factory, ctx.impl, ctx.U, ctx.W, ...ctx.refs.map((r) => r.addr)];
async function initCopy() {}
const policyUnknown = () => new Map();
function slotName(ctx, a, k) {
  return ctx.namer.name(a, k, (addr, slot) => {
    if (addr !== ctx.pair) return 'other';
    const v = BigInt(slot);
    if (v >= obsBase && v < obsBase + 3000n) return 'observations[]';
    for (const h of ctx.holders) {
      for (const [s, n] of [[0, 'LP.balance'], [24, 'supplyIndex0'], [25, 'supplyIndex1'], [26, 'claimable0'], [27, 'claimable1']]) if (map(h, s) === v) return n;
    }
    return 'other';
  });
}
const label = (ctx, a) => ctx.namer.label.get(a) ?? a;
const checkSpecs = (ctx) => C.checkSpecs(ctx, (tin, tout) => L.hop(1, ctx.pair, tin, tout));

async function randomOp(rng, ctx) {
  const ti = traderIface();
  const r = rng.next();
  const T = ctx.trader;
  if (r < 0.70) {
    const usd = rng.logBig(1n, 400_000n);
    const inU = rng.next() < 0.5;
    const amt = inU ? usd * C.Q(6) : (usd * C.Q(18)) / 2500n;
    return { kind: 'swap', to: T, data: ti.encodeFunctionData('swapV2', [ctx.pair, inU ? ctx.U : ctx.W, amt, true]) };
  }
  if (r < 0.80) {
    const inU = rng.next() < 0.5;
    const amt = inU ? rng.logBig(1n, 20_000n) * C.Q(6) : (rng.logBig(1n, 20_000n) * C.Q(18)) / 2500n;
    return { kind: 'donate', to: T, data: ti.encodeFunctionData('donate', [inU ? ctx.U : ctx.W, ctx.pair, amt]) };
  }
  if (r < 0.88) {
    const usd = rng.logBig(100n, 300_000n);
    const amtU = usd * C.Q(6), amtW = (usd * C.Q(18)) / 2500n;
    const [a0, a1] = BigInt(ctx.U) < BigInt(ctx.W) ? [amtU, amtW] : [amtW, amtU];
    return { kind: 'mint', to: T, data: ti.encodeFunctionData('mintV2', [ctx.pair, a0, a1]) };
  }
  if (r < 0.92) return { kind: 'burn', to: T, data: ti.encodeFunctionData('burnV2', [ctx.pair, BigInt(rng.int(1, 30)) * 10n ** 16n]) };
  // LP holder collects its earned swap fees (Claim event)
  if (r < 0.95) return { kind: 'claimFees', to: T, data: ti.encodeFunctionData('call', [ctx.pair, poolIface.encodeFunctionData('claimFees', [])]) };
  if (r < 0.97) return { kind: 'sync', to: ctx.pair, data: poolIface.encodeFunctionData('sync', []) };
  return { kind: 'skim', to: ctx.pair, data: poolIface.encodeFunctionData('skim', [ctx.me]) };
}

// The pool's own _updateFor(holder): settle fees earned since last time.
async function updateFor(copy, ctx, h) {
  ctx.holders.add(lc(h));
  const P = ctx.pair;
  const bal = await copy.getSlot(P, map(h, 0));
  const i0 = await copy.getSlot(P, 22n), i1 = await copy.getSlot(P, 23n);
  if (bal > 0n) {
    const s0 = await copy.getSlot(P, map(h, 24)), s1 = await copy.getSlot(P, map(h, 25));
    await copy.setSlot(P, map(h, 24), i0);
    await copy.setSlot(P, map(h, 25), i1);
    if (i0 - s0 > 0n) await C.addTo(copy, P, map(h, 26), (bal * (i0 - s0)) / E18);
    if (i1 - s1 > 0n) await C.addTo(copy, P, map(h, 27), (bal * (i1 - s1)) / E18);
  } else {
    await copy.setSlot(P, map(h, 24), i0);
    await copy.setSlot(P, map(h, 25), i1);
  }
}

async function applyLogs(copy, logs, blk, ctx, io) {
  const P = ctx.pair;
  for (const log of logs) {
    if (await C.applyTokenLog(copy, log, ctx, io)) continue;
    if (lc(log.address) !== P) { io.countEvent('Other.' + log.address); continue; }
    let ev; try { ev = poolIface.parseLog(log); } catch { ev = null; }
    const name = ev?.name ?? 'unknown';
    io.countEvent('Pair.' + name);
    const a = ev?.args;
    if (name === 'Transfer') {
      await updateFor(copy, ctx, a.from);
      await updateFor(copy, ctx, a.to);
      if (BigInt(a.from) === 0n) await C.addTo(copy, P, 2n, a.value); else await C.addTo(copy, P, map(a.from, 0), -a.value);
      if (BigInt(a.to) === 0n) await C.addTo(copy, P, 2n, -a.value); else await C.addTo(copy, P, map(a.to, 0), a.value);
    } else if (name === 'Approval') {
      const slot = ethers.keccak256(abi.encode(['address', 'bytes32'], [a.spender, L.mapSlot('address', a.owner, 1)]));
      await copy.setSlot(P, slot, a.value);
    } else if (name === 'Fees') {
      const ts = await copy.getSlot(P, 2n);
      if (a.amount0 > 0n) await C.addTo(copy, P, 22n, (a.amount0 * E18) / ts);
      if (a.amount1 > 0n) await C.addTo(copy, P, 23n, (a.amount1 * E18) / ts);
    } else if (name === 'Sync') {
      const now = BigInt(blk.timestamp);
      const r0 = await copy.getSlot(P, 17n), r1 = await copy.getSlot(P, 18n), last = await copy.getSlot(P, 19n);
      const el = now - last;
      if (el > 0n && r0 !== 0n && r1 !== 0n) {
        await C.addTo(copy, P, 20n, r0 * el);
        await C.addTo(copy, P, 21n, r1 * el);
      }
      const len = await copy.getSlot(P, 14n);
      const lastObsTs = await copy.getSlot(P, obsBase + 3n * (len - 1n));
      if (now - lastObsTs > 1800n) {
        const o = obsBase + 3n * len;
        await copy.setSlot(P, o, now);
        await copy.setSlot(P, o + 1n, await copy.getSlot(P, 20n));
        await copy.setSlot(P, o + 2n, await copy.getSlot(P, 21n));
        await copy.setSlot(P, 14n, len + 1n);
      }
      await copy.setSlot(P, 17n, a.reserve0);
      await copy.setSlot(P, 18n, a.reserve1);
      await copy.setSlot(P, 19n, now);
    } else if (name === 'Claim') {
      await updateFor(copy, ctx, a.sender);
      await copy.setSlot(P, map(a.sender, 26), 0n);
      await copy.setSlot(P, map(a.sender, 27), 0n);
    } // Mint / Burn / Swap: everything they change comes with Transfer / Fees / Sync.
  }
}

function swapOp(ctx) {
  return { to: ctx.trader, data: traderIface().encodeFunctionData('swapV2', [ctx.pair, ctx.U, 20_000n * C.Q(6), true]) };
}

module.exports = { setup, copiedAccounts, initCopy, policyUnknown, slotName, label, checkSpecs, randomOp, applyLogs, swapOp };
