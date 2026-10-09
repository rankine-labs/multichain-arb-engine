// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/Test.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";
import {ForkBase} from "./Fork.t.sol";

// ============================================================================
// ROBINHOOD FORK: CAN THE EXECUTOR TRADE THE 2 ALGEBRA EXCHANGES?
//
// Plain English:
//   Alandale and KittenSwap on Robinhood Chain run Algebra Integral pools.
//   Their swap() takes the same inputs as Uniswap V3, but they collect
//   payment through a callback called algebraSwapCallback, which the
//   executor now answers (contracts/src/ArbExecutor.sol). This test proves
//   it against the REAL pools on a copy of the live chain, one test per
//   exchange:
//     1. Find the exchange's pool with factory.poolByPair(a, b): WETH/USDG
//        first; if it has none with liquidity, the first well-known pair it
//        shares with Uniswap V3.
//     2. Check the real pool's code: it must contain Uniswap V3's swap()
//        selector and call algebraSwapCallback (selectors found in the code).
//        Also log its current price and fee from globalState().
//     3. Deploy our ArbExecutor (this branch's code) into the fork, give it
//        some coins, and round trip BOTH ways with own money:
//          Uniswap V3 first, then the Algebra pool back, and
//          the Algebra pool first, then Uniswap V3 back.
//        Both directions matter: the pool is paid in a different coin and
//        swaps in a different direction (zeroToOne true / false), so both of
//        our price limits are checked by the real pool.
//   PASS = every swap ran. Real pools are usually in balance, so the normal
//   ending is "all swaps executed, then OUR profit check said no"
//   (InsufficientProfit). A real profit is also a pass. Any other failure
//   (pool refused, callback rejected, coins not paid, bad price limit) fails
//   the test and prints the raw error.
//
//   Gas: measured with every pool and coin "cold", like a real transaction;
//   the number is gas used up to our profit check (a win adds ~2,000).
//
// Lines containing "->" and "GAS " are copied into CI's annotations
// ("Algebra venue fork results"). Needs ROBINHOOD_RPC_URL (CI sets it);
// skips otherwise. The contract name starts with "RobinhoodForkTest" so CI's
// existing fork filter runs it.
// ============================================================================

interface IAlgebraFactory {
    function poolByPair(address a, address b) external view returns (address);
}

interface IAlgebraLikePool {
    function liquidity() external view returns (uint128);
}

contract RobinhoodForkTestAlgebraVenues is ForkBase {
    // Coins (src/config/knownAddresses.ts and robinhoodSeedPairs.ts).
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    // Reference exchange: Uniswap V3 on Robinhood (already traded live).
    address constant UNI_V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    // The Uniswap V3 WETH/USDG pool we compare against.
    address constant UNI_V3_WETH_USDG = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;

    // The 2 Algebra Integral exchanges (src/config/robinhoodVenues.ts).
    address constant ALANDALE = 0x16494A80E08Bcb9285D87b67149d7b01774D82F8;
    address constant KITTENSWAP = 0xf03875b5Ec5eAc83cab83A6c2ab17844304AA7a0;

    // Selectors we expect to find inside a real Algebra pool's code.
    bytes4 constant SWAP_SELECTOR = 0x128acb08;          // swap(address,bool,int256,uint160,bytes)
    bytes4 constant ALGEBRA_CALLBACK_SELECTOR = 0x2c8958f6; // algebraSwapCallback(int256,int256,bytes)

    // Default trade sizes (shrunk for thin pools, see _amountFor).
    uint256 constant WETH_SIZE = 0.01 ether;
    uint256 constant USDG_SIZE = 20e6; // USDG has 6 decimals

    uint8 constant KIND_V3 = 2; // Algebra pools trade as an ordinary V3 hop

    // ---- finding pools --------------------------------------------------------

    function _bal(address token, address who) internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        return ok && ret.length >= 32 ? abi.decode(ret, (uint256)) : 0;
    }

    // True if `p` is a contract with liquidity at the current price.
    function _live(address p) internal view returns (bool) {
        if (p == address(0) || p.code.length == 0) return false;
        (bool ok, bytes memory l) = p.staticcall(abi.encodeWithSelector(IAlgebraLikePool.liquidity.selector));
        return ok && l.length >= 32 && abi.decode(l, (uint128)) > 0;
    }

    // The Algebra exchange's one pool for a pair (Algebra has one pool per
    // pair, no fee tiers), or address(0) if none / no liquidity.
    function _algebraPool(address factory, address a, address b) internal view returns (address p) {
        (bool ok, bytes memory ret) = factory.staticcall(abi.encodeWithSelector(IAlgebraFactory.poolByPair.selector, a, b));
        if (!ok || ret.length < 32) return address(0);
        p = abi.decode(ret, (address));
        if (!_live(p)) return address(0);
    }

    // Deepest Uniswap V3 pool (most `start` coins held) for a pair.
    function _uniPool(address start, address mid) internal view returns (address best) {
        if ((start == WETH && mid == USDG) || (start == USDG && mid == WETH)) {
            if (_live(UNI_V3_WETH_USDG)) return UNI_V3_WETH_USDG;
        }
        uint24[5] memory fees = [uint24(100), 500, 3000, 10000, 2500];
        uint256 bestBal;
        for (uint256 i = 0; i < fees.length; i++) {
            (bool ok, bytes memory ret) =
                UNI_V3_FACTORY.staticcall(abi.encodeWithSignature("getPool(address,address,uint24)", start, mid, fees[i]));
            if (!ok || ret.length < 32) continue;
            address p = abi.decode(ret, (address));
            if (!_live(p)) continue;
            uint256 b = _bal(start, p);
            if (b > bestBal) { bestBal = b; best = p; }
        }
    }

    // Pairs to try, best first. Start coin is always WETH or USDG (we can
    // fund those reliably). Same list as ForkCopyVenues.t.sol.
    function _pairs() internal pure returns (address[2][8] memory p) {
        p[0] = [WETH, USDG];
        p[1] = [USDG, address(0x117cc2133c37B721F49dE2A7a74833232B3B4C0C)]; // SPY
        p[2] = [WETH, address(0x117cc2133c37B721F49dE2A7a74833232B3B4C0C)]; // SPY
        p[3] = [USDG, address(0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC)]; // NVDA
        p[4] = [USDG, address(0x322F0929c4625eD5bAd873c95208D54E1c003b2d)]; // TSLA
        p[5] = [WETH, address(0x020bfC650A365f8BB26819deAAbF3E21291018b4)]; // CASHCAT
        p[6] = [USDG, address(0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e)]; // GLD
        p[7] = [WETH, address(0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31)]; // VIRTUAL
    }

    // Picked route (kept in storage to stay under the local-variable limit).
    address private rStart;
    address private rMid;
    address private rAlg;
    address private rRef;

    // First pair (in _pairs order) with a live pool on BOTH the Algebra
    // exchange and Uniswap V3 (a near-empty Algebra pool is passed over).
    function _pickRoute(address factory) internal returns (bool) {
        address[2][8] memory ps = _pairs();
        for (uint256 i = 0; i < ps.length; i++) {
            address algPool = _algebraPool(factory, ps[i][0], ps[i][1]);
            if (algPool == address(0)) continue;
            // Must hold at least one default trade's worth of the start coin.
            if (_bal(ps[i][0], algPool) < (ps[i][0] == WETH ? WETH_SIZE : USDG_SIZE)) continue;
            address refPool = _uniPool(ps[i][0], ps[i][1]);
            if (refPool == address(0)) continue;
            (rStart, rMid, rAlg, rRef) = (ps[i][0], ps[i][1], algPool, refPool);
            return true;
        }
        return false;
    }

    // Trade size: the default, shrunk to 1% of the start coin in the
    // thinner of the two pools.
    function _amountFor() internal view returns (uint256 amt) {
        amt = rStart == WETH ? WETH_SIZE : USDG_SIZE;
        uint256 a = _bal(rStart, rAlg) / 100;
        uint256 b = _bal(rStart, rRef) / 100;
        if (a < amt) amt = a;
        if (b < amt) amt = b;
    }

    function _fund(uint256 amt) internal {
        if (rStart == WETH) _fundWrapped(WETH, amt);
        else deal(rStart, address(exec), amt);
    }

    // ---- checking the real pool's code --------------------------------------

    // True if `sel` appears in `code` as a PUSH4 (0x63) operand: how compiled
    // Solidity loads a function selector it calls or dispatches on.
    function _hasPush4(bytes memory code, bytes4 sel) internal pure returns (bool) {
        if (code.length < 5) return false;
        for (uint256 i = 0; i + 4 < code.length; i++) {
            if (code[i] == 0x63 && code[i + 1] == sel[0] && code[i + 2] == sel[1] && code[i + 3] == sel[2] && code[i + 4] == sel[3]) {
                return true;
            }
        }
        return false;
    }

    // Logs the pool's globalState (word 0 = sqrt price, word 2 = fee now in
    // pips) and whether its code has the swap and callback selectors.
    function _inspectPool(string memory id) internal view {
        (bool ok, bytes memory gs) = rAlg.staticcall(abi.encodeWithSignature("globalState()"));
        uint256 sqrtPrice;
        uint256 feePips;
        if (ok && gs.length >= 96) {
            assembly {
                sqrtPrice := mload(add(gs, 32))
                feePips := mload(add(gs, 96))
            }
        }
        bytes memory code = rAlg.code;
        bool hasSwap = _hasPush4(code, SWAP_SELECTOR);
        bool hasCallback = _hasPush4(code, ALGEBRA_CALLBACK_SELECTOR);
        console.log(string.concat(
            id, " pool code: swap() selector ", hasSwap ? "found" : "NOT found",
            ", algebraSwapCallback selector ", hasCallback ? "found" : "NOT found",
            ", code size ", vm.toString(code.length)
        ));
        console.log(string.concat(
            id, " pool globalState: sqrtPrice ", vm.toString(sqrtPrice), " fee now ", vm.toString(feePips), " pips"
        ));
    }

    // ---- running and measuring ----------------------------------------------

    // Intrinsic gas of a transaction carrying `data` (21,000 + 16/4 per byte).
    function _intrinsic(bytes memory data) internal pure returns (uint256 g) {
        g = 21_000;
        for (uint256 i = 0; i < data.length; i++) g += data[i] == 0 ? 4 : 16;
    }

    // One round trip. Returns true when every swap ran (profit guard stop or
    // real profit); logs the result line and the gas line.
    function _roundTrip(string memory label, address first, address second, uint256 amt) internal returns (bool) {
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = _hop(KIND_V3, first, rStart, rMid, 0);
        hops[1] = _hop(KIND_V3, second, rMid, rStart, 0);
        ArbExecutor.Trade memory t =
            ArbExecutor.Trade({token: rStart, amountIn: amt, minProfit: 1, maxBlock: _l2Block(), hops: hops});
        bytes memory cd = abi.encodeWithSelector(ArbExecutor.execute.selector, t, address(0));

        // Cold start, like a real transaction.
        vm.cool(first);
        vm.cool(second);
        vm.cool(rStart);
        vm.cool(rMid);
        vm.cool(address(exec));
        uint256 g0 = gasleft();
        (bool ok, bytes memory data) = address(exec).call(cd);
        uint256 used = g0 - gasleft();
        // The contract is the transaction's destination, so it is already warm
        // in real life: take back the 2,500 this test paid to touch it cold.
        if (used > 2_500) used -= 2_500;

        bool pass;
        if (ok) {
            console.log(string.concat(label, " -> executed with real profit (live arb existed at this block)"));
            pass = true;
        // forge-lint: disable-next-line(unsafe-typecast)
        } else if (data.length >= 4 && bytes4(data) == ArbExecutor.InsufficientProfit.selector) {
            console.log(string.concat(label, " -> all swaps executed; stopped by profit guard (expected)"));
            pass = true;
        } else {
            console.log(string.concat(label, " -> algebra FAILED before the profit check. Revert data: ", vm.toString(data)));
        }
        if (pass) {
            console.log(string.concat(
                "GAS ", label, ": exec ", vm.toString(used), " + tx base/calldata ", vm.toString(_intrinsic(cd)),
                " = ", vm.toString(used + _intrinsic(cd)), " gas (L2 part, cold pools)"
            ));
        }
        return pass;
    }

    // Full check for one Algebra exchange: both directions, same start state.
    function _checkVenue(string memory id, address factory) internal {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        if (!_pickRoute(factory)) {
            console.log(string.concat(id, ": skipped, no liquid pool shared with Uniswap V3 on any tested pair"));
            vm.skip(true);
            return;
        }
        uint256 amt = _amountFor();
        console.log(string.concat(id, " pool ", vm.toString(rAlg), " vs Uniswap V3 pool ", vm.toString(rRef)));
        console.log(string.concat(
            id, " pair start ", vm.toString(rStart), " mid ", vm.toString(rMid), " amountIn ", vm.toString(amt),
            " (pool holds ", vm.toString(_bal(rStart, rAlg)), " of the start coin)"
        ));
        _inspectPool(id);
        if (amt == 0) { console.log(string.concat(id, ": skipped, pool holds none of the start coin")); vm.skip(true); return; }

        uint256 snap = vm.snapshotState();
        _fund(amt);
        bool a = _roundTrip(string.concat(id, " uniV3 then algebra"), rRef, rAlg, amt);
        vm.revertToState(snap);
        _fund(amt);
        bool b = _roundTrip(string.concat(id, " algebra then uniV3"), rAlg, rRef, amt);
        console.log(string.concat("ALGEBRA VENUE ", id, " -> ", a && b ? "PASS" : "FAIL"));
        assertTrue(a, string.concat(id, ": uniV3 then algebra failed"));
        assertTrue(b, string.concat(id, ": algebra then uniV3 failed"));
    }

    // The pools pay out by calling back whoever swapped. This test contract
    // never swaps directly, so these exist only to make a wrong callback
    // route fail loudly here instead of silently.
    function uniswapV3SwapCallback(int256, int256, bytes calldata) external pure { revert("test contract should not be called back"); }
    function algebraSwapCallback(int256, int256, bytes calldata) external pure { revert("test contract should not be called back"); }

    // ---- one test per Algebra exchange --------------------------------------

    function test_fork_robinhood_algebra_alandale() public { _checkVenue("alandale", ALANDALE); }
    function test_fork_robinhood_algebra_kittenswap() public { _checkVenue("kittenswap-algebra", KITTENSWAP); }
}
