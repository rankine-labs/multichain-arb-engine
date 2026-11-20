#!/usr/bin/env python3
# ============================================================================
# V4 HISTORY READ: every Uniswap V4 pool ever created, by pool id
#
# Plain English:
#   The sniper only knows a V4 pool's "key" (its two coins, fee, spacing,
#   hook) if it saw the pool being created, so V4 pools made before a run
#   started were skipped as "unknown v4 pool" (159 rushes in run 8's first
#   3 hours). This reads every pool creation (PoolManager Initialize event)
#   from the chain's full history once, the same way the dex bot does it
#   (PR #185, src/core/v4EventDiscovery.ts):
#     - log requests over block ranges that adapt: bigger while answers are
#       small (up to 500,000 blocks), halved when the node refuses or times
#       out (down to 50); a "slow down" answer waits and retries the same
#       range;
#     - progress saved, so a restart carries on where it stopped.
#   Unlike the dex bot's file (which keeps only pools its fee list can't
#   guess, without their ids), this keeps every pool BY ID that the sniper
#   could trade: one side WETH / USDG / native ETH, and no hook that can
#   change trade amounts (the same rule as venue.rs hook_changes_amounts).
#
#   Output: paper-out/v4_pool_keys.json (shared by all runs, same format as
#   each run's own v4_pool_keys.json). Read-only on the chain.
#   Usage: python3 deploy/v4-history.py [out_dir=paper-out] [from_block=0]
# ============================================================================
import json
import os
import sys
import time
import urllib.request

RPC = os.environ.get("SNIPER_RHC_HTTP", "")
PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
INIT = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438"
WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"
USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
NATIVE = "0x" + "0" * 40
BASES = {WETH, USDG, NATIVE}
RETURNS_DELTA = (1 << 3) | (1 << 2)  # before/after swap returns delta
MIN_R, MAX_R, START_R, TARGET_LOGS = 50, 500_000, 50_000, 3_000
calls = 0


class Refused(Exception):
    pass


class SlowDown(Exception):
    pass


def rpc(method, params):
    global calls
    calls += 1
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            v = json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code == 429:
            raise SlowDown()
        raise Refused(f"http {e.code}")
    except Exception as e:  # timeout / connection
        raise Refused(type(e).__name__)
    if "error" in v:
        msg = str(v["error"]).lower()
        if "rate" in msg or "too many requests" in msg:
            raise SlowDown()
        raise Refused(msg[:120])
    return v["result"]


def decode(l):
    """Initialize log -> (id, key dict) or None (same checks as the dex bot)."""
    t = l.get("topics") or []
    if len(t) != 4 or t[0].lower() != INIT or l.get("removed"):
        return None
    d = (l.get("data") or "0x")[2:]
    if len(d) < 64 * 5:
        return None
    w = lambda i: int(d[64 * i:64 * (i + 1)], 16)
    fee, ts_raw, hooks = w(0), w(1), w(2)
    if fee >= 1 << 24 or hooks >= 1 << 160:
        return None
    ts = ts_raw - (1 << 256) if ts_raw >= 1 << 255 else ts_raw
    if not -(1 << 23) <= ts < (1 << 23):
        return None
    c0, c1 = "0x" + t[2][-40:].lower(), "0x" + t[3][-40:].lower()
    hk = "0x%040x" % hooks
    return t[1].lower(), {"c0": c0, "c1": c1, "fee": fee, "ts": ts, "hooks": hk}


def keep(k):
    """Pools the sniper could trade, with a hook that can't change amounts."""
    if k["c0"] not in BASES and k["c1"] not in BASES:
        return False
    return (int(k["hooks"], 16) & 0x3FFF) & RETURNS_DELTA == 0


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "paper-out"
    start = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "v4_pool_keys.json")
    prog = os.path.join(out_dir, "v4_history_progress.json")
    keys = json.load(open(out)) if os.path.exists(out) else {}
    st = json.load(open(prog)) if os.path.exists(prog) else {"next": start, "seen": 0, "skipped_hook": 0, "skipped_pair": 0}
    head = int(rpc("eth_blockNumber", []), 16)
    frm, rng, last_save = st["next"], START_R, time.time()
    print(f"v4-history: blocks {frm}..{head}, {len(keys)} keys so far", file=sys.stderr)
    fails = 0
    while frm <= head:
        to = min(head, frm + rng - 1)
        try:
            logs = rpc("eth_getLogs", [{"address": PM, "topics": [INIT], "fromBlock": hex(frm), "toBlock": hex(to)}])
        except SlowDown:
            time.sleep(5)
            continue
        except Refused as e:
            if rng > MIN_R:
                rng = max(MIN_R, rng // 2)
                continue
            fails += 1
            if fails > 5:
                print(f"v4-history: giving up at block {frm} ({e}); rerun to continue", file=sys.stderr)
                break
            time.sleep(10 * fails)
            continue
        fails = 0
        for l in logs:
            d = decode(l)
            if not d:
                continue
            st["seen"] += 1
            pid, k = d
            if keep(k):
                keys[pid] = k
            elif k["c0"] in BASES or k["c1"] in BASES:
                st["skipped_hook"] += 1
            else:
                st["skipped_pair"] += 1
        frm = to + 1
        st["next"] = frm
        # grow while answers are small, shrink when they are big
        if len(logs) < TARGET_LOGS // 4:
            rng = min(MAX_R, rng * 2)
        elif len(logs) > TARGET_LOGS:
            rng = max(MIN_R, rng // 2)
        if time.time() - last_save > 30 or frm > head:
            for path, obj in ((out, keys), (prog, st)):
                json.dump(obj, open(path + ".tmp", "w"))
                os.replace(path + ".tmp", path)
            last_save = time.time()
            print(f"v4-history: block {frm}/{head} ({100*frm/max(1,head):.0f}%) | pools seen {st['seen']} | kept {len(keys)} | requests {calls}", file=sys.stderr)
        time.sleep(0.05)
    for path, obj in ((out, keys), (prog, st)):
        json.dump(obj, open(path + ".tmp", "w"))
        os.replace(path + ".tmp", path)
    print(f"v4-history: done to block {frm - 1} | pools seen {st['seen']} | kept {len(keys)} (tradeable) | skipped: unsafe hook {st['skipped_hook']}, other pairs {st['skipped_pair']} | requests {calls}")


if __name__ == "__main__":
    main()
