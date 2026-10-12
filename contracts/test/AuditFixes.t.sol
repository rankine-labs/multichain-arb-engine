// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";

// ============================================================================
// Audit fixes (Oct 12): the owner (cold wallet) and the bot (hot wallet) can
// never be the same address, because the hot wallet could then withdraw
// everything. setExecutor(address(0)) stays allowed: it is the kill switch.
// ============================================================================
contract AuditFixesTest is Test {
    address bot = makeAddr("bot");
    address cold = makeAddr("cold");

    function test_deploy_refusesOwnerAsExecutor() public {
        vm.prank(cold);
        vm.expectRevert(ArbExecutor.OwnerIsExecutor.selector);
        new ArbExecutor(cold);
    }

    function test_setExecutor_refusesOwner_allowsKillSwitch() public {
        vm.prank(cold);
        ArbExecutor exec = new ArbExecutor(bot);
        vm.prank(cold);
        vm.expectRevert(ArbExecutor.OwnerIsExecutor.selector);
        exec.setExecutor(cold);
        vm.prank(cold);
        exec.setExecutor(address(0));   // kill switch
        assertEq(exec.executor(), address(0), "kill switch: no bot can trade");
    }

    function test_ownership_cannotGoToBot() public {
        vm.prank(cold);
        ArbExecutor exec = new ArbExecutor(bot);
        vm.prank(cold);
        vm.expectRevert(ArbExecutor.OwnerIsExecutor.selector);
        exec.transferOwnership(bot);
    }
}
