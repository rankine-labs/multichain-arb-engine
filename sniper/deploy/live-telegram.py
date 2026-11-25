#!/usr/bin/env python3
# ============================================================================
# live-telegram.py: post every LIVE sniper trade to Telegram.
#
# Plain English:
#   Watches the live run's trade log (live_trades.jsonl) and the live log
#   (live.log). Each new buy, sell, halt or refusal becomes one Telegram
#   message in the same chat the dex bot uses. It only READS files; it never
#   touches the trading process, keys or the chain, so starting/stopping it
#   can't affect trading.
#
#   Token + chat id come from the arb bot's .env (TELEGRAM_BOT_TOKEN,
#   TELEGRAM_CHAT_ID; path from ~/.sniper-cron.conf ARB_ENV). The token is
#   never printed or logged.
#
#   Usage (from ~/sniper-bin):
#     nohup python3 -I deploy/live-telegram.py paper-out/live1 >> live-telegram.log 2>&1 &
#     python3 -I deploy/live-telegram.py paper-out/live1 --test     (one test message)
#     python3 -I deploy/live-telegram.py paper-out/live1 --summary  (one summary now)
#   Also posts an hourly summary (hours with trades only) and a daily one at 8 AM Toronto.
# ============================================================================
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

EXPLORER = "https://robinhoodchain.blockscout.com/tx/"
POLL_S = 2.0

# ---------------------------------------------------------------------------
# Low-balance alert
#   Every BAL_EVERY_S the notifier reads the sniper wallet's plain ETH and
#   WETH balances from the PUBLIC Robinhood Chain RPC (not our paid node, so
#   it costs nothing against the Chainstack budget and needs no secret).
#   If either one can no longer pay for one more trade plus the gas reserve,
#   it posts a warning (at most once an hour per coin) and an all-clear when
#   it recovers. V4 trades spend plain ETH, V3 trades spend WETH.
# ---------------------------------------------------------------------------
PUBLIC_RPC = os.environ.get("SNIPER_PUBLIC_RPC", "https://rpc.mainnet.chain.robinhood.com")
WALLET = os.environ.get("SNIPER_WALLET", "0xA2462149e3b8894532622c65038905A6Eb0f540f")
WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"
USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
GAS_RESERVE_ETH = 0.0005        # live keeps this much plain ETH for emergency sells
DEFAULT_TRADE_ETH = 0.0060      # ~$10 at ~$1,700/ETH; replaced by the last real buy size
BAL_EVERY_S = 300
BAL_REPEAT_S = 3600


def kv(path, key):
    """KEY=value from an env-style file, quotes stripped ('' if missing)."""
    try:
        for line in open(os.path.expanduser(path)):
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def creds():
    arb_env = kv("~/.sniper-cron.conf", "ARB_ENV")
    tok = kv(arb_env, "TELEGRAM_BOT_TOKEN") if arb_env else ""
    chat = kv(arb_env, "TELEGRAM_CHAT_ID") if arb_env else ""
    # Sniper-only override: SNIPER_TG_CHAT in ~/.sniper-cron.conf sends the
    # sniper's messages to another chat (e.g. the "Defi Bot Alerts" group)
    # without touching the dex bot's own settings.
    chat = kv("~/.sniper-cron.conf", "SNIPER_TG_CHAT") or chat
    if not tok or not chat:
        sys.exit("live-telegram: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not found in the arb .env")
    return tok, chat


def send(tok, chat, text):
    """Post one message (HTML). Retries a few times; never raises."""
    data = urllib.parse.urlencode({"chat_id": chat, "text": text, "parse_mode": "HTML", "disable_web_page_preview": "true"}).encode()
    for attempt in range(3):
        try:
            with urllib.request.urlopen(f"https://api.telegram.org/bot{tok}/sendMessage", data, timeout=15) as r:
                if json.loads(r.read()).get("ok"):
                    return True
        except Exception as e:  # network / Telegram hiccup: log without the URL (it holds the token)
            print(f"{time.strftime('%H:%M:%S')} send failed ({type(e).__name__}), retry {attempt + 1}", flush=True)
        time.sleep(2 + 2 * attempt)
    return False


def short(h):
    return f"{h[:8]}…{h[-4:]}" if h and len(h) > 14 else (h or "?")


def tx_links(d):
    out = []
    for t in d.get("txs") or []:
        h = t.get("hash")
        if h:
            out.append(f'<a href="{EXPLORER}{h}">{t.get("what", "tx")}</a>')
    return "\n".join(out)


TOKEN_URL = "https://robinhoodchain.blockscout.com/token/"

# Why the bot sold, in plain words.
REASONS = {
    "take_profit": "hit the profit target",
    "stop_loss": "price dropped, cut the loss",
    "time": "time limit reached, got out",
    "rug": "liquidity pulled, emergency exit",
    "emergency": "emergency exit",
}


def money(x):
    """$1.20 / -$0.84 style."""
    return f"-${abs(x):.2f}" if x < 0 else f"+${x:.2f}"


def secs(s):
    try:
        s = float(s)
    except (TypeError, ValueError):
        return "?"
    return f"{s:.0f} sec" if s < 90 else f"{s / 60:.1f} min"


def coin(d):
    t = d.get("token") or ""
    return f'<a href="{TOKEN_URL}{t}">{short(t)}</a>' if t else "?"


def main_tx(d):
    """Link to the actual swap (skip the approve step)."""
    txs = [t for t in (d.get("txs") or []) if t.get("hash")]
    swaps = [t for t in txs if "approve" not in (t.get("what") or "").lower()]
    t = (swaps or txs or [None])[-1]
    return f'<a href="{EXPLORER}{t["hash"]}">view on explorer</a>' if t else ""


def fmt(d, day, day_n=None):
    """One trade row -> short plain-English Telegram message."""
    ev = d.get("event", "?")
    if ev == "buy":
        usd = d.get("usd") or d.get("usd_in")
        size = f"${usd:.2f}" if isinstance(usd, (int, float)) else "?"
        return (f"🛒 <b>BOUGHT {size}</b> of coin {coin(d)}\n"
                f"Watching for a profit to sell...\n{main_tx(d)}")
    if ev == "sell":
        real = d.get("real_net_usd")
        pct = d.get("real_pct")
        won = isinstance(real, (int, float)) and real > 0
        head = "🟢 <b>WON" if won else "🔴 <b>LOST"
        amt = f"${abs(real):.2f}" if isinstance(real, (int, float)) else "?"  # sign is in WON/LOST
        p = f" ({pct:+.1f}%)" if isinstance(pct, (int, float)) else ""
        why = REASONS.get(d.get("reason"), d.get("reason") or "?")
        if d.get("emergency") and d.get("reason") != "take_profit" and "emergency" not in why:
            why += " (fast exit)"
        dr = d.get("day_realized_usd")
        today = dr if isinstance(dr, (int, float)) else day
        lines = [
            f"{head} {amt}</b>{p} on coin {coin(d)}",
            f"Sold after {secs(d.get('held_s'))}: {why}",
        ]
        ppct = d.get("paper_pct")
        if isinstance(ppct, (int, float)) and isinstance(pct, (int, float)):
            diff = pct - ppct
            lines.append(f"Simulator expected {ppct:+.1f}% ({'better' if diff >= 0 else 'worse'} by {abs(diff):.1f}%)")
        lines.append(f"Today: <b>{money(today)}</b>" + (f" over {day_n} trades" if day_n else ""))
        lines.append(main_tx(d))
        return "\n".join(x for x in lines if x)
    return f"⚠️ <b>SNIPER LIVE</b> {ev}: {json.dumps({k: v for k, v in d.items() if k not in ('txs',)})[:600]}"


# ---------------------------------------------------------------------------
# Summaries
#   Hourly: posted at the top of each hour, only if at least one sell closed
#           in that hour (no "nothing happened" noise).
#   Daily:  posted at DAILY_HOUR local time, covering the last 24 h plus the
#           running total since live started. Always posted, even if quiet.
# Totals are rebuilt from the full trade file each time, so they stay correct
# even if this notifier was restarted.
# ---------------------------------------------------------------------------
try:
    from zoneinfo import ZoneInfo
    LOCAL_TZ = ZoneInfo("America/Toronto")
except Exception:  # very old Python: fall back to server time
    LOCAL_TZ = None
DAILY_HOUR = 8


def row_time(d):
    """Best-effort unix seconds for a trade row (None if it has no timestamp)."""
    for k in ("ts_ms", "t_ms", "time_ms", "unix_ms"):
        v = d.get(k)
        if isinstance(v, (int, float)):
            return v / 1000.0
    for k in ("ts", "time", "unix", "t"):
        v = d.get(k)
        if isinstance(v, (int, float)):
            return v / 1000.0 if v > 1e12 else float(v)
        if isinstance(v, str):
            try:
                from datetime import datetime
                return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
            except ValueError:
                pass
    return None


def local_now():
    from datetime import datetime
    return datetime.now(LOCAL_TZ) if LOCAL_TZ else datetime.now()


def stats_text(title, sells):
    """Plain-English summary block for a list of sell rows."""
    real = [s["real_net_usd"] for s in sells if isinstance(s.get("real_net_usd"), (int, float))]
    if not real:
        return f"📊 <b>{title}</b>\nNo trades."
    # Simulator result at the LIVE size: paper % x live $ in (paper itself trades $100).
    paper = [s["paper_pct"] / 100.0 * s.get("_usd", 10.0) for s in sells
             if isinstance(s.get("paper_pct"), (int, float))]
    wins = [x for x in real if x > 0]
    losses = [x for x in real if x <= 0]
    total = sum(real)
    lines = [
        f"📊 <b>{title}</b>",
        f"{'🟢' if total >= 0 else '🔴'} Profit: <b>{money(total)}</b> from {len(real)} trades",
        f"Won {len(wins)}, lost {len(losses)} ({len(wins) / len(real) * 100:.0f}% winners)",
    ]
    if wins:
        lines.append(f"Typical win {money(sum(wins) / len(wins))}, biggest {money(max(wins))}")
    if losses:
        lines.append(f"Typical loss {money(sum(losses) / len(losses))}, biggest {money(min(losses))}")
    if paper:
        diff = total - sum(paper)
        lines.append(f"Simulator expected {money(sum(paper))} (real was {'better' if diff >= 0 else 'worse'} by ${abs(diff):.2f})")
    by = {}
    for s in sells:
        if isinstance(s.get("real_net_usd"), (int, float)):
            v = (s.get("venue") or "?").upper()
            n, tot = by.get(v, (0, 0.0))
            by[v] = (n + 1, tot + s["real_net_usd"])
    if len(by) > 1:
        lines.append("By type: " + ", ".join(f"{v} {money(t)} ({n})" for v, (n, t) in sorted(by.items())))
    return "\n".join(lines)


def all_sells(path, seen_at):
    """Every sell row in the trade file, each with a close time (_t) and live
    size in USD (_usd) attached. Sell rows carry no clock time, so the close
    time is the matching buy's pos.opened_unix + held_s. Rows that still have no
    time use the moment this notifier first saw them."""
    out, open_buy = [], {}
    try:
        with open(path) as f:
            for i, line in enumerate(f):
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                key = (d.get("token") or d.get("pool") or "").lower()
                if d.get("event") == "buy":
                    open_buy[key] = d
                    continue
                if d.get("event") != "sell":
                    continue
                b = open_buy.pop(key, {})
                opened = (b.get("pos") or {}).get("opened_unix")
                t = row_time(d)
                if t is None and isinstance(opened, (int, float)):
                    t = opened + float(d.get("held_s") or 0)
                if t is None:
                    t = seen_at.setdefault(i, time.time())
                d["_t"] = t
                if isinstance(b.get("usd"), (int, float)):
                    d["_usd"] = b["usd"]
                out.append(d)
    except OSError:
        pass
    return out


class Tail:
    """Read lines appended to a file since we started (handles truncation)."""

    def __init__(self, path, from_end=True):
        self.path, self.pos = path, 0
        if from_end and os.path.exists(path):
            self.pos = os.path.getsize(path)

    def lines(self):
        try:
            size = os.path.getsize(self.path)
        except OSError:
            return []
        if size < self.pos:
            self.pos = 0
        with open(self.path) as f:
            f.seek(self.pos)
            data = f.read()
            self.pos = f.tell()
        return [l for l in data.split("\n") if l.strip()]


# live.log lines worth an alert (halts, refusals at start, gate closed, errors).
# Case-sensitive "LIVE" tag so ordinary lowercase "live" in status lines no
# longer matches.
ALERT = re.compile(r"LIVE.*(HALT|halt|refus|not done|gate|failed|stuck|unknown)")
# Routine health/status lines: never alert on these. They contain words like
# "refused 0" and "0 failed" that used to trip the alert pattern every minute.
ROUTINE = re.compile(r"ws hot|healthy|refused 0\b|\b0 failed|went quiet 0", re.I)
# Same alert text is posted at most once per this many seconds (anti-spam).
ALERT_COOLDOWN_S = 900


def worth_alert(line, last_sent, now):
    """True if this log line is a real problem we haven't posted recently."""
    if ROUTINE.search(line) or not ALERT.search(line):
        return False
    # Dedupe on the line with digits stripped, so counters don't make it "new".
    key = re.sub(r"\d+", "#", line)[:200]
    if now - last_sent.get(key, 0) < ALERT_COOLDOWN_S:
        return False
    last_sent[key] = now
    return True


def rpc(method, params):
    """One JSON-RPC call to the public node. Returns the result or None."""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    # A browser-like User-Agent: the public node rejects Python's default one.
    req = urllib.request.Request(PUBLIC_RPC, body, {"Content-Type": "application/json", "User-Agent": "curl/8.5.0"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read()).get("result")
    except Exception:
        return None


def balances():
    """(eth, weth, usdg) of the sniper wallet, or None if the node didn't answer."""
    eth = rpc("eth_getBalance", [WALLET, "latest"])
    data = "0x70a08231" + WALLET[2:].lower().rjust(64, "0")   # balanceOf(wallet)
    weth = rpc("eth_call", [{"to": WETH, "data": data}, "latest"])
    usdg = rpc("eth_call", [{"to": USDG, "data": data}, "latest"])
    if eth is None or weth is None:
        return None
    return (int(eth, 16) / 1e18, int(weth, 16) / 1e18, int(usdg, 16) / 1e6 if usdg else 0.0)


def trade_eth(trade_path):
    """ETH needed for one trade: the size of the last real buy (base_in), else the default."""
    last = None
    try:
        for line in open(trade_path):
            if '"event":"buy"' in line or '"event": "buy"' in line:
                last = line
        if last:
            d = json.loads(last)
            b = (d.get("pos") or {}).get("base_in") or d.get("base_spent")
            if b and d.get("base") in ("ETH", "WETH"):
                return int(b) / 1e18
    except (OSError, ValueError):
        pass
    return DEFAULT_TRADE_ETH


def balance_check(trade_path, state, now):
    """Low-balance warnings. `state` remembers what's low and when we last said so."""
    b = balances()
    if b is None:
        return []
    eth, weth, usdg = b
    need = trade_eth(trade_path)
    state["last"] = b
    msgs = []
    for name, have, needed, venue in (("plain ETH", eth, need + GAS_RESERVE_ETH, "V4"),
                                      ("WETH", weth, need, "V3")):
        low = have < needed
        was = state.get(name)
        if low and (was is None or now - was >= BAL_REPEAT_S):
            msgs.append(f"🪫 <b>SNIPER WALLET LOW: {name}</b>\n"
                        f"Has {have:.4f}, needs {needed:.4f} for one more trade.\n"
                        f"{venue} buys will be skipped until it's topped up.")
            state[name] = now
        elif not low and was is not None:
            msgs.append(f"✅ SNIPER wallet {name} OK again ({have:.4f}).")
            state.pop(name, None)
    return msgs


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "paper-out/live1"
    tok, chat = creds()
    if "--test" in sys.argv:
        ok = send(tok, chat, "🎯 SNIPER live Telegram test: trades from " + out + " will show here.")
        print("test message", "sent" if ok else "FAILED", flush=True)
        return
    trade_path = os.path.join(out, "live_trades.jsonl")
    trades = Tail(trade_path)
    log = Tail("live.log")
    last_sent = {}  # alert key -> last post time, for the cooldown
    seen_at = {}    # trade-file line number -> first-seen time (rows without a timestamp)
    # "--summary" posts one summary now (since-start + last 24 h) and exits.
    if "--summary" in sys.argv:
        sells = all_sells(trade_path, seen_at)
        cut = time.time() - 86400
        send(tok, chat, stats_text("Sniper: last 24 hours", [s for s in sells if s["_t"] >= cut])
             + "\n\n" + stats_text("Sniper: since going live", sells))
        print("summary sent", flush=True)
        return
    if "--balances" in sys.argv:
        b = balances()
        print("balances (eth, weth, usdg):", b, "| one trade needs", round(trade_eth(trade_path), 5), "ETH", flush=True)
        return
    sigs = Tail(os.path.join(out, "signals.jsonl"))
    bal_state = {}
    last_bal = 0.0
    cap_day = ""   # local day we last announced "daily loss limit reached"
    send(tok, chat, f"🎯 SNIPER live notifier started ({out}). Trades, hourly and {DAILY_HOUR} AM summaries will post here.")
    print(f"{time.strftime('%H:%M:%S')} watching {out}", flush=True)
    now = local_now()
    last_hour = now.strftime("%Y-%m-%d %H")      # hour we last considered for an hourly summary
    last_daily = now.strftime("%Y-%m-%d") if now.hour >= DAILY_HOUR else ""
    while True:
        new_rows = trades.lines()
        if new_rows:
            # Today's live total (local calendar day), rebuilt from the whole file.
            sells = all_sells(trade_path, seen_at)
            midnight = local_now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
            today = [s for s in sells
                     if s["_t"] >= midnight and isinstance(s.get("real_net_usd"), (int, float))]
            day = sum(s["real_net_usd"] for s in today)
            day_n = len(today)
        for line in new_rows:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            send(tok, chat, fmt(d, day, day_n))
        for line in log.lines():
            if worth_alert(line, last_sent, time.time()):
                send(tok, chat, "⚠️ <b>SNIPER LIVE</b> " + line[:500].replace("<", "&lt;"))
        # Live refused a buy because of the daily loss limit: say so once a day.
        for line in sigs.lines():
            if '"live_skip"' in line and "daily loss cap" in line:
                dk = local_now().strftime("%Y-%m-%d")
                if dk != cap_day:
                    send(tok, chat, "🛑 <b>SNIPER LIVE stopped for the day</b>\n"
                                    "Daily loss limit reached: one more losing trade could pass the cap, "
                                    "so new buys are refused until the limit resets (7 PM Toronto).")
                    cap_day = dk
        # Wallet balances every few minutes.
        if time.time() - last_bal >= BAL_EVERY_S:
            last_bal = time.time()
            for m in balance_check(trade_path, bal_state, last_bal):
                send(tok, chat, m)
        # Hourly summary for the hour that just ended (only if it had trades).
        now = local_now()
        hour_key = now.strftime("%Y-%m-%d %H")
        if hour_key != last_hour:
            end = now.replace(minute=0, second=0, microsecond=0).timestamp()
            sells = all_sells(trade_path, seen_at)
            hour_sells = [s for s in sells if end - 3600 <= s["_t"] < end]
            if hour_sells:
                send(tok, chat, stats_text(f"Sniper: last hour (to {now.strftime('%-I %p')})", hour_sells))
            last_hour = hour_key
        # Daily summary once per day at DAILY_HOUR local.
        day_key = now.strftime("%Y-%m-%d")
        if now.hour >= DAILY_HOUR and day_key != last_daily:
            sells = all_sells(trade_path, seen_at)
            cut = time.time() - 86400
            b = bal_state.get("last") or balances()
            wallet = (f"\n\n👛 Wallet: {b[0]:.4f} ETH, {b[1]:.4f} WETH, {b[2]:.2f} USDG" if b else "")
            send(tok, chat, stats_text("Sniper daily report (last 24 hours)", [s for s in sells if s["_t"] >= cut])
                 + "\n\n" + stats_text("Sniper: since going live", sells) + wallet)
            last_daily = day_key
        time.sleep(POLL_S)

if __name__ == "__main__":
    main()
