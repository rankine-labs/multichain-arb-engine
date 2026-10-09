// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/Test.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";
import {ForkBase} from "./Fork.t.sol";

// ============================================================================
// ROBINHOOD FORK: CAN OUR EXISTING EXECUTOR TRADE THE 6 "COPY" EXCHANGES?
//
// Plain English:
//   Six exchanges on Robinhood Chain are copies of exchanges we already
//   trade (PancakeSwap V3, Uniswap V3, or Velodrome/Aerodrome "Slipstream").
//   If a copy behaves exactly like the original, our deployed contract can
//   already trade it, with no contract change. This test proves it, one
//   exchange per test, on a copy of the live chain:
//     1. Find a pool on that exchange (WETH/USDG first; if it has none, the
//        first well-known pair it shares with Uniswap V3).
//     2. Deploy our real ArbExecutor into the fork and give it some coins.
//     3. Round trip BOTH ways, own money (no flash loan):
//          Uniswap V3 first, then the copy exchange back, and
//          the copy exchange first, then Uniswap V3 back.
//        Both directions matter: a pool pays out and gets paid differently
//        depending on which of its two coins goes in.
//   PASS = every swap ran. Real pools are usually in balance, so the normal
//   ending is "all swaps executed, then OUR profit check said no"
//   (InsufficientProfit), exactly like the other fork tests. A real profit
//   is also a pass. Any other failure (pool refused, callback rejected,
//   coins not paid) fails the test and prints the raw error.
//
//   Gas: each run is measured with every pool and coin "cold" (first touch
//   in the transaction pays full price), like a real transaction. The number
//   is the gas used up to our profit check; a winning trade adds only the
//   final event (about 2,000 more).
//
// Lines containing "->" and "GAS " are copied into CI's fork-test annotation.
// Needs ROBINHOOD_RPC_URL (CI sets the public one); skips otherwise. The
// contract name contains "RobinhoodForkTest" so CI's filter picks it up.
// ============================================================================

interface ICopyV3Pool {
    function token0() external view returns (address);
    function liquidity() external view returns (uint128);
}

contract RobinhoodForkTestCopyVenues is ForkBase {
    // Coins (from src/config/knownAddresses.ts and robinhoodSeedPairs.ts).
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    // Our reference exchange: Uniswap V3 on Robinhood (already traded live).
    address constant UNI_V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;

    // The 6 copy exchanges (src/config/robinhoodVenues.ts).
    address constant GIGA_CL = 0xEce6eCd61177336ea6Fb9b17937AC439D85EE20B;      // PancakeSwap V3 copy
    address constant SWAPHOOD_V3 = 0x0Ec554F0BfF0Be6C99d1e95C8015bb0950f6A2C7;  // PancakeSwap V3 copy
    address constant SUSHI_V3 = 0xE51960f1B45f1C9FB6D166E6a884F866fC70433B;     // Uniswap V3 copy
    address constant UP_CL = 0x1ac9dB4a2608ba45D6127B1737949b51Bb54B7F3;        // Slipstream copy
    address constant TOPAZ_CL = 0xaa5865dC3A60b25D305226d66fd573021f0D8fFB;     // Slipstream copy
    address constant RAPHAEL_CL = 0x5481864ddd46a2D798Df0925C23B7846e776E5E3;   // Slipstream copy

    // How a factory names its pools.
    uint8 constant BY_FEE = 0;      // getPool(a, b, uint24 fee)
    uint8 constant BY_SPACING = 1;  // getPool(a, b, int24 tickSpacing)

    // Default trade sizes (shrunk for thin pools, see _amountFor).
    uint256 constant WETH_SIZE = 0.01 ether;
    uint256 constant USDG_SIZE = 20e6; // USDG has 6 decimals

    // ---- finding pools --------------------------------------------------------

    // Every fee tier / tick spacing these copies are known to use. A key the
    // factory doesn't have simply returns address(0) and is skipped.
    function _keys(uint8 style) internal pure returns (int256[] memory k) {
        if (style == BY_FEE) {
            k = new int256[](8);
            (k[0], k[1], k[2], k[3], k[4], k[5], k[6], k[7]) = (int256(50), 100, 500, 2000, 2500, 3000, 10000, 250);
        } else {
            k = new int256[](8);
            (k[0], k[1], k[2], k[3], k[4], k[5], k[6], k[7]) = (int256(1), 5, 10, 50, 60, 100, 200, 2000);
        }
    }

    function _getPool(address factory, uint8 style, address a, address b, int256 key) internal view returns (address p) {
        // The casts are safe: every key comes from _keys(), all small positive numbers.
        bytes memory q = style == BY_FEE
            // forge-lint: disable-next-line(unsafe-typecast)
            ? abi.encodeWithSignature("getPool(address,address,uint24)", a, b, uint24(uint256(key)))
            // forge-lint: disable-next-line(unsafe-typecast)
            : abi.encodeWithSignature("getPool(address,address,int24)", a, b, int24(key));
        (bool ok, bytes memory ret) = factory.staticcall(q);
        if (!ok || ret.length < 32) return address(0);
        p = abi.decode(ret, (address));
        if (p == address(0) || p.code.length == 0) return address(0);
        // Must have liquidity at the current price, or a swap goes nowhere.
        (bool okl, bytes memory l) = p.staticcall(abi.encodeWithSelector(ICopyV3Pool.liquidity.selector));
        if (!okl || l.length < 32 || abi.decode(l, (uint128)) == 0) return address(0);
    }

    function _bal(address token, address who) internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        return ok && ret.length >= 32 ? abi.decode(ret, (uint256)) : 0;
    }

    // The pool holding the most `start` coins for pair (start, mid) on a factory.
    function _deepest(address factory, uint8 style, address start, address mid) internal view returns (address best) {
        int256[] memory k = _keys(style);
        uint256 bestBal;
        for (uint256 i = 0; i < k.length; i++) {
            address p = _getPool(factory, style, start, mid, k[i]);
            if (p == address(0)) continue;
            uint256 b = _bal(start, p);
            if (b > bestBal) { bestBal = b; best = p; }
        }
    }

    // Pairs to try, best first. Start coin is always WETH or USDG (we can
    // fund those reliably). Taken from src/config/robinhoodSeedPairs.ts.
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

    // Picked route for one venue (kept in storage to stay under Solidity's
    // local-variable limit).
    address private rStart;
    address private rMid;
    address private rCopy;
    address private rRef;

    // First pair (in _pairs order) that has a live pool on BOTH the copy
    // exchange and Uniswap V3. Returns false if there is none.
    function _pickRoute(address factory, uint8 style) internal returns (bool) {
        address[2][8] memory ps = _pairs();
        for (uint256 i = 0; i < ps.length; i++) {
            address copyPool = _deepest(factory, style, ps[i][0], ps[i][1]);
            if (copyPool == address(0)) continue;
            address refPool = _deepest(UNI_V3_FACTORY, BY_FEE, ps[i][0], ps[i][1]);
            if (refPool == address(0)) continue;
            (rStart, rMid, rCopy, rRef) = (ps[i][0], ps[i][1], copyPool, refPool);
            return true;
        }
        return false;
    }

    // Trade size: the default, shrunk to 1% of the start coin in the
    // thinner of the two pools, so a thin copy pool still swaps cleanly.
    function _amountFor() internal view returns (uint256 amt) {
        amt = rStart == WETH ? WETH_SIZE : USDG_SIZE;
        uint256 a = _bal(rStart, rCopy) / 100;
        uint256 b = _bal(rStart, rRef) / 100;
        if (a < amt) amt = a;
        if (b < amt) amt = b;
    }

    // Gives the executor `amt` of the start coin.
    function _fund(uint256 amt) internal {
        if (rStart == WETH) _fundWrapped(WETH, amt);
        else deal(rStart, address(exec), amt);
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
        hops[0] = _hop(2, first, rStart, rMid, 0);
        hops[1] = _hop(2, second, rMid, rStart, 0);
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
        } else if (data.length >= 4 && bytes4(data) ==ArbExecutor.InsufficientProfit.selector) {
            console.log(string.concat(label, " -> all swaps executed; stopped by profit guard (expected)"));
            pass = true;
        } else {
            console.log(string.concat(label, " -> FAILED before the profit check. Revert data:"));
            console.logBytes(data);
        }
        if (pass) {
            console.log(string.concat(
                "GAS ", label, ": exec ", vm.toString(used), " + tx base/calldata ", vm.toString(_intrinsic(cd)),
                " = ", vm.toString(used + _intrinsic(cd)), " gas (L2 part, cold pools)"
            ));
        }
        return pass;
    }

    // Full check for one copy exchange: both directions, same starting state.
    function _checkVenue(string memory id, address factory, uint8 style) internal {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        if (!_pickRoute(factory, style)) {
            console.log(string.concat(id, ": skipped, no pool shared with Uniswap V3 on any tested pair"));
            vm.skip(true);
            return;
        }
        uint256 amt = _amountFor();
        console.log(string.concat(id, " pool ", vm.toString(rCopy), " vs Uniswap V3 pool ", vm.toString(rRef)));
        console.log(string.concat(
            id, " pair start ", vm.toString(rStart), " mid ", vm.toString(rMid), " amountIn ", vm.toString(amt),
            " (copy pool holds ", vm.toString(_bal(rStart, rCopy)), " of the start coin)"
        ));
        if (amt == 0) { console.log(string.concat(id, ": skipped, copy pool holds none of the start coin")); vm.skip(true); return; }

        uint256 snap = vm.snapshotState();
        _fund(amt);
        bool a = _roundTrip(string.concat(id, " uniV3 then copy"), rRef, rCopy, amt);
        vm.revertToState(snap);
        _fund(amt);
        bool b = _roundTrip(string.concat(id, " copy then uniV3"), rCopy, rRef, amt);
        console.log(string.concat("COPY VENUE ", id, " -> ", a && b ? "PASS" : "FAIL"));
        assertTrue(a, string.concat(id, ": uniV3 then copy failed"));
        assertTrue(b, string.concat(id, ": copy then uniV3 failed"));
    }

    // The copy pools pay out by calling back into whoever swapped. This test
    // contract never swaps directly, so these exist only to make a wrong
    // callback route fail loudly here instead of silently.
    function uniswapV3SwapCallback(int256, int256, bytes calldata) external pure { revert("test contract should not be called back"); }
    function pancakeV3SwapCallback(int256, int256, bytes calldata) external pure { revert("test contract should not be called back"); }

    // ---- one test per copy exchange -----------------------------------------

    function test_fork_robinhood_copy_gigaCl() public { _checkVenue("giga-cl", GIGA_CL, BY_FEE); }
    function test_fork_robinhood_copy_swaphoodV3() public { _checkVenue("swaphood-v3", SWAPHOOD_V3, BY_FEE); }
    function test_fork_robinhood_copy_sushiswapV3() public { _checkVenue("sushiswap-v3", SUSHI_V3, BY_FEE); }
    function test_fork_robinhood_copy_upCl() public { _checkVenue("up-cl", UP_CL, BY_SPACING); }
    function test_fork_robinhood_copy_topazCl() public { _checkVenue("topaz-cl", TOPAZ_CL, BY_SPACING); }
    function test_fork_robinhood_copy_raphaelCl() public { _checkVenue("raphael-cl", RAPHAEL_CL, BY_SPACING); }
}
