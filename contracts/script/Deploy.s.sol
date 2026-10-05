// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// ============================================================================
// DEPLOY ArbExecutor (run from your COLD wallet; it becomes the owner forever)
//
//   cd contracts
//   EXECUTOR=0xYourBotHotWallet \
//   FLASH_LENDERS=0xPool1,0xPool2,... \
//   forge script script/Deploy.s.sol \
//     --rpc-url https://rpc.mainnet.chain.robinhood.com \
//     --ledger --sender 0xYourColdWallet --broadcast
//
//   (use --trezor instead of --ledger for a Trezor; drop --broadcast to do a
//    dry run that only prints what it would do)
//
// What it does, in one go:
//   1. deploys ArbExecutor with EXECUTOR as the bot's hot wallet
//   2. approves every FLASH_LENDERS pool as a flash-loan lender
//   3. prints the contract address -> put it in .env as ARB_EXECUTOR_ROBINHOOD
//      and the same lender list as FLASH_LENDERS_ROBINHOOD
//
// Get a lender list with:  Actions -> Live probe -> only = lenders
// ============================================================================

import {Script, console} from "forge-std/Script.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";

contract Deploy is Script {
    function run() external {
        address executor = vm.envAddress("EXECUTOR");
        address[] memory lenders = vm.envOr("FLASH_LENDERS", ",", new address[](0));
        require(executor != address(0), "EXECUTOR not set");

        vm.startBroadcast();
        ArbExecutor exec = new ArbExecutor(executor);
        for (uint256 i = 0; i < lenders.length; i++) {
            exec.setFlashPool(lenders[i], true);
        }
        vm.stopBroadcast();

        console.log("ArbExecutor deployed at:", address(exec));
        console.log("owner (this wallet):    ", exec.owner());
        console.log("executor (bot wallet):  ", exec.executor());
        console.log("flash lenders approved: ", lenders.length);
        console.log("Next: put ARB_EXECUTOR_ROBINHOOD=<address above> and FLASH_LENDERS_ROBINHOOD=<same list> in the bot's .env");
    }
}
