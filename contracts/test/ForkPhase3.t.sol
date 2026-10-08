// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/Test.sol";
import {ArbExecutor} from "../src/ArbExecutor.sol";
import {ForkBase, IWETH, IV2Factory, ISolidlyFactory} from "./Fork.t.sol";

// ============================================================================
// ROBINHOOD FORK: REAL GAS + FLASH-LOAN ACCOUNTING (Phase 3)
//
// Plain English:
//   The other fork tests stop at the profit check (real pools are usually in
//   balance), so they never measure a COMPLETE winning trade. Here we first
//   push one real pool's price 2% (as a big trader would), then run our
//   backrun through the real contract and real pools and record:
//     - GAS: what a full winning trade really uses, own money vs flash loan,
//       plus Robinhood's parent-chain (L1) data charge, the live gas price
//       and ETH price, so it can be turned into dollars.
//     - FLASH: the lender gets back exactly loan + fee, the contract ends
//       holding exactly the profit, and flash profit = own profit - fee.
//     - An EMPTY contract (zero balance, like the live one) succeeds when the
//       trade wins, and fails at repayment when it loses. A pretend balance
//       (what a simulation override creates) does not change the outcome.
//
// Lines starting "GAS" / "FLASH" are copied into CI's fork-test annotation.
// Needs ROBINHOOD_RPC_URL (CI sets the public one); skips otherwise.
// The contract name contains "RobinhoodForkTest" so CI's existing
// --match-contract filter picks it up.
// ============================================================================

interface IV3PoolLite {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256, int256);
    function liquidity() external view returns (uint128);
    function fee() external view returns (uint24);
}

contract RobinhoodForkTestPhase3 is ForkBase {
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73; // token0 vs USDG (lower address)
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant UNI_V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant RAMSES_V3_FACTORY = 0xE0c4ceb92d08CA985bB70fe0a22fEb121A9854A8;
    address constant UNI_V2_FACTORY = 0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f;
    address constant RAMSES_V2_FACTORY = 0x43B2Bf9f33036a02fC7A00935571c2A6b0108e66;
    address constant NODE_INTERFACE = address(0xC8); // Arbitrum NodeInterface (eth_call only)

    uint256 constant TRADE_WETH = 0.1 ether;

    // ---- pools --------------------------------------------------------------

    function _uniV3(uint24 fee) internal view returns (address) {
        return _findV3(UNI_V3_FACTORY, WETH, USDG, _fees(fee, fee, fee, fee));
    }

    // Deepest Ramses V3 WETH/USDG pool (keyed by tick spacing).
    function _ramsesV3() internal view returns (address v3) {
        int24[6] memory sp = [int24(1), int24(5), int24(10), int24(50), int24(100), int24(200)];
        uint256 best;
        for (uint256 i = 0; i < sp.length; i++) {
            (bool ok, bytes memory ret) =
                RAMSES_V3_FACTORY.staticcall(abi.encodeWithSignature("getPool(address,address,int24)", WETH, USDG, sp[i]));
            if (!ok || ret.length < 32) continue;
            address p = abi.decode(ret, (address));
            if (p == address(0) || p.code.length == 0) continue;
            uint256 b = IWETH(WETH).balanceOf(p);
            if (b > best) { best = b; v3 = p; }
        }
    }

    function _sqrtP(address pool) internal view returns (uint160) {
        (bool ok, bytes memory ret) = pool.staticcall(abi.encodeWithSignature("slot0()"));
        require(ok && ret.length >= 32, "slot0 unreadable");
        return uint160(uint256(bytes32(ret)));
    }

    // USD price of 1 WETH from a WETH/USDG V3 pool, in cents.
    function _ethUsdCents(address pool) internal view returns (uint256) {
        uint256 s = _sqrtP(pool);
        // price (USDG raw per WETH raw) = s^2 / 2^192; x 1e12 for decimals; x 100 for cents
        return (s * s / (1 << 96)) * 1e14 / (1 << 96);
    }

    function _isqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) { y = z; z = (x / z + z) / 2; }
    }

    // ---- moving a pool's price like a big trader would -----------------------

    address private payPool;
    address private payToken;

    // Buys WETH with USDG on `pool` until its WETH price is `bps` higher.
    function _pushWethUp(address pool, uint256 bps) internal {
        uint256 limit = uint256(_sqrtP(pool)) * _isqrt((10_000 + bps) * 1e32) / 1e18;
        deal(USDG, address(this), 50_000_000e6);
        payPool = pool;
        payToken = USDG;
        // USDG is token1: oneForZero (zeroForOne = false), exact input, stop at `limit`.
        IV3PoolLite(pool).swap(address(this), false, int256(50_000_000e6), uint160(limit), "");
        payPool = address(0);
    }

    function _pay(int256 a0, int256 a1) internal {
        require(msg.sender == payPool, "pay: wrong pool");
        IWETH(payToken).transfer(msg.sender, uint256(a0 > 0 ? a0 : a1));
    }
    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external { _pay(a0, a1); }
    function ramsesV2SwapCallback(int256 a0, int256 a1, bytes calldata) external { _pay(a0, a1); }
    function pancakeV3SwapCallback(int256 a0, int256 a1, bytes calldata) external { _pay(a0, a1); }

    // ---- measuring ----------------------------------------------------------

    struct RunResult {
        bool ok;
        bytes revertData;
        uint256 execGas;      // gas used inside the call (cold pools/tokens)
        uint256 txGas;        // + 21,000 base + calldata cost = what the transaction pays on Robinhood (L2 part)
        uint256 profit;       // WETH the contract gained
        bytes callData;
    }

    // Intrinsic gas of a transaction carrying `data` (21,000 + 16/4 per byte).
    function _intrinsic(bytes memory data) internal pure returns (uint256 g) {
        g = 21_000;
        for (uint256 i = 0; i < data.length; i++) g += data[i] == 0 ? 4 : 16;
    }

    function _run(ArbExecutor.Trade memory t, address lender, address[] memory touched) internal returns (RunResult memory r) {
        r.callData = lender == address(0)
            ? abi.encodeWithSelector(ArbExecutor.execute.selector, t, address(0))
            : abi.encodeWithSelector(ArbExecutor.executeWithV3Flash.selector, t, lender);
        // Make every pool / token / the contract "cold" (first touch in the
        // transaction pays full price), like a real transaction.
        for (uint256 i = 0; i < touched.length; i++) vm.cool(touched[i]);
        vm.cool(address(exec));
        uint256 before = IWETH(WETH).balanceOf(address(exec));
        uint256 g0 = gasleft();
        (r.ok, r.revertData) = address(exec).call(r.callData);
        r.execGas = g0 - gasleft();
        // The contract itself is already "warm" in a real transaction (it is the
        // destination): take back the 2,500 extra this test paid to touch it cold.
        if (r.execGas > 2_500) r.execGas -= 2_500;
        r.txGas = r.execGas + _intrinsic(r.callData);
        uint256 afterBal = IWETH(WETH).balanceOf(address(exec));
        r.profit = afterBal > before ? afterBal - before : 0;
    }

    // Parent-chain (L1) data charge for this calldata, in L2 gas units, from
    // the live node (NodeInterface works only through eth_call). 0 if unavailable.
    function _l1Gas(bytes memory data) internal returns (uint256) {
        bytes memory q = abi.encodeWithSignature("gasEstimateL1Component(address,bool,bytes)", address(exec), false, data);
        string memory params = string.concat('[{"to":"', vm.toString(NODE_INTERFACE), '","data":"', vm.toString(q), '"},"latest"]');
        try vm.rpc("eth_call", params) returns (bytes memory ret) {
            if (ret.length >= 32) return uint256(uint64(uint256(bytes32(ret))));
        } catch {}
        return 0;
    }

    function _gasPriceWei() internal returns (uint256 p) {
        try vm.rpc("eth_gasPrice", "[]") returns (bytes memory ret) {
            // Short hex results come back as raw big-endian bytes.
            for (uint256 i = 0; i < ret.length; i++) p = (p << 8) | uint8(ret[i]);
        } catch {}
        if (p == 0) p = block.basefee;
    }

    // One "GAS" line: gas units and dollars (L2 execution + L1 data).
    function _logGas(string memory label, RunResult memory r, uint256 ethCents) internal {
        uint256 l1 = _l1Gas(r.callData);
        uint256 price = _gasPriceWei();
        uint256 total = r.txGas + l1;
        // micro-dollars = gas x wei/gas x cents/ETH / 1e18 x 1e4
        uint256 microUsd = total * price * ethCents / 1e14;
        console.log(string.concat(
            "GAS ", label, ": exec ", vm.toString(r.execGas), " + tx base/calldata ", vm.toString(r.txGas - r.execGas),
            " + L1 data ", vm.toString(l1), " = ", vm.toString(total), " gas"
        ));
        console.log(string.concat(
            "GAS ", label, ": at ", vm.toString(price), " wei/gas and ETH $", vm.toString(ethCents / 100),
            " = $0.", _sixDigits(microUsd), " (micro-USD ", vm.toString(microUsd), ")"
        ));
    }

    function _sixDigits(uint256 microUsd) internal pure returns (string memory s) {
        if (microUsd >= 1e6) return string.concat(vm.toString(microUsd / 1e6), "+");
        s = vm.toString(microUsd);
        while (bytes(s).length < 6) s = string.concat("0", s);
    }

    function _hops(address first, uint8 k1, address second, uint8 k2) internal pure returns (ArbExecutor.Hop[] memory hops) {
        hops = new ArbExecutor.Hop[](2);
        hops[0] = _hop(k1, first, WETH, USDG, k1 == 0 ? 30 : 0);
        hops[1] = _hop(k2, second, USDG, WETH, k2 == 0 ? 30 : 0);
    }

    function _touched(address a, address b, address c) internal pure returns (address[] memory t) {
        t = new address[](5);
        (t[0], t[1], t[2], t[3], t[4]) = (a, b, c == address(0) ? a : c, WETH, USDG);
    }

    // Shared between the own-capital and flash halves (kept in storage to
    // stay under Solidity's local-variable limit).
    string private cLabel;
    address private cSell;
    address private cBuy;
    uint256 private cEthCents;
    uint256 private cOwnProfit;

    // Full winning backrun, own money then flash loan, on the same pushed state.
    // `sellDear` is the pool we push (WETH becomes dear there: we sell WETH
    // into it first), `buyBack` is where we buy the WETH back.
    function _winningPair(string memory label, address sellDear, uint8 kSell, address buyBack, uint8 kBuy, address lender) internal {
        (cLabel, cSell, cBuy) = (label, sellDear, buyBack);
        cEthCents = _ethUsdCents(sellDear);
        _pushWethUp(sellDear, 200); // +2%, like a big buyer just hit this pool
        ArbExecutor.Trade memory t = ArbExecutor.Trade({
            token: WETH, amountIn: TRADE_WETH, minProfit: 1, maxBlock: _l2Block(), hops: _hops(sellDear, kSell, buyBack, kBuy)
        });
        uint256 snap = vm.snapshotState();
        if (!_ownHalf(t)) return;
        vm.revertToState(snap);
        if (lender == address(0)) { console.log("FLASH", label, "skipped: no separate lender pool"); return; }
        _flashHalf(t, lender);
        vm.revertToState(snap);
    }

    function _ownHalf(ArbExecutor.Trade memory t) internal returns (bool) {
        _fundWrapped(WETH, TRADE_WETH);
        RunResult memory own = _run(t, address(0), _touched(cSell, cBuy, address(0)));
        if (!own.ok) { console.log(cLabel, "own capital FAILED:"); console.logBytes(own.revertData); fail(); return false; }
        assertEq(IWETH(WETH).balanceOf(address(exec)), TRADE_WETH + own.profit, "own: capital + profit");
        cOwnProfit = own.profit;
        _logGas(string.concat(cLabel, " own capital"), own, cEthCents);
        return true;
    }

    // Flash loan with an EMPTY contract (no float at all).
    function _flashHalf(ArbExecutor.Trade memory t, address lender) internal {
        exec.setFlashPool(lender, true);
        assertEq(IWETH(WETH).balanceOf(address(exec)), 0, "flash: contract starts empty");
        uint256 lenderBefore = IWETH(WETH).balanceOf(lender);
        uint256 fee = (TRADE_WETH * IV3PoolLite(lender).fee() + 999_999) / 1_000_000; // Uniswap rounds the fee up
        RunResult memory fl = _run(t, lender, _touched(cSell, cBuy, lender));
        if (!fl.ok) { console.log(cLabel, "flash FAILED:"); console.logBytes(fl.revertData); fail(); return; }
        assertEq(IWETH(WETH).balanceOf(lender), lenderBefore + fee, "lender got exactly loan + fee back");
        assertEq(IWETH(WETH).balanceOf(address(exec)), fl.profit, "contract holds exactly the profit");
        assertEq(fl.profit + fee, cOwnProfit, "flash profit = own-capital profit - fee");
        assertEq(IWETH(USDG).balanceOf(address(exec)), 0, "no USDG left behind");
        _logGas(string.concat(cLabel, " flash loan"), fl, cEthCents);
        console.log(string.concat(
            "FLASH ", cLabel, ": own profit ", vm.toString(cOwnProfit), " wei, flash profit ", vm.toString(fl.profit),
            " wei, fee ", vm.toString(fee), " wei (repaid in full, empty contract)"
        ));
    }

    function test_fork_robinhood_gas_uniV3_to_ramsesV3() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        address uni = _uniV3(500);
        address ram = _ramsesV3();
        address lender = _uniV3(100);
        if (uni == address(0) || ram == address(0)) { console.log("GAS skipped: pools missing"); vm.skip(true); return; }
        _winningPair("V3->V3 (uni 0.05% push, ramses back)", uni, 2, ram, 2, lender == uni || lender == ram ? address(0) : lender);
    }

    function test_fork_robinhood_gas_uniV3_to_uniV2() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        address uni = _uniV3(500);
        address v2 = IV2Factory(UNI_V2_FACTORY).getPair(WETH, USDG);
        address lender = _uniV3(100);
        if (uni == address(0) || v2 == address(0) || IWETH(WETH).balanceOf(v2) < 1 ether) {
            console.log("GAS skipped: no Uniswap V2 WETH/USDG pair with >= 1 WETH");
            vm.skip(true);
            return;
        }
        _winningPair("V3->V2 (uni 0.05% push, uni v2 back)", uni, 2, v2, 0, lender == uni ? address(0) : lender);
    }

    function test_fork_robinhood_gas_uniV3_to_ramsesV2() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        address uni = _uniV3(500);
        address sol = ISolidlyFactory(RAMSES_V2_FACTORY).getPair(WETH, USDG, false);
        address lender = _uniV3(100);
        if (uni == address(0) || sol == address(0)) { console.log("GAS skipped: pools missing"); vm.skip(true); return; }
        _winningPair("V3->Solidly (uni 0.05% push, ramses v2 back)", uni, 2, sol, 1, lender == uni ? address(0) : lender);
    }

    // Losing trade, EMPTY contract: fails at repayment (TransferFailed); with a
    // pretend balance it fails at our profit check instead. Never succeeds,
    // lender never loses. This is why the bot's flash simulation must not
    // (and now does not) give the contract a balance.
    function test_fork_robinhood_flash_losingTrade_neverHidden() public {
        if (!_fork("ROBINHOOD_RPC_URL")) return;
        address uni = _uniV3(500);
        address ram = _ramsesV3();
        address lender = _uniV3(100);
        if (uni == address(0) || ram == address(0) || lender == address(0) || lender == uni || lender == ram) {
            console.log("FLASH losing-trade check skipped: pools missing"); vm.skip(true); return;
        }
        _pushWethUp(uni, 200);
        exec.setFlashPool(lender, true);
        // Wrong way round: buy WETH where it is now dear. Loses ~2%.
        ArbExecutor.Hop[] memory hops = new ArbExecutor.Hop[](2);
        hops[0] = _hop(2, ram, WETH, USDG, 0);
        hops[1] = _hop(2, uni, USDG, WETH, 0);
        ArbExecutor.Trade memory t = ArbExecutor.Trade({token: WETH, amountIn: TRADE_WETH, minProfit: 1, maxBlock: _l2Block(), hops: hops});
        uint256 lenderBefore = IWETH(WETH).balanceOf(lender);

        (bool okEmpty, bytes memory dEmpty) = address(exec).call(abi.encodeWithSelector(ArbExecutor.executeWithV3Flash.selector, t, lender));
        assertFalse(okEmpty, "losing flash trade must fail with an empty contract");
        assertEq(bytes4(dEmpty), ArbExecutor.TransferFailed.selector, "empty contract: fails repaying the loan");

        _fundWrapped(WETH, 1 ether); // pretend balance, like a simulation override
        (bool okFloat, bytes memory dFloat) = address(exec).call(abi.encodeWithSelector(ArbExecutor.executeWithV3Flash.selector, t, lender));
        assertFalse(okFloat, "losing flash trade must fail even with a pretend balance");
        assertEq(bytes4(dFloat), ArbExecutor.InsufficientProfit.selector, "with a float: reaches the profit check and fails there");
        assertEq(IWETH(WETH).balanceOf(lender), lenderBefore, "lender never loses");
        console.log("FLASH losing trade: empty contract -> TransferFailed, with float -> InsufficientProfit; never succeeds (OK)");
    }
}
