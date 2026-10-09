// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";
import {MockERC20, MockV2Pair, MockAlgebraPool, AlgebraCallbackRelay} from "./mocks/Mocks.sol";

// ============================================================================
// ALGEBRA INTEGRAL POOLS (Alandale, KittenSwap) -- unit tests with mocks
//
// Plain English:
//   Algebra pools take the same swap() call as Uniswap V3 but ask to be paid
//   through a callback named algebraSwapCallback. The executor trades them
//   as an ordinary V3 hop (KIND_V3) and answers that callback exactly like
//   the Uniswap/PancakeSwap ones: only the pool it is swapping with right
//   now may call it, and only in the token being sold into that pool.
//   The real-pool proof is the fork test (ForkAlgebraVenues.t.sol).
// ============================================================================

contract AlgebraTest is Test {
    ArbExecutor exec;
    MockERC20 usdc;
    MockERC20 weth;
    MockV2Pair cheapV2;       // 1 WETH = 3,000 USDC
    MockV2Pair dearV2;        // 1 WETH = 3,300 USDC
    MockAlgebraPool dearAlg;  // 1 WETH = 3,300 USDC, 0.05% fee
    MockAlgebraPool cheapAlg; // 1 WETH = 3,000 USDC, 0.05% fee

    address bot = makeAddr("bot");
    address stranger = makeAddr("stranger");
    uint256 constant E18 = 1e18;
    uint256 constant TRADE = 30_000 * E18;
    uint8 constant KIND_V2 = 0;
    uint8 constant KIND_V3 = 2;

    function setUp() public {
        usdc = new MockERC20("USDC", 18);
        weth = new MockERC20("WETH", 18);
        exec = new ArbExecutor(bot);

        cheapV2 = new MockV2Pair(address(usdc), address(weth), 30);
        weth.mint(address(cheapV2), 1_000 * E18);
        usdc.mint(address(cheapV2), 3_000_000 * E18);
        cheapV2.sync();
        dearV2 = new MockV2Pair(address(usdc), address(weth), 30);
        weth.mint(address(dearV2), 1_000 * E18);
        usdc.mint(address(dearV2), 3_300_000 * E18);
        dearV2.sync();

        dearAlg = new MockAlgebraPool(address(weth), address(usdc), 3_300, 1, 500);
        weth.mint(address(dearAlg), 1_000 * E18);
        usdc.mint(address(dearAlg), 5_000_000 * E18);
        cheapAlg = new MockAlgebraPool(address(weth), address(usdc), 3_000, 1, 500);
        weth.mint(address(cheapAlg), 1_000 * E18);
        usdc.mint(address(cheapAlg), 5_000_000 * E18);
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

    // Selling INTO an Algebra pool (it pays out USDC, we pay WETH in the callback).
    function test_algebra_asSellHop_makesProfit() public {
        usdc.mint(address(exec), TRADE);
        ArbExecutor.Trade memory t = _trade(KIND_V2, address(cheapV2), KIND_V3, address(dearAlg), 1_000 * E18);
        vm.prank(bot);
        exec.execute(t, address(0));
        assertGt(usdc.balanceOf(address(exec)), TRADE + 1_000 * E18, "V2 -> Algebra profit");
    }

    // Buying FROM an Algebra pool (we pay USDC in the callback). Together with
    // the test above this covers both swap directions (zeroToOne true and
    // false), so both of our price limits pass Algebra's limit check.
    function test_algebra_asBuyHop_makesProfit() public {
        usdc.mint(address(exec), TRADE);
        ArbExecutor.Trade memory t = _trade(KIND_V3, address(cheapAlg), KIND_V2, address(dearV2), 1_000 * E18);
        vm.prank(bot);
        exec.execute(t, address(0));
        assertGt(usdc.balanceOf(address(exec)), TRADE + 1_000 * E18, "Algebra -> V2 profit");
    }

    // Two Algebra hops in one route.
    function test_algebra_toAlgebra_makesProfit() public {
        usdc.mint(address(exec), TRADE);
        ArbExecutor.Trade memory t = _trade(KIND_V3, address(cheapAlg), KIND_V3, address(dearAlg), 1_000 * E18);
        vm.prank(bot);
        exec.execute(t, address(0));
        assertGt(usdc.balanceOf(address(exec)), TRADE + 1_000 * E18, "Algebra -> Algebra profit");
    }

    // The profit guard still applies (buy dear, sell cheap = loss).
    function test_algebra_unprofitable_stoppedByProfitGuard() public {
        usdc.mint(address(exec), TRADE);
        ArbExecutor.Trade memory t = _trade(KIND_V3, address(dearAlg), KIND_V2, address(cheapV2), 1);
        vm.prank(bot);
        vm.expectPartialRevert(ArbExecutor.InsufficientProfit.selector);
        exec.execute(t, address(0));
        assertEq(usdc.balanceOf(address(exec)), TRADE, "balance untouched after revert");
    }

    // Nobody can call the callback directly, not even the real pool when no
    // swap of ours is in progress.
    function test_algebraCallback_rejectsDirectCalls() public {
        vm.prank(stranger);
        vm.expectRevert(ArbExecutor.UnauthorizedCallback.selector);
        exec.algebraSwapCallback(1, 0, "");

        vm.prank(address(dearAlg));
        vm.expectRevert(ArbExecutor.UnauthorizedCallback.selector);
        exec.algebraSwapCallback(1, 0, "");
    }

    // Mid-swap, a contract OTHER than the pool we are trading with tries to
    // collect payment through algebraSwapCallback: refused.
    function test_algebraCallback_rejectsOtherCallerMidSwap() public {
        AlgebraCallbackRelay relay = new AlgebraCallbackRelay();
        dearAlg.setRelay(address(relay));
        usdc.mint(address(exec), TRADE);
        ArbExecutor.Trade memory t = _trade(KIND_V2, address(cheapV2), KIND_V3, address(dearAlg), 1);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.UnauthorizedCallback.selector);
        exec.execute(t, address(0));
    }
}
