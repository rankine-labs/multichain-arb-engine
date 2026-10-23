// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// ============================================================================
// Helper contracts for the practice chain (anvil) ONLY.
// (Copy of bench/event-copy-test/Helpers.sol, used by
// sim/tests/copy2_replay_anvil.rs; compiled by sim/tools/copy2/build.js into
// tests/fixtures/copy2/artifacts.json. The `Replayer` here is the original
// the sidecar's ReplayHelper.sol was ported from; the test doesn't use it.)
//
// Plain English:
//   - Token:  a plain coin that behaves like a normal ERC-20 and, importantly,
//             announces EVERY balance change with a Transfer event (also when
//             new coins are minted). Balances live at storage slot 0
//             (mapping), so a holder's balance slot = keccak(holder, 0).
//   - Trader: the "other market players". It swaps, adds and removes
//             liquidity on the pools we test, paying the pools when they call
//             back (Uniswap/Pancake/Algebra callback names), and can "donate"
//             coins straight to a pool.
//   - PancakeDeployer: PancakeSwap V3 pools ask their deployer for their
//             settings while being created; npm ships only the pool code, so
//             this stands in for Pancake's real deployer (same answers).
// ============================================================================

contract Token {
    // slot 0: balances, slot 1: allowances, slot 2: total supply
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    string public symbol;
    uint8 public immutable decimals;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory s, uint8 d) { symbol = s; decimals = d; }

    function mint(address to, uint256 a) external {
        totalSupply += a;
        balanceOf[to] += a;
        emit Transfer(address(0), to, a);
    }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        emit Transfer(msg.sender, to, a);
        return true;
    }
    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        emit Approval(msg.sender, s, a);
        return true;
    }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[t] += a;
        emit Transfer(f, t, a);
        return true;
    }
}

// A coin whose balance word counts only its LOW 128 bits (live Robinhood
// USDG, probed Oct 22 copy2-r: raw 2^128 + 5 reads as 5, raw 2^200 + 999
// can't pay 1000): the high half of the word is another field. Balances at
// slot 0 like Token (keccak(holder . 0)).
contract Token128 {
    struct Acct { uint128 bal; uint128 other; }
    mapping(address => Acct) internal acct;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    string public symbol;
    uint8 public immutable decimals;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory s, uint8 d) { symbol = s; decimals = d; }

    function balanceOf(address a) external view returns (uint256) { return acct[a].bal; }
    function mint(address to, uint256 a) external {
        totalSupply += a;
        acct[to].bal += uint128(a);
        emit Transfer(address(0), to, a);
    }
    function _move(address f, address t, uint256 a) internal {
        require(acct[f].bal >= a, "insufficient balance");
        acct[f].bal -= uint128(a);
        acct[t].bal += uint128(a);
        emit Transfer(f, t, a);
    }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        emit Approval(msg.sender, s, a);
        return true;
    }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        _move(f, t, a);
        return true;
    }
}

interface IV3Like {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external returns (int256, int256);
    function mint(address recipient, int24 lo, int24 hi, uint128 amount, bytes calldata data) external returns (uint256, uint256);
    function burn(int24 lo, int24 hi, uint128 amount) external returns (uint256, uint256);
    function collect(address recipient, int24 lo, int24 hi, uint128 a0, uint128 a1) external returns (uint128, uint128);
}

interface IFlashLike {
    function flash(address recipient, uint256 a0, uint256 a1, bytes calldata data) external;
}

interface IAlgebraLike {
    function mint(address leftoversRecipient, address recipient, int24 lo, int24 hi, uint128 liq, bytes calldata data)
        external returns (uint256, uint256, uint128);
    function burn(int24 lo, int24 hi, uint128 amount, bytes calldata data) external returns (uint256, uint256);
}

interface IV2Like {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256 a0, uint256 a1, address to, bytes calldata data) external;
    function mint(address to) external returns (uint256);
    function burn(address to) external returns (uint256, uint256);
    function transfer(address to, uint256 v) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface ISolidlyLike {
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
}

contract Trader {
    uint160 constant MIN_P = 4295128740;
    uint160 constant MAX_P = 1461446703485210103287273052203988822378723970341;

    // ---- V3-style pools (Uniswap V3, PancakeSwap V3, Algebra) ----
    // Exact-input swap; the pool calls one of the callbacks below to be paid.
    // amount > 0: exact input; amount < 0: exact output. limit 0 = no price limit.
    function swapV3(address pool, bool zeroForOne, int256 amount, uint160 limit) external {
        IV3Like(pool).swap(address(this), zeroForOne, amount, limit != 0 ? limit : (zeroForOne ? MIN_P : MAX_P), abi.encode(pool));
    }
    function _pay(int256 d0, int256 d1) internal {
        if (d0 > 0) Token(IV3Like(msg.sender).token0()).transfer(msg.sender, uint256(d0));
        if (d1 > 0) Token(IV3Like(msg.sender).token1()).transfer(msg.sender, uint256(d1));
    }
    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external { _pay(d0, d1); }
    function pancakeV3SwapCallback(int256 d0, int256 d1, bytes calldata) external { _pay(d0, d1); }
    function algebraSwapCallback(int256 d0, int256 d1, bytes calldata) external { _pay(d0, d1); }

    function mintV3(address pool, int24 lo, int24 hi, uint128 liq) external {
        IV3Like(pool).mint(address(this), lo, hi, liq, "");
    }
    function burnV3(address pool, int24 lo, int24 hi, uint128 liq, bool collectToo) external {
        IV3Like(pool).burn(lo, hi, liq);
        if (collectToo) IV3Like(pool).collect(address(this), lo, hi, type(uint128).max, type(uint128).max);
    }
    function collectV3(address pool, int24 lo, int24 hi) external {
        IV3Like(pool).collect(address(this), lo, hi, type(uint128).max, type(uint128).max);
    }
    function uniswapV3MintCallback(uint256 o0, uint256 o1, bytes calldata) external { _pay(int256(o0), int256(o1)); }
    function pancakeV3MintCallback(uint256 o0, uint256 o1, bytes calldata) external { _pay(int256(o0), int256(o1)); }
    function algebraMintCallback(uint256 o0, uint256 o1, bytes calldata) external { _pay(int256(o0), int256(o1)); }

    // Flash loan from a V3-style pool: borrow, then repay with the pool's fee.
    function flashV3(address pool, uint256 a0, uint256 a1) external {
        IFlashLike(pool).flash(address(this), a0, a1, abi.encode(a0, a1));
    }
    function _repay(uint256 f0, uint256 f1, bytes calldata data) internal {
        (uint256 a0, uint256 a1) = abi.decode(data, (uint256, uint256));
        if (a0 + f0 > 0) Token(IV3Like(msg.sender).token0()).transfer(msg.sender, a0 + f0);
        if (a1 + f1 > 0) Token(IV3Like(msg.sender).token1()).transfer(msg.sender, a1 + f1);
    }
    function uniswapV3FlashCallback(uint256 f0, uint256 f1, bytes calldata d) external { _repay(f0, f1, d); }
    function pancakeV3FlashCallback(uint256 f0, uint256 f1, bytes calldata d) external { _repay(f0, f1, d); }
    function algebraFlashCallback(uint256 f0, uint256 f1, bytes calldata d) external { _repay(f0, f1, d); }

    // Algebra's mint/burn take extra arguments.
    function mintAlgebra(address pool, int24 lo, int24 hi, uint128 liq) external {
        IAlgebraLike(pool).mint(address(this), address(this), lo, hi, liq, "");
    }
    function burnAlgebra(address pool, int24 lo, int24 hi, uint128 liq, bool collectToo) external {
        IAlgebraLike(pool).burn(lo, hi, liq, "");
        if (collectToo) IV3Like(pool).collect(address(this), lo, hi, type(uint128).max, type(uint128).max);
    }

    // ---- V2-style pairs (Uniswap V2 and Solidly/Velodrome) ----
    // Sends amountIn to the pair and takes the matching output.
    // solidly = true: ask the pair for its own price (stable/volatile curve + fee).
    function swapV2(address pair, address tokenIn, uint256 amountIn, bool solidly) external {
        IV2Like p = IV2Like(pair);
        bool inIs0 = p.token0() == tokenIn;
        uint256 out;
        if (solidly) {
            out = ISolidlyLike(pair).getAmountOut(amountIn, tokenIn);
        } else {
            (uint112 r0, uint112 r1, ) = p.getReserves();
            (uint256 rin, uint256 rout) = inIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
            uint256 inFee = amountIn * 997;
            out = (inFee * rout) / (rin * 1000 + inFee);
        }
        Token(tokenIn).transfer(pair, amountIn);
        if (out == 0) return;
        p.swap(inIs0 ? 0 : out, inIs0 ? out : 0, address(this), "");
    }
    // Adds liquidity (amounts as given) and keeps the LP tokens here.
    function mintV2(address pair, uint256 a0, uint256 a1) external {
        Token(IV2Like(pair).token0()).transfer(pair, a0);
        Token(IV2Like(pair).token1()).transfer(pair, a1);
        IV2Like(pair).mint(address(this));
    }
    // Removes `share` (out of 1e18) of our LP tokens.
    function burnV2(address pair, uint256 share) external {
        uint256 lp = (IV2Like(pair).balanceOf(address(this)) * share) / 1e18;
        if (lp == 0) return;
        IV2Like(pair).transfer(pair, lp);
        IV2Like(pair).burn(address(this));
    }

    // ---- donations: coins sent straight to a pool ----
    function donate(address token, address to, uint256 a) external { Token(token).transfer(to, a); }

    // ---- approvals (for V4 test routers that pull coins with transferFrom) ----
    function approveAll(address token, address spender) external { Token(token).approve(spender, type(uint256).max); }

    // Generic forwarder: lets the EOA make this contract call anything (V4 routers).
    function call(address to, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = to.call(data);
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
        return ret;
    }
}

// Stand-in for PancakeSwap's pool deployer: the new pool calls parameters()
// from its constructor to learn its factory, coins, fee and tick spacing.
contract PancakeDeployer {
    struct Params { address factory; address token0; address token1; uint24 fee; int24 tickSpacing; }
    Params public parameters;
    function deploy(bytes calldata initCode, address factory, address t0, address t1, uint24 fee, int24 spacing)
        external returns (address pool)
    {
        parameters = Params(factory, t0, t1, fee, spacing);
        bytes memory code = initCode;
        assembly { pool := create(0, add(code, 32), mload(code)) }
        require(pool != address(0), "deploy failed");
        delete parameters;
    }
}

// ============================================================================
// Replayer: used ONLY on the COPY chain, inside a pretend call (eth_call /
// debug_traceCall with a code override), never as a real transaction.
//
// Plain English: when the copy sees a pool event (Swap, Mint, Flash...), it can
// ask the pool's OWN code on the copy to do the same action again, with the
// numbers from the event. The pool then updates every one of its own storage
// slots exactly like on the real chain (fee counters, price history, ticks).
// We keep only the POOL's storage changes from that pretend call; coin
// balances are kept from the coins' own Transfer events instead.
// It pays whatever the pool asks (it is given coins by an override).
// ============================================================================
contract Replayer {
    uint160 constant MIN_P = 4295128740;
    uint160 constant MAX_P = 1461446703485210103287273052203988822378723970341;

    function swap(address pool, bool zeroForOne, int256 amount, uint160 limit) external returns (int256 a0, int256 a1) {
        (a0, a1) = IV3Like(pool).swap(address(this), zeroForOne, amount, limit != 0 ? limit : (zeroForOne ? MIN_P : MAX_P), "");
    }
    function _pay(int256 d0, int256 d1) internal {
        if (d0 > 0) Token(IV3Like(msg.sender).token0()).transfer(msg.sender, uint256(d0));
        if (d1 > 0) Token(IV3Like(msg.sender).token1()).transfer(msg.sender, uint256(d1));
    }
    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external { _pay(d0, d1); }
    function pancakeV3SwapCallback(int256 d0, int256 d1, bytes calldata) external { _pay(d0, d1); }
    function algebraSwapCallback(int256 d0, int256 d1, bytes calldata) external { _pay(d0, d1); }

    // Liquidity added for `owner` (the position belongs to `owner`, as in the event).
    function mint(address pool, address owner, int24 lo, int24 hi, uint128 liq) external returns (uint256, uint256) {
        return IV3Like(pool).mint(owner, lo, hi, liq, "");
    }
    function mintAlgebra(address pool, address owner, int24 lo, int24 hi, uint128 liq) external returns (uint256 a0, uint256 a1, uint128 l) {
        (a0, a1, l) = IAlgebraLike(pool).mint(address(this), owner, lo, hi, liq, "");
    }
    function uniswapV3MintCallback(uint256 o0, uint256 o1, bytes calldata) external { _pay(int256(o0), int256(o1)); }
    function pancakeV3MintCallback(uint256 o0, uint256 o1, bytes calldata) external { _pay(int256(o0), int256(o1)); }
    function algebraMintCallback(uint256 o0, uint256 o1, bytes calldata) external { _pay(int256(o0), int256(o1)); }

    // Flash loan that pays back exactly what the event says was paid.
    function flash(address pool, uint256 a0, uint256 a1, uint256 paid0, uint256 paid1) external {
        IFlashLike(pool).flash(address(this), a0, a1, abi.encode(a0 + paid0, a1 + paid1));
    }
    function _back(bytes calldata data) internal {
        (uint256 b0, uint256 b1) = abi.decode(data, (uint256, uint256));
        if (b0 > 0) Token(IV3Like(msg.sender).token0()).transfer(msg.sender, b0);
        if (b1 > 0) Token(IV3Like(msg.sender).token1()).transfer(msg.sender, b1);
    }
    function uniswapV3FlashCallback(uint256, uint256, bytes calldata d) external { _back(d); }
    function pancakeV3FlashCallback(uint256, uint256, bytes calldata d) external { _back(d); }
    function algebraFlashCallback(uint256, uint256, bytes calldata d) external { _back(d); }
}

// ============================================================================
// Uniswap V4 helper: trades / adds liquidity / donates through the
// PoolManager (one contract that holds every V4 pool). V4 works by
// "unlocking" the PoolManager, which calls us back; we act, then pay what we
// owe (sync + transfer + settle) and take what we are owed.
// Also used on the COPY chain in pretend calls to replay V4 events.
// ============================================================================
struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
struct ModifyLiquidityParams { int24 tickLower; int24 tickUpper; int256 liquidityDelta; bytes32 salt; }

interface IPoolManagerLike {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData) external returns (int256, int256);
    function donate(PoolKey memory key, uint256 a0, uint256 a1, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

contract V4Trader {
    uint160 constant MIN_P = 4295128740;
    uint160 constant MAX_P = 1461446703485210103287273052203988822378723970341;
    IPoolManagerLike public immutable pm;
    constructor(address _pm) { pm = IPoolManagerLike(_pm); }

    // action 0 = swap, 1 = modifyLiquidity, 2 = donate
    function swap(PoolKey calldata key, bool zeroForOne, int256 amountSpecified, uint160 limit) external returns (int256 delta) {
        SwapParams memory p = SwapParams(zeroForOne, amountSpecified, limit != 0 ? limit : (zeroForOne ? MIN_P : MAX_P));
        delta = abi.decode(pm.unlock(abi.encode(uint8(0), key, abi.encode(p))), (int256));
    }
    function modify(PoolKey calldata key, int24 lo, int24 hi, int256 liq, bytes32 salt) external returns (int256 delta) {
        delta = abi.decode(pm.unlock(abi.encode(uint8(1), key, abi.encode(ModifyLiquidityParams(lo, hi, liq, salt)))), (int256));
    }
    function donate(PoolKey calldata key, uint256 a0, uint256 a1) external returns (int256 delta) {
        delta = abi.decode(pm.unlock(abi.encode(uint8(2), key, abi.encode(a0, a1))), (int256));
    }
    function coinDonate(address token, address to, uint256 a) external { Token(token).transfer(to, a); }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "not pm");
        (uint8 action, PoolKey memory key, bytes memory inner) = abi.decode(data, (uint8, PoolKey, bytes));
        int256 delta;
        if (action == 0) {
            delta = pm.swap(key, abi.decode(inner, (SwapParams)), "");
        } else if (action == 1) {
            (int256 callerDelta, ) = pm.modifyLiquidity(key, abi.decode(inner, (ModifyLiquidityParams)), "");
            delta = callerDelta;
        } else {
            (uint256 a0, uint256 a1) = abi.decode(inner, (uint256, uint256));
            delta = pm.donate(key, a0, a1, "");
        }
        _settle(key.currency0, int128(delta >> 128));
        _settle(key.currency1, int128(delta));
        return abi.encode(delta);
    }
    // negative = we owe the PoolManager; positive = it owes us
    function _settle(address c, int128 d) internal {
        if (d < 0) {
            pm.sync(c);
            Token(c).transfer(address(pm), uint256(uint128(-d)));
            pm.settle();
        } else if (d > 0) {
            pm.take(c, address(this), uint256(uint128(d)));
        }
    }
}

// ============================================================================
// TestLmPool: stand-in for PancakeSwap's farm contract ("LM pool").
//
// Plain English: a PancakeSwap V3 pool with a farm calls it on every swap
// (accumulateReward) and on every crossed price point (crossLmTick). The
// farm's own numbers are ALSO changed by the farm's owner (staking /
// unstaking through MasterChef) in transactions that emit NO pool event,
// so a copy that follows only the pool's events can't keep the farm
// current. Here: crossLmTick uses up one unit of `credit` and refuses
// with "LS" (the real farm's LiquidityMath error) when there is none left;
// `addCredit` is the owner's out-of-band change. A stale copy of `credit`
// makes a copy-side swap fail with "LS" while the chain's swap succeeds,
// which is exactly what dry run #17 saw on a PancakeSwap pool.
// ============================================================================
contract TestLmPool {
    uint256 public credit;
    uint256 public rewards;
    constructor(uint256 c) { credit = c; }
    function accumulateReward(uint32 t) external { rewards += t; }
    function crossLmTick(int24, bool) external {
        require(credit > 0, "LS");
        credit -= 1;
    }
    function addCredit(uint256 c) external { credit += c; }
}
