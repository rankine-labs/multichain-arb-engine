// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

// ============================================================================
// ROBINHOOD FORK: FABLES FEASIBILITY PROBE (temporary)
//
// Plain English:
//   Reads the Fables registry, prints every hook contract and its V4
//   permission bits, dumps each hook's code (so it can be checked for caller
//   restrictions), then tries a direct swap from THIS test contract (an
//   arbitrary contract, like our executor) on the most liquid USDG pool.
// ============================================================================

interface IFablesRegistry {
    struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
    struct Entry { PoolKey key; bytes32 id; bool active; }
    function activePools() external view returns (Entry[] memory);
}

interface IStateView {
    function getSlot0(bytes32 id) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getLiquidity(bytes32 id) external view returns (uint128);
}

interface IPM {
    struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(IFablesRegistry.PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

contract RobinhoodForkTestFablesProbe is Test {
    address constant REGISTRY = 0x159A113E012593D9B3cC63ad45E30F0467e13Ef3;
    address constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address constant PM = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    receive() external payable {}

    function _flags(address h) internal pure returns (string memory s) {
        uint160 b = uint160(h);
        string[14] memory names = [
            "afterRemoveLiqReturnsDelta", "afterAddLiqReturnsDelta", "afterSwapReturnsDelta", "beforeSwapReturnsDelta",
            "afterDonate", "beforeDonate", "afterSwap", "beforeSwap", "afterRemoveLiq", "beforeRemoveLiq",
            "afterAddLiq", "beforeAddLiq", "afterInit", "beforeInit"
        ];
        for (uint256 i = 0; i < 14; i++) {
            if (b & (uint160(1) << i) != 0) s = string.concat(s, names[i], " ");
        }
    }

    // Swap callback: swap exact-in, settle, take.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (IFablesRegistry.PoolKey memory key, bool zfo, uint256 amt) = abi.decode(data, (IFablesRegistry.PoolKey, bool, uint256));
        int256 d = IPM(PM).swap(key, IPM.SwapParams({
            zeroForOne: zfo, amountSpecified: -int256(amt),
            sqrtPriceLimitX96: zfo ? 4295128740 : 1461446703485210103287273052203988822378723970341
        }), new bytes(0));
        int128 d0 = int128(d >> 128);
        int128 d1 = int128(d);
        console.log("delta0", vm.toString(int256(d0)), "delta1", vm.toString(int256(d1)));
        address cIn = zfo ? key.currency0 : key.currency1;
        address cOut = zfo ? key.currency1 : key.currency0;
        int128 owed = zfo ? d0 : d1;
        int128 got = zfo ? d1 : d0;
        if (owed < 0) {
            uint256 o = uint256(uint128(-owed));
            if (cIn == address(0)) { IPM(PM).settle{value: o}(); }
            else { IPM(PM).sync(cIn); IERC20Min(cIn).transfer(PM, o); IPM(PM).settle(); }
        }
        if (got > 0) IPM(PM).take(cOut, address(this), uint256(uint128(got)));
        return "";
    }

    function test_fork_robinhood_fables_probe() public {
        string memory url = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(url).length == 0) { vm.skip(true); return; }
        uint256 forkBlock = vm.envOr("ROBINHOOD_RPC_URL_BLOCK", uint256(0));
        if (forkBlock > 0) vm.createSelectFork(url, forkBlock); else vm.createSelectFork(url);

        IFablesRegistry.Entry[] memory es = IFablesRegistry(REGISTRY).activePools();
        console.log("FABLES pools:", es.length);
        address[] memory hooks = new address[](es.length);
        uint256 nh;
        uint256 bestLiq;
        uint256 bestIdx = type(uint256).max;
        for (uint256 i = 0; i < es.length; i++) {
            IFablesRegistry.PoolKey memory k = es[i].key;
            uint128 liq = IStateView(STATE_VIEW).getLiquidity(es[i].id);
            (uint160 sp, , , uint24 lpFee) = IStateView(STATE_VIEW).getSlot0(es[i].id);
            console.log(string.concat("FABLES pool ", vm.toString(i), " c0 ", vm.toString(k.currency0), " c1 ", vm.toString(k.currency1),
                " fee ", vm.toString(uint256(k.fee)), " ts ", vm.toString(int256(k.tickSpacing)), " hooks ", vm.toString(k.hooks)));
            console.log(string.concat("   active ", es[i].active ? "y" : "n", " liq ", vm.toString(uint256(liq)), " lpFee ", vm.toString(uint256(lpFee)), " sqrtP ", vm.toString(uint256(sp))));
            bool seen;
            for (uint256 j = 0; j < nh; j++) if (hooks[j] == k.hooks) seen = true;
            if (!seen) hooks[nh++] = k.hooks;
            if ((k.currency1 == USDG || k.currency0 == USDG) && (k.currency0 == address(0) || k.currency0 == WETH || k.currency1 == WETH) && liq > bestLiq) {
                bestLiq = liq; bestIdx = i;
            }
        }
        for (uint256 j = 0; j < nh; j++) {
            console.log(string.concat("FABLES hook ", vm.toString(hooks[j]), " code size ", vm.toString(hooks[j].code.length), " flags: ", _flags(hooks[j])));
            console.log("HOOKCODE_BEGIN");
            console.logBytes(hooks[j].code);
            console.log("HOOKCODE_END");
        }
        // EIP-1967 implementation slot, in case the hook is a proxy.
        for (uint256 j = 0; j < nh; j++) {
            bytes32 impl = vm.load(hooks[j], 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc);
            console.log(string.concat("FABLES hook impl slot ", vm.toString(impl)));
            address ia = address(uint160(uint256(impl)));
            if (ia.code.length > 0) { console.log("IMPLCODE_BEGIN"); console.logBytes(ia.code); console.log("IMPLCODE_END"); }
        }
        if (bestIdx == type(uint256).max) { console.log("FABLES no ETH/USDG pool"); return; }
        IFablesRegistry.PoolKey memory key = es[bestIdx].key;
        console.log("FABLES trying direct swap on pool", bestIdx);

        // Sell 20 USDG for ETH/WETH, then sell the ETH back.
        deal(USDG, address(this), 20e6);
        bool usdgIs0 = key.currency0 == USDG;
        vm.recordLogs();
        (bool ok, bytes memory ret) = PM.call(abi.encodeWithSelector(IPM.unlock.selector, abi.encode(key, usdgIs0, uint256(20e6))));
        console.log("FABLES swap1 USDG->ETH ok:", ok);
        if (!ok) console.logBytes(ret);
        _logSwapFees();
        uint256 ethGot = key.currency0 == address(0) ? address(this).balance : IERC20Min(WETH).balanceOf(address(this));
        console.log("FABLES got eth", ethGot);
        if (ok && ethGot > 0) {
            vm.recordLogs();
            (ok, ret) = PM.call(abi.encodeWithSelector(IPM.unlock.selector, abi.encode(key, !usdgIs0, ethGot)));
            console.log("FABLES swap2 ETH->USDG ok:", ok);
            if (!ok) console.logBytes(ret);
            _logSwapFees();
            console.log("FABLES usdg back", IERC20Min(USDG).balanceOf(address(this)));
        }
    }

    function _logSwapFees() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 t0 = keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == PM && logs[i].topics.length > 0 && logs[i].topics[0] == t0) {
                (, , , , , uint24 fee) = abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
                console.log("FABLES Swap event fee pips", uint256(fee), "sender", address(uint160(uint256(logs[i].topics[2]))));
            } else {
                console.log("FABLES other log from", logs[i].emitter);
                if (logs[i].topics.length > 0) console.logBytes32(logs[i].topics[0]);
            }
        }
    }
}
