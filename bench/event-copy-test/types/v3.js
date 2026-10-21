// ============================================================================
// POOL TYPE 2: Uniswap V3 (real UniswapV3Pool bytecode, npm v3-core 1.0.1)
// Fee 0.30%, tick spacing 60. All logic is in v3family.js.
// ============================================================================
const L = require('../lib');
const C = require('./common');
const { makeFamily } = require('./v3family');
const { ethers, lc } = L;

module.exports = makeFamily({
  name: 'univ3',
  poolArtifact: C.v3p,
  spacing: 60,
  eventIface: new ethers.Interface(C.v3p.abi),
  // Pool made by the real Uniswap V3 factory.
  async deployPool(chain, base) {
    const f = await L.deploy(chain, C.v3f.abi, C.v3f.bytecode);
    await (await f.createPool(base.U, base.W, 3000)).wait();
    return lc(await f.getPool(base.U, base.W, 3000));
  },
  // Protocol fee ON (1/6 of each swap fee), like many live V3 deployments:
  // that makes the pool's protocolFees counter move on every swap.
  async afterInit(chain, pool) {
    await (await pool.setFeeProtocol(6, 6)).wait().catch(() => {});
  },
});
