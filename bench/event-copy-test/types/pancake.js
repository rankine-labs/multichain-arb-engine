// ============================================================================
// POOL TYPE 3: PancakeSwap V3 (real PancakeV3Pool bytecode, npm @pancakeswap/v3-core 1.0.2)
//
// Same design as Uniswap V3 (logic in v3family.js). Differences that matter:
//   - slot0.feeProtocol is 32 bits (two 16-bit halves) and is ON by default
//     (fee tier 2500 -> 32% of swap fees go to the protocol).
//   - Swap event has two extra fields: protocolFeesToken0/1 of that swap,
//     so the "protocolFees" slot IS derivable from events (unlike Uniswap).
//   - lmPool (liquidity mining hook, slot 65543): when set, every swap calls
//     lmPool.accumulateReward and each crossed tick calls crossLmTick. Here it
//     is 0, like most pools; a real pool with a farm would add that contract's
//     storage to what the check reads (see results.md).
//   - Pools are created by Pancake's deployer contract; npm only ships the
//     pool code, so Helpers.sol PancakeDeployer gives the same constructor
//     answers (factory, coins, fee, tick spacing).
// ============================================================================
const L = require('../lib');
const { makeFamily } = require('./v3family');
const { ethers, lc } = L;

const pk = require('@pancakeswap/v3-core/artifacts/contracts/PancakeV3Pool.sol/PancakeV3Pool.json');

module.exports = makeFamily({
  name: 'pancake',
  poolArtifact: pk,
  spacing: 50,
  eventIface: new ethers.Interface(pk.abi),
  async deployPool(chain, base) {
    const H = L.helpers();
    const D = await L.deploy(chain, H.PancakeDeployer.abi, H.PancakeDeployer.evm.bytecode.object);
    const [t0, t1] = BigInt(base.U) < BigInt(base.W) ? [base.U, base.W] : [base.W, base.U];
    // factory = our own account (it may then call setFeeProtocol / setLmPool)
    await (await D.deploy(pk.bytecode, chain.me, t0, t1, 2500, 50)).wait();
    return lc(ethers.getCreateAddress({ from: await D.getAddress(), nonce: 1 }));
  },
});
