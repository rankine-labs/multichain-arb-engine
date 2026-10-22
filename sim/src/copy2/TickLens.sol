// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// ============================================================================
// COPY 2 TICK LENS (never deployed: placed for ONE pretend call with a state
// override, inside debug_traceCall on the node)
//
// Plain English:
//   A trade check through a V3-style pool can walk the price far from where
//   it is now. Each price "step" the pool crosses reads more of the pool's
//   storage: a "tick map" word (which prices have liquidity changes) and the
//   data of every crossed price point ("tick"). A ready pool used to hold
//   only what its own events had needed so far, so bigger checks answered
//   "I don't know" (a miss) and the bot asked the node instead.
//
//   This contract asks the POOL ITSELF, through its own public read
//   functions, for everything a swap of any realistic size can touch:
//     - Uniswap V3 / PancakeSwap V3: every tick-map word in a wide window
//       around the current price (zero words included), every initialized
//       tick in it, the price history (observations) and the settings.
//     - Algebra Integral: every initialized tick (Algebra keeps them in a
//       linked list from MIN_TICK to MAX_TICK), its tick tree, settings.
//     - Uniswap V4 (pool inside the PoolManager): the same tick-map window
//       and ticks, read with the PoolManager's own extsload.
//     - V3 / Pancake / Algebra: two small "probe" swaps (one each way, a
//       ~2% price move) that are cancelled inside the pay-me callback: the
//       pool runs its real swap code up to the payment, so it reads
//       whatever else a swap reads (fee settings, price history writes,
//       Algebra's plugin), then everything is undone.
//
//   We never use the answers of these calls. arbsim runs this call under
//   the node's "prestateTracer", which lists every storage slot the call
//   READ, with its value, exactly at the traced block. arbsim keeps only
//   the pool's own slots from that list (see copy2/walk.rs). So the lens
//   needs no knowledge of the pool's storage layout: the pool's own code
//   decides which slots it reads.
//
//   At the very end the lens reads one slot of ITS OWN (made-up) storage
//   whose number encodes "finished" + the window it walked. If that slot
//   is in the trace, the walk completed (not cut short by gas).
//
// Build: sim/tools/copy2/build.js (solc 0.8.26, optimizer 200, cancun) ->
// tick_lens.hex (runtime code), embedded by copy2/walk.rs.
// ============================================================================

contract TickLens {
    int24 constant MIN_TICK = -887272;
    int24 constant MAX_TICK = 887272;
    uint160 constant MIN_SQRT = 4295128739;
    uint160 constant MAX_SQRT = 1461446703485210103287273052203988822378723970342;
    // High 128 bits of the "finished" marker slot (low 128 bits = details).
    uint256 constant DONE_BASE = 0xc0b72d0e5a1f00d5c0b72d0e5a1f00d500000000000000000000000000000000;

    struct Args {
        uint256 kind;        // 1 = Uniswap V3, 2 = PancakeSwap V3, 3 = Algebra, 4 = Uniswap V4
        address pool;        // the pool (V4: the PoolManager)
        bytes32 v4id;        // V4 pool id
        int256 v4spacing;    // V4 tick spacing (others: read from the pool)
        uint256 windowTicks; // ticks each side of the current price
        uint256 minSideWords;// at least this many tick-map words each side
        uint256 maxTicks;    // stop after this many initialized ticks
        uint256 maxObs;      // at most this many price-history entries
        uint256 probeBps;    // probe swap: sqrt price moved by this (1/10000)
    }

    // Any call into the lens other than walk() (the pools' pay-me callbacks
    // during the probe swaps): refuse, which cancels the probe swap.
    fallback() external payable {
        revert("lens: probe");
    }

    function walk(Args calldata a) external {
        uint256 words;
        uint256 ticks;
        int256 lo;
        int256 hi;
        int256 center;
        if (a.kind == 4) {
            (lo, hi, center, ticks) = _v4(a);
        } else if (a.kind == 3) {
            (center, ticks) = _algebra(a);
        } else {
            (lo, hi, center, ticks) = _v3(a);
        }
        if (hi >= lo && a.kind != 3) words = uint256(hi - lo + 1);
        // Finished: details packed in the low 128 bits of the marker slot.
        uint256 key = DONE_BASE
            | (uint256(uint16(int16(lo))) << 0)
            | (uint256(uint16(int16(hi))) << 16)
            | (uint256(uint24(int24(center))) << 32)
            | ((ticks & 0xffffff) << 56)
            | ((words & 0xffff) << 80);
        // (Used in a condition so the optimizer can't drop the read; the
        // lens has no storage, so the value is always 0.)
        uint256 v;
        assembly {
            v := sload(key)
        }
        if (v == 0x5eed) revert("lens: impossible");
    }

    // ---- small low-level helpers (a failing call is simply skipped) ----
    function _call(address to, bytes memory data) internal view returns (bool ok, bytes memory out) {
        (ok, out) = to.staticcall(data);
    }

    function _word(bytes memory out, uint256 i) internal pure returns (uint256 w) {
        if (out.length < (i + 1) * 32) return 0;
        assembly {
            w := mload(add(out, add(32, mul(i, 32))))
        }
    }

    function _floorDiv(int256 x, int256 d) internal pure returns (int256) {
        int256 q = x / d;
        if (x % d != 0 && (x < 0) != (d < 0)) q -= 1;
        return q;
    }

    // Tick-map word window around `tick`, clipped to the valid range.
    function _window(int256 tick, int256 sp, Args calldata a) internal pure returns (int256 lo, int256 hi) {
        int256 w = _floorDiv(tick, sp) >> 8;
        int256 side = int256((a.windowTicks + uint256(sp) * 256 - 1) / (uint256(sp) * 256));
        if (side < int256(a.minSideWords)) side = int256(a.minSideWords);
        int256 wMin = _floorDiv(int256(MIN_TICK), sp) >> 8;
        int256 wMax = _floorDiv(int256(MAX_TICK), sp) >> 8;
        lo = w - side < wMin ? wMin : w - side;
        hi = w + side > wMax ? wMax : w + side;
    }

    // ---- Uniswap V3 / PancakeSwap V3 ----
    function _v3(Args calldata a) internal returns (int256 lo, int256 hi, int256 center, uint256 ticks) {
        address p = a.pool;
        (bool ok, bytes memory s0) = _call(p, abi.encodeWithSignature("slot0()"));
        if (!ok) return (1, 0, 0, 0);
        center = int256(int24(int256(_word(s0, 1))));
        (bool ok2, bytes memory spo) = _call(p, abi.encodeWithSignature("tickSpacing()"));
        if (!ok2) return (1, 0, center, 0);
        int256 sp = int256(int24(int256(_word(spo, 0))));
        if (sp <= 0) return (1, 0, center, 0);
        // Settings a swap reads.
        _call(p, abi.encodeWithSignature("feeGrowthGlobal0X128()"));
        _call(p, abi.encodeWithSignature("feeGrowthGlobal1X128()"));
        _call(p, abi.encodeWithSignature("protocolFees()"));
        _call(p, abi.encodeWithSignature("liquidity()"));
        if (a.kind == 2) _call(p, abi.encodeWithSignature("lmPool()"));
        (lo, hi) = _window(center, sp, a);
        ticks = _v3Ticks(p, lo, hi, sp, a.maxTicks);
        _v3Obs(p, _word(s0, 2), _word(s0, 4), a.maxObs);
        _probe(a, _word(s0, 0));
    }

    // Tick map words lo..hi (zero ones too) + every initialized tick in them.
    function _v3Ticks(address p, int256 lo, int256 hi, int256 sp, uint256 maxTicks) internal view returns (uint256 ticks) {
        for (int256 w = lo; w <= hi; w++) {
            (bool okb, bytes memory bm) = _call(p, abi.encodeWithSignature("tickBitmap(int16)", int16(w)));
            if (!okb) continue;
            uint256 bits = _word(bm, 0);
            while (bits != 0 && ticks < maxTicks) {
                uint256 b = _lsb(bits);
                bits &= bits - 1;
                _call(p, abi.encodeWithSignature("ticks(int24)", int24(((w << 8) + int256(b)) * sp)));
                ticks++;
            }
        }
    }

    // Price history: every entry up to cardinalityNext (or the next maxObs
    // from the current index, wrapping, if there are more).
    function _v3Obs(address p, uint256 obsIndex, uint256 obsNext, uint256 maxObs) internal view {
        if (obsNext == 0) return;
        uint256 n = obsNext < maxObs ? obsNext : maxObs;
        for (uint256 i = 0; i < n; i++) {
            uint256 idx = obsNext <= maxObs ? i : (obsIndex + i) % obsNext;
            _call(p, abi.encodeWithSignature("observations(uint256)", idx));
        }
    }

    // ---- Algebra Integral ----
    function _algebra(Args calldata a) internal returns (int256 center, uint256 ticks) {
        address p = a.pool;
        (bool ok, bytes memory gs) = _call(p, abi.encodeWithSignature("globalState()"));
        if (!ok) return (0, 0);
        uint256 price = _word(gs, 0);
        center = int256(int24(int256(_word(gs, 1))));
        string[13] memory views = [
            "liquidity()", "prevTickGlobal()", "nextTickGlobal()", "totalFeeGrowth0Token()", "totalFeeGrowth1Token()",
            "getReserves()", "lastFeeTransferTimestamp()", "getCommunityFeePending()", "getPluginFeePending()",
            "plugin()", "communityVault()", "tickSpacing()", "isUnlocked()"
        ];
        for (uint256 i = 0; i < views.length; i++) _call(p, abi.encodeWithSignature(views[i]));
        // Linked list of initialized ticks, MIN_TICK -> MAX_TICK.
        int256 t = MIN_TICK;
        while (ticks < a.maxTicks) {
            (bool okt, bytes memory td) = _call(p, abi.encodeWithSignature("ticks(int24)", int24(t)));
            ticks++;
            if (!okt || t >= MAX_TICK) break;
            int256 nxt = int256(int24(int256(_word(td, 3))));
            if (nxt <= t) break;
            t = nxt;
        }
        // Tick tree (used when liquidity is added at a new price point).
        (bool okr, bytes memory rt) = _call(p, abi.encodeWithSignature("tickTreeRoot()"));
        if (okr) {
            uint256 root = _word(rt, 0);
            for (uint256 i = 0; i < 32; i++) {
                if (root & (1 << i) == 0) continue;
                (bool oks, bytes memory sl) = _call(p, abi.encodeWithSignature("tickTreeSecondLayer(int16)", int16(int256(i))));
                if (!oks) continue;
                uint256 bits = _word(sl, 0);
                while (bits != 0) {
                    uint256 b = _lsb(bits);
                    bits &= bits - 1;
                    int256 leaf = int256(i) * 256 + int256(b) - 3466;
                    _call(p, abi.encodeWithSignature("tickTable(int16)", int16(leaf)));
                }
            }
        }
        _probe(a, price);
    }

    // ---- Uniswap V4 (hook-free pool in the PoolManager) ----
    function _ext(address pm, bytes32 slot) internal view returns (uint256 v) {
        (bool ok, bytes memory out) = _call(pm, abi.encodeWithSignature("extsload(bytes32)", slot));
        if (ok) v = _word(out, 0);
    }

    function _v4(Args calldata a) internal view returns (int256 lo, int256 hi, int256 center, uint256 ticks) {
        address pm = a.pool;
        uint256 base = uint256(keccak256(abi.encode(a.v4id, uint256(6))));
        uint256 s0 = _ext(pm, bytes32(base));
        for (uint256 i = 1; i < 4; i++) _ext(pm, bytes32(base + i));
        center = int256(int24(int256(s0 >> 160)));
        int256 sp = a.v4spacing;
        if (sp <= 0) return (1, 0, center, 0);
        (lo, hi) = _window(center, sp, a);
        for (int256 w = lo; w <= hi; w++) {
            uint256 bits = _ext(pm, keccak256(abi.encode(int16(w), base + 5)));
            while (bits != 0 && ticks < a.maxTicks) {
                uint256 b = _lsb(bits);
                bits &= bits - 1;
                int256 t = ((w << 8) + int256(b)) * sp;
                uint256 ts = uint256(keccak256(abi.encode(int24(t), base + 4)));
                for (uint256 k = 0; k < 3; k++) _ext(pm, bytes32(ts + k));
                ticks++;
            }
        }
    }

    // ---- probe swaps (cancelled in the callback, see header) ----
    function _probe(Args calldata a, uint256 sqrtP) internal {
        if (a.probeBps == 0 || sqrtP == 0) return;
        uint256 d = (sqrtP * a.probeBps) / 10000;
        uint256 down = sqrtP > d ? sqrtP - d : 0;
        uint256 up = sqrtP + d;
        int256 amount = int256(1 << 120);
        if (down > MIN_SQRT) {
            a.pool.call(abi.encodeWithSignature("swap(address,bool,int256,uint160,bytes)", address(this), true, amount, uint160(down), ""));
        }
        if (up < MAX_SQRT) {
            a.pool.call(abi.encodeWithSignature("swap(address,bool,int256,uint160,bytes)", address(this), false, amount, uint160(up), ""));
        }
    }

    function _lsb(uint256 x) internal pure returns (uint256 r) {
        // index of the lowest set bit (x != 0)
        x = x & (~x + 1);
        if (x >= 1 << 128) { x >>= 128; r += 128; }
        if (x >= 1 << 64) { x >>= 64; r += 64; }
        if (x >= 1 << 32) { x >>= 32; r += 32; }
        if (x >= 1 << 16) { x >>= 16; r += 16; }
        if (x >= 1 << 8) { x >>= 8; r += 8; }
        if (x >= 1 << 4) { x >>= 4; r += 4; }
        if (x >= 1 << 2) { x >>= 2; r += 2; }
        if (x >= 1 << 1) { r += 1; }
    }
}
