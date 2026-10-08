// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";
import {MockERC20, MockV2Pair, MockV3Pool, MockAavePool} from "./mocks/Mocks.sol";

// ============================================================================
// FLASH-LOAN REPAYMENT PROOFS (mock pools, runs offline in CI's unit step)
//
// Plain English:
//   A flash loan must be paid back IN FULL plus the lender's fee, inside the
//   same transaction, from the trade's own proceeds. These tests prove:
//     1. With an EMPTY contract (zero balance, exactly like the live one), a
//        profitable flash trade succeeds, the lender gets back exactly
//        loan + fee, and the contract ends holding exactly the profit.
//     2. Flash profit = own-capital profit minus the fee, to the last unit.
//     3. The bot's simulator trick (minProfit = MAX, read the profit from
//        the InsufficientProfit error) reports the REAL profit with no
//        balance override at all.
//     4. A pretend balance ("float", what a simulation balance override
//        creates) can NOT hide a failed repayment: a losing trade fails with
//        or without it, a winning trade's profit is the same with or without
//        it, and the lender is always made whole. (Fuzzed over sizes/floats.)
// ============================================================================
contract FlashRepayTest is Test {
    ArbExecutor exec;
    MockERC20 usdc;
    MockERC20 weth;
    MockV2Pair cheapV2;   // 1 WETH = 3,000 USDC
    MockV2Pair dearV2;    // 1 WETH = 3,300 USDC
    MockV3Pool lender;    // lends USDC, 0.05% flash fee
    MockAavePool aave;    // lends USDC, 0.05% premium
    address bot = makeAddr("bot");

    uint256 constant E18 = 1e18;
    uint256 constant TRADE = 30_000 * E18;

    function setUp() public {
        usdc = new MockERC20("USDC", 18);
        weth = new MockERC20("WETH", 18);
        exec = new ArbExecutor(bot);
        cheapV2 = new MockV2Pair(address(usdc), address(weth), 30);
        _fundV2(cheapV2, 1_000 * E18, 3_000_000 * E18);
        dearV2 = new MockV2Pair(address(usdc), address(weth), 30);
        _fundV2(dearV2, 1_000 * E18, 3_300_000 * E18);
        lender = new MockV3Pool(address(weth), address(usdc), 3_000, 1, false);
        usdc.mint(address(lender), 1_000_000 * E18);
        exec.setFlashPool(address(lender), true);
        aave = new MockAavePool();
        usdc.mint(address(aave), 1_000_000 * E18);
        exec.setFlashPool(address(aave), true);
    }

    function _fundV2(MockV2Pair pair, uint256 wethAmt, uint256 usdcAmt) internal {
        weth.mint(address(pair), wethAmt);
        usdc.mint(address(pair), usdcAmt);
        pair.sync();
    }

    // USDC -> WETH on `buy`, WETH -> USDC on `sell`, both V2 (kind 0).
    function _trade(address buy, address sell, uint256 amountIn, uint256 minProfit) internal view returns (ArbExecutor.Trade memory t) {
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = ArbExecutor.Hop({kind: 0, pool: buy, tokenIn: address(usdc), tokenOut: address(weth), feeBps: 30, v4Fee: 0, v4TickSpacing: 0, v4Native: false});
        hops[1] = ArbExecutor.Hop({kind: 0, pool: sell, tokenIn: address(weth), tokenOut: address(usdc), feeBps: 30, v4Fee: 0, v4TickSpacing: 0, v4Native: false});
        t = ArbExecutor.Trade({token: address(usdc), amountIn: amountIn, minProfit: minProfit, maxBlock: block.number, hops: hops});
    }

    // Uniswap V3 flash fee: rounded UP (MockV3Pool copies this).
    function _v3Fee(uint256 amount) internal pure returns (uint256) {
        return (amount * 5 + 9_999) / 10_000;
    }

    // Own-capital profit for the same trade (state rolled back afterwards).
    function _ownCapitalProfit(uint256 amountIn) internal returns (uint256 profit) {
        uint256 snap = vm.snapshotState();
        usdc.mint(address(exec), amountIn);
        vm.prank(bot);
        exec.execute(_trade(address(cheapV2), address(dearV2), amountIn, 1), address(0));
        profit = usdc.balanceOf(address(exec)) - amountIn;
        vm.revertToState(snap);
    }

    // 1 + 2: empty contract, exact accounting, flash = own - fee.
    function test_v3Flash_emptyContract_repaysExactlyLoanPlusFee() public {
        uint256 own = _ownCapitalProfit(TRADE);
        uint256 lenderBefore = usdc.balanceOf(address(lender));
        assertEq(usdc.balanceOf(address(exec)), 0, "contract starts empty (no float)");

        vm.prank(bot);
        exec.executeWithV3Flash(_trade(address(cheapV2), address(dearV2), TRADE, 1), address(lender));

        uint256 fee = _v3Fee(TRADE);
        assertEq(usdc.balanceOf(address(lender)), lenderBefore + fee, "lender got loan + fee back, exactly");
        assertEq(usdc.balanceOf(address(exec)), own - fee, "contract keeps exactly own-capital profit minus the fee");
        assertEq(weth.balanceOf(address(exec)), 0, "no middle token left behind");
    }

    function test_aaveFlash_emptyContract_repaysExactlyLoanPlusPremium() public {
        uint256 own = _ownCapitalProfit(TRADE);
        uint256 aaveBefore = usdc.balanceOf(address(aave));
        vm.prank(bot);
        exec.execute(_trade(address(cheapV2), address(dearV2), TRADE, 1), address(aave));
        uint256 premium = TRADE * 5 / 10_000;
        assertEq(usdc.balanceOf(address(aave)), aaveBefore + premium, "Aave got loan + premium back, exactly");
        assertEq(usdc.balanceOf(address(exec)), own - premium, "contract keeps own-capital profit minus premium");
        assertEq(usdc.allowance(address(exec), address(aave)), 0, "no allowance left");
    }

    // 3: the simulator's "minProfit = MAX" trick, with NO balance override.
    function test_simTrick_reportsRealFlashProfit_withoutAnyFloat() public {
        uint256 expected = _ownCapitalProfit(TRADE) - _v3Fee(TRADE);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(ArbExecutor.InsufficientProfit.selector, expected, type(uint256).max));
        exec.executeWithV3Flash(_trade(address(cheapV2), address(dearV2), TRADE, type(uint256).max), address(lender));
    }

    // Losing trade, empty contract: the REPAYMENT fails (TransferFailed),
    // which the simulator reads as "loss" in flash mode.
    function test_v3Flash_losingTrade_emptyContract_failsAtRepayment() public {
        uint256 lenderBefore = usdc.balanceOf(address(lender));
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.TransferFailed.selector);
        exec.executeWithV3Flash(_trade(address(dearV2), address(cheapV2), TRADE, 1), address(lender));
        assertEq(usdc.balanceOf(address(lender)), lenderBefore, "lender whole");
    }

    // 4: fuzz. A float can never turn a failed repayment into success, and
    // never changes a winning trade's profit.
    function testFuzz_float_cannotHideRepaymentFailure(uint256 amountIn, uint256 float, bool winning) public {
        amountIn = bound(amountIn, 100 * E18, 60_000 * E18);
        float = bound(float, 0, 200_000 * E18);
        (address buy, address sell) = winning ? (address(cheapV2), address(dearV2)) : (address(dearV2), address(cheapV2));
        uint256 lenderBefore = usdc.balanceOf(address(lender));

        // Run A: empty contract (the real situation).
        uint256 snap = vm.snapshotState();
        vm.prank(bot);
        (bool okA, ) = address(exec).call(abi.encodeWithSelector(ArbExecutor.executeWithV3Flash.selector, _trade(buy, sell, amountIn, 1), address(lender)));
        uint256 profitA = usdc.balanceOf(address(exec));
        vm.revertToState(snap);

        // Run B: same trade with a pretend balance in the contract.
        usdc.mint(address(exec), float);
        vm.prank(bot);
        (bool okB, ) = address(exec).call(abi.encodeWithSelector(ArbExecutor.executeWithV3Flash.selector, _trade(buy, sell, amountIn, 1), address(lender)));
        uint256 profitB = usdc.balanceOf(address(exec)) - float;

        assertEq(okA, okB, "float changes nothing about success or failure");
        if (okA) assertEq(profitA, profitB, "same profit with or without float");
        if (!winning) assertFalse(okA, "losing trade never succeeds");
        // Lender: either untouched (revert) or + exactly its fee.
        uint256 lenderAfter = usdc.balanceOf(address(lender));
        assertTrue(lenderAfter == lenderBefore || lenderAfter == lenderBefore + _v3Fee(amountIn), "lender whole or paid its fee");
    }
}
