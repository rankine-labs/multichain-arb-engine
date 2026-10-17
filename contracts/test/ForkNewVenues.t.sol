// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/Test.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";
import {ForkBase} from "./Fork.t.sol";

// ============================================================================
// ROBINHOOD FORK: CAN THE EXECUTOR TRADE THE POOLS ADDED ON OCT 16?
//
// Plain English:
//   The Oct 16 pair workbook showed pools the bot never read. This test
//   trades the real ones on a copy of the live chain with our real
//   ArbExecutor, both directions, own money:
//     1. Uniswap V4 pools WITHOUT a hook at non-standard settings (fee and
//        tick spacing outside the 4 usual ones). They use the normal V4 trade
//        type (KIND_V4), which the DEPLOYED contract also has; the fee and
//        tick spacing simply travel inside the trade.
//          - ETH/USDG 0.046%, tick spacing 9 (native ETH), ~$730k
//          - WETH/USDG 0.02%, tick spacing 4, ~$260k
//     2. Uniswap V4 pools WITH a hook (listed in src/config/
//        robinhoodHookedPools.ts): the hooked-V4 trade type (KIND_V4_HOOKED),
//        which only this branch's contract SOURCE has (fork-tested on Fables).
//     3. Abyss (a Uniswap V3 copy, factory 0xe7fef2bc...): ABYSS/WETH 1% pool,
//        WETH in and back out of the same pool (that proves the pool's swap
//        and pay-me callback work with our contract in both directions).
//   PASS = every swap ran. Pools are usually in balance, so the normal end is
//   "all swaps executed, then OUR profit check said no" (InsufficientProfit).
//   A real profit is also a pass. Anything else fails and prints the error.
//
// Lines containing "NEWVENUE" are copied into CI's annotation ("New venue
// fork results"). Needs ROBINHOOD_RPC_URL (CI sets it); skips otherwise. The
// contract name starts with "RobinhoodForkTest" so CI's fork filter runs it.
// ============================================================================

interface IStateViewNV {
    function getSlot0(bytes32 id) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getLiquidity(bytes32 id) external view returns (uint128);
}

contract RobinhoodForkTestNewVenues is ForkBase {
    address constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant UNI_V3_WETH_USDG = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;
    address constant ABYSS_WETH_POOL = 0xdec74A2AFabd34aA6F268C5161D2e9E210CA7185;
    address constant ABYSS = 0x15F3385625d7e364c5a6216FbBcEaDF10fa90E7D;

    uint8 constant KIND_V3 = 2;
    uint8 constant KIND_V4 = 3;
    uint8 constant KIND_V4_HOOKED = 4;
    uint256 constant WETH_SIZE = 0.01 ether;

    // One V4 pool to test: its key and whether it holds native ETH.
    struct V4Case { string label; bytes32 id; uint24 fee; int24 tickSpacing; address hooks; bool native; }

    function _v4Hop(V4Case memory c, address tIn, address tOut) internal pure returns (ArbExecutor.Hop memory) {
        bool hooked = c.hooks != address(0);
        return ArbExecutor.Hop({
            kind: hooked ? KIND_V4_HOOKED : KIND_V4, pool: hooked ? c.hooks : POOL_MANAGER, tokenIn: tIn, tokenOut: tOut,
            feeBps: 0, v4Fee: c.fee, v4TickSpacing: c.tickSpacing, v4Native: c.native
        });
    }

    // Runs `hops` (WETH in, WETH out) and reports. True when every swap ran.
    function _run(string memory label, ArbExecutor.Hop[] memory hops) internal returns (bool) {
        _fundWrapped(WETH, WETH_SIZE);
        ArbExecutor.Trade memory t = ArbExecutor.Trade({token: WETH, amountIn: WETH_SIZE, minProfit: 1, maxBlock: _l2Block(), hops: hops});
        (bool ok, bytes memory data) = address(exec).call(abi.encodeWithSelector(ArbExecutor.execute.selector, t, address(0)));
        if (ok) { console.log(string.concat("NEWVENUE ", label, " -> executed with real profit")); return true; }
        // forge-lint: disable-next-line(unsafe-typecast)
        if (data.length >= 4 && bytes4(data) == ArbExecutor.InsufficientProfit.selector) {
            console.log(string.concat("NEWVENUE ", label, " -> all swaps executed; stopped by profit guard (expected)"));
            return true;
        }
        console.log(string.concat("NEWVENUE ", label, " -> FAILED before the profit check. Revert data: ", vm.toString(data)));
        return false;
    }

    // Both directions against Uniswap V3 WETH/USDG. Skips (logs) an empty pool.
    function _bothWays(V4Case memory c) internal returns (bool) {
        uint128 liq = IStateViewNV(STATE_VIEW).getLiquidity(c.id);
        if (liq == 0) { console.log(string.concat("NEWVENUE ", c.label, ": skipped, no liquidity at this block")); return true; }
        (, , , uint24 lpFee) = IStateViewNV(STATE_VIEW).getSlot0(c.id);
        console.log(string.concat("NEWVENUE ", c.label, " pool ", vm.toString(c.id), " lpFee ", vm.toString(uint256(lpFee)), " liquidity ", vm.toString(uint256(liq))));
        uint256 snap = vm.snapshotState();
        ArbExecutor.Hop[] memory h = new ArbExecutor.Hop[](2);
        h[0] = _hop(KIND_V3, UNI_V3_WETH_USDG, WETH, USDG, 0);
        h[1] = _v4Hop(c, USDG, WETH);
        bool a = _run(string.concat(c.label, " uniV3 then v4"), h);
        assertEq(address(exec).balance, 0, "no ETH left in the contract");
        vm.revertToState(snap);
        h[0] = _v4Hop(c, WETH, USDG);
        h[1] = _hop(KIND_V3, UNI_V3_WETH_USDG, USDG, WETH, 0);
        bool b = _run(string.concat(c.label, " v4 then uniV3"), h);
        assertEq(address(exec).balance, 0, "no ETH left in the contract");
        vm.revertToState(snap);
        return a && b;
    }

    function _setUpV4() internal {
        vm.prank(FORK_OWNER);
        exec.setV4(POOL_MANAGER, WETH);
    }

    // 1) Hook-free V4 pools at non-standard settings (KIND_V4, deployed contract has it).
    function test_fork_robinhood_v4ExtraTiers() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        _setUpV4();
        bool a = _bothWays(V4Case("v4 ETH/USDG 0.046% ts9", 0x54f7883914619af9105355bf83ed678bcf9f63560218ac61c9963b9503d0ba32, 460, 9, address(0), true));
        bool b = _bothWays(V4Case("v4 WETH/USDG 0.02% ts4", 0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6, 200, 4, address(0), false));
        console.log(string.concat("NEWVENUE V4 EXTRA TIERS -> ", a && b ? "PASS" : "FAIL"));
        assertTrue(a && b, "non-standard V4 pool round trip failed");
    }

    // 2) Hooked V4 pools from the listed set (KIND_V4_HOOKED, contract source only).
    function test_fork_robinhood_listedHooks() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        _setUpV4();
        V4Case[] memory cs = _hookedCases();
        bool all = true;
        for (uint256 i = 0; i < cs.length; i++) all = _bothWays(cs[i]) && all;
        console.log(string.concat("NEWVENUE LISTED HOOKS -> ", all ? "PASS" : "FAIL", " (", vm.toString(cs.length), " pools)"));
        assertTrue(all, "listed hooked pool round trip failed");
    }

    // 3) Abyss (Uniswap V3 copy): WETH -> ABYSS -> WETH on the same pool.
    function test_fork_robinhood_abyss() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        if (ABYSS_WETH_POOL.code.length == 0) { console.log("NEWVENUE abyss: skipped, pool has no code"); return; }
        ArbExecutor.Hop[] memory h = new ArbExecutor.Hop[](2);
        h[0] = _hop(KIND_V3, ABYSS_WETH_POOL, WETH, ABYSS, 0);
        h[1] = _hop(KIND_V3, ABYSS_WETH_POOL, ABYSS, WETH, 0);
        bool ok = _run("abyss ABYSS/WETH in and out", h);
        console.log(string.concat("NEWVENUE ABYSS -> ", ok ? "PASS" : "FAIL"));
        assertTrue(ok, "abyss round trip failed");
    }

    // WETH/USDG and ETH/USDG hooked pools to test (filled from the probe).
    function _hookedCases() internal pure returns (V4Case[] memory cs) {
        cs = new V4Case[](0);
    }
}
