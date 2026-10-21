// ============================================================================
// POOL TYPES 2 + 3: Uniswap V3 and PancakeSwap V3 (same design, same layout)
//
// Pool storage, Uniswap V3 (slot: what) - confirmed on anvil:
//   0 slot0 = sqrtPriceX96 | tick | observationIndex | observationCardinality
//             | observationCardinalityNext | feeProtocol (8 bits) | unlocked
//   1 feeGrowthGlobal0X128   2 feeGrowthGlobal1X128
//   3 protocolFees (token0 | token1)        4 liquidity (active)
//   5 ticks[tick]       (4 slots each: gross|net, feeOutside0, feeOutside1,
//                        tickCumOutside|secPerLiqOutside|secondsOutside|initialized)
//   6 tickBitmap[word]  7 positions[key] (4 slots each)
//   8 .. 8+65534 observations (price history, one slot each)
// PancakeSwap V3: feeProtocol is 32 bits, so slot0 no longer fits in one
//   slot: feeProtocol + unlocked move to slot 1 and EVERYTHING after moves
//   down by one (feeGrowth 2/3, protocolFees 4, liquidity 5, ticks 6,
//   bitmap 7, positions 8, observations from 9, lmPool at 65544).
//   Confirmed on anvil (first history entry found at slot 9).
//
// Two ways to keep the copy, chosen by the run's "variant":
//
//  "fields": write ONLY what the events say.
//     Swap  -> slot0 price + tick, liquidity; the price-history entry the
//              pool writes when the tick changes (computable: old tick, old
//              liquidity, block time); PancakeSwap: protocolFees (its Swap
//              event carries the protocol-fee amounts).
//              NOT derivable from a Swap event: feeGrowthGlobal0/1, the fee
//              counters stored in every tick the swap crossed (feeOutside0/1,
//              cumulative fields), Uniswap's protocolFees. They stay stale.
//     Mint / Burn / Collect / Flash / IncreaseObservationCardinalityNext ->
//              "node re-read" of the slots that action can change (computed
//              from the event: the two ticks, their bitmap words, the
//              position, slot0, liquidity, fee counters, history entries).
//
//  "replay": re-do each event's action with the pool's OWN code on the copy
//     (a pretend call; see Replayer in Helpers.sol), using only numbers from
//     the event (amounts, final price, ticks, owner) and the block's time.
//     We keep the pool's storage changes from that pretend call. The result
//     is checked against the event (same amounts, final price, tick and
//     liquidity); if it doesn't match, we fall back to a counted node re-read.
// ============================================================================
const L = require('../lib');
const C = require('./common');
const { ethers, abi, hex32, lc } = L;

const REPLAYER = '0x00000000000000000000000000000000fee0beef';
const BIG = 10n ** 40n;

function makeFamily(cfg) {
  // cfg: { name, poolArtifact, fee, spacing, eventIface, deployPool(chain, base) }
  const poolIface = new ethers.Interface(cfg.poolArtifact.abi);
  const traderIface = () => new ethers.Interface(L.helpers().Trader.abi);
  const replayerIface = () => new ethers.Interface(L.helpers().Replayer.abi);
  // Storage layout. PancakeSwap's slot0 is 264 bits, so it spills into a
  // second slot (feeProtocol + unlocked in slot 1) and everything after it
  // moves down by one (confirmed on anvil: first history entry at slot 9).
  const P = cfg.name === 'pancake'
    ? { fg0: 2n, fg1: 3n, pf: 4n, liq: 5n, ticks: 6, bitmap: 7, pos: 8, obs: 9n, lm: 65544n }
    : { fg0: 1n, fg1: 2n, pf: 3n, liq: 4n, ticks: 5, bitmap: 6, pos: 7, obs: 8n, lm: null };
  const OBS = P.obs;

  // ---- slot-0 helpers ----
  // Uniswap: feeProtocol (8 bits) + unlocked live in slot 0. Pancake: in slot 1
  // (never changed by events we handle), so only the first five fields here.
  const twoWord = cfg.name === 'pancake';
  const fpBits = 8n;
  function unpackSlot0(v) {
    const m = (b) => (1n << b) - 1n;
    let o = 0n;
    const take = (bits) => { const x = (v >> o) & m(bits); o += bits; return x; };
    const sqrt = take(160n), tick = C.asInt(take(24n), 24), idx = Number(take(16n)), card = Number(take(16n)),
      cardNext = Number(take(16n)), fp = twoWord ? 0n : take(fpBits), unlocked = twoWord ? 0n : take(8n);
    return { sqrt, tick, idx, card, cardNext, fp, unlocked };
  }
  function packSlot0(s) {
    let v = 0n, o = 0n;
    const put = (x, bits) => { v |= (BigInt.asUintN(Number(bits), BigInt(x))) << o; o += bits; };
    put(s.sqrt, 160n); put(s.tick, 24n); put(s.idx, 16n); put(s.card, 16n); put(s.cardNext, 16n); if (!twoWord) { put(s.fp, fpBits); put(s.unlocked, 8n); }
    return v;
  }
  const posKey = (owner, lo, hi) => ethers.keccak256(ethers.solidityPacked(['address', 'int24', 'int24'], [owner, lo, hi]));
  const posSlot = (owner, lo, hi) => BigInt(ethers.keccak256(abi.encode(['bytes32', 'uint256'], [posKey(owner, lo, hi), P.pos])));
  const tickSlot = (t) => BigInt(C.tickKey(t, P.ticks));
  const wordOf = (t) => (Math.floor(t / cfg.spacing)) >> 8;
  const bitmapSlot = (t) => BigInt(C.wordKey(wordOf(t), P.bitmap));

  async function setup(chain, rng, opts) {
    const base = await C.setupBase(chain, rng);
    const pool = lc(await cfg.deployPool(chain, base));
    const p = new ethers.Contract(pool, cfg.poolArtifact.abi, await chain.provider.getSigner(0));
    await (await p.initialize(C.sqrtPriceFor(2500, base.U, base.W))).wait();
    // Room for 25 price-history entries, so the history wraps around during the run.
    await (await p.increaseObservationCardinalityNext(25)).wait();
    if (cfg.afterInit) await cfg.afterInit(chain, p, base);
    const tick = Number((await p.slot0()).tick);
    const b = Math.floor(tick / cfg.spacing) * cfg.spacing;
    const ctx = { ...base, pool, positions: [], ticks: new Set() };
    ctx.namer = C.makeNamer(base, { pool, replayer: REPLAYER });
    ctx.namer.label.set(pool, cfg.name);
    for (const [k, n] of [[0n, 'slot0'], [P.fg0, 'feeGrowthGlobal0'], [P.fg1, 'feeGrowthGlobal1'], [P.pf, 'protocolFees'], [P.liq, 'liquidity']]) ctx.namer.add(pool, k, n);
    if (twoWord) ctx.namer.add(pool, 1n, 'slot0b(feeProtocol|unlocked)');
    // Many overlapping positions so swaps cross many ticks.
    for (let k = 1; k <= 14; k++) {
      const lo = b - cfg.spacing * k * 6, hi = b + cfg.spacing * k * 5;
      await (await base.traderC.mintV3(pool, lo, hi, C.Q(16) * BigInt(rng.int(1, 4)))).wait();
      registerPosition(ctx, base.trader, lo, hi);
    }
    ctx.tickNow = tick;
    return ctx;
  }

  function registerPosition(ctx, owner, lo, hi) {
    for (const t of [lo, hi]) {
      if (!ctx.ticks.has(t)) {
        ctx.ticks.add(t);
        for (const [j, n] of ['gross|net', 'feeOutside0', 'feeOutside1', 'cumulatives|initialized'].entries()) ctx.namer.add(ctx.pool, tickSlot(t) + BigInt(j), `tick.${n}`);
        ctx.namer.add(ctx.pool, bitmapSlot(t), 'tickBitmap');
      }
    }
    const ps = posSlot(owner, lo, hi);
    for (const [j, n] of ['liquidity', 'feeInside0Last', 'feeInside1Last', 'tokensOwed'].entries()) ctx.namer.add(ctx.pool, ps + BigInt(j), `position.${n}`);
    if (!ctx.positions.find((x) => x.owner === lc(owner) && x.lo === lo && x.hi === hi)) ctx.positions.push({ owner: lc(owner), lo, hi });
  }

  const copiedAccounts = (ctx) => [ctx.pool, ctx.U, ctx.W, ...ctx.refs.map((r) => r.addr)];

  async function initCopy(copy, ctx) {
    ctx.replayerCode = '0x' + L.helpers().Replayer.evm.deployedBytecode.object;
  }

  // Which slots the copy KNOWS it can't keep exact (strict mode treats them as unknown).
  function policyUnknown(ctx) {
    const m = new Map();
    if (ctx.variant !== 'fields') return m;
    const s = new Set([hex32(P.fg0), hex32(P.fg1)]);
    if (cfg.name !== 'pancake') s.add(hex32(P.pf));
    for (const t of ctx.ticks) for (const j of [1n, 2n, 3n]) s.add(hex32(tickSlot(t) + j));
    m.set(ctx.pool, s);
    return m;
  }

  function slotName(ctx, a, k) {
    return ctx.namer.name(a, k, (addr, slot) => {
      if (addr === ctx.pool) {
        const v = BigInt(slot);
        if (v >= OBS && v < OBS + 65535n) return 'observations';
        if (P.lm !== null && v === P.lm) return 'lmPool';
      }
      return 'other';
    });
  }
  const label = (ctx, a) => ctx.namer.label.get(a) ?? a;
  const checkSpecs = (ctx) => C.checkSpecs(ctx, (tin, tout) => L.hop(2, ctx.pool, tin, tout));

  // ---- random market activity ----
  async function randomOp(rng, ctx) {
    const ti = traderIface();
    const r = rng.next();
    const T = ctx.trader;
    const zeroIsU = BigInt(ctx.U) < BigInt(ctx.W);
    if (r < 0.66) { // swaps: exact input (mostly), exact output, or with a price limit
      const usd = rng.logBig(1n, 3_000_000n);
      const inU = rng.next() < 0.5;
      const zeroForOne = inU === zeroIsU;
      const amtIn = inU ? usd * C.Q(6) : (usd * C.Q(18)) / 2500n;
      const mode = rng.next();
      if (mode < 0.15) { // exact output: ask for a fixed amount of the other coin
        const out = inU ? (usd * C.Q(18)) / 2600n : (usd * C.Q(6) * 9n) / 10n;
        return { kind: 'swapExactOut', to: T, data: ti.encodeFunctionData('swapV3', [ctx.pool, zeroForOne, -out, 0]) };
      }
      if (mode < 0.25) { // price limit: stop part-way
        const cur = ctx.lastSqrt ?? 0n;
        if (cur > 0n) {
          const f = BigInt(rng.int(1, 30));
          let lim = zeroForOne ? cur - (cur * f) / 1000n : cur + (cur * f) / 1000n;
          // keep inside the allowed price range
          const MINP = 4295128740n, MAXP = 1461446703485210103287273052203988822378723970341n;
          if (lim <= MINP) lim = MINP; if (lim >= MAXP) lim = MAXP;
          return { kind: 'swapLimit', to: T, data: ti.encodeFunctionData('swapV3', [ctx.pool, zeroForOne, amtIn, lim]) };
        }
      }
      return { kind: 'swap', to: T, data: ti.encodeFunctionData('swapV3', [ctx.pool, zeroForOne, amtIn, 0]) };
    }
    if (r < 0.74) { // donation straight to the pool
      const inU = rng.next() < 0.5;
      const amt = inU ? rng.logBig(1n, 50_000n) * C.Q(6) : (rng.logBig(1n, 50_000n) * C.Q(18)) / 2500n;
      return { kind: 'donate', to: T, data: ti.encodeFunctionData('donate', [inU ? ctx.U : ctx.W, ctx.pool, amt]) };
    }
    if (r < 0.83) { // new position somewhere around the current price
      const t = ctx.tickNow ?? 0;
      const b = Math.floor(t / cfg.spacing) * cfg.spacing;
      const lo = b - cfg.spacing * rng.int(-20, 120), hi = lo + cfg.spacing * rng.int(1, 150);
      const liq = C.Q(14) * BigInt(rng.int(1, 300));
      return { kind: 'mint', to: T, data: ti.encodeFunctionData('mintV3', [ctx.pool, lo, hi, liq]),
        onSuccess: () => registerPosition(ctx, ctx.trader, lo, hi) };
    }
    if (r < 0.91 && ctx.positions.length) { // remove part (or all) of a position
      const p = rng.pick(ctx.positions);
      const liq = ctx.posLiq?.get(`${p.lo}:${p.hi}`) ?? 0n;
      if (liq > 0n) {
        const amt = rng.next() < 0.3 ? liq : (liq * BigInt(rng.int(1, 60))) / 100n;
        return { kind: 'burn', to: T, data: ti.encodeFunctionData('burnV3', [ctx.pool, p.lo, p.hi, amt, rng.next() < 0.5]) };
      }
    }
    if (r < 0.95 && ctx.positions.length) { // collect earned fees
      const p = rng.pick(ctx.positions);
      return { kind: 'collect', to: T, data: ti.encodeFunctionData('collectV3', [ctx.pool, p.lo, p.hi]) };
    }
    if (r < 0.98) { // flash loan
      const a0 = rng.logBig(1n, 10n ** 12n), a1 = rng.logBig(1n, 10n ** 12n);
      return { kind: 'flash', to: T, data: ti.encodeFunctionData('flashV3', [ctx.pool, a0, a1]) };
    }
    // grow the price-history buffer
    const next = (ctx.cardNext ?? 25) + rng.int(1, 5);
    ctx.cardNextPending = next;
    return { kind: 'growHistory', to: ctx.pool, data: poolIface.encodeFunctionData('increaseObservationCardinalityNext', [next]) };
  }

  // ---- REPLAY: run an action with the pool's own code on the copy ----
  async function replayCall(copy, blk, from, to, data, keep) {
    const ov = {
      [REPLAYER]: { code: copy._replayerCode },
      // the Replayer has plenty of both coins (only inside this pretend call)
    };
    for (const t of copy._tokens) ov[t] = { stateDiff: { [C.tokBal(REPLAYER)]: hex32(BIG) } };
    const bo = { time: '0x' + blk.timestamp.toString(16), number: '0x' + blk.number.toString(16) };
    const tx = { from, to, data, gas: '0x1c9c380' };
    const ct = await copy.rpc('debug_traceCall', [tx, 'latest', { tracer: 'callTracer', stateOverrides: ov, blockOverrides: bo }]);
    if (ct.error) return { ok: false, error: ct.error + ' ' + (ct.revertReason ?? '') };
    const d = await copy.rpc('debug_traceCall', [tx, 'latest', { tracer: 'prestateTracer', tracerConfig: { diffMode: true }, stateOverrides: ov, blockOverrides: bo }]);
    const writes = [];
    for (const a of keep) {
      const A = Object.keys(d.post).find((x) => lc(x) === a) ?? a;
      const Ap = Object.keys(d.pre).find((x) => lc(x) === a) ?? a;
      const post = d.post[A]?.storage ?? {}, pre = d.pre[Ap]?.storage ?? {};
      for (const [k, v] of Object.entries(post)) writes.push([a, k, BigInt(v)]);
      for (const k of Object.keys(pre)) if (!(k in post)) writes.push([a, k, 0n]); // changed to zero
    }
    return { ok: true, output: ct.output, writes };
  }
  async function applyWrites(copy, writes) {
    for (const [a, k, v] of writes) await copy.setSlot(a, k, v);
  }

  // Slots an action can change, computed from the event (for node re-reads).
  function reReadSlots(ev) {
    const s = [0n, P.fg0, P.fg1, P.pf, P.liq];
    if (ev.tickLower !== undefined) {
      for (const t of [ev.tickLower, ev.tickUpper]) { for (const j of [0n, 1n, 2n, 3n]) s.push(tickSlot(t) + j); s.push(bitmapSlot(t)); }
      const ps = posSlot(ev.owner, ev.tickLower, ev.tickUpper);
      for (const j of [0n, 1n, 2n, 3n]) s.push(ps + j);
    }
    return s;
  }
  // Price-history slots: after re-reading slot0, also re-read the entries
  // between the old and new index, plus newly prepared ones (growHistory).
  async function reReadHistory(copy, ctx, io, before, reason) {
    const after = unpackSlot0(await copy.getSlot(ctx.pool, 0n));
    const slots = [];
    if (after.idx !== before.idx || after.card !== before.card) slots.push(OBS + BigInt(after.idx));
    for (let i = before.cardNext; i < after.cardNext; i++) slots.push(OBS + BigInt(i));
    if (slots.length) await io.reRead(ctx.pool, slots, reason + ':history');
  }

  // ---- apply one block's events to the copy ----
  async function applyLogs(copy, logs, blk, ctx, io) {
    copy._replayerCode = ctx.replayerCode;
    copy._tokens = [ctx.U, ctx.W];
    // Group by transaction: pool events first (they must see coin balances
    // as they were before the transaction), then that transaction's coin events.
    const byTx = new Map();
    for (const lg of logs) {
      const k = lg.transactionHash;
      if (!byTx.has(k)) byTx.set(k, []);
      byTx.get(k).push(lg);
    }
    for (const txLogs of byTx.values()) {
      for (const log of txLogs) {
        if (lc(log.address) !== ctx.pool) continue;
        let ev;
        try { ev = cfg.eventIface.parseLog(log); } catch { ev = null; }
        const name = ev?.name ?? 'unknown';
        io.countEvent(`Pool.${name}`);
        await applyPoolEvent(copy, ctx, io, blk, name, ev?.args, log);
      }
      for (const log of txLogs) if (lc(log.address) !== ctx.pool) await C.applyTokenLog(copy, log, ctx, io);
    }
    if (ctx.pendingReRead) {
      const before = unpackSlot0(await copy.getSlot(ctx.pool, 0n));
      await io.reRead(ctx.pool, [...ctx.pendingReRead.slots], ctx.pendingReRead.reasons.join('+'));
      await reReadHistory(copy, ctx, io, before, 'block');
      ctx.pendingReRead = null;
    }
    const s0 = unpackSlot0(await copy.getSlot(ctx.pool, 0n));
    ctx.tickNow = s0.tick; ctx.lastSqrt = s0.sqrt; ctx.cardNext = s0.cardNext;
    // track position sizes (from the copy) so burns pick sensible amounts
    ctx.posLiq = new Map();
    for (const p of ctx.positions) ctx.posLiq.set(`${p.lo}:${p.hi}`, (await copy.getSlot(ctx.pool, posSlot(p.owner, p.lo, p.hi))) & ((1n << 128n) - 1n));
  }

  async function applyPoolEvent(copy, ctx, io, blk, name, a, log) {
    const pool = ctx.pool;
    if (name === 'Swap') {
      if (ctx.variant === 'fields') return swapFromFields(copy, ctx, blk, a);
      return swapByReplay(copy, ctx, io, blk, a, log);
    }
    if (['Mint', 'Burn', 'Collect', 'Flash', 'IncreaseObservationCardinalityNext'].includes(name)) {
      if (name === 'Mint') registerPosition(ctx, a.owner, Number(a.tickLower), Number(a.tickUpper));
      if (ctx.variant === 'fields') {
        // A node can only be asked about the state at the END of a block, so
        // collect what to re-read and do it after the block's last event.
        const ev = a.tickLower !== undefined ? { owner: a.owner, tickLower: Number(a.tickLower), tickUpper: Number(a.tickUpper) } : {};
        ctx.pendingReRead ??= { slots: new Set(), reasons: [] };
        for (const sl of reReadSlots(ev)) ctx.pendingReRead.slots.add(sl);
        ctx.pendingReRead.reasons.push(name);
        return;
      }
      // replay
      const ri = replayerIface();
      let r;
      if (name === 'Mint') r = await replayCall(copy, blk, ctx.me, REPLAYER, ri.encodeFunctionData('mint', [pool, a.owner, a.tickLower, a.tickUpper, a.amount]), [pool]);
      else if (name === 'Burn') r = await replayCall(copy, blk, a.owner, pool, poolIface.encodeFunctionData('burn', [a.tickLower, a.tickUpper, a.amount]), [pool]);
      else if (name === 'Collect') r = await replayCall(copy, blk, a.owner, pool, poolIface.encodeFunctionData('collect', [a.recipient, a.tickLower, a.tickUpper, a.amount0, a.amount1]), [pool]);
      else if (name === 'Flash') r = await replayCall(copy, blk, ctx.me, REPLAYER, ri.encodeFunctionData('flash', [pool, a.amount0, a.amount1, a.paid0, a.paid1]), [pool]);
      else r = await replayCall(copy, blk, ctx.me, pool, poolIface.encodeFunctionData('increaseObservationCardinalityNext', [a.observationCardinalityNextNew]), [pool]);
      // check the replay against the event's own numbers
      let ok = r.ok;
      if (ok && (name === 'Mint' || name === 'Burn')) {
        const [x0, x1] = abi.decode(['uint256', 'uint256'], r.output);
        ok = x0 === a.amount0 && x1 === a.amount1;
      }
      if (ok && name === 'Collect') {
        const [x0, x1] = abi.decode(['uint128', 'uint128'], r.output);
        ok = x0 === a.amount0 && x1 === a.amount1;
      }
      if (ok) { io.replay(name); await applyWrites(copy, r.writes); return; }
      io.replay(name + ':FAILED');
      const before = unpackSlot0(await copy.getSlot(pool, 0n));
      const ev = a.tickLower !== undefined ? { owner: a.owner, tickLower: Number(a.tickLower), tickUpper: Number(a.tickUpper) } : {};
      await io.reRead(pool, reReadSlots(ev), name + ':replayFailed');
      await reReadHistory(copy, ctx, io, before, name);
      return;
    }
    // Anything else (SetFeeProtocol, CollectProtocol, Initialize...): not expected here.
    io.replay('UNHANDLED:' + name);
  }

  // "fields": write what the Swap event says, compute the history entry.
  async function swapFromFields(copy, ctx, blk, a) {
    const s0 = unpackSlot0(await copy.getSlot(ctx.pool, 0n));
    const liqBefore = (await copy.getSlot(ctx.pool, P.liq)) & ((1n << 128n) - 1n);
    const tick = Number(a.tick);
    if (tick !== s0.tick) {
      const w = await C.oracleWrite(copy, ctx.pool, OBS, s0.idx, blk.timestamp, s0.tick, liqBefore, s0.card, s0.cardNext);
      s0.idx = w.index; s0.card = w.card;
      // If a Mint/Burn earlier in this SAME block is waiting for its node
      // re-read, the liquidity we just used may be stale (the node can only
      // be asked about the block's end), so this history entry is re-read too.
      if (ctx.pendingReRead) ctx.pendingReRead.slots.add(OBS + BigInt(w.index));
    }
    s0.sqrt = a.sqrtPriceX96; s0.tick = tick;
    await copy.setSlot(ctx.pool, 0n, packSlot0(s0));
    await copy.setSlot(ctx.pool, P.liq, a.liquidity);
    if (cfg.name === 'pancake') { // Swap event carries this swap's protocol fees
      const pf = await copy.getSlot(ctx.pool, P.pf);
      const p0 = (pf & ((1n << 128n) - 1n)) + a.protocolFeesToken0, p1 = (pf >> 128n) + a.protocolFeesToken1;
      await copy.setSlot(ctx.pool, P.pf, BigInt.asUintN(128, p0) | (BigInt.asUintN(128, p1) << 128n));
    }
  }

  // "replay": re-run the swap. The event doesn't say whether it was "exact
  // input" or "exact output", or whether a price limit stopped it; try the
  // possibilities in order and keep the first that reproduces the event's
  // amounts, final price, tick and liquidity exactly.
  async function swapByReplay(copy, ctx, io, blk, a, log) {
    // Direction: coin0 paid in = zeroForOne; if no coins moved (0/0), price fell = zeroForOne.
    const priceBefore = unpackSlot0(await copy.getSlot(ctx.pool, 0n)).sqrt;
    const zeroForOne = a.amount0 !== 0n || a.amount1 !== 0n ? a.amount0 > 0n : a.sqrtPriceX96 < priceBefore;
    const amtIn = zeroForOne ? a.amount0 : a.amount1;
    const amtOut = zeroForOne ? -a.amount1 : -a.amount0;
    const ri = replayerIface();
    // Last two: "as much as needed, stop at the event's final price". That is
    // what a swap that ran out of liquidity (price pushed to its limit through
    // empty ticks) looks like: the coins used alone stop too early.
    const HUGE = 1n << 200n;
    const tries = [['exactIn', amtIn, 0n], ['exactOut', -amtOut, 0n], ['exactIn+limit', amtIn, a.sqrtPriceX96],
      ['exactOut+limit', -amtOut, a.sqrtPriceX96], ['toPrice', HUGE, a.sqrtPriceX96], ['toPriceOut', -HUGE, a.sqrtPriceX96],
      // no-liquidity range: event amounts 0/0, price moved (see v4.js)
      ['tinyIn', 1n, a.sqrtPriceX96], ['tinyOut', -1n, a.sqrtPriceX96]];
    const why = [];
    for (const [mode, amount, limit] of tries) {
      const r = await replayCall(copy, blk, ctx.me, REPLAYER, ri.encodeFunctionData('swap', [ctx.pool, zeroForOne, amount, limit]), [ctx.pool]);
      if (!r.ok) { why.push(`${mode}: reverted ${r.error}`); continue; }
      const [x0, x1] = abi.decode(['int256', 'int256'], r.output);
      if (x0 !== a.amount0 || x1 !== a.amount1) { why.push(`${mode}: amounts ${x0},${x1} vs event ${a.amount0},${a.amount1}`); continue; }
      // final price / tick / liquidity from the replay's own writes
      const w0 = r.writes.find(([acc, k]) => acc === ctx.pool && BigInt(k) === 0n);
      const s0 = unpackSlot0(w0 ? w0[2] : await copy.getSlot(ctx.pool, 0n));
      const wl = r.writes.find(([acc, k]) => acc === ctx.pool && BigInt(k) === P.liq);
      const liq = (wl ? wl[2] : await copy.getSlot(ctx.pool, P.liq)) & ((1n << 128n) - 1n);
      if (s0.sqrt !== a.sqrtPriceX96 || s0.tick !== Number(a.tick) || liq !== a.liquidity) { why.push(`${mode}: end state sqrt ${s0.sqrt} vs ${a.sqrtPriceX96}, tick ${s0.tick} vs ${a.tick}, liq ${liq} vs ${a.liquidity}`); continue; }
      io.replay('Swap:' + mode);
      await applyWrites(copy, r.writes);
      return;
    }
    io.replay('Swap:FAILED');
    if (process.env.DEBUG) console.log('\nswap replay failed:', why.join(' | '));
    // Fall back to a node re-read: pool globals + every known tick the price
    // moved across (their fee counters change when crossed).
    const before = unpackSlot0(await copy.getSlot(ctx.pool, 0n));
    const lo = Math.min(before.tick, Number(a.tick)), hi = Math.max(before.tick, Number(a.tick));
    const crossed = [...ctx.ticks].filter((t) => t >= lo - 1 && t <= hi + 1).flatMap((t) => [0n, 1n, 2n, 3n].map((j) => tickSlot(t) + j));
    await io.reRead(ctx.pool, [0n, P.fg0, P.fg1, P.pf, P.liq, ...crossed], 'Swap:replayFailed');
    await reReadHistory(copy, ctx, io, before, 'Swap');
  }

  function swapOp(ctx) {
    const zeroIsU = BigInt(ctx.U) < BigInt(ctx.W);
    return { to: ctx.trader, data: traderIface().encodeFunctionData('swapV3', [ctx.pool, zeroIsU, 200_000n * C.Q(6), 0]) };
  }

  return { setup, copiedAccounts, initCopy, policyUnknown, slotName, label, checkSpecs, randomOp, applyLogs, swapOp, unpackSlot0 };
}

module.exports = { makeFamily, REPLAYER };
