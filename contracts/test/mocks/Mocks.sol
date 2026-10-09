// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// ============================================================================
// TEST MOCKS
// Minimal stand-ins for real tokens, DEX pools and Aave, just faithful enough
// to prove ArbExecutor's plumbing and safety checks. They are NOT exact
// replicas of mainnet contracts -- fork tests against real pools are still
// required before going live (see contracts/README.md).
// ============================================================================

contract MockERC20 {
    string public name;
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_, uint8 decimals_) {
        name = name_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

// Uniswap V2 style constant-product pair with K check, like the real thing.
contract MockV2Pair {
    address public immutable token0;
    address public immutable token1;
    uint112 private reserve0;
    uint112 private reserve1;
    uint16 public immutable feeBps;

    constructor(address a, address b, uint16 feeBps_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        feeBps = feeBps_;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, 0);
    }

    function sync() public {
        reserve0 = uint112(MockERC20(token0).balanceOf(address(this)));
        reserve1 = uint112(MockERC20(token1).balanceOf(address(this)));
    }

    function swap(uint256 out0, uint256 out1, address to, bytes calldata) external {
        if (out0 > 0) MockERC20(token0).transfer(to, out0);
        if (out1 > 0) MockERC20(token1).transfer(to, out1);
        uint256 b0 = MockERC20(token0).balanceOf(address(this));
        uint256 b1 = MockERC20(token1).balanceOf(address(this));
        uint256 in0 = b0 > reserve0 - out0 ? b0 - (reserve0 - out0) : 0;
        uint256 in1 = b1 > reserve1 - out1 ? b1 - (reserve1 - out1) : 0;
        // Fee-adjusted K must not decrease (same rule as Uniswap V2).
        uint256 adj0 = b0 * 10_000 - in0 * feeBps;
        uint256 adj1 = b1 * 10_000 - in1 * feeBps;
        require(adj0 * adj1 >= uint256(reserve0) * reserve1 * 1e8, "K");
        sync();
    }
}

// Solidly style pair: quotes its own output via getAmountOut (volatile curve here).
contract MockSolidlyPair {
    address public immutable token0;
    address public immutable token1;
    uint256 public constant FEE_BPS = 5;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function getAmountOut(uint256 amountIn, address tokenIn) public view returns (uint256) {
        (uint256 rIn, uint256 rOut) = tokenIn == token0
            ? (MockERC20(token0).balanceOf(address(this)), MockERC20(token1).balanceOf(address(this)))
            : (MockERC20(token1).balanceOf(address(this)), MockERC20(token0).balanceOf(address(this)));
        uint256 inAfterFee = amountIn * (10_000 - FEE_BPS) / 10_000;
        return inAfterFee * rOut / (rIn + inAfterFee);
    }

    // Simplified: trusts the caller already sent tokens in (balance-based quote above).
    function swap(uint256 out0, uint256 out1, address to, bytes calldata) external {
        if (out0 > 0) MockERC20(token0).transfer(to, out0);
        if (out1 > 0) MockERC20(token1).transfer(to, out1);
    }
}

interface IV3Callback {
    function uniswapV3SwapCallback(int256, int256, bytes calldata) external;
    function pancakeV3SwapCallback(int256, int256, bytes calldata) external;
    function uniswapV3FlashCallback(uint256, uint256, bytes calldata) external;
    function pancakeV3FlashCallback(uint256, uint256, bytes calldata) external;
}

// V3 style pool at a fixed price. Pays out first, then demands payment via
// the callback and checks it arrived -- the same flow real V3 pools use.
contract MockV3Pool {
    address public immutable token0;
    address public immutable token1;
    // price of token0 in token1, as num/den
    uint256 public immutable priceNum;
    uint256 public immutable priceDen;
    bool public immutable pancakeStyle;
    bool private locked; // like real V3 pools: can't swap while lending
    uint256 public constant FLASH_FEE_BPS = 5; // 0.05% fee tier

    constructor(address a, address b, uint256 num, uint256 den, bool pancakeStyle_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        // caller passes price as "a in b"; flip if a ended up as token1
        if (a < b) { priceNum = num; priceDen = den; } else { priceNum = den; priceDen = num; }
        pancakeStyle = pancakeStyle_;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(!locked, "LOK");
        require(amountSpecified > 0, "exact-in only");
        uint256 amountIn = uint256(amountSpecified);
        address tokenIn = zeroForOne ? token0 : token1;
        address tokenOut = zeroForOne ? token1 : token0;
        uint256 amountOut = zeroForOne ? amountIn * priceNum / priceDen : amountIn * priceDen / priceNum;
        amountOut = amountOut * 9_970 / 10_000; // 0.30% fee

        uint256 before = MockERC20(tokenIn).balanceOf(address(this));
        MockERC20(tokenOut).transfer(recipient, amountOut);

        (amount0, amount1) = zeroForOne
            ? (int256(amountIn), -int256(amountOut))
            : (-int256(amountOut), int256(amountIn));
        if (pancakeStyle) IV3Callback(msg.sender).pancakeV3SwapCallback(amount0, amount1, data);
        else IV3Callback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);

        require(MockERC20(tokenIn).balanceOf(address(this)) >= before + amountIn, "IIA");
    }

    // Uniswap V3 flash: lend, call back with the fee owed, check repayment.
    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external {
        require(!locked, "LOK");
        locked = true;
        uint256 fee0 = (amount0 * FLASH_FEE_BPS + 9_999) / 10_000;
        uint256 fee1 = (amount1 * FLASH_FEE_BPS + 9_999) / 10_000;
        uint256 b0 = MockERC20(token0).balanceOf(address(this));
        uint256 b1 = MockERC20(token1).balanceOf(address(this));
        if (amount0 > 0) MockERC20(token0).transfer(recipient, amount0);
        if (amount1 > 0) MockERC20(token1).transfer(recipient, amount1);
        if (pancakeStyle) IV3Callback(msg.sender).pancakeV3FlashCallback(fee0, fee1, data);
        else IV3Callback(msg.sender).uniswapV3FlashCallback(fee0, fee1, data);
        require(MockERC20(token0).balanceOf(address(this)) >= b0 + fee0, "F0");
        require(MockERC20(token1).balanceOf(address(this)) >= b1 + fee1, "F1");
        locked = false;
    }
}

interface IFlashReceiver {
    function executeOperation(address, uint256, uint256, address, bytes calldata) external returns (bool);
}

// Aave V3 flashLoanSimple: lend, call back, pull amount + premium.
contract MockAavePool {
    uint256 public constant PREMIUM_BPS = 5;

    function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16)
        external
    {
        uint256 premium = amount * PREMIUM_BPS / 10_000;
        MockERC20(asset).transfer(receiver, amount);
        require(IFlashReceiver(receiver).executeOperation(asset, amount, premium, receiver, params), "callback");
        MockERC20(asset).transferFrom(receiver, address(this), amount + premium);
    }
}

// ---------------------------------------------------------------------------
// ATTACKERS -- used to prove a stolen executor key can't drain the contract.
// ---------------------------------------------------------------------------

// A fake "V3 pool" that demands far more tokenIn than it was asked to swap,
// paying out `payout` of the other token -- e.g. take the contract's stored
// WETH profits while handing back just enough of the trade token to look
// "profitable".
contract DrainingV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint256 public immutable demand;
    uint256 public immutable payout;

    constructor(address a, address b, uint256 demand_, uint256 payout_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        demand = demand_;
        payout = payout_;
    }

    function swap(address, bool zeroForOne, int256, uint160, bytes calldata data)
        external
        returns (int256, int256)
    {
        int256 d = int256(demand);
        if (zeroForOne) IV3Callback(msg.sender).uniswapV3SwapCallback(d, 0, data);
        else IV3Callback(msg.sender).uniswapV3SwapCallback(0, d, data);
        address tokenOut = zeroForOne ? token1 : token0;
        MockERC20(tokenOut).transfer(msg.sender, payout);
        return (0, 0);
    }
}

// A fake "Aave pool" that swaps in a different route when calling back,
// and tries to leave itself a big allowance.
contract EvilFlashPool {
    bytes public substituteParams;

    function setSubstitute(bytes calldata p) external {
        substituteParams = p;
    }

    function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16)
        external
    {
        bytes memory p = params;
        if (substituteParams.length > 0) p = substituteParams;
        MockERC20(asset).transfer(receiver, amount);
        IFlashReceiver(receiver).executeOperation(asset, amount, type(uint128).max, receiver, p);
        MockERC20(asset).transferFrom(receiver, address(this), amount);
    }
}

// A fake V3 "lender": calls back with a different trade, or a giant fee.
contract EvilV3Lender {
    address public immutable token0;
    address public immutable token1;
    bytes public substituteData;
    uint256 public fakeFee;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function setSubstitute(bytes calldata d) external { substituteData = d; }
    function setFakeFee(uint256 f) external { fakeFee = f; }

    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external {
        if (amount0 > 0) MockERC20(token0).transfer(recipient, amount0);
        if (amount1 > 0) MockERC20(token1).transfer(recipient, amount1);
        bytes memory d = data;
        if (substituteData.length > 0) d = substituteData;
        IV3Callback(msg.sender).uniswapV3FlashCallback(fakeFee, fakeFee, d);
    }
}

interface IAlgebraCallback {
    function algebraSwapCallback(int256, int256, bytes calldata) external;
}

// Algebra Integral style pool at a fixed price (Alandale, KittenSwap).
// Same swap() inputs as Uniswap V3, but it pays out, then calls
// algebraSwapCallback and checks the payment arrived. Like the real pool it
// refuses a price limit that is ON or outside Algebra's MIN/MAX sqrt ratio
// (same numbers as Uniswap's TickMath), or on the wrong side of the price.
// Optional `relay`: instead of calling back itself, the pool asks another
// contract to make the callback (used to prove a different caller is refused).
contract MockAlgebraPool {
    address public immutable token0;
    address public immutable token1;
    uint256 public immutable priceNum; // price of token0 in token1, as num/den
    uint256 public immutable priceDen;
    uint16 public immutable feePips;   // e.g. 500 = 0.05%
    address public relay;

    // Algebra Integral TickMath bounds (identical to Uniswap V3 TickMath).
    uint160 public constant MIN_SQRT_RATIO = 4295128739;
    uint160 public constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;
    // A fixed "current" sqrt price (1:1 in raw units) for the side check.
    uint160 public constant CURRENT_SQRT_PRICE = 79228162514264337593543950336;

    constructor(address a, address b, uint256 num, uint256 den, uint16 feePips_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        if (a < b) { priceNum = num; priceDen = den; } else { priceNum = den; priceDen = num; }
        feePips = feePips_;
    }

    function setRelay(address r) external { relay = r; }

    function swap(address recipient, bool zeroToOne, int256 amountRequired, uint160 limitSqrtPrice, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        // Algebra's limit check (AlgebraPool: invalidLimitSqrtPrice).
        if (zeroToOne) {
            require(limitSqrtPrice < CURRENT_SQRT_PRICE && limitSqrtPrice > MIN_SQRT_RATIO, "invalidLimitSqrtPrice");
        } else {
            require(limitSqrtPrice > CURRENT_SQRT_PRICE && limitSqrtPrice < MAX_SQRT_RATIO, "invalidLimitSqrtPrice");
        }
        require(amountRequired > 0, "exact-in only");
        uint256 amountIn = uint256(amountRequired);
        address tokenIn = zeroToOne ? token0 : token1;
        address tokenOut = zeroToOne ? token1 : token0;
        uint256 amountOut = zeroToOne ? amountIn * priceNum / priceDen : amountIn * priceDen / priceNum;
        amountOut = amountOut * (1_000_000 - feePips) / 1_000_000;

        uint256 before = MockERC20(tokenIn).balanceOf(address(this));
        MockERC20(tokenOut).transfer(recipient, amountOut);

        (amount0, amount1) = zeroToOne
            ? (int256(amountIn), -int256(amountOut))
            : (-int256(amountOut), int256(amountIn));
        if (relay != address(0)) AlgebraCallbackRelay(relay).poke(msg.sender, amount0, amount1, data);
        else IAlgebraCallback(msg.sender).algebraSwapCallback(amount0, amount1, data);

        require(MockERC20(tokenIn).balanceOf(address(this)) >= before + amountIn, "insufficientInputAmount");
    }
}

// Calls algebraSwapCallback on a target from ITS OWN address: a contract
// that is not the pool being swapped with. The executor must refuse it.
contract AlgebraCallbackRelay {
    function poke(address target, int256 a0, int256 a1, bytes calldata data) external {
        IAlgebraCallback(target).algebraSwapCallback(a0, a1, data);
    }
}
