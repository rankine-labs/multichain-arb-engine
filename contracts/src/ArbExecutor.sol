// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// ============================================================================
// ARB EXECUTOR
//
// Plain English:
//   The bot finds a price gap between two pools. This contract executes the
//   round trip in ONE transaction: buy on pool A, sell on pool B, end up
//   with more of the starting token than we began with. If at the end we
//   don't have at least `minProfit` more, the WHOLE transaction reverts and
//   nothing happens except a small gas cost. It can never "half-execute".
//
// Funding (pick per trade) -- the first two need NO money in the contract:
//   - Aave V3 flash loan: execute(t, aavePool). Borrow, trade, repay in the
//     same transaction. Use where Aave exists (Avalanche).
//   - V3 pool flash loan: executeWithV3Flash(t, lendPool). Borrow from any
//     Uniswap V3 / PancakeSwap V3 / Ramses V3 pool holding the token (fee =
//     that pool's fee tier). Works on any chain with V3 pools (Robinhood,
//     Monad, Avalanche). The lending pool must NOT be one of the trade's pools.
//   - Own capital: execute(t, address(0)). Trades tokens already held here.
//   Lenders (Aave pools and V3 lending pools) must be allowlisted by the owner.
//
// Pool types supported (Hop.kind):
//   KIND_V2      Uniswap V2 style: TraderJoe v1, Sushi, PancakeSwap V2, LFJ v1
//   KIND_SOLIDLY Solidly style:   Ramses V2 (stable and volatile pairs)
//   KIND_V3      Concentrated liquidity: Uniswap V3, PancakeSwap V3, Ramses V3
//   KIND_V4      Uniswap V4 (one PoolManager holds every pool). Only pools
//                WITHOUT hooks (custom add-on code): the contract always
//                builds the pool key with hooks = address(0), so a hooked
//                pool simply can't be reached. Native-ETH pools are traded
//                through WETH (unwrapped going in, wrapped coming out).
//                Off until the owner calls setV4(poolManager, weth).
//   NOT supported (reverts UnsupportedKind): LFJ Liquidity Book, Kuru
//   orderbook. Add them as new kinds when needed.
//
// Who can do what:
//   owner    - cold wallet. Sets the executor, withdraws profits. Fixed at deploy.
//   executor - the bot's hot wallet. Can ONLY call execute().
//
// Safety model (why a stolen executor key can't drain the contract):
//   Every token any hop touches is snapshotted before the trade. After the
//   trade, none of them may have gone down, and the starting token must be up
//   by at least minProfit. A fake "pool" that tries to take tokens fails that
//   check and the whole transaction reverts. Callbacks (Aave + V3) only
//   accept calls from the exact pool this contract is currently trading
//   with, and only while a trade is in progress.
//   Still: sweep profits to the owner regularly. A balance that isn't there
//   can't be at risk.
// ============================================================================

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IUniswapV2Pair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface ISolidlyPair {
    function token0() external view returns (address);
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

// Uniswap V3-style pool flash loan (PancakeSwap V3 / Ramses V3 are forks).
interface IV3FlashPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external;
}

// Uniswap V4 PoolManager (only what we use). Currency = token address,
// address(0) = native ETH. BalanceDelta packs two int128s: amount0 in the
// high 128 bits, amount1 in the low 128 bits. Negative = we owe the pool,
// positive = the pool owes us.
interface IV4PoolManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }
    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified; // negative = exact input
        uint160 sqrtPriceLimitX96;
    }
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IAaveV3Pool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

contract ArbExecutor {
    // ------------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------------

    uint8 public constant KIND_V2 = 0;
    uint8 public constant KIND_SOLIDLY = 1;
    uint8 public constant KIND_V3 = 2;
    uint8 public constant KIND_V4 = 3;

    // One swap in the route.
    struct Hop {
        uint8 kind;        // KIND_V2 / KIND_SOLIDLY / KIND_V3 / KIND_V4
        address pool;      // the pair / pool contract itself (NOT a router). KIND_V4: the PoolManager.
        address tokenIn;
        address tokenOut;
        uint16 feeBps;     // KIND_V2 only: pool fee in basis points (30 = 0.30%). Ignored otherwise.
        uint24 v4Fee;      // KIND_V4 only: the pool's fee in pips (3000 = 0.30%)
        int24 v4TickSpacing; // KIND_V4 only: the pool's tick spacing
        bool v4Native;     // KIND_V4 only: the pool holds native ETH where the route has WETH
    }

    // A full round trip. Route must start and end in `token`.
    struct Trade {
        address token;      // the token we start with and must end with more of
        uint256 amountIn;   // how much of `token` to put into the first hop
        uint256 minProfit;  // revert unless we end with at least this much more `token` (after flash fee)
        uint256 maxBlock;   // revert if mined after this block (stale opportunity)
        Hop[] hops;
    }

    // ------------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------------

    address public immutable owner;
    address public executor;

    // Aave pools the owner has approved for flash loans. The executor can't
    // point execute() at an arbitrary contract pretending to be a lender.
    mapping(address => bool) public flashPools;

    // Set only while execute() is running. Callbacks check these, so nothing
    // can call them outside a trade we started, or from the wrong contract.
    address private activeFlashPool;   // Aave pool we requested a flash loan from
    bytes32 private activeTradeHash;   // hash of the exact trade that was snapshotted and checked
    address private activeV3Pool;      // V3 pool we are mid-swap with
    address private activeV3TokenIn;   // token that V3 pool is owed
    bool private locked;               // re-entrancy guard
    bool private activeFlashIs0;       // V3 flash: borrowed token is the lending pool's token0
    bool private activeV4;             // true only while we are inside our own PoolManager.unlock()

    // Uniswap V4 (zero = V4 trading off). Set by the owner once per chain.
    address public v4PoolManager;
    address public weth;               // wrapped native token, for native-ETH V4 pools

    // ------------------------------------------------------------------------
    // Events / errors
    // ------------------------------------------------------------------------

    event Executed(address indexed token, uint256 amountIn, uint256 profit, bool flashLoan);
    event ExecutorChanged(address indexed oldExecutor, address indexed newExecutor);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event FlashPoolSet(address indexed pool, bool allowed);
    event V4Set(address indexed poolManager, address indexed weth);

    error NotOwner();
    error NotExecutor();
    error Reentrancy();
    error Expired();
    error BadRoute();
    error UnsupportedKind(uint8 kind);
    error ZeroAmount();
    error InsufficientProfit(uint256 got, uint256 wanted);
    error TokenBalanceDropped(address token);
    error UnauthorizedCallback();
    error TransferFailed();
    error FlashPoolNotAllowed(address pool);
    error V4NotEnabled();
    error UnexpectedEth();

    // ------------------------------------------------------------------------
    // Setup / admin
    // ------------------------------------------------------------------------

    constructor(address executor_) {
        owner = msg.sender;
        executor = executor_;
        emit ExecutorChanged(address(0), executor_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor) revert NotExecutor();
        _;
    }

    modifier nonReentrant() {
        if (locked) revert Reentrancy();
        locked = true;
        _;
        locked = false;
    }

    // Swap out the bot's hot wallet (e.g. if the key may be compromised).
    function setExecutor(address newExecutor) external onlyOwner {
        emit ExecutorChanged(executor, newExecutor);
        executor = newExecutor;
    }

    // Approve / remove an Aave V3 Pool for flash loans (one per chain).
    function setFlashPool(address pool, bool allowed) external onlyOwner {
        flashPools[pool] = allowed;
        emit FlashPoolSet(pool, allowed);
    }

    // Turn on Uniswap V4 trading: the chain's PoolManager and WETH. Owner only.
    // Pass zero addresses to turn it off again.
    function setV4(address poolManager, address weth_) external onlyOwner {
        v4PoolManager = poolManager;
        weth = weth_;
        emit V4Set(poolManager, weth_);
    }

    // Native ETH only ever arrives mid-trade: from WETH (unwrapping) or from
    // the PoolManager (a native-ETH V4 pool paying out). Anything else is refused.
    receive() external payable {
        if (msg.sender != weth && msg.sender != v4PoolManager) revert UnexpectedEth();
    }

    // Move profits (or own-capital float) out. Owner only.
    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        _safeTransfer(token, to, amount);
        emit Withdrawn(token, to, amount);
    }

    // ------------------------------------------------------------------------
    // Main entry point
    // ------------------------------------------------------------------------

    // flashPool: Aave V3 Pool address to borrow from, or address(0) to trade
    // with this contract's own balance.
    function execute(Trade calldata t, address flashPool) external onlyExecutor nonReentrant {
        if (block.number > t.maxBlock) revert Expired();
        if (t.amountIn == 0 || t.minProfit == 0) revert ZeroAmount();
        _validateRoute(t);

        // Snapshot every token the route touches (fake-pool drain protection).
        (address[] memory tokens, uint256[] memory before) = _snapshot(t);

        if (flashPool == address(0)) {
            _runHops(t.hops, t.amountIn);
        } else {
            if (!flashPools[flashPool]) revert FlashPoolNotAllowed(flashPool);
            bytes memory params = abi.encode(t);
            activeFlashPool = flashPool;
            activeTradeHash = keccak256(params);
            IAaveV3Pool(flashPool).flashLoanSimple(address(this), t.token, t.amountIn, params, 0);
            activeFlashPool = address(0);
            activeTradeHash = bytes32(0);
            // Never leave an allowance behind (Aave has already pulled what it's owed).
            _safeApprove(t.token, flashPool, 0);
        }

        // Profit + no-loss checks. Flash fee has already been repaid by now,
        // so it is automatically counted against the profit.
        uint256 profit = _checkBalances(t.token, t.minProfit, tokens, before);
        emit Executed(t.token, t.amountIn, profit, flashPool != address(0));
    }

    // V3 pool flash loan: borrow t.amountIn of t.token from `lendPool` (an
    // allowlisted Uniswap/Pancake/Ramses V3 pool), run the route, repay the
    // loan plus the pool's fee, keep the rest. No capital needed in here.
    function executeWithV3Flash(Trade calldata t, address lendPool) external onlyExecutor nonReentrant {
        if (block.number > t.maxBlock) revert Expired();
        if (t.amountIn == 0 || t.minProfit == 0) revert ZeroAmount();
        _validateRoute(t);
        if (!flashPools[lendPool]) revert FlashPoolNotAllowed(lendPool);
        // A pool is locked while it lends, so it can't also be a trade hop.
        for (uint256 i = 0; i < t.hops.length; i++) {
            if (t.hops[i].pool == lendPool) revert BadRoute();
        }
        bool is0 = IV3FlashPool(lendPool).token0() == t.token;
        if (!is0 && IV3FlashPool(lendPool).token1() != t.token) revert BadRoute();

        (address[] memory tokens, uint256[] memory before) = _snapshot(t);

        bytes memory data = abi.encode(t);
        activeFlashPool = lendPool;
        activeTradeHash = keccak256(data);
        activeFlashIs0 = is0;
        IV3FlashPool(lendPool).flash(address(this), is0 ? t.amountIn : 0, is0 ? 0 : t.amountIn, data);
        activeFlashPool = address(0);
        activeTradeHash = bytes32(0);

        // Fee was repaid inside the callback, so it's already counted here.
        uint256 profit = _checkBalances(t.token, t.minProfit, tokens, before);
        emit Executed(t.token, t.amountIn, profit, true);
    }

    // V3 flash callbacks (same logic, different names per DEX).
    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external {
        _onV3Flash(fee0, fee1, data);
    }

    function pancakeV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external {
        _onV3Flash(fee0, fee1, data);
    }

    function ramsesV2FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external {
        _onV3Flash(fee0, fee1, data);
    }

    function _onV3Flash(uint256 fee0, uint256 fee1, bytes calldata data) private {
        // Only the pool we're borrowing from, only for the exact trade we snapshotted.
        if (msg.sender != activeFlashPool || msg.sender == address(0)) revert UnauthorizedCallback();
        if (keccak256(data) != activeTradeHash) revert UnauthorizedCallback();

        Trade memory t = abi.decode(data, (Trade));
        _runHops(t.hops, t.amountIn);

        // Repay principal + fee. If the route didn't make enough, this
        // transfer fails or the pool's own balance check reverts everything.
        uint256 fee = activeFlashIs0 ? fee0 : fee1;
        _safeTransfer(t.token, msg.sender, t.amountIn + fee);
    }

    // ------------------------------------------------------------------------
    // Aave V3 flash loan callback
    // ------------------------------------------------------------------------

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        // Only the Aave pool we just called, only for a loan WE started.
        if (msg.sender != activeFlashPool || initiator != address(this)) revert UnauthorizedCallback();
        // Must be the exact trade execute() snapshotted -- not a substitute route.
        if (keccak256(params) != activeTradeHash) revert UnauthorizedCallback();

        Trade memory t = abi.decode(params, (Trade));
        if (asset != t.token || amount != t.amountIn) revert UnauthorizedCallback();

        _runHops(t.hops, amount);

        // Let Aave pull back the loan + fee. If we're short, Aave reverts
        // the whole thing -- no partial outcome.
        _safeApprove(asset, msg.sender, amount + premium);
        return true;
    }

    // ------------------------------------------------------------------------
    // V3 swap callbacks (same logic, different names per DEX)
    // ------------------------------------------------------------------------

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _payV3(amount0Delta, amount1Delta);
    }

    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _payV3(amount0Delta, amount1Delta);
    }

    function ramsesV2SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _payV3(amount0Delta, amount1Delta);
    }

    // Pays the V3 pool what it's owed -- but only the pool we're mid-swap
    // with, and only in the token we're selling into it.
    function _payV3(int256 amount0Delta, int256 amount1Delta) private {
        if (msg.sender != activeV3Pool || msg.sender == address(0)) revert UnauthorizedCallback();
        // Exactly one side is positive on a real swap: the amount we owe.
        int256 owedSigned = amount0Delta > 0 ? amount0Delta : amount1Delta;
        if (owedSigned <= 0) revert UnauthorizedCallback();
        // forge-lint: disable-next-line(unsafe-typecast)
        _safeTransfer(activeV3TokenIn, msg.sender, uint256(owedSigned)); // safe: checked > 0 above
    }

    // ------------------------------------------------------------------------
    // Route execution
    // ------------------------------------------------------------------------

    // Runs every hop in order; each hop spends exactly what the previous one
    // produced. Returns the final amount received.
    function _runHops(Hop[] memory hops, uint256 amountIn) private returns (uint256 amount) {
        amount = amountIn;
        for (uint256 i = 0; i < hops.length; i++) {
            Hop memory h = hops[i];
            uint256 outBefore = IERC20(h.tokenOut).balanceOf(address(this));

            if (h.kind == KIND_V2) {
                _swapV2(h, amount);
            } else if (h.kind == KIND_SOLIDLY) {
                _swapSolidly(h, amount);
            } else if (h.kind == KIND_V3) {
                _swapV3(h, amount);
            } else if (h.kind == KIND_V4) {
                _swapV4(h, amount);
            } else {
                revert UnsupportedKind(h.kind);
            }

            // Measure what we actually received (handles odd tokens and
            // keeps every hop honest about its output).
            amount = IERC20(h.tokenOut).balanceOf(address(this)) - outBefore;
            if (amount == 0) revert ZeroAmount();
        }
    }

    function _swapV2(Hop memory h, uint256 amountIn) private {
        IUniswapV2Pair pair = IUniswapV2Pair(h.pool);
        bool inIs0 = pair.token0() == h.tokenIn;
        (uint112 r0, uint112 r1, ) = pair.getReserves();
        (uint256 reserveIn, uint256 reserveOut) = inIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));

        _safeTransfer(h.tokenIn, h.pool, amountIn);
        // Use what the pair actually received, not what we sent.
        uint256 received = IERC20(h.tokenIn).balanceOf(h.pool) - reserveIn;

        // Standard constant-product output after fee.
        uint256 inWithFee = received * (10_000 - h.feeBps);
        uint256 amountOut = (inWithFee * reserveOut) / (reserveIn * 10_000 + inWithFee);

        (uint256 out0, uint256 out1) = inIs0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
        pair.swap(out0, out1, address(this), new bytes(0));
    }

    function _swapSolidly(Hop memory h, uint256 amountIn) private {
        ISolidlyPair pair = ISolidlyPair(h.pool);
        bool inIs0 = pair.token0() == h.tokenIn;
        // The pair knows its own curve (stable or volatile) and fee.
        uint256 amountOut = pair.getAmountOut(amountIn, h.tokenIn);
        _safeTransfer(h.tokenIn, h.pool, amountIn);
        (uint256 out0, uint256 out1) = inIs0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
        pair.swap(out0, out1, address(this), new bytes(0));
    }

    // Uniswap V3 price limits: just inside the allowed range = no limit.
    // Overall slippage is enforced by the final profit check instead.
    uint160 private constant MIN_SQRT_RATIO_PLUS_1 = 4295128740;
    uint160 private constant MAX_SQRT_RATIO_MINUS_1 = 1461446703485210103287273052203988822378723970341;

    function _swapV3(Hop memory h, uint256 amountIn) private {
        IUniswapV3Pool pool = IUniswapV3Pool(h.pool);
        bool zeroForOne = pool.token0() == h.tokenIn;
        if (amountIn > uint256(type(int256).max)) revert BadRoute();

        activeV3Pool = h.pool;
        activeV3TokenIn = h.tokenIn;
        pool.swap(
            address(this),
            zeroForOne,
            // forge-lint: disable-next-line(unsafe-typecast)
            int256(amountIn), // positive = exact input (range checked above)
            zeroForOne ? MIN_SQRT_RATIO_PLUS_1 : MAX_SQRT_RATIO_MINUS_1,
            new bytes(0)
        );
        activeV3Pool = address(0);
        activeV3TokenIn = address(0);
    }

    // ------------------------------------------------------------------------
    // Uniswap V4
    // ------------------------------------------------------------------------
    //
    // V4 keeps every pool inside one PoolManager. To trade, you "unlock" it;
    // it calls back unlockCallback(), where you swap, pay what you owe and
    // take what you're owed. Everything must net to zero before unlock()
    // returns, or the PoolManager reverts the whole transaction.
    //
    // One unlock per V4 hop keeps the rest of the route unchanged (V2/V3
    // hops and the flash-loan logic don't need to know about V4).

    function _swapV4(Hop memory h, uint256 amountIn) private {
        address pm = v4PoolManager;
        if (pm == address(0) || weth == address(0)) revert V4NotEnabled();
        if (h.pool != pm) revert BadRoute(); // only the real PoolManager, never a look-alike
        if (amountIn > uint256(type(int256).max)) revert BadRoute();

        activeV4 = true;
        IV4PoolManager(pm).unlock(abi.encode(h, amountIn));
        activeV4 = false;
    }

    // Called by the PoolManager during our unlock(). Does the swap and settles.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != v4PoolManager || msg.sender == address(0) || !activeV4) revert UnauthorizedCallback();
        (Hop memory h, uint256 amountIn) = abi.decode(data, (Hop, uint256));
        IV4PoolManager pm = IV4PoolManager(msg.sender);

        // The pool's currencies: WETH becomes native ETH (address 0) when the
        // pool is a native-ETH pool. The route's other token must not be WETH
        // in that case (that would be a WETH/ETH "pool", not a real trade).
        address cIn = h.tokenIn;
        address cOut = h.tokenOut;
        if (h.v4Native) {
            if (cIn == weth) cIn = address(0);
            else if (cOut == weth) cOut = address(0);
            else revert BadRoute();
        }
        bool zeroForOne = cIn < cOut; // currency0 is always the lower address (native = 0 = lowest)
        IV4PoolManager.PoolKey memory key = IV4PoolManager.PoolKey({
            currency0: zeroForOne ? cIn : cOut,
            currency1: zeroForOne ? cOut : cIn,
            fee: h.v4Fee,
            tickSpacing: h.v4TickSpacing,
            hooks: address(0) // hookless pools only, always
        });

        // forge-lint: disable-next-line(unsafe-typecast)
        int256 delta = pm.swap(key, IV4PoolManager.SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(amountIn), // exact input (range checked in _swapV4)
            sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_RATIO_PLUS_1 : MAX_SQRT_RATIO_MINUS_1
        }), new bytes(0));

        // Split the packed delta into the two currencies.
        int128 d0 = int128(delta >> 128);
        int128 d1 = int128(delta);
        int128 owedSigned = zeroForOne ? d0 : d1; // negative: we owe
        int128 gotSigned = zeroForOne ? d1 : d0;  // positive: we receive
        if (owedSigned >= 0 || gotSigned <= 0) revert ZeroAmount();
        uint256 owed = uint256(uint128(-owedSigned));
        uint256 got = uint256(uint128(gotSigned));

        // Pay what we owe.
        if (cIn == address(0)) {
            IWETH(weth).withdraw(owed);            // WETH -> ETH
            pm.settle{value: owed}();
        } else {
            pm.sync(cIn);                          // tell the PoolManager to count what arrives
            _safeTransfer(cIn, address(pm), owed);
            pm.settle();
        }

        // Take what we're owed.
        pm.take(cOut, address(this), got);
        if (cOut == address(0)) IWETH(weth).deposit{value: got}(); // ETH -> WETH, so the route stays in tokens

        return new bytes(0);
    }

    // ------------------------------------------------------------------------
    // Checks
    // ------------------------------------------------------------------------

    // Route must be 2+ hops, chain correctly, and start/end in t.token.
    function _validateRoute(Trade calldata t) private pure {
        uint256 n = t.hops.length;
        if (n < 2) revert BadRoute();
        if (t.hops[0].tokenIn != t.token || t.hops[n - 1].tokenOut != t.token) revert BadRoute();
        for (uint256 i = 0; i < n; i++) {
            Hop calldata h = t.hops[i];
            if (h.pool == address(0) || h.tokenIn == h.tokenOut) revert BadRoute();
            if (i > 0 && t.hops[i - 1].tokenOut != h.tokenIn) revert BadRoute();
            if (h.kind == KIND_V2 && h.feeBps >= 10_000) revert BadRoute();
        }
    }

    // Unique list of every token in the route, with current balances.
    function _snapshot(Trade calldata t) private view returns (address[] memory tokens, uint256[] memory bals) {
        uint256 n = t.hops.length;
        address[] memory tmp = new address[](n + 1);
        uint256 count;
        tmp[count++] = t.token;
        for (uint256 i = 0; i < n; i++) {
            address tok = t.hops[i].tokenOut;
            bool seen;
            for (uint256 j = 0; j < count; j++) {
                if (tmp[j] == tok) { seen = true; break; }
            }
            if (!seen) tmp[count++] = tok;
        }
        tokens = new address[](count);
        bals = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            tokens[i] = tmp[i];
            bals[i] = IERC20(tmp[i]).balanceOf(address(this));
        }
    }

    // tokens[0] is the trade token: must be up by >= minProfit.
    // Every other token touched: must not be down at all.
    function _checkBalances(
        address token,
        uint256 minProfit,
        address[] memory tokens,
        uint256[] memory before
    ) private view returns (uint256 profit) {
        uint256 afterBal = IERC20(token).balanceOf(address(this));
        profit = afterBal > before[0] ? afterBal - before[0] : 0;
        if (profit < minProfit) revert InsufficientProfit(profit, minProfit);
        for (uint256 i = 1; i < tokens.length; i++) {
            if (IERC20(tokens[i]).balanceOf(address(this)) < before[i]) revert TokenBalanceDropped(tokens[i]);
        }
    }

    // ------------------------------------------------------------------------
    // Token helpers (work with tokens that return nothing, e.g. USDT)
    // ------------------------------------------------------------------------

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeApprove(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
