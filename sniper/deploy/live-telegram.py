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
#     python3 -I deploy/live-telegram.py paper-out/live1 --test   (one test message)
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
    trades = Tail(os.path.join(out, "live_trades.jsonl"))
    log = Tail("live.log")
    day = 0.0
    last_sent = {}  # alert key -> last post time, for the cooldown
    send(tok, chat, f"🎯 SNIPER live notifier started ({out}). Every live buy and sell will post here.")
    print(f"{time.strftime('%H:%M:%S')} watching {out}", flush=True)
    while True:
        for line in trades.lines():
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("event") == "sell" and isinstance(d.get("real_net_usd"), (int, float)):
                day += d["real_net_usd"]
            send(tok, chat, fmt(d, day))
        for line in log.lines():
            if worth_alert(line, last_sent, time.time()):
                send(tok, chat, "⚠️ <b>SNIPER LIVE</b> " + line[:500].replace("<", "&lt;"))
        time.sleep(POLL_S)


if __name__ == "__main__":
    main()
