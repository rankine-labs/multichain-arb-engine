// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";
import {MockERC20, MockV2Pair, MockAavePool} from "./mocks/Mocks.sol";
import {MockWETH, IUnlockCallbackLike} from "./V4.t.sol";

// ============================================================================
// Uniswap V4 pools WITH A HOOK (KIND_V4_HOOKED), e.g. Fables on Robinhood.
//
// Plain English:
//   A hooked V4 pool lives in the same PoolManager as a plain one; its pool
//   key just names a hook contract, and Fables pools also use the
//   "dynamic fee" flag (fee field 0x800000) so the hook picks the fee on
//   every swap. For this kind the hop's `pool` field carries the HOOK
//   address and the PoolManager always comes from setV4().
//
//   The mock PoolManager below enforces V4's core rule (every currency must
//   net to zero before unlock() returns) and can simulate a hook that
//   changes amounts ("returns delta"): taking a cut of what we receive, or
//   adding to what we pay. Real V4 folds such hook amounts into the delta
//   swap() returns, and so does this mock.
//
// Covers: profitable round trips on a hooked WETH pool and a hooked
// native-ETH pool with the dynamic-fee flag; a hook taking a cut of the
// output (settles correctly, profit reduced); a hook billing more than the
// hop's input (refused); hook address equal to the PoolManager or to the
// executor (refused); wrong hook address (pool not found); V4 off; and that
// plain KIND_V4 hops still build hooks = 0.
// ============================================================================

contract MockHookedPoolManager {
    struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
    struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
    // price of currency0 in currency1; dynFee = fee the "hook" charges (pips)
    // when the key has the dynamic-fee flag; cutOutBps = hook's cut of the
    // output; extraIn = extra input the hook bills on top of the exact input.
    struct Pool { bool exists; uint256 priceNum; uint256 priceDen; uint24 dynFee; uint256 cutOutBps; uint256 extraIn; }

    uint24 constant DYNAMIC_FEE_FLAG = 0x800000;

    mapping(bytes32 => Pool) public pools;
    mapping(address => int256) public delta; // currency => caller's balance with us (negative = owes)
    address public locker;
    address public synced;
    uint256 public syncedReserve;
    PoolKey public lastKey;  // key of the last swap (lets tests check the hooks field used)

    function addPool(PoolKey memory key, uint256 num, uint256 den, uint24 dynFee) external {
        pools[keccak256(abi.encode(key))] = Pool(true, num, den, dynFee, 0, 0);
    }

    function setHookEffects(PoolKey memory key, uint256 cutOutBps, uint256 extraIn) external {
        Pool storage p = pools[keccak256(abi.encode(key))];
        p.cutOutBps = cutOutBps;
        p.extraIn = extraIn;
    }

    function _bal(address c) internal view returns (uint256) {
        return c == address(0) ? address(this).balance : MockERC20(c).balanceOf(address(this));
    }

    function unlock(bytes calldata data) external returns (bytes memory r) {
        require(locker == address(0), "already unlocked");
        locker = msg.sender;
        r = IUnlockCallbackLike(msg.sender).unlockCallback(data);
        require(delta[lastKey.currency0] == 0 && delta[lastKey.currency1] == 0, "CurrencyNotSettled");
        locker = address(0);
    }

    function swap(PoolKey memory key, SwapParams memory p, bytes calldata) external returns (int256) {
        require(msg.sender == locker, "locked");
        Pool memory pool = pools[keccak256(abi.encode(key))];
        require(pool.exists, "pool not initialized");
        require(p.amountSpecified < 0, "exact input only in mock");
        lastKey = key;
        uint256 amountIn = uint256(-p.amountSpecified);
        uint256 out = p.zeroForOne
            ? amountIn * pool.priceNum / pool.priceDen
            : amountIn * pool.priceDen / pool.priceNum;
        uint24 fee = key.fee == DYNAMIC_FEE_FLAG ? pool.dynFee : key.fee;
        out = out * (1_000_000 - fee) / 1_000_000;
        out = out * (10_000 - pool.cutOutBps) / 10_000; // hook's cut (afterSwap returns delta)
        uint256 billed = amountIn + pool.extraIn;        // hook's extra bill (beforeSwap returns delta)
        int128 a0 = p.zeroForOne ? -int128(int256(billed)) : int128(int256(out));
        int128 a1 = p.zeroForOne ? int128(int256(out)) : -int128(int256(billed));
        delta[key.currency0] += a0;
        delta[key.currency1] += a1;
        return (int256(a0) << 128) | int256(uint256(uint128(a1)));
    }

    function sync(address c) external { synced = c; syncedReserve = _bal(c); }

    function settle() external payable returns (uint256 paid) {
        require(msg.sender == locker, "locked");
        if (msg.value > 0) { paid = msg.value; delta[address(0)] += int256(paid); }
        else { paid = _bal(synced) - syncedReserve; delta[synced] += int256(paid); synced = address(0); }
    }

    function take(address c, address to, uint256 amount) external {
        require(msg.sender == locker, "locked");
        delta[c] -= int256(amount);
        if (c == address(0)) { (bool ok, ) = to.call{value: amount}(""); require(ok, "eth"); }
        else MockERC20(c).transfer(to, amount);
    }

    receive() external payable {}
}

contract ArbExecutorV4HookedTest is Test {
    ArbExecutor exec;
    MockERC20 usdc;
    MockWETH weth;
    MockV2Pair cheapV2;      // 1 WETH = 3,000 USDC
    MockHookedPoolManager pm;
    MockAavePool aave;
    address bot = makeAddr("bot");
    address hook = address(0x06a889870C8f83640D6816319f72e2aA579b6080); // Fables-style hook (beforeInit + beforeSwap bits)
    uint256 constant E18 = 1e18;
    uint256 constant TRADE = 30_000 * E18;
    uint24 constant DYNAMIC = 0x800000; // dynamic-fee flag, as Fables registers its pools
    uint24 constant HOOK_FEE = 700;     // 0.07%, a fee Fables really charged on a fork swap
    int24 constant SPACING = 10;

    function setUp() public {
        usdc = new MockERC20("USDC", 18);
        weth = new MockWETH();
        exec = new ArbExecutor(bot);
        cheapV2 = new MockV2Pair(address(usdc), address(weth), 30);
        weth.mint(address(cheapV2), 1_000 * E18);
        usdc.mint(address(cheapV2), 3_000_000 * E18);
        cheapV2.sync();

        pm = new MockHookedPoolManager();
        // Hooked WETH/USDC and hooked native-ETH/USDC pools at 3,300, dynamic fee.
        pm.addPool(_key(address(weth), address(usdc), hook), _num(address(weth), address(usdc)), _den(address(weth), address(usdc)), HOOK_FEE);
        pm.addPool(_key(address(0), address(usdc), hook), 3_300, 1, HOOK_FEE);
        usdc.mint(address(pm), 10_000_000 * E18);
        weth.mint(address(pm), 1_000 * E18);
        vm.deal(address(pm), 1_000 * E18);
        vm.deal(address(weth), 10_000 * E18); // real WETH is always fully backed by ETH

        aave = new MockAavePool();
        usdc.mint(address(aave), 10_000_000 * E18);
        exec.setFlashPool(address(aave), true);
    }

    // ---- helpers -----------------------------------------------------------

    function _key(address a, address b, address hooks) internal pure returns (MockHookedPoolManager.PoolKey memory) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return MockHookedPoolManager.PoolKey(c0, c1, DYNAMIC, SPACING, hooks);
    }
    function _num(address w, address u) internal pure returns (uint256) { return w < u ? 3_300 : 1; }
    function _den(address w, address u) internal pure returns (uint256) { return w < u ? 1 : 3_300; }

    function _v2Hop(address tIn, address tOut) internal view returns (ArbExecutor.Hop memory) {
        return ArbExecutor.Hop({kind: 0, pool: address(cheapV2), tokenIn: tIn, tokenOut: tOut, feeBps: 30, v4Fee: 0, v4TickSpacing: 0, v4Native: false});
    }
    // Hooked V4 hop: kind 4, `pool` = the hook.
    function _hookedHop(address hookAddr, address tIn, address tOut, bool native) internal pure returns (ArbExecutor.Hop memory) {
        return ArbExecutor.Hop({kind: 4, pool: hookAddr, tokenIn: tIn, tokenOut: tOut, feeBps: 0, v4Fee: DYNAMIC, v4TickSpacing: SPACING, v4Native: native});
    }
    function _trade(ArbExecutor.Hop memory a, ArbExecutor.Hop memory b, uint256 minProfit) internal view returns (ArbExecutor.Trade memory t) {
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = a; hops[1] = b;
        t = ArbExecutor.Trade({token: address(usdc), amountIn: TRADE, minProfit: minProfit, maxBlock: block.number + 5, hops: hops});
    }
    function _enable() internal { exec.setV4(address(pm), address(weth)); }

    // ---- tests ------------------------------------------------------------

    function test_hooked_kindConstant() public view {
        assertEq(exec.KIND_V4_HOOKED(), 4);
        assertEq(exec.KIND_V4(), 3, "plain V4 kind unchanged");
    }

    function test_hooked_offByDefault() public {
        ArbExecutor.Trade memory t = _trade(_v2Hop(address(usdc), address(weth)), _hookedHop(hook, address(weth), address(usdc), false), 1);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.V4NotEnabled.selector);
        exec.execute(t, address(aave));
    }

    function test_hooked_profitableRoundTrip_wethPool() public {
        _enable();
        ArbExecutor.Trade memory t = _trade(_v2Hop(address(usdc), address(weth)), _hookedHop(hook, address(weth), address(usdc), false), 100 * E18);
        vm.prank(bot);
        exec.execute(t, address(aave));
        assertGt(usdc.balanceOf(address(exec)), 100 * E18, "made USDC profit");
        assertEq(weth.balanceOf(address(exec)), 0, "no WETH left behind");
        (, , uint24 fee, , address usedHooks) = pm.lastKey();
        assertEq(usedHooks, hook, "pool key carried the hook address");
        assertEq(fee, DYNAMIC, "pool key carried the dynamic-fee flag");
    }

    function test_hooked_profitableRoundTrip_nativeEthPool() public {
        _enable();
        ArbExecutor.Trade memory t = _trade(_v2Hop(address(usdc), address(weth)), _hookedHop(hook, address(weth), address(usdc), true), 100 * E18);
        vm.prank(bot);
        exec.execute(t, address(aave));
        assertGt(usdc.balanceOf(address(exec)), 100 * E18, "made USDC profit via hooked native ETH pool");
        assertEq(address(exec).balance, 0, "no ETH left in the contract");
        (address c0, , , , ) = pm.lastKey();
        assertEq(c0, address(0), "native ETH is currency0");
    }

    function test_hooked_buyOnHookedPool_ownCapital() public {
        _enable();
        // Hooked pool first (USDC -> WETH at 3,300 is the DEAR side), V2 back: loses money.
        usdc.mint(address(exec), TRADE);
        ArbExecutor.Trade memory t = _trade(_hookedHop(hook, address(usdc), address(weth), false), _v2Hop(address(weth), address(usdc)), 1);
        vm.prank(bot);
        vm.expectRevert();
        exec.execute(t, address(0));
    }

    // A hook that keeps 1% of our output (afterSwap returning a delta):
    // the delta swap() returns already reflects it, so we settle exactly and
    // the trade only fails if profit drops below minProfit.
    function test_hooked_hookTakesCutOfOutput_settlesAndProfitShrinks() public {
        _enable();
        ArbExecutor.Trade memory t = _trade(_v2Hop(address(usdc), address(weth)), _hookedHop(hook, address(weth), address(usdc), false), 100 * E18);
        uint256 snap = vm.snapshotState();
        vm.prank(bot);
        exec.execute(t, address(aave));
        uint256 profitNoCut = usdc.balanceOf(address(exec));
        vm.revertToState(snap);
        pm.setHookEffects(_key(address(weth), address(usdc), hook), 100, 0); // 1% cut
        vm.prank(bot);
        exec.execute(t, address(aave));
        uint256 profitCut = usdc.balanceOf(address(exec));
        assertLt(profitCut, profitNoCut, "hook cut reduced profit");
        assertGt(profitCut, 0, "still settled and profitable");
    }

    // A hook that bills more than the exact input: refused, so the hook can
    // never make us pay from the contract's other funds.
    function test_hooked_hookBillsMoreThanInput_refused() public {
        _enable();
        pm.setHookEffects(_key(address(weth), address(usdc), hook), 0, 1);
        weth.mint(address(exec), 1 * E18); // spare WETH the hook would like to take
        ArbExecutor.Trade memory t = _trade(_v2Hop(address(usdc), address(weth)), _hookedHop(hook, address(weth), address(usdc), false), 1);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.BadRoute.selector);
        exec.execute(t, address(aave));
    }

    function test_hooked_hookEqualsPoolManager_refused() public {
        _enable();
        ArbExecutor.Trade memory t = _trade(_v2Hop(address(usdc), address(weth)), _hookedHop(address(pm), address(weth), address(usdc), false), 1);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.BadRoute.selector);
        exec.execute(t, address(aave));
    }

    function test_hooked_hookEqualsExecutor_refused() public {
        _enable();
        ArbExecutor.Trade memory t = _trade(_v2Hop(address(usdc), address(weth)), _hookedHop(address(exec), address(weth), address(usdc), false), 1);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.BadRoute.selector);
        exec.execute(t, address(aave));
    }

    function test_hooked_wrongHook_poolNotFound() public {
        _enable();
        ArbExecutor.Trade memory t = _trade(_v2Hop(address(usdc), address(weth)), _hookedHop(address(0xBEEF), address(weth), address(usdc), false), 1);
        vm.prank(bot);
        vm.expectRevert(bytes("pool not initialized"));
        exec.execute(t, address(aave));
    }

    // Plain KIND_V4 still builds hooks = 0: pointed at the same PoolManager it
    // can't reach the hooked pool (backward compatible behaviour).
    function test_plainV4_stillHookless() public {
        _enable();
        ArbExecutor.Hop memory plain = ArbExecutor.Hop({kind: 3, pool: address(pm), tokenIn: address(weth), tokenOut: address(usdc), feeBps: 0, v4Fee: DYNAMIC, v4TickSpacing: SPACING, v4Native: false});
        ArbExecutor.Trade memory t = _trade(_v2Hop(address(usdc), address(weth)), plain, 1);
        vm.prank(bot);
        vm.expectRevert(bytes("pool not initialized"));
        exec.execute(t, address(aave));
    }

    // Unknown kinds above the hooked one are still refused.
    function test_kind5_unsupported() public {
        _enable();
        ArbExecutor.Hop memory bad = _hookedHop(hook, address(weth), address(usdc), false);
        bad.kind = 5;
        ArbExecutor.Trade memory t = _trade(_v2Hop(address(usdc), address(weth)), bad, 1);
        vm.prank(bot);
        vm.expectRevert(abi.encodeWithSelector(ArbExecutor.UnsupportedKind.selector, uint8(5)));
        exec.execute(t, address(aave));
    }
}
