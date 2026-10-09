// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";
import {ForkBase} from "./Fork.t.sol";

// ============================================================================
// ROBINHOOD FORK: CAN THE EXECUTOR TRADE FABLES (V4 POOLS WITH A HOOK)?
//
// Plain English:
//   Fables is Robinhood Chain's 2nd biggest exchange. Its pools are Uniswap
//   V4 pools on the normal PoolManager, but each one has a HOOK (extra code
//   the PoolManager calls on every swap) and the "dynamic fee" flag: the
//   hook picks the fee for each swap (the pool's stored fee reads 0). The
//   executor trades them with hop kind KIND_V4_HOOKED (4), where the hop's
//   `pool` field is the hook address (contracts/src/ArbExecutor.sol).
//
//   This test proves it against the REAL pools on a copy of the live chain:
//     1. Read the Fables registry (activePools) and pick the most liquid
//        ETH/USDG (native ETH) or WETH/USDG pool. Log its hook and the hook's
//        V4 permission bits (the low bits of the hook address). Fables hooks
//        use beforeSwap (to set the fee) and beforeInitialize; none of the
//        "returns delta" bits, so the hook never changes swap amounts.
//     2. Deploy our ArbExecutor (this branch's code), give it WETH, and round
//        trip BOTH ways with own money against Uniswap V3 WETH/USDG:
//          Uniswap V3 first, then Fables back, and
//          Fables first, then Uniswap V3 back.
//        Native ETH: the bot uses WETH; the contract unwraps before paying
//        the pool and wraps what it receives (v4Native = true).
//   PASS = every swap ran. Real pools are usually in balance, so the normal
//   ending is "all swaps executed, then OUR profit check said no"
//   (InsufficientProfit). A real profit is also a pass. Anything else fails
//   the test and prints the raw error.
//
//   Fee actually charged: a reverted transaction keeps no events, so the
//   round trips can't report it. Instead, from the same starting state, this
//   test swaps directly on the Fables pool (from this test contract, an
//   ordinary contract like ours) at the same size, both directions, plus a
//   couple of bigger sizes, and logs the fee from each Swap event (pips:
//   100 = 0.01%). A second test surveys the fee on other Fables USDG pools.
//
//   Gas: measured with every pool and coin "cold", like a real transaction;
//   the number is gas used up to our profit check (a win adds ~2,000).
//
// Lines containing "FABLES" are copied into CI's annotations ("Fables venue
// fork results"). Needs ROBINHOOD_RPC_URL (CI sets it); skips otherwise. The
// contract name starts with "RobinhoodForkTest" so CI's fork filter runs it.
// ============================================================================

interface IFablesRegistry {
    struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
    struct Entry { PoolKey key; bytes32 id; bool active; }
    function activePools() external view returns (Entry[] memory);
}

interface IStateView {
    function getSlot0(bytes32 id) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getLiquidity(bytes32 id) external view returns (uint128);
}

interface IPoolManagerLite {
    struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(IFablesRegistry.PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

interface IERC20Lite {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

contract RobinhoodForkTestFablesVenues is ForkBase {
    // Fables (src/config/robinhoodVenues.ts) and Uniswap V4 on Robinhood.
    address constant REGISTRY = 0x159A113E012593D9B3cC63ad45E30F0467e13Ef3;
    address constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    // Coins (src/config/knownAddresses.ts).
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    // Reference exchange: Uniswap V3 WETH/USDG on Robinhood (already traded live).
    address constant UNI_V3_WETH_USDG = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;

    uint8 constant KIND_V3 = 2;
    uint8 constant KIND_V4_HOOKED = 4;
    uint256 constant WETH_SIZE = 0.01 ether;

    // V4 Swap event: Swap(id, sender, amount0, amount1, sqrtPriceX96, liquidity, tick, fee).
    bytes32 constant SWAP_TOPIC = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
    uint160 constant MIN_SQRT_PLUS_1 = 4295128740;
    uint160 constant MAX_SQRT_MINUS_1 = 1461446703485210103287273052203988822378723970341;

    // Picked Fables pool (kept in storage to stay under the local-variable limit).
    IFablesRegistry.PoolKey private fKey;
    bytes32 private fId;
    bool private fNative;

    // (ForkBase already accepts native ETH, which the direct swaps below need.)

    // ---- finding the pool ---------------------------------------------------

    // Most liquid active Fables ETH/USDG (native) or WETH/USDG pool.
    function _pickPool() internal returns (bool) {
        IFablesRegistry.Entry[] memory es = IFablesRegistry(REGISTRY).activePools();
        console.log(string.concat("FABLES registry: ", vm.toString(es.length), " active pools"));
        uint256 bestLiq;
        for (uint256 i = 0; i < es.length; i++) {
            IFablesRegistry.PoolKey memory k = es[i].key;
            if (!es[i].active) continue;
            bool ethSide = k.currency0 == address(0) || k.currency0 == WETH || k.currency1 == WETH;
            bool usdgSide = k.currency0 == USDG || k.currency1 == USDG;
            if (!ethSide || !usdgSide) continue;
            uint256 liq = IStateView(STATE_VIEW).getLiquidity(es[i].id);
            if (liq > bestLiq) {
                bestLiq = liq;
                fKey = k;
                fId = es[i].id;
            }
        }
        fNative = fKey.currency0 == address(0);
        return bestLiq > 0;
    }

    // Names of the V4 hook permission bits set in a hook address (low 14 bits).
    function _flags(address h) internal pure returns (string memory s) {
        uint160 b = uint160(h);
        string[14] memory names = [
            "afterRemoveLiqReturnsDelta", "afterAddLiqReturnsDelta", "afterSwapReturnsDelta", "beforeSwapReturnsDelta",
            "afterDonate", "beforeDonate", "afterSwap", "beforeSwap", "afterRemoveLiq", "beforeRemoveLiq",
            "afterAddLiq", "beforeAddLiq", "afterInit", "beforeInit"
        ];
        for (uint256 i = 0; i < 14; i++) {
            if (b & (uint160(1) << uint160(i)) != 0) s = string.concat(s, names[i], " ");
        }
    }

    function _logPool() internal view {
        (uint160 sp, , , uint24 lpFee) = IStateView(STATE_VIEW).getSlot0(fId);
        console.log(string.concat(
            "FABLES pool id ", vm.toString(fId), " ", fNative ? "native ETH" : "WETH", "/USDG fee field ",
            vm.toString(uint256(fKey.fee)), " tickSpacing ", vm.toString(int256(fKey.tickSpacing))
        ));
        console.log(string.concat(
            "FABLES hook ", vm.toString(fKey.hooks), " bits: ", _flags(fKey.hooks), "| stored lpFee ",
            vm.toString(uint256(lpFee)), " sqrtPrice ", vm.toString(uint256(sp)),
            " liquidity ", vm.toString(uint256(IStateView(STATE_VIEW).getLiquidity(fId)))
        ));
        // Bits 0..3 are the "returns delta" permissions (hook changes amounts).
        console.log(string.concat("FABLES hook returns-delta bits: ", uint160(fKey.hooks) & 0xf == 0 ? "none (amounts untouched)" : "SET"));
    }

    // ---- executor round trips -----------------------------------------------

    function _fablesHop(address tIn, address tOut) internal view returns (ArbExecutor.Hop memory) {
        return ArbExecutor.Hop({
            kind: KIND_V4_HOOKED, pool: fKey.hooks, tokenIn: tIn, tokenOut: tOut, feeBps: 0,
            v4Fee: fKey.fee, v4TickSpacing: fKey.tickSpacing, v4Native: fNative
        });
    }

    // Intrinsic gas of a transaction carrying `data` (21,000 + 16/4 per byte).
    function _intrinsic(bytes memory data) internal pure returns (uint256 g) {
        g = 21_000;
        for (uint256 i = 0; i < data.length; i++) g += data[i] == 0 ? 4 : 16;
    }

    // One round trip, WETH -> USDG -> WETH. fablesFirst picks the order.
    // Returns true when every swap ran (profit guard stop or real profit).
    function _roundTrip(string memory label, bool fablesFirst, uint256 amt) internal returns (bool) {
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        if (fablesFirst) {
            hops[0] = _fablesHop(WETH, USDG);
            hops[1] = _hop(KIND_V3, UNI_V3_WETH_USDG, USDG, WETH, 0);
        } else {
            hops[0] = _hop(KIND_V3, UNI_V3_WETH_USDG, WETH, USDG, 0);
            hops[1] = _fablesHop(USDG, WETH);
        }
        ArbExecutor.Trade memory t =
            ArbExecutor.Trade({token: WETH, amountIn: amt, minProfit: 1, maxBlock: _l2Block(), hops: hops});
        bytes memory cd = abi.encodeWithSelector(ArbExecutor.execute.selector, t, address(0));

        // Cold start, like a real transaction.
        vm.cool(POOL_MANAGER);
        vm.cool(fKey.hooks);
        vm.cool(UNI_V3_WETH_USDG);
        vm.cool(WETH);
        vm.cool(USDG);
        vm.cool(address(exec));
        uint256 g0 = gasleft();
        (bool ok, bytes memory data) = address(exec).call(cd);
        uint256 used = g0 - gasleft();
        // The contract is the transaction's destination, so it is already warm
        // in real life: take back the 2,500 this test paid to touch it cold.
        if (used > 2_500) used -= 2_500;

        bool pass;
        if (ok) {
            console.log(string.concat("FABLES ", label, " -> executed with real profit (live arb existed at this block)"));
            pass = true;
        // forge-lint: disable-next-line(unsafe-typecast)
        } else if (data.length >= 4 && bytes4(data) == ArbExecutor.InsufficientProfit.selector) {
            console.log(string.concat("FABLES ", label, " -> all swaps executed; stopped by profit guard (expected)"));
            pass = true;
        } else {
            console.log(string.concat("FABLES ", label, " -> fables FAILED before the profit check. Revert data: ", vm.toString(data)));
        }
        if (pass) {
            console.log(string.concat(
                "GAS fables ", label, ": exec ", vm.toString(used), " + tx base/calldata ", vm.toString(_intrinsic(cd)),
                " = ", vm.toString(used + _intrinsic(cd)), " gas (L2 part, cold pools)"
            ));
        }
        return pass;
    }

    // ---- direct swaps (to read the fee really charged) ----------------------

    // PoolManager callback for this test's own direct swaps: exact-input swap,
    // pay what we owe, take what we're owed.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == POOL_MANAGER, "only PoolManager");
        (IFablesRegistry.PoolKey memory key, bool zeroForOne, uint256 amt) =
            abi.decode(data, (IFablesRegistry.PoolKey, bool, uint256));
        int256 d = IPoolManagerLite(POOL_MANAGER).swap(key, IPoolManagerLite.SwapParams({
            zeroForOne: zeroForOne,
            // forge-lint: disable-next-line(unsafe-typecast)
            amountSpecified: -int256(amt),
            sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PLUS_1 : MAX_SQRT_MINUS_1
        }), new bytes(0));
        int128 d0 = int128(d >> 128);
        int128 d1 = int128(d);
        address cIn = zeroForOne ? key.currency0 : key.currency1;
        address cOut = zeroForOne ? key.currency1 : key.currency0;
        int128 owed = zeroForOne ? d0 : d1;
        int128 got = zeroForOne ? d1 : d0;
        if (owed < 0) {
            uint256 o = uint256(uint128(-owed));
            if (cIn == address(0)) {
                IPoolManagerLite(POOL_MANAGER).settle{value: o}();
            } else {
                IPoolManagerLite(POOL_MANAGER).sync(cIn);
                IERC20Lite(cIn).transfer(POOL_MANAGER, o);
                IPoolManagerLite(POOL_MANAGER).settle();
            }
        }
        if (got > 0) IPoolManagerLite(POOL_MANAGER).take(cOut, address(this), uint256(uint128(got)));
        return abi.encode(got > 0 ? uint256(uint128(got)) : 0);
    }

    // Direct exact-input swap of `amt` on `key`; returns (ok, amount out, fee
    // in pips from the pool's Swap event). Caller funds this contract first.
    function _directSwap(IFablesRegistry.PoolKey memory key, bytes32 id, bool zeroForOne, uint256 amt)
        internal
        returns (bool ok, uint256 out, uint256 feePips)
    {
        vm.recordLogs();
        (bool s, bytes memory ret) = POOL_MANAGER.call(
            abi.encodeWithSelector(IPoolManagerLite.unlock.selector, abi.encode(key, zeroForOne, amt))
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (!s) return (false, 0, 0);
        out = abi.decode(abi.decode(ret, (bytes)), (uint256));
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == POOL_MANAGER && logs[i].topics.length > 1 && logs[i].topics[0] == SWAP_TOPIC && logs[i].topics[1] == id) {
                (, , , , , uint24 fee) = abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
                feePips = fee;
            }
        }
        ok = true;
    }

    // Sell `ethAmt` ETH for USDG on the picked pool, then sell that USDG back.
    // Logs the fee each swap paid. Runs from (and restores) the given state.
    function _feeAtSize(uint256 ethAmt) internal {
        uint256 snap = vm.snapshotState();
        bool usdgIs0 = fKey.currency0 == USDG;
        // Fund the ETH side: native ETH (this contract already has plenty in
        // a fork) or WETH.
        if (!fNative) _wrapToSelf(ethAmt);
        (bool ok1, uint256 usdgOut, uint256 fee1) = _directSwap(fKey, fId, !usdgIs0, ethAmt);
        (bool ok2, uint256 ethBack, uint256 fee2) = ok1 ? _directSwap(fKey, fId, usdgIs0, usdgOut) : (false, 0, 0);
        console.log(string.concat(
            "FABLES fee at ", vm.toString(ethAmt), " wei: ETH->USDG ", ok1 ? vm.toString(fee1) : "FAILED",
            " pips (got ", vm.toString(usdgOut), " USDG units), USDG->ETH ", ok2 ? vm.toString(fee2) : "FAILED",
            " pips (got ", vm.toString(ethBack), " wei)"
        ));
        vm.revertToState(snap);
    }

    function _wrapToSelf(uint256 amt) internal {
        vm.deal(address(this), address(this).balance + amt);
        (bool ok, ) = WETH.call{value: amt}(abi.encodeWithSignature("deposit()"));
        require(ok, "wrap failed");
    }

    // ---- tests --------------------------------------------------------------

    // Executor round trips both ways on the most liquid Fables ETH/USDG pool,
    // plus the fee really charged at that size and two bigger sizes.
    function test_fork_robinhood_fables_roundTrips() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        if (!_pickPool()) {
            console.log("FABLES: skipped, no liquid ETH/USDG or WETH/USDG pool in the registry");
            vm.skip(true);
            return;
        }
        _logPool();
        exec.setV4(POOL_MANAGER, WETH);

        uint256 snap = vm.snapshotState();
        _fundWrapped(WETH, WETH_SIZE);
        bool a = _roundTrip("uniV3 then fables", false, WETH_SIZE);
        assertEq(address(exec).balance, 0, "no ETH left in the contract");
        vm.revertToState(snap);
        _fundWrapped(WETH, WETH_SIZE);
        bool b = _roundTrip("fables then uniV3", true, WETH_SIZE);
        assertEq(address(exec).balance, 0, "no ETH left in the contract");
        vm.revertToState(snap);

        _feeAtSize(WETH_SIZE);
        _feeAtSize(0.1 ether);
        _feeAtSize(1 ether);

        console.log(string.concat("FABLES VENUE -> ", a && b ? "PASS" : "FAIL"));
        assertTrue(a, "uniV3 then fables failed");
        assertTrue(b, "fables then uniV3 failed");
    }

    // Fee survey for Worker B: first 8 active Fables pools that trade against
    // USDG and have liquidity. Direct swap of 20 USDG in, then the coins
    // received back, logging the fee each way. Information only: a pool that
    // refuses (e.g. a token with transfer rules) is logged, not failed.
    function test_fork_robinhood_fables_feeSurvey() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        IFablesRegistry.Entry[] memory es = IFablesRegistry(REGISTRY).activePools();
        uint256 done;
        for (uint256 i = 0; i < es.length && done < 8; i++) {
            IFablesRegistry.PoolKey memory k = es[i].key;
            if (!es[i].active || (k.currency0 != USDG && k.currency1 != USDG)) continue;
            if (IStateView(STATE_VIEW).getLiquidity(es[i].id) == 0) continue;
            done++;
            uint256 snap = vm.snapshotState();
            deal(USDG, address(this), 20e6);
            bool usdgIs0 = k.currency0 == USDG;
            address other = usdgIs0 ? k.currency1 : k.currency0;
            (bool ok1, uint256 out1, uint256 fee1) = _directSwap(k, es[i].id, usdgIs0, 20e6);
            (bool ok2, , uint256 fee2) = ok1 ? _directSwap(k, es[i].id, !usdgIs0, out1) : (false, 0, 0);
            console.log(string.concat(
                "FABLES fee survey USDG/", vm.toString(other), " ts ", vm.toString(int256(k.tickSpacing)),
                ": USDG->X ", ok1 ? vm.toString(fee1) : "FAILED", " pips, X->USDG ", ok2 ? vm.toString(fee2) : "FAILED", " pips"
            ));
            vm.revertToState(snap);
        }
    }
}
