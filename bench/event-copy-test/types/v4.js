// ============================================================================
// POOL TYPE 5: Uniswap V4 PoolManager, hook-free pools
//   real PoolManager bytecode from npm @uniswap/v4-core 1.0.2.
//
// ONE contract (the PoolManager) holds every V4 pool. Its storage:
//   0 owner   1 protocolFeeController   2 protocolFeesAccrued[currency]
//   3-5 ERC6909 claim balances / operators / allowances
//   6 _pools[poolId] -> per pool, at base = keccak(poolId, 6):
//       base+0 slot0 = sqrtPriceX96 | tick | protocolFee | lpFee
//       base+1 feeGrowthGlobal0   base+2 feeGrowthGlobal1   base+3 liquidity
//       base+4 ticks[tick]  (3 slots: gross|net, feeOutside0, feeOutside1)
//       base+5 tickBitmap[word]   base+6 positions[key] (3 slots)
//   (Per-transaction bookkeeping - "who owes what" - is in TRANSIENT storage,
//    which starts empty for every transaction, so a copy never needs it.)
//
// We run TWO pools in the same PoolManager (test pool 0.30%/60 and a second
// 0.05%/10 pool that is also traded) so the copy must also keep pools apart.
//
// Copy variants:
//  "fields": Swap(id, sender, amount0, amount1, sqrtPriceX96, liquidity, tick, fee)
//     -> that pool's slot0 price+tick and liquidity. NOT derivable: the fee
//        counters (feeGrowthGlobal, ticks' feeOutside) and, if a protocol fee
//        were on, protocolFeesAccrued (the event has no protocol-fee amount;
//        it's off here). Donate -> only fee counters change: nothing to do.
//     ModifyLiquidity -> counted node re-read of the slots it can change.
//  "replay": re-do Swap / ModifyLiquidity / Donate through the PoolManager's
//     own code on the copy (pretend call) and keep the PoolManager's changes.
// ============================================================================
const L = require('../lib');
const C = require('./common');
const { ethers, abi, hex32, lc } = L;

const pmA = require('@uniswap/v4-core/out/PoolManager.sol/PoolManager.json');
const pmIface = new ethers.Interface(pmA.abi);
const v4tIface = () => new ethers.Interface(L.helpers().V4Trader.abi);
const M = (b) => (1n << BigInt(b)) - 1n;

const poolId = (k) => ethers.keccak256(abi.encode(['address', 'address', 'uint24', 'int24', 'address'], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
const baseOf = (id) => BigInt(ethers.keccak256(abi.encode(['bytes32', 'uint256'], [id, 6])));
const tickSlot = (p, t) => BigInt(ethers.keccak256(abi.encode(['int24', 'uint256'], [t, p.base + 4n])));
const wordSlot = (p, t) => BigInt(ethers.keccak256(abi.encode(['int16', 'uint256'], [Math.floor(t / p.key.tickSpacing) >> 8, p.base + 5n])));
const posSlot = (p, owner, lo, hi, salt) => {
  const k = ethers.keccak256(ethers.solidityPacked(['address', 'int24', 'int24', 'bytes32'], [owner, lo, hi, salt]));
  return BigInt(ethers.keccak256(abi.encode(['bytes32', 'uint256'], [k, p.base + 6n])));
};
const unpackS0 = (v) => ({ sqrt: v & M(160), tick: C.asInt((v >> 160n) & M(24), 24), rest: v >> 184n });
const packS0 = (s) => s.sqrt | (BigInt.asUintN(24, BigInt(s.tick)) << 160n) | (s.rest << 184n);

async function setup(chain, rng) {
  const base = await C.setupBase(chain, rng);
  const pm = await L.deploy(chain, pmA.abi, pmA.bytecode.object, chain.me);
  const pmAddr = lc(await pm.getAddress());
  const H = L.helpers();
  const t = await L.deploy(chain, H.V4Trader.abi, H.V4Trader.evm.bytecode.object, pmAddr);
  const tAddr = lc(await t.getAddress());
  for (const tok of [base.U, base.W]) {
    const c = new ethers.Contract(tok, H.Token.abi, await chain.provider.getSigner(0));
    await (await c.mint(tAddr, C.Q(36))).wait();
  }
  const [c0, c1] = BigInt(base.U) < BigInt(base.W) ? [base.U, base.W] : [base.W, base.U];
  const ctx = { ...base, pm: pmAddr, v4trader: tAddr, pools: {}, positions: [] };
  ctx.namer = C.makeNamer(base, { pm: pmAddr, v4trader: tAddr });
  ctx.namer.label.set(pmAddr, 'PoolManager');
  for (const [k, n] of [[0, 'owner'], [1, 'protocolFeeController']]) ctx.namer.add(pmAddr, k, n);
  for (const [name, fee, spacing, price] of [['test', 3000, 60, 2500], ['other', 500, 10, 2500]]) {
    const key = { currency0: c0, currency1: c1, fee, tickSpacing: spacing, hooks: ethers.ZeroAddress };
    const id = poolId(key);
    const p = { name, key, id, base: baseOf(id), ticks: new Set() };
    ctx.pools[id] = p;
    for (const [j, n] of ['slot0', 'feeGrowthGlobal0', 'feeGrowthGlobal1', 'liquidity'].entries()) ctx.namer.add(pmAddr, p.base + BigInt(j), `${name}.${n}`);
    await (await pm.initialize(key, C.sqrtPriceFor(price, base.U, base.W))).wait();
    const tick = unpackS0(await chain.getSlot(pmAddr, p.base)).tick;
    const b = Math.floor(tick / spacing) * spacing;
    for (let k = 1; k <= 14; k++) {
      const lo = b - spacing * k * 6, hi = b + spacing * k * 5;
      await (await t.modify(key, lo, hi, C.Q(16) * BigInt(rng.int(1, 4)), hex32(0))).wait();
      registerPosition(ctx, p, tAddr, lo, hi, hex32(0));
    }
    p.tickNow = tick;
  }
  ctx.test = Object.values(ctx.pools).find((p) => p.name === 'test');
  return ctx;
}

function registerPosition(ctx, p, owner, lo, hi, salt) {
  for (const t of [lo, hi]) {
    if (p.ticks.has(t)) continue;
    p.ticks.add(t);
    for (const [j, n] of ['gross|net', 'feeOutside0', 'feeOutside1'].entries()) ctx.namer.add(ctx.pm, tickSlot(p, t) + BigInt(j), `${p.name}.tick.${n}`);
    ctx.namer.add(ctx.pm, wordSlot(p, t), `${p.name}.tickBitmap`);
  }
  const ps = posSlot(p, owner, lo, hi, salt);
  for (const [j, n] of ['liquidity', 'feeInside0Last', 'feeInside1Last'].entries()) ctx.namer.add(ctx.pm, ps + BigInt(j), `${p.name}.position.${n}`);
  if (!ctx.positions.find((x) => x.p === p && x.lo === lo && x.hi === hi)) ctx.positions.push({ p, owner: lc(owner), lo, hi, salt });
}

const copiedAccounts = (ctx) => [ctx.pm, ctx.U, ctx.W, ...ctx.refs.map((r) => r.addr)];
async function initCopy() {}

function policyUnknown(ctx) {
  const m = new Map();
  if (ctx.variant !== 'fields') return m;
  const s = new Set();
  for (const p of Object.values(ctx.pools)) {
    s.add(hex32(p.base + 1n)); s.add(hex32(p.base + 2n));
    for (const t of p.ticks) for (const j of [1n, 2n]) s.add(hex32(tickSlot(p, t) + j));
  }
  m.set(ctx.pm, s);
  return m;
}
const slotName = (ctx, a, k) => ctx.namer.name(a, k);
const label = (ctx, a) => ctx.namer.label.get(a) ?? a;

function checkSpecs(ctx) {
  const k = ctx.test.key;
  return C.checkSpecs(ctx, (tin, tout) => L.hop(3, ctx.pm, tin, tout, { v4Fee: k.fee, v4TickSpacing: k.tickSpacing }))
    // the simulated contract needs V4 switched on: PoolManager (slot 6) + WETH (slot 7)
    .map((s) => ({ ...s, execSlots: { 6: ctx.pm, 7: ctx.W } }));
}

async function randomOp(rng, ctx) {
  const ti = v4tIface();
  const T = ctx.v4trader;
  const p = rng.next() < 0.75 ? ctx.test : ctx.pools[Object.keys(ctx.pools).find((id) => ctx.pools[id] !== ctx.test)];
  const zeroIsU = BigInt(ctx.U) < BigInt(ctx.W);
  const r = rng.next();
  if (r < 0.66) {
    const usd = rng.logBig(1n, 3_000_000n);
    const inU = rng.next() < 0.5;
    const zeroForOne = inU === zeroIsU;
    const amtIn = inU ? usd * C.Q(6) : (usd * C.Q(18)) / 2500n;
    const mode = rng.next();
    if (mode < 0.15) { // exact output (positive amount in V4)
      const out = inU ? (usd * C.Q(18)) / 2600n : (usd * C.Q(6) * 9n) / 10n;
      return { kind: 'swapExactOut', to: T, data: ti.encodeFunctionData('swap', [p.key, zeroForOne, out, 0]) };
    }
    if (mode < 0.25 && p.lastSqrt) {
      const f = BigInt(rng.int(1, 30));
      let lim = zeroForOne ? p.lastSqrt - (p.lastSqrt * f) / 1000n : p.lastSqrt + (p.lastSqrt * f) / 1000n;
      if (lim <= 4295128740n) lim = 4295128740n;
      return { kind: 'swapLimit', to: T, data: ti.encodeFunctionData('swap', [p.key, zeroForOne, -amtIn, lim]) };
    }
    return { kind: 'swap', to: T, data: ti.encodeFunctionData('swap', [p.key, zeroForOne, -amtIn, 0]) };
  }
  if (r < 0.72) { // V4 donate (fees to in-range positions)
    return { kind: 'v4donate', to: T, data: ti.encodeFunctionData('donate', [p.key, rng.logBig(1n, 10n ** 12n), rng.logBig(1n, 10n ** 12n)]) };
  }
  if (r < 0.78) { // coins sent straight to the PoolManager
    const inU = rng.next() < 0.5;
    return { kind: 'coinDonate', to: T, data: ti.encodeFunctionData('coinDonate', [inU ? ctx.U : ctx.W, ctx.pm, rng.logBig(1n, 10n ** 15n)]) };
  }
  if (r < 0.88) { // add liquidity (salt 0 or 1: two positions on the same range)
    const sp = p.key.tickSpacing;
    const b = Math.floor((p.tickNow ?? 0) / sp) * sp;
    const lo = b - sp * rng.int(-20, 120), hi = lo + sp * rng.int(1, 150);
    const salt = hex32(rng.int(0, 1));
    const liq = C.Q(14) * BigInt(rng.int(1, 300));
    return { kind: 'addLiq', to: T, data: ti.encodeFunctionData('modify', [p.key, lo, hi, liq, salt]), onSuccess: () => registerPosition(ctx, p, T, lo, hi, salt) };
  }
  const mine = ctx.positions.filter((x) => (ctx.posLiq?.get(x) ?? 0n) > 0n);
  if (mine.length) {
    const x = rng.pick(mine);
    const liq = ctx.posLiq.get(x);
    const amt = rng.next() < 0.3 ? liq : (liq * BigInt(rng.int(1, 60))) / 100n;
    return { kind: 'removeLiq', to: T, data: ti.encodeFunctionData('modify', [x.p.key, x.lo, x.hi, -amt, x.salt]) };
  }
  return { kind: 'swap', to: T, data: ti.encodeFunctionData('swap', [p.key, true, -1000n, 0]) };
}

// Pretend call on the copy; keep only the PoolManager's storage changes.
async function replayCall(copy, ctx, blk, to, data) {
  const ov = {};
  for (const t of [ctx.U, ctx.W]) ov[t] = { stateDiff: { [C.tokBal(ctx.v4trader)]: hex32(10n ** 40n) } };
  const bo = { time: '0x' + blk.timestamp.toString(16), number: '0x' + blk.number.toString(16) };
  const tx = { from: ctx.me, to, data, gas: '0x1c9c380' };
  const ct = await copy.rpc('debug_traceCall', [tx, 'latest', { tracer: 'callTracer', stateOverrides: ov, blockOverrides: bo }]);
  if (ct.error) return { ok: false, error: ct.error + ' ' + (ct.revertReason ?? '') };
  const d = await copy.rpc('debug_traceCall', [tx, 'latest', { tracer: 'prestateTracer', tracerConfig: { diffMode: true }, stateOverrides: ov, blockOverrides: bo }]);
  const A = Object.keys(d.post).find((x) => lc(x) === ctx.pm), Ap = Object.keys(d.pre).find((x) => lc(x) === ctx.pm);
  const post = (A && d.post[A].storage) || {}, pre = (Ap && d.pre[Ap].storage) || {};
  const writes = [];
  for (const [k, v] of Object.entries(post)) writes.push([k, BigInt(v)]);
  for (const k of Object.keys(pre)) if (!(k in post)) writes.push([k, 0n]);
  return { ok: true, output: ct.output, writes };
}

async function applyLogs(copy, logs, blk, ctx, io) {
  const ti = v4tIface();
  const byTx = new Map();
  for (const lg of logs) { if (!byTx.has(lg.transactionHash)) byTx.set(lg.transactionHash, []); byTx.get(lg.transactionHash).push(lg); }
  for (const txLogs of byTx.values()) {
    for (const log of txLogs) {
      if (lc(log.address) !== ctx.pm) continue;
      let ev; try { ev = pmIface.parseLog(log); } catch { ev = null; }
      io.countEvent('PM.' + (ev?.name ?? 'unknown'));
      if (!ev) continue;
      const a = ev.args;
      const p = ctx.pools[a.id];
      if (!p) { io.replay('UNKNOWN_POOL'); continue; }
      if (ctx.variant === 'fields') {
        if (ev.name === 'Swap') {
          const s0 = unpackS0(await copy.getSlot(ctx.pm, p.base));
          s0.sqrt = a.sqrtPriceX96; s0.tick = Number(a.tick);
          await copy.setSlot(ctx.pm, p.base, packS0(s0));
          await copy.setSlot(ctx.pm, p.base + 3n, a.liquidity);
        } else if (ev.name === 'ModifyLiquidity') {
          const lo = Number(a.tickLower), hi = Number(a.tickUpper);
          if (a.liquidityDelta > 0n) registerPosition(ctx, p, a.sender, lo, hi, a.salt);
          ctx.pending ??= { slots: new Set(), reasons: [] };
          const s = [p.base, p.base + 1n, p.base + 2n, p.base + 3n, wordSlot(p, lo), wordSlot(p, hi)];
          for (const t of [lo, hi]) for (const j of [0n, 1n, 2n]) s.push(tickSlot(p, t) + j);
          for (const j of [0n, 1n, 2n]) s.push(posSlot(p, a.sender, lo, hi, a.salt) + j);
          for (const x of s) ctx.pending.slots.add(x);
          ctx.pending.reasons.push('ModifyLiquidity');
        } // Donate: only fee counters (already unknown in this variant)
        continue;
      }
      // replay: the event's sender is our V4Trader (same code on the copy)
      if (ev.name === 'Swap') {
        // Direction: coin0 paid in = zeroForOne. If no coins moved (0/0), the
        // price fell = zeroForOne.
        const before = unpackS0(await copy.getSlot(ctx.pm, p.base)).sqrt;
        const zeroForOne = a.amount0 !== 0n || a.amount1 !== 0n ? a.amount0 < 0n : a.sqrtPriceX96 < before;
        const paid = zeroForOne ? -a.amount0 : -a.amount1, got = zeroForOne ? a.amount1 : a.amount0;
        const HUGE = 1n << 120n;
        let done = false;
        for (const [mode, amount, limit] of [['exactIn', -paid, 0n], ['exactOut', got, 0n], ['exactIn+limit', -paid, a.sqrtPriceX96], ['exactOut+limit', got, a.sqrtPriceX96], ['toPrice', -HUGE, a.sqrtPriceX96],
          // A swap through a range with NO liquidity moves the price but swaps
          // 0 coins (event amounts 0/0): any tiny amount up to the event's price reproduces it.
          ['tinyIn', -1n, a.sqrtPriceX96], ['tinyOut', 1n, a.sqrtPriceX96]]) {
          const r = await replayCall(copy, ctx, blk, a.sender, ti.encodeFunctionData('swap', [p.key, zeroForOne, amount, limit]));
          if (!r.ok) { if (process.env.DEBUG) console.log('\nv4 replay', mode, 'reverted', r.error, 'event', a.amount0, a.amount1, a.sqrtPriceX96); continue; }
          const delta = BigInt(abi.decode(['int256'], r.output)[0]);
          const d0 = BigInt.asIntN(128, delta >> 128n), d1 = BigInt.asIntN(128, delta);
          if (d0 !== a.amount0 || d1 !== a.amount1) { if (process.env.DEBUG) console.log('\nv4 replay', mode, 'amounts', d0, d1, 'vs', a.amount0, a.amount1); continue; }
          const w = r.writes.find(([k]) => BigInt(k) === p.base);
          const s0 = unpackS0(w ? w[1] : await copy.getSlot(ctx.pm, p.base));
          const wl = r.writes.find(([k]) => BigInt(k) === p.base + 3n);
          const liq = (wl ? wl[1] : await copy.getSlot(ctx.pm, p.base + 3n)) & M(128);
          if (s0.sqrt !== a.sqrtPriceX96 || s0.tick !== Number(a.tick) || liq !== a.liquidity) { if (process.env.DEBUG) console.log('\nv4 replay', mode, 'end state', s0.sqrt, s0.tick, liq, 'vs', a.sqrtPriceX96, a.tick, a.liquidity); continue; }
          io.replay('Swap:' + mode);
          for (const [k, v] of r.writes) await copy.setSlot(ctx.pm, k, v);
          done = true;
          break;
        }
        if (!done) {
          io.replay('Swap:FAILED');
          const crossed = [...p.ticks].flatMap((t) => [0n, 1n, 2n].map((j) => tickSlot(p, t) + j));
          await io.reRead(ctx.pm, [p.base, p.base + 1n, p.base + 2n, p.base + 3n, ...crossed], 'Swap:replayFailed');
        }
      } else if (ev.name === 'ModifyLiquidity' || ev.name === 'Donate') {
        let r;
        if (ev.name === 'ModifyLiquidity') {
          if (a.liquidityDelta > 0n) registerPosition(ctx, p, a.sender, Number(a.tickLower), Number(a.tickUpper), a.salt);
          r = await replayCall(copy, ctx, blk, a.sender, ti.encodeFunctionData('modify', [p.key, a.tickLower, a.tickUpper, a.liquidityDelta, a.salt]));
        } else {
          r = await replayCall(copy, ctx, blk, a.sender, ti.encodeFunctionData('donate', [p.key, a.amount0, a.amount1]));
        }
        if (r.ok) { io.replay(ev.name); for (const [k, v] of r.writes) await copy.setSlot(ctx.pm, k, v); }
        else { io.replay(ev.name + ':FAILED'); }
      }
    }
    for (const log of txLogs) if (lc(log.address) !== ctx.pm) await C.applyTokenLog(copy, log, ctx, io);
  }
  if (ctx.pending) {
    await io.reRead(ctx.pm, [...ctx.pending.slots], ctx.pending.reasons.join('+'));
    ctx.pending = null;
  }
  for (const p of Object.values(ctx.pools)) {
    const s0 = unpackS0(await copy.getSlot(ctx.pm, p.base));
    p.tickNow = s0.tick; p.lastSqrt = s0.sqrt;
  }
  ctx.posLiq = new Map();
  for (const x of ctx.positions) ctx.posLiq.set(x, (await copy.getSlot(ctx.pm, posSlot(x.p, x.owner, x.lo, x.hi, x.salt))) & M(128));
}

function swapOp(ctx) {
  const zeroIsU = BigInt(ctx.U) < BigInt(ctx.W);
  return { to: ctx.v4trader, data: v4tIface().encodeFunctionData('swap', [ctx.test.key, zeroIsU, -(200_000n * C.Q(6)), 0]) };
}

module.exports = { setup, copiedAccounts, initCopy, policyUnknown, slotName, label, checkSpecs, randomOp, applyLogs, swapOp };
