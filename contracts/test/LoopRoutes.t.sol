// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";
import {
    MockERC20,
    MockV2Pair,
    MockSolidlyPair,
    MockV3Pool,
    MockAlgebraPool,
    MockAavePool
} from "./mocks/Mocks.sol";
import {MockV4PoolManager} from "./V4.t.sol";

// ============================================================================
// LOOP ROUTES -- ArbExecutor with 3, 4 and 5 hops
//
// Plain English:
//   Every other contract test uses 2 hops (buy on A, sell on B). The loop
//   trader (src/core/loopTrader.ts) sends routes of 3 to 5 pools, e.g.
//   WETH -> DJT -> PONS -> USDG -> WETH. These tests prove the contract runs
//   such loops correctly:
//     - each hop spends exactly what the previous hop delivered (no coin is
//       left behind in the middle of the loop)
//     - every pool type works in any position (V2, Solidly, V3, Algebra, V4)
//     - own money, Aave flash loans and V3 pool flash loans all work
//     - a route that does not come back to its start coin is refused
//     - a losing loop is stopped by the profit check
//     - a middle pool paying less than expected only shrinks the result
//     - the V3 payment cap (never pay a pool more than this hop's input)
//       is set fresh on every hop, not carried over from an earlier one
//   It also logs the gas each loop length costs ("GAS loop ...").
//
// Market used by every test (all coins have 18 decimals in the mocks):
//   fair prices in USDC: WETH 3,000  WBTC 60,000  LINK 15  DAI 1
//   The LAST pool of each loop pays about 6% over fair, so the loop
//   USDC -> ... -> USDC ends with more USDC than it started with.
// ============================================================================

// A V3-style pool we can make misbehave, to test the contract's reaction:
//   payoutBps: share of the fair output it really pays (10,000 = honest)
//   extra:     how much MORE than the swap input it asks for in the callback
contract ConfigurableV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint256 public immutable priceNum; // price of token0 in token1, as num/den
    uint256 public immutable priceDen;
    uint256 public payoutBps = 10_000;
    uint256 public extra;

    constructor(address a, address b, uint256 num, uint256 den) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        if (a < b) { priceNum = num; priceDen = den; } else { priceNum = den; priceDen = num; }
    }

    function setPayoutBps(uint256 bps) external { payoutBps = bps; }
    function setExtra(uint256 e) external { extra = e; }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 amountIn = uint256(amountSpecified);
        address tokenIn = zeroForOne ? token0 : token1;
        uint256 owed = amountIn + extra;
        uint256 before = MockERC20(tokenIn).balanceOf(address(this));
        uint256 amountOut = _payOut(recipient, zeroForOne, amountIn);
        (amount0, amount1) = zeroForOne
            ? (int256(owed), -int256(amountOut))
            : (-int256(amountOut), int256(owed));
        ArbExecutor(payable(msg.sender)).uniswapV3SwapCallback(amount0, amount1, data);
        require(MockERC20(tokenIn).balanceOf(address(this)) >= before + owed, "IIA");
    }

    // Sends the output first (like a real V3 pool): 0.30% fee, then the "short pay".
    function _payOut(address recipient, bool zeroForOne, uint256 amountIn) private returns (uint256 amountOut) {
        uint256 fair = zeroForOne ? amountIn * priceNum / priceDen : amountIn * priceDen / priceNum;
        amountOut = fair * 9_970 / 10_000 * payoutBps / 10_000;
        MockERC20(zeroForOne ? token1 : token0).transfer(recipient, amountOut);
    }
}

contract LoopRoutesTest is Test {
    ArbExecutor exec;
    MockERC20 usdc;
    MockERC20 weth;
    MockERC20 wbtc;
    MockERC20 link;
    MockERC20 dai;

    // Fair-price V2 pools along the chain USDC -> WETH -> WBTC -> LINK -> DAI.
    MockV2Pair usdcWethV2;
    MockV2Pair wethWbtcV2;
    MockV2Pair wbtcLinkV2;
    MockV2Pair linkDaiV2;
    // "Dear" closing pools: each pays ~6% over fair for coming back to USDC.
    MockV2Pair wethUsdcDear;
    MockV2Pair wbtcUsdcDear;
    MockV2Pair linkUsdcDear;
    MockV2Pair daiUsdcDear;
    // Other pool types (fair price).
    MockV3Pool wbtcWethV3;            // 1 WBTC = 20 WETH, Uniswap V3 callback
    MockV3Pool usdcWethV3;            // 1 WETH = 3,000 USDC, Uniswap V3 callback
    MockSolidlyPair wbtcLinkSolidly;  // 1 WBTC = 4,000 LINK
    MockAlgebraPool linkDaiAlgebra;   // 1 LINK = 15 DAI, 0.05% fee
    MockV4PoolManager pm;             // DAI/USDC hookless V4 pool, 1 DAI = 1.06 USDC (dear)
    // Lenders (never a pool in the route).
    MockV3Pool usdcDaiLender;         // V3 pool lending USDC (0.05% flash fee)
    MockAavePool aave;

    address bot = makeAddr("bot");
    uint256 constant E18 = 1e18;
    uint256 constant TRADE = 30_000 * E18; // 30k USDC into every loop
    uint24 constant V4_FEE = 3000;
    int24 constant V4_SPACING = 60;

    function setUp() public {
        usdc = new MockERC20("USDC", 18);
        weth = new MockERC20("WETH", 18);
        wbtc = new MockERC20("WBTC", 18);
        link = new MockERC20("LINK", 18);
        dai = new MockERC20("DAI", 18);
        exec = new ArbExecutor(bot); // this test contract is the owner

        // Fair V2 pools (deep enough that a 30k trade moves them ~1%).
        usdcWethV2 = _v2(usdc, weth, 3_000_000 * E18, 1_000 * E18);
        wethWbtcV2 = _v2(weth, wbtc, 20_000 * E18, 1_000 * E18);
        wbtcLinkV2 = _v2(wbtc, link, 100 * E18, 400_000 * E18);
        linkDaiV2 = _v2(link, dai, 200_000 * E18, 3_000_000 * E18);
        // Dear closers: 6% over fair.
        wethUsdcDear = _v2(weth, usdc, 1_000 * E18, 3_180_000 * E18);
        wbtcUsdcDear = _v2(wbtc, usdc, 100 * E18, 6_360_000 * E18);
        linkUsdcDear = _v2(link, usdc, 200_000 * E18, 3_180_000 * E18);
        daiUsdcDear = _v2(dai, usdc, 3_000_000 * E18, 3_180_000 * E18);

        // V3: fixed-price pools. Price is "first coin in second coin".
        wbtcWethV3 = new MockV3Pool(address(wbtc), address(weth), 20, 1, false);
        wbtc.mint(address(wbtcWethV3), 1_000 * E18);
        weth.mint(address(wbtcWethV3), 20_000 * E18);
        usdcWethV3 = new MockV3Pool(address(weth), address(usdc), 3_000, 1, false);
        weth.mint(address(usdcWethV3), 1_000 * E18);
        usdc.mint(address(usdcWethV3), 3_000_000 * E18);

        // Solidly volatile pair.
        wbtcLinkSolidly = new MockSolidlyPair(address(wbtc), address(link));
        wbtc.mint(address(wbtcLinkSolidly), 100 * E18);
        link.mint(address(wbtcLinkSolidly), 400_000 * E18);
        wbtcLinkSolidly.sync();

        // Algebra Integral pool: 1 LINK = 15 DAI, 0.05% fee.
        linkDaiAlgebra = new MockAlgebraPool(address(link), address(dai), 15, 1, 500);
        link.mint(address(linkDaiAlgebra), 200_000 * E18);
        dai.mint(address(linkDaiAlgebra), 3_000_000 * E18);

        // Uniswap V4 PoolManager with one hookless DAI/USDC pool at 1.06.
        pm = new MockV4PoolManager();
        (address c0, address c1) = address(dai) < address(usdc) ? (address(dai), address(usdc)) : (address(usdc), address(dai));
        // price of currency0 in currency1
        (uint256 num, uint256 den) = c0 == address(dai) ? (uint256(106), uint256(100)) : (uint256(100), uint256(106));
        pm.addPool(MockV4PoolManager.PoolKey(c0, c1, V4_FEE, V4_SPACING, address(0)), num, den);
        usdc.mint(address(pm), 5_000_000 * E18);
        dai.mint(address(pm), 5_000_000 * E18);
        // V4 needs a non-zero WETH setting; no native-ETH pool is used here.
        exec.setV4(address(pm), address(weth));

        // Lenders.
        usdcDaiLender = new MockV3Pool(address(usdc), address(dai), 1, 1, false);
        usdc.mint(address(usdcDaiLender), 1_000_000 * E18);
        dai.mint(address(usdcDaiLender), 1_000_000 * E18);
        exec.setFlashPool(address(usdcDaiLender), true);
        aave = new MockAavePool();
        usdc.mint(address(aave), 1_000_000 * E18);
        exec.setFlashPool(address(aave), true);
    }

    // ---- helpers -----------------------------------------------------------

    function _v2(MockERC20 a, MockERC20 b, uint256 amtA, uint256 amtB) internal returns (MockV2Pair p) {
        p = new MockV2Pair(address(a), address(b), 30);
        a.mint(address(p), amtA);
        b.mint(address(p), amtB);
        p.sync();
    }

    function _hop(uint8 kind, address pool, MockERC20 tIn, MockERC20 tOut) internal pure returns (ArbExecutor.Hop memory) {
        return ArbExecutor.Hop({
            kind: kind, pool: pool, tokenIn: address(tIn), tokenOut: address(tOut),
            feeBps: kind == 0 ? 30 : 0, v4Fee: 0, v4TickSpacing: 0, v4Native: false
        });
    }

    function _v4Hop(MockERC20 tIn, MockERC20 tOut) internal view returns (ArbExecutor.Hop memory) {
        return ArbExecutor.Hop({
            kind: 3, pool: address(pm), tokenIn: address(tIn), tokenOut: address(tOut),
            feeBps: 0, v4Fee: V4_FEE, v4TickSpacing: V4_SPACING, v4Native: false
        });
    }

    function _trade(ArbExecutor.Hop[] memory hops, uint256 minProfit) internal view returns (ArbExecutor.Trade memory) {
        return ArbExecutor.Trade({token: address(usdc), amountIn: TRADE, minProfit: minProfit, maxBlock: block.number, hops: hops});
    }

    // V2-only loop of n hops along USDC -> WETH -> WBTC -> LINK -> DAI, closed
    // by that coin's dear pool back to USDC. n = 2..5.
    function _v2Loop(uint256 n) internal view returns (ArbExecutor.Hop[] memory hops) {
        MockERC20[5] memory coins = [usdc, weth, wbtc, link, dai];
        MockV2Pair[4] memory along = [usdcWethV2, wethWbtcV2, wbtcLinkV2, linkDaiV2];
        MockV2Pair[4] memory closer = [wethUsdcDear, wbtcUsdcDear, linkUsdcDear, daiUsdcDear];
        hops = new ArbExecutor.Hop[](n);
        for (uint256 i = 0; i < n - 1; i++) hops[i] = _hop(0, address(along[i]), coins[i], coins[i + 1]);
        hops[n - 1] = _hop(0, address(closer[n - 2]), coins[n - 1], usdc);
    }

    // 4 hops, four pool types: USDC -V2-> WETH -V3-> WBTC -Solidly-> LINK -V2(dear)-> USDC
    function _mixed4(address v3Pool) internal view returns (ArbExecutor.Hop[] memory hops) {
        hops = new ArbExecutor.Hop[](4);
        hops[0] = _hop(0, address(usdcWethV2), usdc, weth);
        hops[1] = _hop(2, v3Pool, weth, wbtc);
        hops[2] = _hop(1, address(wbtcLinkSolidly), wbtc, link);
        hops[3] = _hop(0, address(linkUsdcDear), link, usdc);
    }

    // 5 hops, five pool types:
    // USDC -V2-> WETH -V3-> WBTC -Solidly-> LINK -Algebra-> DAI -V4(dear)-> USDC
    function _mixed5() internal view returns (ArbExecutor.Hop[] memory hops) {
        hops = new ArbExecutor.Hop[](5);
        hops[0] = _hop(0, address(usdcWethV2), usdc, weth);
        hops[1] = _hop(2, address(wbtcWethV3), weth, wbtc);
        hops[2] = _hop(1, address(wbtcLinkSolidly), wbtc, link);
        hops[3] = _hop(2, address(linkDaiAlgebra), link, dai);
        hops[4] = _v4Hop(dai, usdc);
    }

    // Nothing may be left over in the middle coins: each hop spent exactly
    // what the hop before it delivered.
    function _assertNoLeftovers(string memory label) internal view {
        assertEq(weth.balanceOf(address(exec)), 0, string.concat(label, ": no WETH left mid-loop"));
        assertEq(wbtc.balanceOf(address(exec)), 0, string.concat(label, ": no WBTC left mid-loop"));
        assertEq(link.balanceOf(address(exec)), 0, string.concat(label, ": no LINK left mid-loop"));
        assertEq(dai.balanceOf(address(exec)), 0, string.concat(label, ": no DAI left mid-loop"));
    }

    // Runs an own-money trade as the bot; returns profit and gas used.
    function _runOwn(ArbExecutor.Trade memory t) internal returns (uint256 profit, uint256 gasUsed) {
        usdc.mint(address(exec), t.amountIn);
        uint256 before = usdc.balanceOf(address(exec));
        vm.prank(bot);
        uint256 g = gasleft();
        exec.execute(t, address(0));
        gasUsed = g - gasleft();
        profit = usdc.balanceOf(address(exec)) - before;
    }

    // ---- happy paths: 3, 4, 5 hops ----------------------------------------

    function test_loop3_v2Only_ownMoney_makesProfit() public {
        (uint256 profit, ) = _runOwn(_trade(_v2Loop(3), 100 * E18));
        assertGt(profit, 100 * E18, "3-hop V2 loop: profit over the 100 USDC floor");
        _assertNoLeftovers("3-hop V2");
        console.log("profit USDC (3-hop V2):", profit / E18);
    }

    function test_loop4_mixedVenues_V2_V3_Solidly_V2() public {
        (uint256 profit, ) = _runOwn(_trade(_mixed4(address(wbtcWethV3)), 100 * E18));
        assertGt(profit, 100 * E18, "4-hop mixed loop: profit over the floor");
        _assertNoLeftovers("4-hop mixed");
        // The V3 pool was paid in full (it checks that itself) and owes nothing.
        console.log("profit USDC (4-hop V2/V3/Solidly/V2):", profit / E18);
    }

    function test_loop5_fiveVenues_V2_V3_Solidly_Algebra_V4() public {
        (uint256 profit, ) = _runOwn(_trade(_mixed5(), 100 * E18));
        assertGt(profit, 100 * E18, "5-hop loop across all five pool types: profit over the floor");
        _assertNoLeftovers("5-hop mixed");
        assertTrue(pm.settledAll(address(dai), address(usdc)), "V4 PoolManager fully settled");
        console.log("profit USDC (5-hop V2/V3/Solidly/Algebra/V4):", profit / E18);
    }

    function test_loop5_v2Only_ownMoney_makesProfit() public {
        (uint256 profit, ) = _runOwn(_trade(_v2Loop(5), 100 * E18));
        assertGt(profit, 100 * E18, "5-hop V2 loop: profit over the floor");
        _assertNoLeftovers("5-hop V2");
    }

    // The same coin may appear twice in a loop (e.g. WETH -> USDC -> WETH ->
    // USDC -> WETH through four different pools). Allowed by the contract;
    // the fork test uses this shape on real WETH/USDG pools.
    function test_loop4_sameCoinsTwice_runs() public {
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](4);
        hops[0] = _hop(0, address(usdcWethV2), usdc, weth);    // buy WETH fair
        hops[1] = _hop(0, address(wethUsdcDear), weth, usdc);  // sell WETH dear
        hops[2] = _hop(2, address(usdcWethV3), usdc, weth);    // buy WETH fair (V3)
        hops[3] = _hop(0, address(wethUsdcDear), weth, usdc);  // sell dear again (pool reused)
        (uint256 profit, ) = _runOwn(_trade(hops, 100 * E18));
        assertGt(profit, 100 * E18, "4-hop loop visiting USDC/WETH twice: profit");
        _assertNoLeftovers("4-hop repeat coins");
    }

    // ---- flash funding on multi-hop ---------------------------------------

    function test_loop4_v3FlashLoan_zeroCapital() public {
        uint256 lenderBefore = usdc.balanceOf(address(usdcDaiLender));
        ArbExecutor.Trade memory t = _trade(_mixed4(address(wbtcWethV3)), 100 * E18);
        vm.prank(bot);
        exec.executeWithV3Flash(t, address(usdcDaiLender));
        // Contract started with 0 USDC: all it holds now is profit after the fee.
        assertGt(usdc.balanceOf(address(exec)), 100 * E18, "4-hop loop on a V3 flash loan: profit with no capital");
        uint256 fee = (TRADE * 5 + 9_999) / 10_000;
        assertEq(usdc.balanceOf(address(usdcDaiLender)), lenderBefore + fee, "lender got loan + 0.05% fee back");
        _assertNoLeftovers("4-hop V3 flash");
    }

    function test_loop5_v3FlashLoan_zeroCapital() public {
        ArbExecutor.Trade memory t = _trade(_mixed5(), 100 * E18);
        vm.prank(bot);
        exec.executeWithV3Flash(t, address(usdcDaiLender));
        assertGt(usdc.balanceOf(address(exec)), 100 * E18, "5-hop loop on a V3 flash loan: profit with no capital");
        _assertNoLeftovers("5-hop V3 flash");
    }

    function test_loop3_aaveFlashLoan_zeroCapital() public {
        uint256 aaveBefore = usdc.balanceOf(address(aave));
        ArbExecutor.Trade memory t = _trade(_v2Loop(3), 100 * E18);
        vm.prank(bot);
        exec.execute(t, address(aave));
        assertGt(usdc.balanceOf(address(exec)), 100 * E18, "3-hop loop on an Aave flash loan: profit");
        assertEq(usdc.balanceOf(address(aave)), aaveBefore + TRADE * 5 / 10_000, "Aave repaid with premium");
        assertEq(usdc.allowance(address(exec), address(aave)), 0, "no allowance left behind");
    }

    // The lender is refused if it is ANY hop of the loop, not just the first two.
    function test_loop4_v3Flash_lenderAsLaterHop_refused() public {
        // Hop 3 (index 2) is replaced by a V3 pool that is also the lender.
        ArbExecutor.Hop[] memory hops = _mixed4(address(wbtcWethV3));
        hops[3] = _hop(2, address(usdcDaiLender), link, usdc);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.BadRoute.selector);
        exec.executeWithV3Flash(_trade(hops, 1), address(usdcDaiLender));
    }

    // ---- route checks -----------------------------------------------------

    // Last coin is not the first coin: USDC -> WETH -> WBTC -> WETH.
    function test_loop3_notClosing_revertsBadRoute() public {
        usdc.mint(address(exec), TRADE);
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](3);
        hops[0] = _hop(0, address(usdcWethV2), usdc, weth);
        hops[1] = _hop(0, address(wethWbtcV2), weth, wbtc);
        hops[2] = _hop(2, address(wbtcWethV3), wbtc, weth);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.BadRoute.selector);
        exec.execute(_trade(hops, 1), address(0));
    }

    // Starts and ends right, but the middle does not chain (hop 2 gives WBTC,
    // hop 3 expects LINK... hop 3 is fed the wrong coin).
    function test_loop4_brokenMiddleChain_revertsBadRoute() public {
        usdc.mint(address(exec), TRADE);
        ArbExecutor.Hop[] memory hops = _mixed4(address(wbtcWethV3));
        hops[2] = _hop(0, address(linkDaiV2), link, dai);       // expects LINK, previous hop gives WBTC
        hops[3] = _hop(0, address(daiUsdcDear), dai, usdc);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.BadRoute.selector);
        exec.execute(_trade(hops, 1), address(0));
    }

    // A hop in the middle of a 5-hop loop that "swaps" a coin into itself.
    function test_loop5_hopSameCoinInAndOut_revertsBadRoute() public {
        usdc.mint(address(exec), TRADE);
        ArbExecutor.Hop[] memory hops = _mixed5();
        hops[2] = _hop(1, address(wbtcLinkSolidly), wbtc, wbtc);
        hops[3] = _hop(2, address(wbtcWethV3), wbtc, dai); // keep the chain intact around it
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.BadRoute.selector);
        exec.execute(_trade(hops, 1), address(0));
    }

    // Same check on the flash entry point.
    function test_loop4_notClosing_v3Flash_revertsBadRoute() public {
        ArbExecutor.Hop[] memory hops = _mixed4(address(wbtcWethV3));
        hops[3] = _hop(0, address(linkDaiV2), link, dai); // ends in DAI, started in USDC
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.BadRoute.selector);
        exec.executeWithV3Flash(_trade(hops, 1), address(usdcDaiLender));
    }

    // ---- profit checks ----------------------------------------------------

    // The 3-hop loop backwards (buy WBTC on the dear pool) loses money.
    function test_loop3_unprofitable_revertsInsufficientProfit() public {
        usdc.mint(address(exec), TRADE);
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](3);
        hops[0] = _hop(0, address(wbtcUsdcDear), usdc, wbtc);
        hops[1] = _hop(0, address(wethWbtcV2), wbtc, weth);
        hops[2] = _hop(0, address(usdcWethV2), weth, usdc);
        vm.prank(bot);
        // A loss shows as profit 0 against the 1-wei floor.
        vm.expectRevert(abi.encodeWithSelector(ArbExecutor.InsufficientProfit.selector, 0, 1));
        exec.execute(_trade(hops, 1), address(0));
        assertEq(usdc.balanceOf(address(exec)), TRADE, "nothing moved after the revert");
    }

    // A profitable 5-hop loop, but the floor is set above what it makes.
    function test_loop5_profitBelowFloor_revertsInsufficientProfit() public {
        uint256 snap = vm.snapshotState();
        (uint256 exact, ) = _runOwn(_trade(_mixed5(), 1));
        vm.revertToState(snap);
        usdc.mint(address(exec), TRADE);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(ArbExecutor.InsufficientProfit.selector, exact, exact + 1));
        exec.execute(_trade(_mixed5(), exact + 1), address(0));
    }

    // A losing 4-hop loop on a V3 flash loan: the lender is never short.
    function test_loop4_v3Flash_unprofitable_reverts_lenderWhole() public {
        uint256 lenderBefore = usdc.balanceOf(address(usdcDaiLender));
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](4);
        hops[0] = _hop(0, address(linkUsdcDear), usdc, link);   // buy LINK dear = loss
        hops[1] = _hop(1, address(wbtcLinkSolidly), link, wbtc);
        hops[2] = _hop(2, address(wbtcWethV3), wbtc, weth);
        hops[3] = _hop(0, address(usdcWethV2), weth, usdc);
        vm.prank(bot);
        vm.expectRevert(); // fails repaying the loan (contract has no float)
        exec.executeWithV3Flash(_trade(hops, 1), address(usdcDaiLender));
        assertEq(usdc.balanceOf(address(usdcDaiLender)), lenderBefore, "lender untouched");
    }

    // ---- a middle pool paying less than expected ---------------------------

    // Middle V3 pool (hop 2 of 4) pays only 99% of its fair output. The next
    // hop must spend exactly what really arrived (not the quoted amount), so
    // the loop still completes, with a smaller profit, and nothing is left over.
    function test_loop4_middleHopPaysLess_nextHopUsesWhatArrived() public {
        ConfigurableV3Pool honest = _cfgPool();
        uint256 snap = vm.snapshotState();
        (uint256 honestProfit, ) = _runOwn(_trade(_mixed4(address(honest)), 1));
        vm.revertToState(snap);

        ConfigurableV3Pool stingy = _cfgPool();
        stingy.setPayoutBps(9_900);
        (uint256 stingyProfit, ) = _runOwn(_trade(_mixed4(address(stingy)), 1));
        assertGt(stingyProfit, 0, "short-paying middle hop: loop still completes");
        assertLt(stingyProfit, honestProfit, "short-paying middle hop: profit is smaller");
        _assertNoLeftovers("4-hop stingy middle");
    }

    // Middle pool pays half: the loop now loses, the profit check stops it.
    function test_loop4_middleHopPaysHalf_revertsInsufficientProfit() public {
        ConfigurableV3Pool stingy = _cfgPool();
        stingy.setPayoutBps(5_000);
        usdc.mint(address(exec), TRADE);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(ArbExecutor.InsufficientProfit.selector, 0, 1));
        exec.execute(_trade(_mixed4(address(stingy)), 1), address(0));
    }

    // Middle pool pays nothing at all: refused right at that hop.
    function test_loop4_middleHopPaysNothing_revertsZeroAmount() public {
        ConfigurableV3Pool stingy = _cfgPool();
        stingy.setPayoutBps(0);
        usdc.mint(address(exec), TRADE);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.ZeroAmount.selector);
        exec.execute(_trade(_mixed4(address(stingy)), 1), address(0));
    }

    // ---- V3 payment cap (activeV3MaxIn) on multi-hop -----------------------

    // Hop 1 is a V3 swap with a BIG input (30,000 USDC). Hop 2 is a V3 pool
    // that asks for 1 wei more than its own, much smaller, input (~10 WETH).
    // The contract holds 50 WETH of old profit, so without a fresh per-hop
    // cap the extra wei could be paid from it. Must be refused at payment.
    function test_loop4_paymentCap_resetPerHop_overchargeRefused() public {
        ConfigurableV3Pool greedy = _cfgPool();
        greedy.setExtra(1);
        weth.mint(address(exec), 50 * E18);
        usdc.mint(address(exec), TRADE);
        ArbExecutor.Hop[] memory hops = _mixed4(address(greedy));
        hops[0] = _hop(2, address(usdcWethV3), usdc, weth); // V3 hop with the big input first
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.BadRoute.selector);
        exec.execute(_trade(hops, 1), address(0));
        assertEq(weth.balanceOf(address(exec)), 50 * E18, "stored WETH untouched");
    }

    // Control for the test above: the same route with an honest pool runs,
    // so the refusal really is the payment cap and not something else.
    function test_loop4_paymentCap_exactPaymentAccepted() public {
        ConfigurableV3Pool honest = _cfgPool();
        weth.mint(address(exec), 50 * E18);
        ArbExecutor.Hop[] memory hops = _mixed4(address(honest));
        hops[0] = _hop(2, address(usdcWethV3), usdc, weth);
        (uint256 profit, ) = _runOwn(_trade(hops, 1));
        assertGt(profit, 0, "honest V3 pool after a V3 hop: loop completes");
        assertEq(weth.balanceOf(address(exec)), 50 * E18, "stored WETH unchanged");
    }

    // Overcharging pool as the LAST hop of a 5-hop loop (its input is the
    // smallest number in the loop): still refused.
    function test_loop5_paymentCap_lastHopOverchargeRefused() public {
        // DAI -> USDC on a misbehaving V3 pool instead of V4, at the same dear price.
        ConfigurableV3Pool greedy = new ConfigurableV3Pool(address(dai), address(usdc), 106, 100);
        usdc.mint(address(greedy), 5_000_000 * E18);
        greedy.setExtra(1);
        dai.mint(address(exec), 1_000 * E18); // stored DAI it could be paid from
        usdc.mint(address(exec), TRADE);
        ArbExecutor.Hop[] memory hops = _mixed5();
        hops[4] = _hop(2, address(greedy), dai, usdc);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.BadRoute.selector);
        exec.execute(_trade(hops, 1), address(0));
    }

    function _cfgPool() internal returns (ConfigurableV3Pool p) {
        // 1 WBTC = 20 WETH, like wbtcWethV3.
        p = new ConfigurableV3Pool(address(wbtc), address(weth), 20, 1);
        wbtc.mint(address(p), 1_000 * E18);
        weth.mint(address(p), 20_000 * E18);
    }

    // ---- gas per loop length ----------------------------------------------
    // Same pool type (V2) for every length so the numbers compare directly.
    // gasleft() around execute(): includes the call itself, excludes the
    // 21,000 transaction base cost and calldata cost of a real transaction.

    function test_gas_v2Loop_2hops() public { _logGas("V2-only", 2, _v2Loop(2)); }
    function test_gas_v2Loop_3hops() public { _logGas("V2-only", 3, _v2Loop(3)); }
    function test_gas_v2Loop_4hops() public { _logGas("V2-only", 4, _v2Loop(4)); }
    function test_gas_v2Loop_5hops() public { _logGas("V2-only", 5, _v2Loop(5)); }
    function test_gas_mixedLoop_4hops() public { _logGas("mixed V2/V3/Solidly/V2", 4, _mixed4(address(wbtcWethV3))); }
    function test_gas_mixedLoop_5hops() public { _logGas("mixed V2/V3/Solidly/Algebra/V4", 5, _mixed5()); }

    function _logGas(string memory label, uint256 n, ArbExecutor.Hop[] memory hops) internal {
        (, uint256 gasUsed) = _runOwn(_trade(hops, 1));
        console.log(string.concat("GAS loop ", label, " hops / gas:"), n, gasUsed);
        // Generous ceiling (~150k per hop on mocks) so a gas blow-up fails loudly.
        assertLt(gasUsed, 150_000 * n, "loop gas within ~150k per hop");
    }

    // ---- calldata layout shared with the bot's TypeScript encoder ----------
    // src/test/loopEncode.test.ts builds this exact 4-hop trade with the bot's
    // encoder (buildLoopTrade + encodeExecuteRaw) and checks the keccak256 of
    // the calldata equals the same constant. If either side's Hop/Trade layout
    // changes, one of the two tests fails.
    bytes32 constant LOOP4_CALLDATA_HASH = 0x5eb4a7e5975a4664dc6befc7cfeef95fc0a53676b6334a405448bd1f78dc43f2;

    function test_encoderParity_loop4_calldataHash() public pure {
        address WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
        address PONS = 0x39dBED3a2bd333467115dE45665cC57F813C4571;
        address CASHCAT = 0x020bfC650A365f8BB26819deAAbF3E21291018b4;
        address USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](4);
        hops[0] = ArbExecutor.Hop(0, 0x1111111111111111111111111111111111111111, WETH, PONS, 30, 0, 0, false);
        hops[1] = ArbExecutor.Hop(2, 0x2222222222222222222222222222222222222222, PONS, CASHCAT, 0, 0, 0, false);
        hops[2] = ArbExecutor.Hop(1, 0x3333333333333333333333333333333333333333, CASHCAT, USDG, 0, 0, 0, false);
        hops[3] = ArbExecutor.Hop(3, 0x8366a39CC670B4001A1121B8F6A443A643e40951, USDG, WETH, 0, 500, 10, true);
        ArbExecutor.Trade memory t = ArbExecutor.Trade(WETH, 1e16, 1, 123_456, hops);
        bytes memory data = abi.encodeCall(ArbExecutor.execute, (t, address(0)));
        console.logBytes32(keccak256(data));
        assertEq(keccak256(data), LOOP4_CALLDATA_HASH, "4-hop execute() calldata matches the TS encoder's bytes");
    }
}
