// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";
import {MockERC20, MockV2Pair, MockAavePool} from "./mocks/Mocks.sol";

// ============================================================================
// Uniswap V4 tests for ArbExecutor (KIND_V4)
//
// Uses a mock PoolManager that enforces V4's core rule: inside unlock(),
// every currency's balance with the caller must net to exactly zero by the
// end (pay what you owe, take what you're owed), or the whole call reverts.
// Pools are fixed-price: WETH = 3,300 USDC on V4, 3,000 USDC on a V2 pair,
// so buy-on-V2 / sell-on-V4 is profitable.
//
// Covers: V4 off by default, a profitable WETH and a native-ETH round trip,
// unprofitable reverts, look-alike PoolManager rejected, direct callback
// calls rejected, hooked pools unreachable, stray ETH refused.
// ============================================================================

contract MockWETH is MockERC20 {
    constructor() MockERC20("WETH", 18) {}
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "eth send failed");
    }
}

interface IUnlockCallbackLike { function unlockCallback(bytes calldata data) external returns (bytes memory); }

contract MockV4PoolManager {
    struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
    struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
    struct Pool { bool exists; uint256 priceNum; uint256 priceDen; } // price of currency0 in currency1

    mapping(bytes32 => Pool) public pools;
    mapping(address => int256) public delta; // currency => caller's balance with us (negative = owes)
    address public locker;
    address public synced;
    uint256 public syncedReserve;

    function addPool(PoolKey memory key, uint256 num, uint256 den) external {
        pools[keccak256(abi.encode(key))] = Pool(true, num, den);
    }

    function _bal(address c) internal view returns (uint256) {
        return c == address(0) ? address(this).balance : MockERC20(c).balanceOf(address(this));
    }

    function unlock(bytes calldata data) external returns (bytes memory r) {
        require(locker == address(0), "already unlocked");
        locker = msg.sender;
        r = IUnlockCallbackLike(msg.sender).unlockCallback(data);
        locker = address(0);
    }

    function swap(PoolKey memory key, SwapParams memory p, bytes calldata) external returns (int256) {
        require(msg.sender == locker, "locked");
        Pool memory pool = pools[keccak256(abi.encode(key))];
        require(pool.exists, "pool not initialized"); // a hooked pool's key never matches a hookless one
        require(p.amountSpecified < 0, "exact input only in mock");
        uint256 amountIn = uint256(-p.amountSpecified);
        uint256 out = p.zeroForOne
            ? amountIn * pool.priceNum / pool.priceDen
            : amountIn * pool.priceDen / pool.priceNum;
        out = out * (1_000_000 - key.fee) / 1_000_000;
        int128 a0 = p.zeroForOne ? -int128(int256(amountIn)) : int128(int256(out));
        int128 a1 = p.zeroForOne ? int128(int256(out)) : -int128(int256(amountIn));
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

    function settledAll(address a, address b) external view returns (bool) { return delta[a] == 0 && delta[b] == 0; }

    receive() external payable {}
}

contract ArbExecutorV4Test is Test {
    ArbExecutor exec;
    MockERC20 usdc;
    MockWETH weth;
    MockV2Pair cheapV2;      // 1 WETH = 3,000 USDC
    MockV4PoolManager pm;
    MockAavePool aave;
    address bot = makeAddr("bot");
    address stranger = makeAddr("stranger");
    uint256 constant E18 = 1e18;
    uint256 constant TRADE = 30_000 * E18;
    uint24 constant FEE = 3000;      // 0.30%
    int24 constant SPACING = 60;

    function setUp() public {
        usdc = new MockERC20("USDC", 18);
        weth = new MockWETH();
        exec = new ArbExecutor(bot);
        cheapV2 = new MockV2Pair(address(usdc), address(weth), 30);
        weth.mint(address(cheapV2), 1_000 * E18);
        usdc.mint(address(cheapV2), 3_000_000 * E18);
        cheapV2.sync();

        pm = new MockV4PoolManager();
        // Hookless WETH/USDC pool at 3,300 and a hookless native-ETH/USDC pool at 3,300.
        pm.addPool(_key(address(weth), address(usdc), address(0)), _num(address(weth), address(usdc)), _den(address(weth), address(usdc)));
        pm.addPool(_key(address(0), address(usdc), address(0)), 3_300, 1);
        usdc.mint(address(pm), 10_000_000 * E18);
        weth.mint(address(pm), 1_000 * E18);
        vm.deal(address(pm), 1_000 * E18);
        vm.deal(address(weth), 10_000 * E18); // real WETH is always fully backed by ETH

        aave = new MockAavePool();
        usdc.mint(address(aave), 10_000_000 * E18);
        exec.setFlashPool(address(aave), true);
    }

    // ---- helpers -----------------------------------------------------------

    function _key(address a, address b, address hooks) internal pure returns (MockV4PoolManager.PoolKey memory) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return MockV4PoolManager.PoolKey(c0, c1, FEE, SPACING, hooks);
    }
    // price of currency0 in currency1 for a WETH = 3,300 USDC pool
    function _num(address w, address u) internal pure returns (uint256) { return w < u ? 3_300 : 1; }
    function _den(address w, address u) internal pure returns (uint256) { return w < u ? 1 : 3_300; }

    function _v2Hop(address tIn, address tOut) internal view returns (ArbExecutor.Hop memory) {
        return ArbExecutor.Hop({kind: 0, pool: address(cheapV2), tokenIn: tIn, tokenOut: tOut, feeBps: 30, v4Fee: 0, v4TickSpacing: 0, v4Native: false});
    }
    function _v4Hop(address pool, address tIn, address tOut, bool native) internal pure returns (ArbExecutor.Hop memory) {
        return ArbExecutor.Hop({kind: 3, pool: pool, tokenIn: tIn, tokenOut: tOut, feeBps: 0, v4Fee: FEE, v4TickSpacing: SPACING, v4Native: native});
    }
    function _trade(ArbExecutor.Hop memory a, ArbExecutor.Hop memory b, uint256 minProfit) internal view returns (ArbExecutor.Trade memory t) {
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = a; hops[1] = b;
        t = ArbExecutor.Trade({token: address(usdc), amountIn: TRADE, minProfit: minProfit, maxBlock: block.number + 5, hops: hops});
    }
    function _enable() internal { exec.setV4(address(pm), address(weth)); }

    // ---- tests ------------------------------------------------------------

    function test_v4_offByDefault() public {
        ArbExecutor.Trade memory t = _trade(_v2Hop(address(usdc), address(weth)), _v4Hop(address(pm), address(weth), address(usdc), false), 1);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.V4NotEnabled.selector);
        exec.execute(t, address(aave));
    }

    function test_v4_onlyOwnerCanEnable() public {
        vm.prank(stranger);
        vm.expectRevert(ArbExecutor.NotOwner.selector);
        exec.setV4(address(pm), address(weth));
    }

    function test_v4_profitableRoundTrip_wethPool() public {
        _enable();
        ArbExecutor.Trade memory t = _trade(_v2Hop(address(usdc), address(weth)), _v4Hop(address(pm), address(weth), address(usdc), false), 100 * E18);
        vm.prank(bot);
        exec.execute(t, address(aave));
        assertGt(usdc.balanceOf(address(exec)), 100 * E18, "made USDC profit");
        assertEq(weth.balanceOf(address(exec)), 0, "no WETH left behind");
        assertTrue(pm.settledAll(address(weth), address(usdc)), "PoolManager fully settled");
    }

    function test_v4_profitableRoundTrip_nativeEthPool() public {
        _enable();
        ArbExecutor.Trade memory t = _trade(_v2Hop(address(usdc), address(weth)), _v4Hop(address(pm), address(weth), address(usdc), true), 100 * E18);
        vm.prank(bot);
        exec.execute(t, address(aave));
        assertGt(usdc.balanceOf(address(exec)), 100 * E18, "made USDC profit via native ETH pool");
        assertEq(address(exec).balance, 0, "no ETH left in the contract");
        assertTrue(pm.settledAll(address(0), address(usdc)), "PoolManager fully settled");
    }

    function test_v4_buyOnV4_sellOnV2_reverts_whenUnprofitable() public {
        _enable();
        // Buying WETH on the dear V4 pool and selling on the cheap V2 pair loses money.
        ArbExecutor.Trade memory t = _trade(_v4Hop(address(pm), address(usdc), address(weth), false), _v2Hop(address(weth), address(usdc)), 1);
        vm.prank(bot);
        vm.expectRevert();
        exec.execute(t, address(aave));
    }

    function test_v4_lookalikePoolManager_rejected() public {
        _enable();
        MockV4PoolManager fake = new MockV4PoolManager();
        ArbExecutor.Trade memory t = _trade(_v2Hop(address(usdc), address(weth)), _v4Hop(address(fake), address(weth), address(usdc), false), 1);
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.BadRoute.selector);
        exec.execute(t, address(aave));
    }

    function test_v4_directCallback_rejected() public {
        _enable();
        bytes memory data = abi.encode(_v4Hop(address(pm), address(weth), address(usdc), false), uint256(1e18));
        vm.prank(stranger);
        vm.expectRevert(ArbExecutor.UnauthorizedCallback.selector);
        exec.unlockCallback(data);
        // Even the real PoolManager can't call it outside a trade we started.
        vm.prank(address(pm));
        vm.expectRevert(ArbExecutor.UnauthorizedCallback.selector);
        exec.unlockCallback(data);
    }

    function test_v4_hookedPool_unreachable() public {
        _enable();
        // Only a HOOKED pool exists for this fee/spacing; the contract always
        // uses hooks = 0, so the key never matches and the swap reverts.
        MockV4PoolManager pm2 = new MockV4PoolManager();
        pm2.addPool(_key(address(weth), address(usdc), address(0xBEEF)), _num(address(weth), address(usdc)), _den(address(weth), address(usdc)));
        usdc.mint(address(pm2), 10_000_000 * E18);
        exec.setV4(address(pm2), address(weth));
        ArbExecutor.Trade memory t = _trade(_v2Hop(address(usdc), address(weth)), _v4Hop(address(pm2), address(weth), address(usdc), false), 1);
        vm.prank(bot);
        vm.expectRevert(bytes("pool not initialized"));
        exec.execute(t, address(aave));
    }

    function test_v4_nativeFlag_withoutWeth_rejected() public {
        _enable();
        MockERC20 other = new MockERC20("OTHER", 18);
        bytes memory data = abi.encode(_v4Hop(address(pm), address(other), address(usdc), true), uint256(1e18));
        // Route through a real trade so the callback is "active": the native
        // flag on a pair with no WETH side must be refused.
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = _v4Hop(address(pm), address(usdc), address(other), true);
        hops[1] = _v4Hop(address(pm), address(other), address(usdc), true);
        ArbExecutor.Trade memory t = ArbExecutor.Trade({token: address(usdc), amountIn: TRADE, minProfit: 1, maxBlock: block.number + 5, hops: hops});
        data; // (kept for readability of intent)
        vm.prank(bot);
        vm.expectRevert(ArbExecutor.BadRoute.selector);
        exec.execute(t, address(aave));
    }

    function test_strayEth_refused() public {
        _enable();
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok, ) = address(exec).call{value: 1 ether}("");
        assertFalse(ok, "contract refuses ETH from anyone but WETH / the PoolManager");
    }
}
