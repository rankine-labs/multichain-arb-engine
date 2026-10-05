// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";
import {
    MockERC20,
    MockV2Pair,
    MockSolidlyPair,
    MockV3Pool,
    MockAavePool,
    DrainingV3Pool,
    EvilFlashPool,
    EvilV3Lender
} from "./mocks/Mocks.sol";

// ============================================================================
// ArbExecutor tests
//
// Setup: WETH is $3,000 on "cheap" pools and $3,300 on "dear" pools, so
// buying WETH cheap with USDC and selling it dear should net USDC.
//
// Covers: every pool type, both funding modes, profit enforcement, access
// control, and the attacks a stolen executor key could try.
// ============================================================================

contract ArbExecutorTest is Test {
    ArbExecutor exec;
    MockERC20 usdc;
    MockERC20 weth;
    MockV2Pair cheapV2;      // 1 WETH = 3,000 USDC
    MockV2Pair dearV2;       // 1 WETH = 3,300 USDC
    MockSolidlyPair cheapSolidly; // 1 WETH = 3,000 USDC
    MockV3Pool dearV3;       // 1 WETH = 3,300 USDC (uniswap callback)
    MockV3Pool dearPancake;  // 1 WETH = 3,300 USDC (pancake callback)
    MockAavePool aave;

    address owner = address(this);
    address bot = makeAddr("bot");
    address stranger = makeAddr("stranger");

    uint256 constant E18 = 1e18;
    uint256 constant TRADE = 30_000 * E18; // 30k USDC per round trip

    function setUp() public {
        usdc = new MockERC20("USDC", 18);
        weth = new MockERC20("WETH", 18);
        exec = new ArbExecutor(bot);

        cheapV2 = new MockV2Pair(address(usdc), address(weth), 30);
        _fundV2(cheapV2, 1_000 * E18, 3_000_000 * E18);
        dearV2 = new MockV2Pair(address(usdc), address(weth), 30);
        _fundV2(dearV2, 1_000 * E18, 3_300_000 * E18);

        cheapSolidly = new MockSolidlyPair(address(usdc), address(weth));
        weth.mint(address(cheapSolidly), 1_000 * E18);
        usdc.mint(address(cheapSolidly), 3_000_000 * E18);

        // price of WETH in USDC = 3300 / 1
        dearV3 = new MockV3Pool(address(weth), address(usdc), 3_300, 1, false);
        dearPancake = new MockV3Pool(address(weth), address(usdc), 3_300, 1, true);
        weth.mint(address(dearV3), 1_000 * E18);
        usdc.mint(address(dearV3), 5_000_000 * E18);
        weth.mint(address(dearPancake), 1_000 * E18);
        usdc.mint(address(dearPancake), 5_000_000 * E18);

        aave = new MockAavePool();
        usdc.mint(address(aave), 10_000_000 * E18);
        exec.setFlashPool(address(aave), true);
    }

    // ---- helpers -----------------------------------------------------------

    function _fundV2(MockV2Pair pair, uint256 wethAmt, uint256 usdcAmt) internal {
        weth.mint(address(pair), wethAmt);
        usdc.mint(address(pair), usdcAmt);
        pair.sync();
    }

    function _hop(uint8 kind, address pool, address tIn, address tOut) internal pure returns (ArbExecutor.Hop memory) {
        return ArbExecutor.Hop({kind: kind, pool: pool, tokenIn: tIn, tokenOut: tOut, feeBps: 30, v4Fee: 0, v4TickSpacing: 0, v4Native: false});
    }

    // USDC -> WETH on `buy`, WETH -> USDC on `sell`.
    function _trade(uint8 buyKind, address buy, uint8 sellKind, address sell, uint256 minProfit)
        internal
        view
        returns (ArbExecutor.Trade memory t)
    {
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = _hop(buyKind, buy, address(usdc), address(weth));
        hops[1] = _hop(sellKind, sell, address(weth), address(usdc));
        t = ArbExecutor.Trade({token: address(usdc), amountIn: TRADE, minProfit: minProfit, maxBlock: block.number, hops: hops});
    }

    // ---- happy paths -------------------------------------------------------

    function test_ownCapital_V2toV2_makesProfit() public {
        usdc.mint(address(exec), TRADE);
        ArbExecutor.Trade memory t = _trade(0, address(cheapV2), 0, address(dearV2), 1_000 * E18);
        vm.prank(bot);
        exec.execute(t, address(0));
        uint256 profit = usdc.balanceOf(address(exec)) - TRADE;
        assertGt(profit, 1_000 * E18, "own-capital V2->V2 profit");
        emit log_named_decimal_uint("profit USDC (V2->V2)", profit, 18);
    }

    function test_flashLoan_V2toV3_makesProfit_andRepaysAave() public {
        uint256 aaveBefore = usdc.balanceOf(address(aave));
        ArbExecutor.Trade memory t = _trade(0, address(cheapV2), 2, address(dearV3), 1_000 * E18);
        vm.prank(bot);
        exec.execute(t, address(aave));
        // Contract started with 0 USDC; everything it holds now is profit.
        uint256 profit = usdc.balanceOf(address(exec));
        assertGt(profit, 1_000 * E18, "flash V2->V3 profit");
        // Aave got loan + 5bps premium back.
        assertEq(usdc.balanceOf(address(aave)), aaveBefore + TRADE * 5 / 10_000, "aave repaid with premium");
        // No allowance left dangling.
        assertEq(usdc.allowance(address(exec), address(aave)), 0, "allowance reset");
    }

    function test_solidly_toV2() public {
        usdc.mint(address(exec), TRADE);
        ArbExecutor.Trade memory t = _trade(1, address(cheapSolidly), 0, address(dearV2), 1_000 * E18);
        vm.prank(bot);
        exec.execute(t, address(0));
        assertGt(usdc.balanceOf(address(exec)), TRADE + 1_000 * E18, "solidly->V2 profit");
    }

    function test_pancakeCallback_works() public {
        usdc.mint(address(exec), TRADE);
        ArbExecutor.Trade memory t = _trade(0, address(cheapV2), 2, address(dearPancake), 1_000 * E18);
        vm.prank(bot);
        exec.execute(t, address(0));
        assertGt(usdc.balanceOf(address(exec)), TRADE + 1_000 * E18, "pancake V3 callback path");
    }

    // ---- profit enforcement -------------------------------------------------

    function test_wrongDirection_reverts_andNothingMoves() public {
        usdc.mint(address(exec), TRADE);
        // Buy dear, sell cheap = guaranteed loss.
        ArbExecutor.Trade memory t = _trade(0, address(dearV2), 0, address(cheapV2), 1);
        vm.prank(bot);
        vm.expectRevert();
        exec.execute(t, address(0));
        assertEq(usdc.balanceOf(address(exec)), TRADE, "balance untouched after revert");
    }

    function test_minProfitNotMet_reverts() public {
        usdc.mint(address(exec), TRADE);
        // Real profit is ~2.5k; demand 100k.
        ArbExecutor.Trade memory t = _trade(0, address(cheapV2), 0, address(dearV2), 100_000 * E18);
        vm.prank(bot);
        vm.expectRevert();
        exec.execute(t, address(0));
    }

    function test_flashFee_countsAgainstProfit() public {
        // Find the exact own-capital profit, then demand just that much on a
        // flash trade: the 5bps Aave fee must push it under and revert.
        uint256 snap = vm.snapshotState();
        usdc.mint(address(exec), TRADE);
        vm.prank(bot);
        exec.execute(_trade(0, address(cheapV2), 0, address(dearV2), 1), address(0));
        uint256 exactProfit = usdc.balanceOf(address(exec)) - TRADE;
        vm.revertToState(snap);

        ArbExecutor.Trade memory t = _trade(0, address(cheapV2), 0, address(dearV2), exactProfit);
        vm.prank(bot);
        vm.expectRevert();
        exec.execute(t, address(aave));
    }

    // ---- input checks -------------------------------------------------------

    function test_expired_reverts() public {
        usdc.mint(address(exec), TRADE);
        ArbExecutor.Trade memory t = _trade(0, address(cheapV2), 0, address(dearV2), 1);
        vm.roll(block.number + 1); // opportunity was for the previous block
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.Expired.selector);
        exec.execute(t, address(0));
    }

    function test_routeMustReturnToStartToken() public {
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = _hop(0, address(cheapV2), address(usdc), address(weth));
        hops[1] = _hop(0, address(dearV2), address(usdc), address(weth)); // doesn't chain / end in USDC
        ArbExecutor.Trade memory t = ArbExecutor.Trade(address(usdc), TRADE, 1, block.number, hops);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.BadRoute.selector);
        exec.execute(t, address(0));
    }

    function test_unsupportedKind_reverts() public {
        usdc.mint(address(exec), TRADE);
        ArbExecutor.Trade memory t = _trade(7, address(cheapV2), 0, address(dearV2), 1);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(ArbExecutor.UnsupportedKind.selector, uint8(7)));
        exec.execute(t, address(0));
    }

    // ---- access control -----------------------------------------------------

    function test_onlyExecutor_canExecute() public {
        ArbExecutor.Trade memory t = _trade(0, address(cheapV2), 0, address(dearV2), 1);
        vm.prank(stranger);
        vm.expectRevert(ArbExecutor.NotExecutor.selector);
        exec.execute(t, address(0));
    }

    function test_onlyOwner_canWithdraw_andSetExecutor() public {
        usdc.mint(address(exec), 500 * E18);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.NotOwner.selector);
        exec.withdraw(address(usdc), bot, 500 * E18);

        vm.prank(bot);
        vm.expectRevert(ArbExecutor.NotOwner.selector);
        exec.setExecutor(stranger);

        exec.withdraw(address(usdc), owner, 500 * E18);
        assertEq(usdc.balanceOf(owner), 500 * E18, "owner withdrew");
    }

    function test_callbacks_rejectDirectCalls() public {
        vm.prank(stranger);
        vm.expectRevert(ArbExecutor.UnauthorizedCallback.selector);
        exec.executeOperation(address(usdc), 1, 0, address(exec), "");

        vm.prank(stranger);
        vm.expectRevert(ArbExecutor.UnauthorizedCallback.selector);
        exec.uniswapV3SwapCallback(1, 0, "");

        // Even a real pool can't call back when no swap is in progress.
        vm.prank(address(dearV3));
        vm.expectRevert(ArbExecutor.UnauthorizedCallback.selector);
        exec.uniswapV3SwapCallback(1, 0, "");
    }

    // ---- stolen-executor-key attacks ----------------------------------------

    function test_flashPool_mustBeAllowlisted() public {
        EvilFlashPool evil = new EvilFlashPool();
        ArbExecutor.Trade memory t = _trade(0, address(cheapV2), 0, address(dearV2), 1);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(ArbExecutor.FlashPoolNotAllowed.selector, address(evil)));
        exec.execute(t, address(evil));
    }

    function test_flashCallback_rejectsSubstitutedRoute() public {
        // Even if the owner mistakenly allowlisted a bad lender, it can't swap
        // in a different route than the one execute() snapshotted.
        EvilFlashPool evil = new EvilFlashPool();
        usdc.mint(address(evil), TRADE);
        exec.setFlashPool(address(evil), true);
        weth.mint(address(exec), 10 * E18); // stored profits it would like to steal

        ArbExecutor.Trade memory honest = _trade(0, address(cheapV2), 0, address(dearV2), 1);
        ArbExecutor.Trade memory sneaky = _trade(0, address(cheapV2), 0, address(dearV2), 1);
        sneaky.amountIn = TRADE; // same loan size, different hash below
        sneaky.minProfit = 2;
        evil.setSubstitute(abi.encode(sneaky));

        vm.prank(bot);
        vm.expectRevert(ArbExecutor.UnauthorizedCallback.selector);
        exec.execute(honest, address(evil));
    }

    function test_fakeV3Pool_cannotDrainStoredBalances() public {
        // Contract holds 10 WETH of past profit plus its USDC float.
        weth.mint(address(exec), 10 * E18);
        usdc.mint(address(exec), TRADE);

        // Fake pool demands 15 WETH (more than this trade produced) and pays
        // back enough USDC to make the USDC side look profitable.
        DrainingV3Pool thief = new DrainingV3Pool(address(weth), address(usdc), 15 * E18, TRADE + 1_000 * E18);
        usdc.mint(address(thief), TRADE + 1_000 * E18);

        ArbExecutor.Trade memory t = _trade(0, address(cheapV2), 2, address(thief), 1);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(ArbExecutor.TokenBalanceDropped.selector, address(weth)));
        exec.execute(t, address(0));
        assertEq(weth.balanceOf(address(exec)), 10 * E18, "stored WETH untouched");
    }

    function test_rotateExecutor_locksOutOldKey() public {
        exec.setExecutor(stranger);
        usdc.mint(address(exec), TRADE);
        ArbExecutor.Trade memory t = _trade(0, address(cheapV2), 0, address(dearV2), 1);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.NotExecutor.selector);
        exec.execute(t, address(0));
    }

    // ---- V3 pool flash loans (no capital in the contract) ------------------

    // A separate V3 pool that holds lots of USDC to lend (not used in the route).
    function _lender() internal returns (MockV3Pool lender) {
        lender = new MockV3Pool(address(weth), address(usdc), 3_000, 1, false);
        usdc.mint(address(lender), 1_000_000 * E18);
        weth.mint(address(lender), 1_000 * E18);
        exec.setFlashPool(address(lender), true);
    }

    function test_v3Flash_makesProfit_withZeroCapital() public {
        MockV3Pool lender = _lender();
        uint256 lenderBefore = usdc.balanceOf(address(lender));
        assertEq(usdc.balanceOf(address(exec)), 0, "contract starts empty");

        vm.prank(bot);
        exec.executeWithV3Flash(_trade(0, address(cheapV2), 0, address(dearV2), 1_000 * E18), address(lender));

        uint256 profit = usdc.balanceOf(address(exec));
        assertGt(profit, 1_000 * E18, "profit from borrowed money only");
        // Lender got its 0.05% fee.
        assertEq(usdc.balanceOf(address(lender)), lenderBefore + (TRADE * 5 + 9_999) / 10_000, "lender repaid + fee");
        emit log_named_decimal_uint("V3-flash profit USDC (after 0.05% fee)", profit, 18);
    }

    function test_v3Flash_pancakeCallback_works() public {
        MockV3Pool lender = new MockV3Pool(address(weth), address(usdc), 3_000, 1, true);
        usdc.mint(address(lender), 1_000_000 * E18);
        exec.setFlashPool(address(lender), true);
        vm.prank(bot);
        exec.executeWithV3Flash(_trade(0, address(cheapV2), 0, address(dearV2), 1_000 * E18), address(lender));
        assertGt(usdc.balanceOf(address(exec)), 1_000 * E18, "pancake flash callback path");
    }

    function test_v3Flash_feeCountsAgainstProfit() public {
        // Exact own-capital profit, then demand it on a flash trade: the fee must push it under.
        uint256 snap = vm.snapshotState();
        usdc.mint(address(exec), TRADE);
        vm.prank(bot);
        exec.execute(_trade(0, address(cheapV2), 0, address(dearV2), 1), address(0));
        uint256 exactProfit = usdc.balanceOf(address(exec)) - TRADE;
        vm.revertToState(snap);

        MockV3Pool lender = _lender();
        vm.prank(bot);
        vm.expectRevert();
        exec.executeWithV3Flash(_trade(0, address(cheapV2), 0, address(dearV2), exactProfit), address(lender));
    }

    function test_v3Flash_unprofitable_revertsAndLenderWhole() public {
        MockV3Pool lender = _lender();
        uint256 lenderBefore = usdc.balanceOf(address(lender));
        vm.prank(bot);
        vm.expectRevert();
        exec.executeWithV3Flash(_trade(0, address(dearV2), 0, address(cheapV2), 1), address(lender));
        assertEq(usdc.balanceOf(address(lender)), lenderBefore, "nothing moved");
    }

    function test_v3Flash_lenderMustBeAllowlisted() public {
        MockV3Pool lender = new MockV3Pool(address(weth), address(usdc), 3_000, 1, false);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(ArbExecutor.FlashPoolNotAllowed.selector, address(lender)));
        exec.executeWithV3Flash(_trade(0, address(cheapV2), 0, address(dearV2), 1), address(lender));
    }

    function test_v3Flash_lenderCannotBeATradePool() public {
        exec.setFlashPool(address(dearV3), true);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.BadRoute.selector);
        exec.executeWithV3Flash(_trade(0, address(cheapV2), 2, address(dearV3), 1), address(dearV3));
    }

    function test_v3Flash_lenderMustHoldTheToken() public {
        MockERC20 other = new MockERC20("OTHER", 18);
        MockV3Pool lender = new MockV3Pool(address(weth), address(other), 1, 1, false);
        exec.setFlashPool(address(lender), true);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.BadRoute.selector);
        exec.executeWithV3Flash(_trade(0, address(cheapV2), 0, address(dearV2), 1), address(lender));
    }

    function test_v3Flash_onlyExecutor() public {
        MockV3Pool lender = _lender();
        vm.prank(stranger);
        vm.expectRevert(ArbExecutor.NotExecutor.selector);
        exec.executeWithV3Flash(_trade(0, address(cheapV2), 0, address(dearV2), 1), address(lender));
    }

    function test_v3Flash_callbackRejectsDirectCalls() public {
        vm.prank(stranger);
        vm.expectRevert(ArbExecutor.UnauthorizedCallback.selector);
        exec.uniswapV3FlashCallback(0, 0, "");
        vm.prank(stranger);
        vm.expectRevert(ArbExecutor.UnauthorizedCallback.selector);
        exec.pancakeV3FlashCallback(0, 0, "");
    }

    function test_v3Flash_evilLender_cannotSubstituteRoute() public {
        EvilV3Lender evil = new EvilV3Lender(address(weth), address(usdc));
        usdc.mint(address(evil), TRADE);
        exec.setFlashPool(address(evil), true);
        ArbExecutor.Trade memory sneaky = _trade(0, address(cheapV2), 0, address(dearV2), 2);
        evil.setSubstitute(abi.encode(sneaky));
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.UnauthorizedCallback.selector);
        exec.executeWithV3Flash(_trade(0, address(cheapV2), 0, address(dearV2), 1), address(evil));
    }

    function test_v3Flash_evilLender_giantFee_cannotTakeStoredFunds() public {
        // Contract holds 5,000 USDC of past profit; evil lender claims a huge fee.
        usdc.mint(address(exec), 5_000 * E18);
        EvilV3Lender evil = new EvilV3Lender(address(weth), address(usdc));
        usdc.mint(address(evil), TRADE);
        evil.setFakeFee(4_000 * E18);
        exec.setFlashPool(address(evil), true);
        vm.prank(bot);
        vm.expectRevert();
        exec.executeWithV3Flash(_trade(0, address(cheapV2), 0, address(dearV2), 1), address(evil));
        assertEq(usdc.balanceOf(address(exec)), 5_000 * E18, "stored profit untouched");
    }
}
