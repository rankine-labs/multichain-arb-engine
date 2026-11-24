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


def fmt(d, day):
    """One trade row -> message text."""
    ev = d.get("event", "?")
    venue = (d.get("venue") or "?").upper()
    pool = short(d.get("pool", ""))
    if ev == "buy":
        usd = d.get("usd_in") or d.get("usd")
        size = f"${usd:.2f}" if isinstance(usd, (int, float)) else "$?"
        return f"🎯 <b>SNIPER LIVE BUY</b> {venue}\nsize {size} | pool {pool}\n{tx_links(d)}"
    if ev == "sell":
        real = d.get("real_net_usd")
        paper = d.get("paper_net_usd")
        usd = d.get("usd_in") or 10.0
        icon = "🟢" if isinstance(real, (int, float)) and real >= 0 else "🔴"
        r = f"${real:+.2f}" if isinstance(real, (int, float)) else "?"
        fill = d.get("fill_vs_quote_pct")
        lines = [
            f"{icon} <b>SNIPER LIVE SELL</b> {venue} ({d.get('reason', '?')}, {d.get('held_s', '?')}s)",
            f"real {r}" + (f" ({real / usd * 100:+.1f}%)" if isinstance(real, (int, float)) and usd else ""),
        ]
        if isinstance(paper, (int, float)):
            lines.append(f"paper twin ${paper:+.2f}")
        if isinstance(fill, (int, float)):
            lines.append(f"fill vs quote {fill:+.2f}%")
        lines.append(f"live today ${day:+.2f}")
        lines.append(tx_links(d))
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
    """Summary block for a list of sell rows."""
    real = [s["real_net_usd"] for s in sells if isinstance(s.get("real_net_usd"), (int, float))]
    if not real:
        return f"📊 <b>{title}</b>\nno closed live trades"
    paper = [s["paper_net_usd"] for s in sells if isinstance(s.get("paper_net_usd"), (int, float))]
    fills = [s["fill_vs_quote_pct"] for s in sells if isinstance(s.get("fill_vs_quote_pct"), (int, float))]
    wins = [x for x in real if x > 0]
    losses = [x for x in real if x <= 0]
    lines = [
        f"📊 <b>{title}</b>",
        f"trades {len(real)} | wins {len(wins)} | losses {len(losses)} | win rate {len(wins) / len(real) * 100:.0f}%",
        f"real net <b>${sum(real):+.2f}</b>" + (f" | paper twin ${sum(paper):+.2f}" if paper else ""),
        f"avg win ${sum(wins) / len(wins):+.2f}" if wins else "avg win n/a",
        f"avg loss ${sum(losses) / len(losses):+.2f}" if losses else "avg loss n/a",
        f"best ${max(real):+.2f} | worst ${min(real):+.2f}",
    ]
    if fills:
        lines.append(f"avg fill vs quote {sum(fills) / len(fills):+.2f}%")
    # Per-venue split (V3 vs V4 etc.)
    by = {}
    for s in sells:
        if isinstance(s.get("real_net_usd"), (int, float)):
            v = (s.get("venue") or "?").upper()
            n, tot = by.get(v, (0, 0.0))
            by[v] = (n + 1, tot + s["real_net_usd"])
    if by:
        lines.append(" | ".join(f"{v}: {n} trades ${t:+.2f}" for v, (n, t) in sorted(by.items())))
    return "\n".join(lines)


def all_sells(path, seen_at):
    """Every sell row in the trade file, each with a timestamp attached.
    Rows without their own timestamp use the time this notifier first saw them."""
    out = []
    try:
        with open(path) as f:
            for i, line in enumerate(f):
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get("event") != "sell":
                    continue
                t = row_time(d)
                if t is None:
                    t = seen_at.setdefault(i, time.time())
                d["_t"] = t
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
        send(tok, chat, stats_text("SNIPER live: last 24 h", [s for s in sells if s["_t"] >= cut])
             + "\n\n" + stats_text("SNIPER live: since start", sells))
        print("summary sent", flush=True)
        return
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
            day = sum(s["real_net_usd"] for s in sells
                      if s["_t"] >= midnight and isinstance(s.get("real_net_usd"), (int, float)))
        for line in new_rows:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            send(tok, chat, fmt(d, day))
        for line in log.lines():
            if worth_alert(line, last_sent, time.time()):
                send(tok, chat, "⚠️ <b>SNIPER LIVE</b> " + line[:500].replace("<", "&lt;"))
        # Hourly summary for the hour that just ended (only if it had trades).
        now = local_now()
        hour_key = now.strftime("%Y-%m-%d %H")
        if hour_key != last_hour:
            end = now.replace(minute=0, second=0, microsecond=0).timestamp()
            sells = all_sells(trade_path, seen_at)
            hour_sells = [s for s in sells if end - 3600 <= s["_t"] < end]
            if hour_sells:
                send(tok, chat, stats_text(f"SNIPER live: last hour (to {now.strftime('%-I %p')})", hour_sells))
            last_hour = hour_key
        # Daily summary once per day at DAILY_HOUR local.
        day_key = now.strftime("%Y-%m-%d")
        if now.hour >= DAILY_HOUR and day_key != last_daily:
            sells = all_sells(trade_path, seen_at)
            cut = time.time() - 86400
            send(tok, chat, stats_text("SNIPER live: daily (last 24 h)", [s for s in sells if s["_t"] >= cut])
                 + "\n\n" + stats_text("SNIPER live: since start", sells))
            last_daily = day_key
        time.sleep(POLL_S)

if __name__ == "__main__":
    main()
