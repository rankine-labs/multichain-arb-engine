// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// ============================================================================
// COPY 2 REPLAY HELPERS (used ONLY inside arbsim's private EVM, never deployed)
//
// Plain English:
//   When one of our pools reports an event (a swap, a liquidity add, a flash
//   loan...), arbsim re-does that same action with the POOL'S OWN CODE on
//   its copy of the pool. The pool then updates every one of its storage
//   slots exactly as it did on the real chain (fee counters, price history,
//   ticks, the Algebra plugin's fee history...). Pools insist on being paid
//   through a "callback" while they work, so something must play the trader:
//   that is `ReplayHelper`.
//
//   - ReplayHelper is placed (only inside the private EVM run) at the SAME
//     address that did the action on the real chain (the event's `sender`),
//     so the pool sees the same caller and writes the same event.
//   - StubToken stands in for both coins of the pool during the replay. The
//     real coin contracts are NOT run: their balances are kept separately
//     by the event intake (coin Transfer events), and the pool only needs
//     "balanceOf" and "transfer" to work. Every change made to the stub coins
//     is thrown away afterwards; only the pool's own storage is kept.
//
//   Port of Helpers.sol `Replayer` + `V4Trader` from the offline proof
//   (bench/event-copy-test), which was exact on 21,618 checks.
//
// Build: sim/tools/copy2/build.js compiles this file (solc 0.8.26, optimizer
// 200 runs, cancun) and writes the runtime code next to it
// (replay_helper.hex, stub_token.hex), which replay.rs embeds.
// ============================================================================

// ---------------------------------------------------------------------------
// StubToken: the simplest possible coin. Balances in a mapping at slot 0.
// arbsim decides what each holder's balance starts at (see replay.rs).
// No events, no allowances: nothing here is ever kept.
// ---------------------------------------------------------------------------
contract StubToken {
    mapping(address => uint256) public balanceOf; // slot 0

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        balanceOf[f] -= a;
        balanceOf[t] += a;
        return true;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function allowance(address, address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }
}

interface IPoolTokens {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IV3Pool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256, int256);
    function mint(address recipient, int24 lo, int24 hi, uint128 amount, bytes calldata data) external returns (uint256, uint256);
    function flash(address recipient, uint256 a0, uint256 a1, bytes calldata data) external;
}

interface IAlgebraPool {
    function mint(address leftoversRecipient, address recipient, int24 lo, int24 hi, uint128 liq, bytes calldata data)
        external
        returns (uint256, uint256, uint128);
}

interface IERC20Min {
    function transfer(address to, uint256 a) external returns (bool);
}

// Uniswap V4 shapes (same as v4-core 1.0).
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256, int256);
    function donate(PoolKey memory key, uint256 a0, uint256 a1, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

// ---------------------------------------------------------------------------
// ReplayHelper: plays the trader. No storage at all (it is placed at other
// contracts' addresses during a replay, so it must not depend on any).
// ---------------------------------------------------------------------------
contract ReplayHelper {
    uint160 constant MIN_P = 4295128740;
    uint160 constant MAX_P = 1461446703485210103287273052203988822378723970341;

    // ---- V3-style pools (Uniswap V3, PancakeSwap V3, Algebra) ----

    // Swap. amount > 0: exact input; < 0: exact output. limit 0 = no limit.
    function swap(address pool, address recipient, bool zeroForOne, int256 amount, uint160 limit)
        external
        returns (int256 a0, int256 a1)
    {
        (a0, a1) = IV3Pool(pool).swap(recipient, zeroForOne, amount, limit != 0 ? limit : (zeroForOne ? MIN_P : MAX_P), "");
    }

    // Pay whatever the pool asks for (positive = we owe it).
    function _pay(int256 d0, int256 d1) internal {
        if (d0 > 0) IERC20Min(IPoolTokens(msg.sender).token0()).transfer(msg.sender, uint256(d0));
        if (d1 > 0) IERC20Min(IPoolTokens(msg.sender).token1()).transfer(msg.sender, uint256(d1));
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        _pay(d0, d1);
    }

    function pancakeV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        _pay(d0, d1);
    }

    function algebraSwapCallback(int256 d0, int256 d1, bytes calldata) external {
        _pay(d0, d1);
    }

    // Liquidity added for `owner` (the position belongs to `owner`, as in the event).
    function mint(address pool, address owner, int24 lo, int24 hi, uint128 liq) external returns (uint256, uint256) {
        return IV3Pool(pool).mint(owner, lo, hi, liq, "");
    }

    function mintAlgebra(address pool, address owner, int24 lo, int24 hi, uint128 liq)
        external
        returns (uint256 a0, uint256 a1, uint128 l)
    {
        (a0, a1, l) = IAlgebraPool(pool).mint(address(this), owner, lo, hi, liq, "");
    }

    function uniswapV3MintCallback(uint256 o0, uint256 o1, bytes calldata) external {
        _pay(int256(o0), int256(o1));
    }

    function pancakeV3MintCallback(uint256 o0, uint256 o1, bytes calldata) external {
        _pay(int256(o0), int256(o1));
    }

    function algebraMintCallback(uint256 o0, uint256 o1, bytes calldata) external {
        _pay(int256(o0), int256(o1));
    }

    // Flash loan that pays back exactly what the event says was paid.
    function flash(address pool, address recipient, uint256 a0, uint256 a1, uint256 paid0, uint256 paid1) external {
        IV3Pool(pool).flash(recipient, a0, a1, abi.encode(a0 + paid0, a1 + paid1));
    }

    function _back(bytes calldata data) internal {
        (uint256 b0, uint256 b1) = abi.decode(data, (uint256, uint256));
        if (b0 > 0) IERC20Min(IPoolTokens(msg.sender).token0()).transfer(msg.sender, b0);
        if (b1 > 0) IERC20Min(IPoolTokens(msg.sender).token1()).transfer(msg.sender, b1);
    }

    function uniswapV3FlashCallback(uint256, uint256, bytes calldata d) external {
        _back(d);
    }

    function pancakeV3FlashCallback(uint256, uint256, bytes calldata d) external {
        _back(d);
    }

    function algebraFlashCallback(uint256, uint256, bytes calldata d) external {
        _back(d);
    }

    // ---- Uniswap V4 (inside the PoolManager) ----
    // The PoolManager must be "unlocked"; it then calls unlockCallback, where
    // we act and settle what we owe / take what we are owed.
    // action 0 = swap, 1 = modifyLiquidity, 2 = donate.

    function v4Swap(address pm, PoolKey calldata key, bool zeroForOne, int256 amountSpecified, uint160 limit)
        external
        returns (int256 delta)
    {
        SwapParams memory p = SwapParams(zeroForOne, amountSpecified, limit != 0 ? limit : (zeroForOne ? MIN_P : MAX_P));
        delta = abi.decode(IPoolManager(pm).unlock(abi.encode(uint8(0), pm, key, abi.encode(p))), (int256));
    }

    function v4Modify(address pm, PoolKey calldata key, int24 lo, int24 hi, int256 liq, bytes32 salt)
        external
        returns (int256 delta)
    {
        bytes memory inner = abi.encode(ModifyLiquidityParams(lo, hi, liq, salt));
        delta = abi.decode(IPoolManager(pm).unlock(abi.encode(uint8(1), pm, key, inner)), (int256));
    }

    function v4Donate(address pm, PoolKey calldata key, uint256 a0, uint256 a1) external returns (int256 delta) {
        delta = abi.decode(IPoolManager(pm).unlock(abi.encode(uint8(2), pm, key, abi.encode(a0, a1))), (int256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (uint8 action, address pm, PoolKey memory key, bytes memory inner) = abi.decode(data, (uint8, address, PoolKey, bytes));
        IPoolManager m = IPoolManager(pm);
        int256 delta;
        if (action == 0) {
            delta = m.swap(key, abi.decode(inner, (SwapParams)), "");
        } else if (action == 1) {
            (int256 callerDelta,) = m.modifyLiquidity(key, abi.decode(inner, (ModifyLiquidityParams)), "");
            delta = callerDelta;
        } else {
            (uint256 a0, uint256 a1) = abi.decode(inner, (uint256, uint256));
            delta = m.donate(key, a0, a1, "");
        }
        _settle(m, key.currency0, int128(delta >> 128));
        _settle(m, key.currency1, int128(delta));
        return abi.encode(delta);
    }

    // negative = we owe the PoolManager; positive = it owes us.
    // currency 0x0 = native ETH (paid with value; arbsim gives us plenty).
    function _settle(IPoolManager m, address c, int128 d) internal {
        if (d < 0) {
            uint256 owed = uint256(uint128(-d));
            if (c == address(0)) {
                m.settle{value: owed}();
            } else {
                m.sync(c);
                IERC20Min(c).transfer(address(m), owed);
                m.settle();
            }
        } else if (d > 0) {
            m.take(c, address(this), uint256(uint128(d)));
        }
    }

    receive() external payable {}
}
