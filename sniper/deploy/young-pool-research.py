#!/usr/bin/env python3
# ============================================================================
# young-pool-research.py: can we keep the young-pool profit without the rugs?
# Read-only research on recorded paper trades. No node calls.
#
# Plain English:
#   Loads every YOUNG TEST paper trade (pool < 1 h old) from all run folders,
#   marks the rugs (lost half or more of the stake, or the exit could not be
#   priced at all), then slices the results every way we have data for:
#     - pool age (finer buckets inside the first 15 minutes)
#     - venue and base coin
#     - the rush before entry (buyers vs sellers)
#     - the early check (what an exit a few blocks in would have paid)
#     - safety measurements recorded at the buy (code flags, owner, proxy...)
#   and replays a few candidate rules ("only V4", "skip if...", "exit early if
#   in profit") to see what each keeps and what it gives up.
#   Also works out the break-even rug rate: how often rugs can happen before
#   the young pocket stops paying.
#
# Usage (from ~/sniper-bin):
#   python3 -I young-pool-research.py paper-out
# ============================================================================
import collections
import glob
import json
import os
import sys


def is_rug(t):
    """Same definition the bot uses: lost >= half the stake, or no exit price."""
    if t.get("reason") == "exit_quote_failed":
        return True
    usd = t.get("usd_in") or 0
    return usd > 0 and t.get("net_usd", 0) <= -0.5 * usd


def load(root):
    """Young test trades from every run folder, de-duplicated, plus the rug
    measurements written at the buy (signals.jsonl, keyed by pool + block)."""
    trades, seen, meta = [], set(), {}
    for d in sorted(glob.glob(os.path.join(root, "*"))):
        sp = os.path.join(d, "signals.jsonl")
        if os.path.exists(sp):
            for line in open(sp):
                if '"taken"' not in line:
                    continue
                try:
                    s = json.loads(line)
                except ValueError:
                    continue
                if s.get("taken") and s.get("pool"):
                    meta[(s["pool"].lower(), s.get("block"))] = s
        tp = os.path.join(d, "paper_trades.jsonl")
        if not os.path.exists(tp):
            continue
        for line in open(tp):
            try:
                t = json.loads(line)
            except ValueError:
                continue
            if t.get("group") != "young" or "net_usd" not in t or "ladder" in t:
                continue
            key = ((t.get("pool") or "").lower(), t.get("open_block"))
            if key in seen:
                continue
            seen.add(key)
            t["_run"] = os.path.basename(d)
            t["_meta"] = meta.get(key, {})
            t["_rug"] = is_rug(t)
            trades.append(t)
    return trades


def line(name, ts):
    """One summary row: trades, win rate, rugs, net, net without rugs, per trade."""
    if not ts:
        print(f"  {name:38s}    0 trades")
        return
    n = len(ts)
    w = sum(t["net_usd"] > 0 for t in ts)
    r = [t for t in ts if t["_rug"]]
    net = sum(t["net_usd"] for t in ts)
    clean = sum(t["net_usd"] for t in ts if not t["_rug"])
    print(f"  {name:38s} {n:5d} trades | wins {100*w/n:3.0f}% | rugs {len(r):3d} ({100*len(r)/n:4.1f}%) "
          f"| net ${net:+8.0f} | no-rug ${clean:+8.0f} | ${net/n:+.2f}/trade")


def bucket(t, edges, key):
    v = t.get(key)
    if v is None:
        return "unknown"
    for lo, hi, lab in edges:
        if lo <= v < hi:
            return lab
    return "other"


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "paper-out"
    T = load(root)
    print(f"{len(T)} young-pool trades across runs: "
          + ", ".join(f"{k} {v}" for k, v in sorted(collections.Counter(t['_run'] for t in T).items())))
    U = [t for t in T if (t.get("pool_age_s") or 9e9) < 900]
    print("\n== All young (<1 h) vs under 15 min ==")
    line("all young", T)
    line("under 15 min", U)

    print("\n== Under 15 min, by pool age ==")
    edges = [(0, 120, "0-2 min"), (120, 300, "2-5 min"), (300, 600, "5-10 min"), (600, 900, "10-15 min")]
    for lab in [e[2] for e in edges]:
        line(lab, [t for t in U if bucket(t, edges, "pool_age_s") == lab])

    print("\n== Under 15 min, by venue / base ==")
    for k in sorted({(t.get("venue"), t.get("base")) for t in U}, key=str):
        line(f"{k[0]} {k[1]}", [t for t in U if (t.get("venue"), t.get("base")) == k])

    print("\n== Under 15 min, by run (is it consistent?) ==")
    for run in sorted({t["_run"] for t in U}):
        line(run, [t for t in U if t["_run"] == run])

    print("\n== Under 15 min, rush before entry (buyers / sellers) ==")
    def ratio(t):
        pf = t.get("pre_flow") or {}
        b, s = pf.get("buys", 0), pf.get("sells", 0)
        return b / s if s else (99 if b else 0)
    for lab, f in (("buyers > 2x sellers", lambda r: r > 2), ("buyers 1-2x", lambda r: 1 <= r <= 2), ("sellers >= buyers", lambda r: r < 1)):
        line(lab, [t for t in U if f(ratio(t))])

    print("\n== Under 15 min, how long rugs/wins were held ==")
    rugs = [t for t in U if t["_rug"]]
    hs = sorted(t.get("held_s") or 0 for t in rugs)
    if hs:
        print(f"  rug hold seconds: min {hs[0]:.1f} | median {hs[len(hs)//2]:.1f} | max {hs[-1]:.1f}")
    early_r = [t.get("early", {}).get("net_if_exit") for t in rugs if isinstance((t.get("early") or {}).get("net_if_exit"), (int, float))]
    if early_r:
        pos = sum(x > 0 for x in early_r)
        print(f"  rugs with an early-exit quote recorded: {len(early_r)} | of those in profit at the early check: {pos}")

    print("\n== Under 15 min, safety measurements at the buy (where recorded) ==")
    for field in ("proxy", "owner_renounced", "lp_holder_is_creator"):
        vals = collections.defaultdict(list)
        for t in U:
            sf = ((t["_meta"].get("rug") or {}).get("safety") or {})
            vals[str(sf.get(field))].append(t)
        for v, ts in sorted(vals.items()):
            line(f"{field}={v}", ts)
    flags = collections.defaultdict(list)
    for t in U:
        sf = ((t["_meta"].get("rug") or {}).get("safety") or {})
        cf = sf.get("code_flags") or []
        flags["code flags: none" if not cf else "code flags: some"].append(t)
    for k, ts in sorted(flags.items()):
        line(k, ts)

    print("\n== Candidate rules on the under-15-min pocket ==")
    line("baseline", U)
    line("V4 only", [t for t in U if t.get("venue") == "v4"])
    line("skip 0-2 min old", [t for t in U if (t.get("pool_age_s") or 0) >= 120])
    line("V4 only, skip 0-2 min", [t for t in U if t.get("venue") == "v4" and (t.get("pool_age_s") or 0) >= 120])
    line("buyers > 2x sellers only", [t for t in U if ratio(t) > 2])

    print("\n== Break-even rug rate (under 15 min) ==")
    clean = [t for t in U if not t["_rug"]]
    if clean and rugs:
        gain = sum(t["net_usd"] for t in clean) / len(clean)
        loss = -sum(t["net_usd"] for t in rugs) / len(rugs)
        be = gain / (gain + loss)
        print(f"  clean trade avg ${gain:+.2f} | rug avg -${loss:.2f} | break-even rug rate {100*be:.1f}% "
              f"(actual {100*len(rugs)/len(U):.1f}%)")


if __name__ == "__main__":
    main()
