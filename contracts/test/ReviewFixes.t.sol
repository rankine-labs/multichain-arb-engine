// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";
import {MockERC20, MockV2Pair} from "./mocks/Mocks.sol";

// Fake ArbSys precompile. On Arbitrum/Orbit chains it lives at address(100)
// and returns the L2 block number (block.number there is the parent chain's).
contract MockArbSys {
    uint256 public n;
    function set(uint256 v) external { n = v; }
    function arbBlockNumber() external view returns (uint256) { return n; }
}

// Wallet that refuses ETH, to prove a failed ETH rescue reverts.
contract RejectEth {
    receive() external payable { revert("no"); }
}

// Tests for the contract review fixes:
//   1. Trade deadline uses the L2 block number (ArbSys) with a block.number fallback.
//   2. Owner can rescue native ETH.
//   3. Ownership handover is two-step (propose, then accept from the new wallet).
contract ReviewFixesTest is Test {
    ArbExecutor exec;
    MockERC20 usdc;
    MockERC20 weth;
    MockV2Pair cheapV2;
    MockV2Pair dearV2;

    address bot = makeAddr("bot");
    address stranger = makeAddr("stranger");
    address newOwner = makeAddr("newOwner");

    uint256 constant E18 = 1e18;
    uint256 constant TRADE = 30_000 * E18;

    function setUp() public {
        usdc = new MockERC20("USDC", 18);
        weth = new MockERC20("WETH", 18);
        exec = new ArbExecutor(bot);
        cheapV2 = new MockV2Pair(address(usdc), address(weth), 30);
        dearV2 = new MockV2Pair(address(usdc), address(weth), 30);
        weth.mint(address(cheapV2), 1_000 * E18);
        usdc.mint(address(cheapV2), 3_000_000 * E18);
        cheapV2.sync();
        weth.mint(address(dearV2), 1_000 * E18);
        usdc.mint(address(dearV2), 3_300_000 * E18);
        dearV2.sync();
        usdc.mint(address(exec), TRADE);
    }

    // Two-hop own-capital trade, valid until `maxBlock`.
    function _trade(uint256 maxBlock) internal view returns (ArbExecutor.Trade memory t) {
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = _hop(address(cheapV2), address(usdc), address(weth));
        hops[1] = _hop(address(dearV2), address(weth), address(usdc));
        t = ArbExecutor.Trade({token: address(usdc), amountIn: TRADE, minProfit: 1, maxBlock: maxBlock, hops: hops});
    }

    function _hop(address pool, address tIn, address tOut) internal pure returns (ArbExecutor.Hop memory h) {
        h.kind = 0;
        h.pool = pool;
        h.tokenIn = tIn;
        h.tokenOut = tOut;
        h.feeBps = 30; // matches the mock pools' 0.3% fee
    }

    function _installArbSys(uint256 l2Block) internal returns (MockArbSys sys) {
        vm.etch(address(100), address(new MockArbSys()).code);
        sys = MockArbSys(address(100));
        sys.set(l2Block);
    }

    // ---- 1. deadline ---------------------------------------------------------

    // On an Arbitrum chain the deadline follows ArbSys, not block.number.
    function test_deadline_usesArbSysBlock() public {
        _installArbSys(5_000_000);
        vm.roll(100); // parent-chain number: far lower, must be ignored

        // L2 block 5,000,001 > maxBlock 5,000,000: expired even though block.number is tiny.
        MockArbSys(address(100)).set(5_000_001);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.Expired.selector);
        exec.execute(_trade(5_000_000), address(0));

        // Same L2 block as maxBlock: still valid, trade goes through.
        MockArbSys(address(100)).set(5_000_000);
        vm.prank(bot);
        exec.execute(_trade(5_000_000), address(0));
        assertGt(usdc.balanceOf(address(exec)), TRADE, "profit made");
    }

    // Old behavior would wrongly pass: block.number lags behind, ArbSys says expired.
    function test_deadline_staleTradeRejectedEvenIfParentBlockLags() public {
        _installArbSys(2_000);
        vm.roll(10);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.Expired.selector);
        exec.executeWithV3Flash(_trade(1_999), address(0xBEEF));
    }

    // Off Arbitrum (no code at address(100)) it falls back to block.number.
    function test_deadline_fallsBackToBlockNumber() public {
        assertEq(address(100).code.length, 0, "no precompile in plain EVM");
        vm.roll(50);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.Expired.selector);
        exec.execute(_trade(49), address(0));

        vm.prank(bot);
        exec.execute(_trade(50), address(0));
        assertGt(usdc.balanceOf(address(exec)), TRADE, "profit made");
    }

    // ---- 2. ETH rescue -------------------------------------------------------

    function test_withdrawEth_ownerOnly_andSends() public {
        vm.deal(address(exec), 2 ether); // e.g. force-sent via selfdestruct
        address payable to = payable(makeAddr("vault"));

        vm.prank(stranger);
        vm.expectRevert(ArbExecutor.NotOwner.selector);
        exec.withdrawEth(to, 1 ether);

        exec.withdrawEth(to, 1.5 ether);
        assertEq(to.balance, 1.5 ether, "vault got ETH");
        assertEq(address(exec).balance, 0.5 ether, "rest stays");
    }

    function test_withdrawEth_revertsIfReceiverRefuses() public {
        vm.deal(address(exec), 1 ether);
        RejectEth r = new RejectEth();
        vm.expectRevert(ArbExecutor.TransferFailed.selector);
        exec.withdrawEth(payable(address(r)), 1 ether);
        assertEq(address(exec).balance, 1 ether, "nothing lost");
    }

    // ---- 3. two-step ownership ----------------------------------------------

    function test_ownership_twoStep() public {
        assertEq(exec.owner(), address(this), "deployer owns");

        vm.prank(stranger);
        vm.expectRevert(ArbExecutor.NotOwner.selector);
        exec.transferOwnership(stranger);

        exec.transferOwnership(newOwner);
        assertEq(exec.pendingOwner(), newOwner, "proposed");
        assertEq(exec.owner(), address(this), "not moved until accepted");

        // Only the proposed wallet can accept.
        vm.prank(stranger);
        vm.expectRevert(ArbExecutor.NotPendingOwner.selector);
        exec.acceptOwnership();

        vm.prank(newOwner);
        exec.acceptOwnership();
        assertEq(exec.owner(), newOwner, "handed over");
        assertEq(exec.pendingOwner(), address(0), "pending cleared");

        // Old owner is locked out, new owner has control.
        vm.expectRevert(ArbExecutor.NotOwner.selector);
        exec.setExecutor(stranger);
        vm.prank(newOwner);
        exec.setExecutor(stranger);
        assertEq(exec.executor(), stranger, "new owner in control");
    }

    function test_ownership_cancel() public {
        exec.transferOwnership(newOwner);
        exec.transferOwnership(address(0)); // cancel
        vm.prank(newOwner);
        vm.expectRevert(ArbExecutor.NotPendingOwner.selector);
        exec.acceptOwnership();
        assertEq(exec.owner(), address(this), "unchanged");
    }

    function test_nobodyCanAcceptWhenNothingPending() public {
        vm.prank(address(0));
        vm.expectRevert(ArbExecutor.NotPendingOwner.selector);
        exec.acceptOwnership();
    }
}
