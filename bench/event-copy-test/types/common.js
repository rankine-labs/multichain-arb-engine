// ============================================================================
// Pieces shared by every pool type.
//
// Plain English:
//   - setupBase(): two coins (USD 6 decimals, "ETH" 18 decimals), the Trader
//     helper with lots of both, and TWO reference Uniswap V3 pools that the
//     random traders never touch (one priced 2% higher than the test pool,
//     one 2% lower). The bot's check sends money through the pool under
//     test and back through a reference pool, so price gaps exist both ways.
//   - applyTokenLog(): how the copy keeps every coin balance right using
//     only the coin's Transfer / Approval events.
//   - checkSpecs(): the bot checks we compare: 4 routes x 3 sizes.
//   - Oracle helpers for V3-style pools (the "observations" price history).
// ============================================================================
const L = require('../lib');
const { ethers, abi, hex32, lc } = L;

const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const APPROVAL = ethers.id('Approval(address,address,uint256)');
const Q = (n) => 10n ** BigInt(n);

const v3f = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json');
const v3p = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json');

// Price of 1 W in U (both in whole coins) -> V3 sqrtPriceX96 for a pool whose
// token0/token1 order is given.
function sqrtPriceFor(priceUperW, U, W, decU = 6, decW = 18) {
  // raw price = token1 per token0 in base units
  const wIs0 = BigInt(W) < BigInt(U);
  let p = priceUperW * 10 ** (decU - decW); // U-units per W-unit
  if (!wIs0) p = 1 / p;
  return BigInt(Math.floor(Math.sqrt(p) * 2 ** 48)) * (1n << 48n);
}

async function setupBase(chain, rng) {
  const H = L.helpers();
  const U = await L.deploy(chain, H.Token.abi, H.Token.evm.bytecode.object, 'USD', 6);
  const W = await L.deploy(chain, H.Token.abi, H.Token.evm.bytecode.object, 'WETH', 18);
  const trader = await L.deploy(chain, H.Trader.abi, H.Trader.evm.bytecode.object);
  const tAddr = await trader.getAddress();
  for (const t of [U, W]) await (await t.mint(tAddr, Q(36))).wait();
  const base = { U: lc(await U.getAddress()), W: lc(await W.getAddress()), trader: lc(tAddr), traderC: trader,
    tokens: {}, me: lc(chain.me) };
  base.tokens[base.U] = { name: 'USD', dec: 6 };
  base.tokens[base.W] = { name: 'WETH', dec: 18 };

  // Reference pools (Uniswap V3, never traded by the workload).
  const factory = await L.deploy(chain, v3f.abi, v3f.bytecode);
  base.refs = [];
  // 2550 / 2450: realistic +-2% gaps (like the bot sees). 5000 / 1250:
  // "sensitive" pools, priced so far off that the round trip is ALWAYS
  // profitable, so the profit number always depends on the test pool's exact
  // output (a loss would be reported as profit 0 and hide differences).
  for (const [fee, spacing, price] of [[500, 10, 2550], [3000, 60, 2450], [100, 1, 5000], [10000, 200, 1250]]) {
    if (fee === 100) await (await factory.enableFeeAmount(100, 1)).wait();
    await (await factory.createPool(base.U, base.W, fee)).wait();
    const addr = lc(await factory.getPool(base.U, base.W, fee));
    const pool = new ethers.Contract(addr, v3p.abi, await chain.provider.getSigner(0));
    await (await pool.initialize(sqrtPriceFor(price, base.U, base.W))).wait();
    const tick = Number((await pool.slot0()).tick);
    const b = Math.floor(tick / spacing) * spacing;
    const w = spacing === 1 ? 200 : spacing === 200 ? 4000 : spacing * 20;
    for (let k = 1; k <= 6; k++) await (await trader.mintV3(addr, b - w * k, b + w * k, Q(17) * 3n)).wait();
    base.refs.push({ addr, fee, price });
  }
  return base;
}

// The bot's checks: start coin U; 6 routes (test pool first or second, with
// either reference pool), 3 sizes each. `testHop(tokenIn, tokenOut)` gives
// the hop through the pool under test.
function checkSpecs(base, testHop) {
  const specs = [];
  const sizes = [100n * Q(6), 5_000n * Q(6), 250_000n * Q(6)];
  for (const ref of base.refs) {
    const refIn = L.hop(2, ref.addr, base.U, base.W);
    const refOut = L.hop(2, ref.addr, base.W, base.U);
    for (const amt of sizes) {
      // Sensitive pools only in their always-profitable direction.
      if (ref.price !== 1250) specs.push({ name: `test>ref${ref.fee}-${amt / Q(6)}`, token: base.U, amountIn: amt, hops: [testHop(base.U, base.W), refOut] });
      if (ref.price !== 5000) specs.push({ name: `ref${ref.fee}>test-${amt / Q(6)}`, token: base.U, amountIn: amt, hops: [refIn, testHop(base.W, base.U)] });
    }
  }
  return specs;
}

// ---- coins: keep balances / allowances / supply from events only ----
// Our Token: balances mapping at slot 0, allowances at slot 1, supply at 2.
const tokBal = (h) => L.mapSlot('address', h, 0);
const tokAllow = (o, s) => ethers.keccak256(abi.encode(['address', 'bytes32'], [s, ethers.keccak256(abi.encode(['address', 'uint256'], [o, 1]))]));

async function addTo(chain, addr, slot, delta) {
  const v = await chain.getSlot(addr, slot);
  await chain.setSlot(addr, slot, BigInt.asUintN(256, v + delta));
}

// Returns true if the log was a coin event we handled.
async function applyTokenLog(copy, log, base, io) {
  const a = lc(log.address);
  if (!base.tokens[a]) return false;
  if (log.topics[0] === TRANSFER) {
    io.countEvent('Token.Transfer');
    const from = '0x' + log.topics[1].slice(26), to = '0x' + log.topics[2].slice(26);
    const v = BigInt(log.data);
    if (BigInt(from) === 0n) await addTo(copy, a, 2, v); else await addTo(copy, a, tokBal(from), -v);
    if (BigInt(to) === 0n) await addTo(copy, a, 2, -v); else await addTo(copy, a, tokBal(to), v);
    return true;
  }
  if (log.topics[0] === APPROVAL) {
    io.countEvent('Token.Approval');
    const o = '0x' + log.topics[1].slice(26), s = '0x' + log.topics[2].slice(26);
    await copy.setSlot(a, tokAllow(o, s), BigInt(log.data));
    return true;
  }
  return false;
}

// ---- naming slots for the report ----
function makeNamer(base, extraHolders) {
  const names = new Map(); // addr -> Map(slot -> name)
  const label = new Map();
  const add = (a, slot, n) => { a = lc(a); if (!names.has(a)) names.set(a, new Map()); names.get(a).set(L.norm(slot), n); };
  const holders = { trader: base.trader, executor: L.SIM_EXECUTOR, me: base.me, ...extraHolders };
  for (const [k, v] of Object.entries(holders)) if (!v) delete holders[k];
  for (const [t, info] of Object.entries(base.tokens)) {
    label.set(t, info.name);
    add(t, 2, 'totalSupply');
    for (const [hn, h] of Object.entries(holders)) add(t, tokBal(h), `balance[${hn}]`);
    base.refs.forEach((r, i) => add(t, tokBal(r.addr), `balance[ref${r.fee}]`));
  }
  base.refs.forEach((r) => label.set(r.addr, `ref${r.fee}`));
  return {
    add, label,
    name(addr, slot, fallback) {
      addr = lc(addr);
      const n = names.get(addr)?.get(L.norm(slot));
      return `${label.get(addr) ?? addr.slice(0, 10)}:${n ?? (fallback ? fallback(addr, L.norm(slot)) : 'other')}`;
    },
  };
}

// ---- V3-style price history ("observations") ----
// One observation in one storage slot (Uniswap V3 / PancakeSwap V3 layout):
//   blockTimestamp uint32 | tickCumulative int56 | secondsPerLiquidityCumulativeX128 uint160 | initialized bool
function unpackObs(v) {
  return {
    ts: Number(v & 0xffffffffn),
    tickCum: BigInt.asIntN(56, (v >> 32n) & ((1n << 56n) - 1n)),
    spl: (v >> 88n) & ((1n << 160n) - 1n),
    init: (v >> 248n) & 1n,
  };
}
function packObs(o) {
  return BigInt(o.ts) | (BigInt.asUintN(56, o.tickCum) << 32n) | (BigInt.asUintN(160, o.spl) << 88n) | (BigInt(o.init) << 248n);
}
// Exact copy of Oracle.write (Uniswap V3 Oracle.sol). Returns the new
// index/cardinality and, if a new observation is written, its slot + value.
async function oracleWrite(copy, pool, obsBase, index, ts, tick, liquidity, card, cardNext) {
  const lastSlot = BigInt(obsBase) + BigInt(index);
  const last = unpackObs(await copy.getSlot(pool, lastSlot));
  if (last.ts === ts % 2 ** 32) return { index, card };
  const cardU = cardNext > card && index === card - 1 ? cardNext : card;
  const idx = (index + 1) % cardU;
  const delta = BigInt((ts - last.ts) >>> 0);
  const next = {
    ts: ts % 2 ** 32,
    tickCum: BigInt.asIntN(56, last.tickCum + BigInt(tick) * delta),
    spl: BigInt.asUintN(160, last.spl + ((delta << 128n) / (liquidity > 0n ? liquidity : 1n))),
    init: 1,
  };
  await copy.setSlot(pool, BigInt(obsBase) + BigInt(idx), packObs(next));
  return { index: idx, card: cardU };
}

// int24 / int16 mapping keys, as Solidity encodes them.
const tickKey = (tick, base) => L.mapSlot('int24', tick, base);
const wordKey = (word, base) => L.mapSlot('int16', word, base);
const asInt = (v, bits) => Number(BigInt.asIntN(bits, v));

module.exports = { TRANSFER, APPROVAL, Q, setupBase, checkSpecs, applyTokenLog, makeNamer, tokBal, tokAllow, addTo,
  unpackObs, packObs, oracleWrite, tickKey, wordKey, asInt, sqrtPriceFor, v3p, v3f };
