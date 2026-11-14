#!/usr/bin/env python3
# ============================================================================
# FEED RELAY (runs on the sniper feed server, started by sniper-cron.sh)
#
# Plain English:
#   Robinhood's public sequencer feed only accepts COMPRESSED websocket
#   connections ("permessage-deflate"); without it the server answers
#   "400 Bad Request". Our Rust websocket library can't do compression, so
#   this small relay does the one thing it can't:
#     1. Keeps ONE compressed connection to the official feed.
#     2. Passes every message, unchanged, to local programs on
#        ws://127.0.0.1:9642 (uncompressed, this machine only).
#   Same idea as Chainstack Labs' robinhood-chain-sequencer-feed relay.
#
# Safety / politeness:
#   - Exactly one upstream connection, never more.
#   - Any HTTP refusal: wait 10 minutes (65 if 403) before retrying, so we
#     never get the server blocked the way repeated refusals did before.
#   - Local only: binds to 127.0.0.1. No keys, read-only.
# ============================================================================
import asyncio
import os
import sys
import time

try:
    from websockets.asyncio.client import connect
    from websockets.asyncio.server import serve
except ImportError:  # older websockets (< 13)
    from websockets import connect, serve  # type: ignore

UPSTREAM = os.environ.get("FEED_UPSTREAM", "wss://feed.mainnet.chain.robinhood.com")
HOST, PORT = "127.0.0.1", int(os.environ.get("FEED_RELAY_PORT", "9642"))

clients = set()


def log(msg):
    print(time.strftime("[%Y-%m-%d %H:%M:%S] ") + msg, flush=True)


async def local_client(ws, *_):
    """A local program connected: send it everything until it leaves."""
    clients.add(ws)
    try:
        await ws.wait_closed()
    finally:
        clients.discard(ws)


async def upstream():
    backoff = 1
    while True:
        try:
            # compression="deflate" is the default; the feed requires it.
            async with connect(UPSTREAM, open_timeout=15, max_size=None, ping_interval=20) as ws:
                log(f"feed UP ({UPSTREAM})")
                backoff = 1
                async for msg in ws:
                    for c in list(clients):
                        try:
                            await c.send(msg)
                        except Exception:
                            clients.discard(c)
            log("feed closed by server")
        except Exception as e:
            text = f"{type(e).__name__}: {e}"
            log(f"feed DOWN ({text})")
            if "HTTP" in text or "status" in text.lower():
                wait = 65 * 60 if "403" in text else 600
                log(f"feed refused us, waiting {wait // 60} min before retrying")
                await asyncio.sleep(wait)
                continue
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 30)


async def main():
    async with serve(local_client, HOST, PORT, compression=None, max_size=None):
        log(f"relay listening on ws://{HOST}:{PORT}")
        await upstream()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
