#!/usr/bin/env python3
# ============================================================================
# RUG WARNING TEST: could watching the pool's liquidity have saved us?
#
# Plain English:
#   Most of our rugs were "liquidity pulls": the creator removed the pool's
#   money while we held, so we could not sell. Robinhood Chain has no
#   mempool, so we can never see the pull itself coming. The only hope is a
#   WARNING SIGN before it: a smaller earlier removal, or the puller's wallet
#   doing something (approvals, transfers) shortly before.
#
#   For every rug trade in every paper run (exit quote failed, or lost half
#   or more), this finds:
#     - the liquidity removals on that pool from 5 min before our buy to
#       5 min after (V3/V2 Burn events, V4 ModifyLiquidity with a negative
#       amount), with the wallet that sent each one
#     - the big pull (the largest removal after our buy)
#     - any warning before the big pull: an earlier removal on the pool, or
#       any event from the puller's wallet, and how many seconds before the
#       pull it happened
#   Verdict per rug:
#     SKIP   warning came before our buy        -> we would not have bought
#     SAVED  warning came after our buy, >= 0.5 s before the pull
#            -> a watcher (websocket, ~0.1 s) could have sold first
#     LOST   no warning, or less than 0.5 s     -> nothing would have helped
#     OTHER  no liquidity removal found (dump by a holder, tax, etc.)
#   Read-only. Node: SNIPER_RHC_HTTP (URL never printed).
#   Usage: python3 -I rug-warning-test.py paper-out
# ============================================================================
import glob
import json
import os
import sys
import time
import urllib.request

RPC = os.environ.get("SNIPER_RHC_HTTP", "")
PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"          # V4 PoolManager
V3_BURN = "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c"
V2_BURN = "0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496"
V4_MOD = "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec"
BLOCK_S = 0.105
WIN = 3000            # blocks either side of our buy (~5 min)
SAVE_GAP_S = 0.5      # warning must come this long before the pull
calls = 0


def rpc(method, params):
    """One node request with a few retries."""
    global calls
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
    last = None
    for attempt in range(3):
        try:
            calls += 1
            with urllib.request.urlopen(req, timeout=60) as r:
                v = json.loads(r.read())
            if "error" in v:
                raise ValueError(str(v["error"])[:160])
            return v["result"]
        except OSError as e:
            last = e
            time.sleep(1 + attempt)
    raise last


def logs(addr, topics, a, b):
    """eth_getLogs over [a, b], split into 2,000-block pieces."""
    out = []
    x = a
    while x <= b:
        y = min(b, x + 1999)
        f = {"fromBlock": hex(x), "toBlock": hex(y), "topics": topics}
        if addr:
            f["address"] = addr
        out += rpc("eth_getLogs", [f])
        x = y + 1
    return out


def signed(word):
    v = int(word, 16)
    return v - (1 << 256) if v >= 1 << 255 else v


def removals(pool, venue, a, b):
    """[(block, log_index, tx, size)] liquidity removals on this pool."""
    res = []
    if venue == "v4" or len(pool) == 66:
        for l in logs(PM, [V4_MOD, pool], a, b):
            d = l["data"][2:]
            delta = signed(d[128:192])
            if delta < 0:
                res.append((int(l["blockNumber"], 16), int(l["logIndex"], 16), l["transactionHash"], -delta))
    else:
        for l in logs(pool, [[V3_BURN, V2_BURN]], a, b):
            d = l["data"][2:]
            size = int(d[0:64], 16) if l["topics"][0] == V3_BURN else int(d[0:64], 16) + int(d[64:128], 16)
            if size > 0:
                res.append((int(l["blockNumber"], 16), int(l["logIndex"], 16), l["transactionHash"], size))
    return sorted(res)


def sender(tx):
    t = rpc("eth_getTransactionByHash", [tx])
    return (t or {}).get("from", "").lower()


def wallet_events(w, a, b):
    """Blocks where wallet w shows up in any event (as topic1 or topic2)."""
    pad = "0x" + w[2:].rjust(64, "0")
    blocks = set()
    for topics in ([None, pad], [None, None, pad]):
        try:
            for l in logs(None, topics, a, b):
                blocks.add(int(l["blockNumber"], 16))
        except (ValueError, OSError):
            pass
    return sorted(blocks)


def rug_trades(root):
    """Every rug trade in every run: dicts with run, pool, venue, open_block."""
    out = []
    for f in sorted(glob.glob(os.path.join(root, "run*", "paper_trades.jsonl"))):
        run = os.path.basename(os.path.dirname(f))
        rows = []
        for line in open(f):
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
        for i, r in enumerate(rows):
            if "reason" not in r or r.get("pool") is None:
                continue
            usd = r.get("usd_in") or 50.0
            net = r.get("net_usd") or 0.0
            if not (r["reason"] == "exit_quote_failed" or net <= -0.5 * usd):
                continue
            ob = r.get("open_block")
            if ob is None:  # exit_quote_failed rows: open block is on the next ladder line
                for x in rows[i + 1:i + 4] + rows[max(0, i - 3):i]:
                    if x.get("ladder_for") == r["pool"] and x.get("open_block"):
                        ob = x["open_block"]
                        break
            if ob:
                out.append({"run": run, "pool": r["pool"].lower(), "venue": r.get("venue", ""), "open": ob, "net": net, "why": r["reason"], "group": r.get("group", "main")})
    return out


def main():
    if not RPC:
        sys.exit("set SNIPER_RHC_HTTP")
    rugs = rug_trades(sys.argv[1] if len(sys.argv) > 1 else "paper-out")
    print(f"rug trades found: {len(rugs)}", flush=True)
    tally = {"SKIP": 0, "SAVED": 0, "LOST": 0, "OTHER": 0}
    money = dict.fromkeys(tally, 0.0)
    for t in rugs:
        a, b = t["open"] - WIN, t["open"] + WIN
        try:
            rem = removals(t["pool"], t["venue"], a, b)
        except (ValueError, OSError) as e:
            print(f"  {t['run']} {t['pool'][:12]} lookup failed: {e}")
            continue
        after = [r for r in rem if r[0] >= t["open"]]
        if not after:
            verdict, note = "OTHER", "no liquidity removal found near our trade"
        else:
            big = max(after, key=lambda r: r[3])
            pull_b = big[0]
            earlier = [r for r in rem if (r[0], r[1]) < (big[0], big[1])]
            puller = sender(big[2])
            wev = [x for x in wallet_events(puller, a, pull_b) if x < pull_b] if puller else []
            # Before our buy only an earlier REMOVAL counts as a warning (the
            # creator adding liquidity or trading at launch is normal). After
            # our buy, any removal or any event from the puller's wallet does.
            before = [r[0] for r in earlier if r[0] < t["open"]]
            warn = sorted({r[0] for r in earlier if r[0] >= t["open"]} | {x for x in wev if x >= t["open"]})
            last_warn = warn[-1] if warn else None
            gap_s = (pull_b - last_warn) * BLOCK_S if last_warn is not None else None
            held_s = (pull_b - t["open"]) * BLOCK_S
            if before:
                verdict = "SKIP"
                note = f"a removal {(t['open'] - before[-1]) * BLOCK_S:.1f}s BEFORE our buy ({len(before)} removal(s) before)"
            elif last_warn is not None and gap_s >= SAVE_GAP_S:
                verdict = "SAVED"
                note = f"warning {gap_s:.1f}s before the pull (pull {held_s:.1f}s after our buy)"
            else:
                verdict = "LOST"
                note = f"pull {held_s:.1f}s after our buy, " + ("no warning" if last_warn is None else f"warning only {gap_s:.2f}s before")
        tally[verdict] += 1
        money[verdict] += t["net"]
        print(f"  {verdict:<5} {t['run']:<6} {t['group']:<5} {t['venue']:<3} {t['pool'][:12]} ${t['net']:+.2f} | {note}", flush=True)
    print(f"\nRUG WARNING TEST | {len(rugs)} rug trades | node requests {calls}")
    for k in tally:
        print(f"  {k:<5} {tally[k]:>3} rugs  ${money[k]:+.2f}")
    print("SKIP = warning before our buy (would not have bought) | SAVED = watcher could have sold first | LOST = no usable warning | OTHER = not a liquidity pull")


if __name__ == "__main__":
    main()
