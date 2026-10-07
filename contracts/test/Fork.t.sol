// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";

// ============================================================================
// FORK TESTS -- ArbExecutor against REAL mainnet pools
//
// Plain English:
//   Copies each chain's live state, deploys ArbExecutor into that copy, and
//   runs a small real round trip through real pools. Real pools are usually
//   in balance, so the expected outcome is "every swap executed, then the
//   PROFIT CHECK said no" (InsufficientProfit). That proves:
//     - each pool type's swap call works on the real contract
//     - each V3 DEX calls back using a callback name we implement
//     - nothing else breaks along the way (only the profit guard stops it)
//   If a real arb happens to exist at that moment, success is also a pass.
//
// Needs RPC URLs (CI sets public ones). Locally, tests skip if unset:
//   AVALANCHE_RPC_URL, MONAD_RPC_URL, ROBINHOOD_RPC_URL
// Addresses come from src/config/knownAddresses.ts.
// ============================================================================

interface IWETH {
    function deposit() external payable;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IV2Factory {
    function getPair(address a, address b) external view returns (address);
}

interface ISolidlyFactory {
    function getPair(address a, address b, bool stable) external view returns (address);
}

interface IV3Pool {
    function liquidity() external view returns (uint128);
}

abstract contract ForkBase is Test {
    ArbExecutor exec;

    // Starts a fork if the RPC env var is set; otherwise marks the test skipped.
    function _fork(string memory envVar) internal returns (bool) {
        string memory url = vm.envOr(envVar, string(""));
        if (bytes(url).length == 0) {
            console.log("skipped: set", envVar, "to run");
            vm.skip(true);
            return false;
        }
        // Fork a few blocks behind the tip when CI provides one (<ENV>_BLOCK):
        // the newest block may not be accepted yet on public nodes
        // ("block not found: not accepted yet" on Avalanche).
        uint256 forkBlock = vm.envOr(string.concat(envVar, "_BLOCK"), uint256(0));
        if (forkBlock > 0) vm.createSelectFork(url, forkBlock);
        else vm.createSelectFork(url);
        // This test contract is both owner and executor.
        exec = new ArbExecutor(address(this));
        return true;
    }

    // The chain's own block number, as the contract sees it for deadlines.
    // On Arbitrum/Orbit chains (Robinhood) block.number is the PARENT chain's
    // block, so ask the ArbSys precompile (address 100); elsewhere use
    // block.number. Mirrors the bot, which takes maxBlock from eth_blockNumber.
    function _l2Block() internal view returns (uint256) {
        (bool ok, bytes memory ret) = address(100).staticcall{gas: 20_000}(abi.encodeWithSignature("arbBlockNumber()"));
        if (ok && ret.length >= 32) return abi.decode(ret, (uint256));
        return block.number;
    }

    // Wraps native gas token into the wrapped token and hands it to the executor.
    function _fundWrapped(address wrapped, uint256 amount) internal {
        vm.deal(address(this), amount);
        IWETH(wrapped).deposit{value: amount}();
        IWETH(wrapped).transfer(address(exec), amount);
    }

    function _hop(uint8 kind, address pool, address tIn, address tOut, uint16 feeBps)
        internal
        pure
        returns (ArbExecutor.Hop memory)
    {
        return ArbExecutor.Hop({kind: kind, pool: pool, tokenIn: tIn, tokenOut: tOut, feeBps: feeBps, v4Fee: 0, v4TickSpacing: 0, v4Native: false});
    }

    // Runs the trade. Pass = it succeeded (real arb) OR reverted ONLY at the
    // profit check. Any other revert (swap failed, unknown callback, bad
    // transfer) fails the test with the raw revert data.
    function _runExpectingOnlyProfitGuard(string memory label, ArbExecutor.Trade memory t, address flashPool)
        internal
    {
        (bool ok, bytes memory data) =
            address(exec).call(abi.encodeWithSelector(ArbExecutor.execute.selector, t, flashPool));
        if (ok) {
            console.log(label, "-> executed with real profit (live arb existed at this block)");
            return;
        }
        if (data.length >= 4 && bytes4(data) == ArbExecutor.InsufficientProfit.selector) {
            console.log(label, "-> all swaps executed; stopped by profit guard (expected)");
            return;
        }
        console.log(label, "-> FAILED before the profit check. Revert data:");
        console.logBytes(data);
        fail();
    }

    // Same as _runExpectingOnlyProfitGuard, but borrowing from a V3 pool.
    function _runV3FlashExpectingOnlyProfitGuard(string memory label, ArbExecutor.Trade memory t, address lender)
        internal
    {
        (bool ok, bytes memory data) =
            address(exec).call(abi.encodeWithSelector(ArbExecutor.executeWithV3Flash.selector, t, lender));
        if (ok) {
            console.log(label, "-> executed with real profit (live arb existed at this block)");
            return;
        }
        if (data.length >= 4 && bytes4(data) == ArbExecutor.InsufficientProfit.selector) {
            console.log(label, "-> borrowed, all swaps executed, repaid; stopped by profit guard (expected)");
            return;
        }
        console.log(label, "-> FAILED before the profit check. Revert data:");
        console.logBytes(data);
        fail();
    }

    // V3 pool for the pair with liquidity, skipping any pool in `exclude`.
    function _findV3Excluding(address factory, address a, address b, uint24[] memory fees, address exclude)
        internal
        view
        returns (address)
    {
        for (uint256 i = 0; i < fees.length; i++) {
            (bool ok, bytes memory ret) =
                factory.staticcall(abi.encodeWithSignature("getPool(address,address,uint24)", a, b, fees[i]));
            if (!ok || ret.length < 32) continue;
            address pool = abi.decode(ret, (address));
            if (pool == address(0) || pool == exclude || pool.code.length == 0) continue;
            if (IV3Pool(pool).liquidity() > 0) return pool;
        }
        return address(0);
    }

    // Finds a V3-style pool with liquidity for the pair, trying common fee tiers
    // via getPool(address,address,uint24). Returns address(0) if none.
    function _findV3(address factory, address a, address b, uint24[] memory fees) internal view returns (address) {
        for (uint256 i = 0; i < fees.length; i++) {
            (bool ok, bytes memory ret) =
                factory.staticcall(abi.encodeWithSignature("getPool(address,address,uint24)", a, b, fees[i]));
            if (!ok || ret.length < 32) continue;
            address pool = abi.decode(ret, (address));
            if (pool != address(0) && pool.code.length > 0 && IV3Pool(pool).liquidity() > 0) return pool;
        }
        return address(0);
    }

    // Same, for factories keyed by tick spacing: getPool(address,address,int24).
    function _findV3ByTickSpacing(address factory, address a, address b, int24[] memory spacings)
        internal
        view
        returns (address)
    {
        for (uint256 i = 0; i < spacings.length; i++) {
            (bool ok, bytes memory ret) =
                factory.staticcall(abi.encodeWithSignature("getPool(address,address,int24)", a, b, spacings[i]));
            if (!ok || ret.length < 32) continue;
            address pool = abi.decode(ret, (address));
            if (pool != address(0) && pool.code.length > 0 && IV3Pool(pool).liquidity() > 0) return pool;
        }
        return address(0);
    }

    function _fees(uint24 a, uint24 b, uint24 c, uint24 d) internal pure returns (uint24[] memory f) {
        f = new uint24[](4);
        (f[0], f[1], f[2], f[3]) = (a, b, c, d);
    }

    receive() external payable {}
}

// ---------------------------------------------------------------------------
// AVALANCHE: TraderJoe v1 (V2) <-> SushiSwap (V2), own capital and Aave flash
// ---------------------------------------------------------------------------
contract AvalancheForkTest is ForkBase {
    address constant WAVAX = 0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7;
    address constant USDC = 0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E;
    address constant JOE_FACTORY = 0x9Ad6C38BE94206cA50bb0d90783181662f0Cfa10;
    address constant SUSHI_FACTORY = 0xc35DADB65012eC5796536bD9864eD8773aBc74C4;
    // Aave V3 Pool on Avalanche (same address Aave uses on several chains).
    address constant AAVE_POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;

    function _route(uint256 amountIn) internal view returns (ArbExecutor.Trade memory t) {
        address joe = IV2Factory(JOE_FACTORY).getPair(WAVAX, USDC);
        address sushi = IV2Factory(SUSHI_FACTORY).getPair(WAVAX, USDC);
        require(joe != address(0) && sushi != address(0), "WAVAX/USDC pair missing on Joe or Sushi");
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = _hop(0, joe, WAVAX, USDC, 30);
        hops[1] = _hop(0, sushi, USDC, WAVAX, 30);
        t = ArbExecutor.Trade({token: WAVAX, amountIn: amountIn, minProfit: 1, maxBlock: _l2Block(), hops: hops});
    }

    function test_fork_avalanche_V2_ownCapital() public {
        if (!_fork("AVALANCHE_RPC_URL")) return;
        _fundWrapped(WAVAX, 1 ether);
        _runExpectingOnlyProfitGuard("avalanche joe->sushi (own capital)", _route(1 ether), address(0));
    }

    function test_fork_avalanche_V2_aaveFlashLoan() public {
        if (!_fork("AVALANCHE_RPC_URL")) return;
        require(AAVE_POOL.code.length > 0, "no Aave pool code at expected address");
        exec.setFlashPool(AAVE_POOL, true);
        // Small float so a losing round trip can still repay Aave, letting the
        // revert happen at OUR profit check (proves the full flash loop works).
        _fundWrapped(WAVAX, 0.1 ether);
        _runExpectingOnlyProfitGuard("avalanche joe->sushi (Aave flash)", _route(1 ether), AAVE_POOL);
        assertEq(IWETH(WAVAX).balanceOf(address(exec)), 0.1 ether, "float untouched after revert");
    }
}

// ---------------------------------------------------------------------------
// MONAD: Uniswap V3 <-> PancakeSwap V3 (both callback names)
// ---------------------------------------------------------------------------
contract MonadForkTest is ForkBase {
    address constant WMON = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;
    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address constant UNI_V3_FACTORY = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    address constant PANCAKE_V3_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    address constant PANCAKE_V2_FACTORY = 0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E;

    function test_fork_monad_uniV3_to_pancakeV3() public {
        if (!_fork("MONAD_RPC_URL")) return;
        address uni = _findV3(UNI_V3_FACTORY, WMON, USDC, _fees(3000, 500, 10000, 100));
        address cake = _findV3(PANCAKE_V3_FACTORY, WMON, USDC, _fees(2500, 500, 10000, 100));
        console.log("monad uniswap v3 WMON/USDC:", uni);
        console.log("monad pancake v3 WMON/USDC:", cake);
        require(uni != address(0) && cake != address(0), "WMON/USDC V3 pool missing");

        _fundWrapped(WMON, 10 ether);
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = _hop(2, uni, WMON, USDC, 0);
        hops[1] = _hop(2, cake, USDC, WMON, 0);
        ArbExecutor.Trade memory t =
            ArbExecutor.Trade({token: WMON, amountIn: 10 ether, minProfit: 1, maxBlock: _l2Block(), hops: hops});
        _runExpectingOnlyProfitGuard("monad uniV3->pancakeV3", t, address(0));
    }

    // ZERO-CAPITAL on Monad: borrow WMON from a different Uniswap V3 pool
    // than the one being traded.
    function test_fork_monad_v3FlashLoan() public {
        if (!_fork("MONAD_RPC_URL")) return;
        address uni = _findV3(UNI_V3_FACTORY, WMON, USDC, _fees(3000, 500, 10000, 100));
        address cake = _findV3(PANCAKE_V3_FACTORY, WMON, USDC, _fees(2500, 500, 10000, 100));
        address lender = _findV3Excluding(UNI_V3_FACTORY, WMON, USDC, _fees(500, 10000, 3000, 100), uni);
        if (lender == cake) lender = address(0);
        console.log("monad lender (V3 pool):", lender);
        if (uni == address(0) || cake == address(0) || lender == address(0)) {
            console.log("skipped: no separate WMON lender pool found");
            vm.skip(true);
            return;
        }
        exec.setFlashPool(lender, true);
        _fundWrapped(WMON, 1 ether); // tiny float so a losing trade can repay and reach the profit check
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = _hop(2, uni, WMON, USDC, 0);
        hops[1] = _hop(2, cake, USDC, WMON, 0);
        ArbExecutor.Trade memory t =
            ArbExecutor.Trade({token: WMON, amountIn: 10 ether, minProfit: 1, maxBlock: _l2Block(), hops: hops});
        _runV3FlashExpectingOnlyProfitGuard("monad V3 flash loan + uniV3->cakeV3", t, lender);
    }

    function test_fork_monad_pancakeV2_to_uniV3() public {
        if (!_fork("MONAD_RPC_URL")) return;
        address v2 = IV2Factory(PANCAKE_V2_FACTORY).getPair(WMON, USDC);
        address uni = _findV3(UNI_V3_FACTORY, WMON, USDC, _fees(3000, 500, 10000, 100));
        console.log("monad pancake v2 WMON/USDC:", v2);
        if (v2 == address(0)) {
            console.log("skipped: no Pancake V2 WMON/USDC pair on Monad");
            vm.skip(true);
            return;
        }
        require(uni != address(0), "WMON/USDC Uniswap V3 pool missing");

        _fundWrapped(WMON, 10 ether);
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = _hop(0, v2, WMON, USDC, 25); // PancakeSwap V2 fee: 0.25%
        hops[1] = _hop(2, uni, USDC, WMON, 0);
        ArbExecutor.Trade memory t =
            ArbExecutor.Trade({token: WMON, amountIn: 10 ether, minProfit: 1, maxBlock: _l2Block(), hops: hops});
        _runExpectingOnlyProfitGuard("monad pancakeV2->uniV3", t, address(0));
    }
}

// ---------------------------------------------------------------------------
// ROBINHOOD CHAIN: Ramses V2 (Solidly) <-> Ramses V3 / PancakeSwap V3
// ---------------------------------------------------------------------------
contract RobinhoodForkTest is ForkBase {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant RAMSES_V2_FACTORY = 0x43B2Bf9f33036a02fC7A00935571c2A6b0108e66;
    address constant RAMSES_V3_FACTORY = 0xE0c4ceb92d08CA985bB70fe0a22fEb121A9854A8;
    address constant PANCAKE_V3_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;
    address constant UNI_V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;

    function _ramsesV2() internal view returns (address pair) {
        pair = ISolidlyFactory(RAMSES_V2_FACTORY).getPair(WETH, USDG, false);
        require(pair != address(0), "Ramses V2 WETH/USDG volatile pair missing");
    }

    function _solidlyToV3(string memory label, address v3) internal {
        _fundWrapped(WETH, 0.01 ether);
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = _hop(1, _ramsesV2(), WETH, USDG, 0);
        hops[1] = _hop(2, v3, USDG, WETH, 0);
        ArbExecutor.Trade memory t =
            ArbExecutor.Trade({token: WETH, amountIn: 0.01 ether, minProfit: 1, maxBlock: _l2Block(), hops: hops});
        _runExpectingOnlyProfitGuard(label, t, address(0));
    }

    function test_fork_robinhood_ramsesV2_to_ramsesV3() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        // Ramses V3 may key pools by fee or by tick spacing -- try both.
        address v3 = _findV3(RAMSES_V3_FACTORY, WETH, USDG, _fees(3000, 500, 10000, 100));
        if (v3 == address(0)) {
            int24[] memory sp = new int24[](4);
            (sp[0], sp[1], sp[2], sp[3]) = (int24(60), int24(10), int24(200), int24(1));
            v3 = _findV3ByTickSpacing(RAMSES_V3_FACTORY, WETH, USDG, sp);
        }
        console.log("robinhood ramses v3 WETH/USDG:", v3);
        if (v3 == address(0)) {
            console.log("skipped: no Ramses V3 WETH/USDG pool with liquidity found");
            vm.skip(true);
            return;
        }
        _solidlyToV3("robinhood ramsesV2->ramsesV3", v3);
    }

    // ZERO-CAPITAL on Robinhood: borrow WETH from a real Uniswap V3 pool,
    // trade Ramses V2 -> PancakeSwap V3, repay loan + fee.
    function test_fork_robinhood_v3FlashLoan() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        address cake = _findV3(PANCAKE_V3_FACTORY, WETH, USDG, _fees(2500, 500, 10000, 100));
        address lender = _findV3Excluding(UNI_V3_FACTORY, WETH, USDG, _fees(500, 3000, 10000, 100), cake);
        if (lender == address(0)) lender = _findV3Excluding(RAMSES_V3_FACTORY, WETH, USDG, _fees(3000, 500, 10000, 100), cake);
        console.log("robinhood lender (V3 pool):", lender);
        console.log("robinhood pancake v3 trade pool:", cake);
        if (cake == address(0) || lender == address(0)) {
            console.log("skipped: no separate lender pool / trade pool found");
            vm.skip(true);
            return;
        }
        exec.setFlashPool(lender, true);
        // Float ONLY so a losing round trip can still repay the loan and reach
        // our profit check (proves the full borrow/trade/repay loop). Sized to
        // cover even a total loss of the 0.01 WETH borrowed: live pool prices
        // drift, and a 0.001 float stopped covering the round-trip loss.
        _fundWrapped(WETH, 0.011 ether);
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = _hop(1, _ramsesV2(), WETH, USDG, 0);
        hops[1] = _hop(2, cake, USDG, WETH, 0);
        ArbExecutor.Trade memory t =
            ArbExecutor.Trade({token: WETH, amountIn: 0.01 ether, minProfit: 1, maxBlock: _l2Block(), hops: hops});
        _runV3FlashExpectingOnlyProfitGuard("robinhood V3 flash loan + ramsesV2->cakeV3", t, lender);
    }

    // RAMSES V3 AS LENDER: borrow WETH from a real Ramses V3 pool. Proves the
    // pool calls the flash callback name our contract implements
    // (ramsesV2FlashCallback); if it used another name the loan would revert.
    function test_fork_robinhood_ramsesV3_asLender() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        address cake = _findV3(PANCAKE_V3_FACTORY, WETH, USDG, _fees(2500, 500, 10000, 100));
        // Ramses V3 pools are keyed by tick spacing; take one that holds WETH.
        address lender = address(0);
        int24[6] memory sp = [int24(1), int24(5), int24(10), int24(50), int24(100), int24(200)];
        for (uint256 i = 0; i < sp.length && lender == address(0); i++) {
            (bool ok, bytes memory ret) =
                RAMSES_V3_FACTORY.staticcall(abi.encodeWithSignature("getPool(address,address,int24)", WETH, USDG, sp[i]));
            if (!ok || ret.length < 32) continue;
            address p = abi.decode(ret, (address));
            if (p == address(0) || p == cake || p.code.length == 0) continue;
            (bool okb, bytes memory bal) = WETH.staticcall(abi.encodeWithSignature("balanceOf(address)", p));
            if (okb && bal.length >= 32 && abi.decode(bal, (uint256)) >= 0.05 ether) lender = p;
        }
        console.log("robinhood ramses v3 lender:", lender);
        console.log("robinhood pancake v3 trade pool:", cake);
        if (cake == address(0) || lender == address(0)) {
            console.log("skipped: no Ramses V3 lender / PancakeSwap trade pool found");
            vm.skip(true);
            return;
        }
        exec.setFlashPool(lender, true);
        _fundWrapped(WETH, 0.011 ether); // covers even a total-loss round trip, so we reach the profit check
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = _hop(1, _ramsesV2(), WETH, USDG, 0);
        hops[1] = _hop(2, cake, USDG, WETH, 0);
        ArbExecutor.Trade memory t =
            ArbExecutor.Trade({token: WETH, amountIn: 0.01 ether, minProfit: 1, maxBlock: _l2Block(), hops: hops});
        _runV3FlashExpectingOnlyProfitGuard("robinhood RAMSES V3 flash loan + ramsesV2->cakeV3", t, lender);
    }

    // ---- Uniswap V4 (real PoolManager, real hookless pools) -----------------
    // Pools confirmed live by the V4 probe (only=v4): native ETH/USDG and
    // WETH/USDG at 0.05% (tick spacing 10), both without hooks.
    address constant V4_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    function _v4Hop(address tIn, address tOut, uint24 fee, int24 spacing, bool native)
        internal
        pure
        returns (ArbExecutor.Hop memory)
    {
        return ArbExecutor.Hop({kind: 3, pool: V4_POOL_MANAGER, tokenIn: tIn, tokenOut: tOut, feeBps: 0, v4Fee: fee, v4TickSpacing: spacing, v4Native: native});
    }

    function _uniV3() internal view returns (address v3) {
        v3 = _findV3(UNI_V3_FACTORY, WETH, USDG, _fees(500, 3000, 10000, 100));
    }

    // WETH -> USDG on Uniswap V3, USDG -> WETH on the NATIVE-ETH V4 pool
    // (contract unwraps/wraps around the V4 swap).
    function test_fork_robinhood_v3_to_v4NativeEth() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        address v3 = _uniV3();
        if (v3 == address(0)) { console.log("skipped: no Uniswap V3 WETH/USDG pool"); vm.skip(true); return; }
        exec.setV4(V4_POOL_MANAGER, WETH);
        _fundWrapped(WETH, 0.011 ether);
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = _hop(2, v3, WETH, USDG, 0);
        hops[1] = _v4Hop(USDG, WETH, 500, 10, true);
        ArbExecutor.Trade memory t =
            ArbExecutor.Trade({token: WETH, amountIn: 0.01 ether, minProfit: 1, maxBlock: _l2Block(), hops: hops});
        _runExpectingOnlyProfitGuard("robinhood uniV3 -> V4 native ETH/USDG", t, address(0));
        assertEq(address(exec).balance, 0, "no ETH left in the contract");
    }

    // WETH -> USDG on the WETH (ERC20) V4 pool, USDG -> WETH on Uniswap V3.
    function test_fork_robinhood_v4Weth_to_v3() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        address v3 = _uniV3();
        if (v3 == address(0)) { console.log("skipped: no Uniswap V3 WETH/USDG pool"); vm.skip(true); return; }
        exec.setV4(V4_POOL_MANAGER, WETH);
        _fundWrapped(WETH, 0.011 ether);
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = _v4Hop(WETH, USDG, 500, 10, false);
        hops[1] = _hop(2, v3, USDG, WETH, 0);
        ArbExecutor.Trade memory t =
            ArbExecutor.Trade({token: WETH, amountIn: 0.01 ether, minProfit: 1, maxBlock: _l2Block(), hops: hops});
        _runExpectingOnlyProfitGuard("robinhood V4 WETH/USDG -> uniV3", t, address(0));
    }

    // Ramses V3 WETH/USDG pool keyed by tick spacing, with real coins in it.
    function _ramsesV3ByTick() internal view returns (address v3) {
        int24[6] memory sp = [int24(1), int24(5), int24(10), int24(50), int24(100), int24(200)];
        uint256 best;
        for (uint256 i = 0; i < sp.length; i++) {
            (bool ok, bytes memory ret) =
                RAMSES_V3_FACTORY.staticcall(abi.encodeWithSignature("getPool(address,address,int24)", WETH, USDG, sp[i]));
            if (!ok || ret.length < 32) continue;
            address p = abi.decode(ret, (address));
            if (p == address(0) || p.code.length == 0) continue;
            (bool okb, bytes memory bal) = WETH.staticcall(abi.encodeWithSignature("balanceOf(address)", p));
            if (!okb || bal.length < 32) continue;
            uint256 b = abi.decode(bal, (uint256));
            if (b > best) { best = b; v3 = p; } // deepest WETH balance
        }
    }

    // The exact route the bot's checks failed on (Oct 7): WETH -> USDG on
    // Uniswap V3, then USDG -> WETH on Ramses V3. Own capital, so only the
    // Ramses hop itself is being tested (no lender involved).
    function test_fork_robinhood_uniV3_to_ramsesV3() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        address uni = _uniV3();
        address ram = _ramsesV3ByTick();
        console.log("robinhood uni v3 WETH/USDG:", uni);
        console.log("robinhood ramses v3 WETH/USDG (by tick spacing):", ram);
        if (uni == address(0) || ram == address(0)) { console.log("skipped: pools not found"); vm.skip(true); return; }
        _fundWrapped(WETH, 0.05 ether);
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = _hop(2, uni, WETH, USDG, 0);
        hops[1] = _hop(2, ram, USDG, WETH, 0);
        ArbExecutor.Trade memory t =
            ArbExecutor.Trade({token: WETH, amountIn: 0.05 ether, minProfit: 1, maxBlock: _l2Block(), hops: hops});
        _runExpectingOnlyProfitGuard("robinhood uniV3 -> ramsesV3", t, address(0));
    }

    // Reverse direction: Ramses V3 first, then Uniswap V3.
    function test_fork_robinhood_ramsesV3_to_uniV3() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        address uni = _uniV3();
        address ram = _ramsesV3ByTick();
        if (uni == address(0) || ram == address(0)) { console.log("skipped: pools not found"); vm.skip(true); return; }
        _fundWrapped(WETH, 0.05 ether);
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = _hop(2, ram, WETH, USDG, 0);
        hops[1] = _hop(2, uni, USDG, WETH, 0);
        ArbExecutor.Trade memory t =
            ArbExecutor.Trade({token: WETH, amountIn: 0.05 ether, minProfit: 1, maxBlock: _l2Block(), hops: hops});
        _runExpectingOnlyProfitGuard("robinhood ramsesV3 -> uniV3", t, address(0));
    }

    // Same failing route, now with a flash loan from the TINY 0.01% Uniswap
    // V3 pool the bot used to pick. Logs how much WETH that pool holds, so we
    // can see whether it could ever cover the loan.
    function test_fork_robinhood_tinyLenderBalance() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        address tiny = _findV3(UNI_V3_FACTORY, WETH, USDG, _fees(100, 100, 100, 100));
        console.log("robinhood uni v3 0.01% WETH/USDG pool:", tiny);
        if (tiny == address(0)) { console.log("skipped: no 0.01% pool"); vm.skip(true); return; }
        (, bytes memory bal) = WETH.staticcall(abi.encodeWithSignature("balanceOf(address)", tiny));
        (, bytes memory bal2) = USDG.staticcall(abi.encodeWithSignature("balanceOf(address)", tiny));
        console.log("  tiny pool WETH held (wei):", abi.decode(bal, (uint256)));
        console.log("  tiny pool USDG held (raw):", abi.decode(bal2, (uint256)));
    }

    // Flash loan from the Uniswap V3 0.01% pool (the lender the bot picked),
    // then the failing route, starting with WETH or USDG, at a bot-like size.
    // A float covers a losing round trip so a clean run stops at the profit
    // check. Any other revert prints its raw data.
    function _flashRoute(string memory label, address start, address mid, uint256 amount, address h1, uint8 k1, address h2, uint8 k2, bool native1, bool native2) internal {
        address lender = _findV3(UNI_V3_FACTORY, WETH, USDG, _fees(100, 100, 100, 100));
        if (lender == address(0) || h1 == address(0) || h2 == address(0)) { console.log(label, "skipped: pool missing"); vm.skip(true); return; }
        exec.setFlashPool(lender, true);
        exec.setV4(V4_POOL_MANAGER, WETH);
        if (start == WETH) _fundWrapped(WETH, amount);
        else deal(start, address(exec), amount);
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = k1 == 3 ? _v4Hop(start, mid, 500, 10, native1) : _hop(k1, h1, start, mid, 0);
        hops[1] = k2 == 3 ? _v4Hop(mid, start, 500, 10, native2) : _hop(k2, h2, mid, start, 0);
        ArbExecutor.Trade memory t =
            ArbExecutor.Trade({token: start, amountIn: amount, minProfit: 1, maxBlock: _l2Block(), hops: hops});
        _runV3FlashExpectingOnlyProfitGuard(label, t, lender);
    }

    function test_fork_robinhood_flash_uniV3_to_ramsesV3_WETH() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        address uni = _findV3Excluding(UNI_V3_FACTORY, WETH, USDG, _fees(500, 3000, 10000, 500), address(0));
        _flashRoute("robinhood flash(uni 0.01%) uniV3->ramsesV3 start WETH 0.3", WETH, USDG, 0.3 ether, uni, 2, _ramsesV3ByTick(), 2, false, false);
    }

    function test_fork_robinhood_flash_uniV3_to_ramsesV3_USDG() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        address uni = _findV3Excluding(UNI_V3_FACTORY, WETH, USDG, _fees(500, 3000, 10000, 500), address(0));
        _flashRoute("robinhood flash(uni 0.01%) uniV3->ramsesV3 start USDG 1000", USDG, WETH, 1000e6, uni, 2, _ramsesV3ByTick(), 2, false, false);
    }

    function test_fork_robinhood_flash_v4_to_ramsesV3_WETH() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        _flashRoute("robinhood flash(uni 0.01%) V4(native)->ramsesV3 start WETH 0.3", WETH, USDG, 0.3 ether, V4_POOL_MANAGER, 3, _ramsesV3ByTick(), 2, true, false);
    }

    function test_fork_robinhood_flash_v4_to_ramsesV3_USDG() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        _flashRoute("robinhood flash(uni 0.01%) V4(native)->ramsesV3 start USDG 1000", USDG, WETH, 1000e6, V4_POOL_MANAGER, 3, _ramsesV3ByTick(), 2, true, false);
    }

    function test_fork_robinhood_ramsesV2_to_pancakeV3() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        address v3 = _findV3(PANCAKE_V3_FACTORY, WETH, USDG, _fees(2500, 500, 10000, 100));
        console.log("robinhood pancake v3 WETH/USDG:", v3);
        if (v3 == address(0)) {
            console.log("skipped: no PancakeSwap V3 WETH/USDG pool with liquidity found");
            vm.skip(true);
            return;
        }
        _solidlyToV3("robinhood ramsesV2->pancakeV3", v3);
    }
}
