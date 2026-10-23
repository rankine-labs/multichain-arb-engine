#!/usr/bin/env python3
# =============================================================================
# misswatch.py: READ-ONLY "why did we lose this race?" checker (Oct 23, 2026)
#
# Plain English:
#   Watches the bot's log. Every time the bot sends a REAL trade, this script:
#     1. waits for the trade's result on chain (won or failed),
#     2. replays our exact trade on a paid node, block by block, from the block
#        the Rust copy checked up to the block our trade landed in, to see when
#        the chance disappeared,
#     3. finds the trade that moved the price first (the "opener") and the
#        rival trade that took the chance (the "closer"), and where they sat,
#     4. writes one plain line per trade to data/miss-analysis.txt and the full
#        details to data/miss-analysis.jsonl.
#
#   It never sends anything, never touches the bot, never prints node URLs or
#   keys. It only reads the log, the fast-check file and the chain.
#
# Run (on the server, from ~/multichain-arb-engine):
#   nohup python3 ~/inbot-bench/bench/tools/misswatch.py >> data/misswatch.log 2>&1 &
# Options (environment):
#   MISS_LOG   bot log file   (default ~/.pm2/logs/dex-arb-shadow-out.log)
#   MISS_NODE  which .env node setting to use (default QUICKNODE_RPC_ROBINHOOD,
#              falls back to CHAINSTACK_RPC_ROBINHOOD). Public node has no
#              history, so it can't replay older blocks.
#   MISS_BACKFILL=1  also analyse sends already in the log (from the last start)
# =============================================================================
import json, os, re, sys, time, threading, urllib.request

ROOT = os.getcwd()
ENV = os.path.join(ROOT, '.env')
LOG = os.path.expanduser(os.environ.get('MISS_LOG', '~/.pm2/logs/dex-arb-shadow-out.log'))
SIMFILE = os.path.join(ROOT, 'data/local-sim-shadow.jsonl')
OUT_TXT = os.path.join(ROOT, 'data/miss-analysis.txt')
OUT_JSON = os.path.join(ROOT, 'data/miss-analysis.jsonl')

# Swap event signatures we look for (who touched our pools):
SWAP_TOPICS = {
    '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67': 'v3',      # Uniswap V3 style
    '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83': 'pcs-v3',  # PancakeSwap V3 style
    '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f': 'v4',      # Uniswap V4 PoolManager
    '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822': 'v2',      # Uniswap V2 style
}
OPENER_LOOKBACK = 20  # blocks to look back for the trade that opened the gap


def read_env(name):
    """Value of one .env setting (never printed)."""
    try:
        for line in open(ENV):
            if line.startswith(name + '='):
                return line.split('=', 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return None


NODE_NAME = os.environ.get('MISS_NODE', 'QUICKNODE_RPC_ROBINHOOD')
NODE = read_env(NODE_NAME) or read_env('CHAINSTACK_RPC_ROBINHOOD')
if not NODE:
    sys.exit('misswatch: no paid node setting found in .env')


def rpc(method, params, tries=3):
    """One JSON-RPC call to the paid node. Returns the whole reply (dict)."""
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
    for i in range(tries):
        try:
            req = urllib.request.Request(NODE, body, {'content-type': 'application/json', 'user-agent': 'misswatch/1'})
            return json.load(urllib.request.urlopen(req, timeout=20))
        except Exception as e:  # network hiccup: short wait, try again
            err = str(e)[:80]
            time.sleep(1 + i)
    return {'error': {'message': 'request failed: ' + err}}


def result(method, params):
    return rpc(method, params).get('result')


def touched_addresses(tx_hash):
    """Every contract our trade called (pools, PoolManager, lenders), from a trace."""
    tr = result('debug_traceTransaction', [tx_hash, {'tracer': 'callTracer'}])
    seen = set()

    def walk(c):
        if not isinstance(c, dict):
            return
        if c.get('to'):
            seen.add(c['to'].lower())
        for s in c.get('calls') or []:
            walk(s)
    walk(tr)
    return seen


def swaps_on(receipt, pools):
    """Swap events in one receipt that hit one of our pools: list of (kind, address)."""
    out = []
    for lg in receipt.get('logs') or []:
        t = (lg.get('topics') or [None])[0]
        if t in SWAP_TOPICS and lg['address'].lower() in pools:
            out.append((SWAP_TOPICS[t], lg['address'].lower()))
    return out


def block_receipts(n):
    return result('eth_getBlockReceipts', [hex(n)]) or []


def replay(tx, block):
    """Would our exact trade work on the state after `block`? OK / REVERT / ERR."""
    r = rpc('eth_call', [{'from': tx['from'], 'to': tx['to'], 'data': tx['input'], 'gas': '0x400000'}, hex(block)])
    if 'result' in r:
        return 'OK'
    msg = json.dumps(r.get('error', {}))
    return 'REVERT' if 'revert' in msg.lower() else 'ERR'


def latest_copy_record(before_ms):
    """The newest live fast-check 'profit' answer written before the send."""
    try:
        with open(SIMFILE, 'rb') as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 400_000))
            lines = f.read().decode(errors='ignore').splitlines()[1:]
    except OSError:
        return None
    best = None
    for l in lines:
        try:
            d = json.loads(l)
        except ValueError:
            continue
        # Any live-mode check (decided by the copy OR by the node when the copy
        # was unsure): the newest one before the send is this send's check.
        if d.get('mode') == 'on' and d.get('k') != 'recheck' and d.get('t', 0) <= before_ms + 2000:
            best = d
    if best and before_ms - best.get('t', 0) > 30_000:
        return None  # too old to be this send's check
    return best


def describe(tx_hash, ctx, seen_ms):
    """Full analysis of one real send. Returns (plain line, details dict)."""
    rec = None
    for _ in range(90):  # wait up to ~90 s for the result
        rec = result('eth_getTransactionReceipt', [tx_hash])
        if rec:
            break
        time.sleep(1)
    if not rec:
        return f'{tx_hash[:10]} no result after 90 s (not mined?)', {'tx': tx_hash, 'status': 'no receipt'}
    tx = result('eth_getTransactionByHash', [tx_hash])
    landed = int(rec['blockNumber'], 16)
    ok = rec['status'] == '0x1'
    gas_eth = int(rec['gasUsed'], 16) * int(rec.get('effectiveGasPrice', '0x0'), 16) / 1e18
    copy = latest_copy_record(seen_ms)
    copy_blk = int(copy['c2blk'], 16) if copy and copy.get('c2blk') else None
    d = {'tx': tx_hash, 'won': ok, 'landed': landed, 'our_index': int(rec['transactionIndex'], 16),
         'gas_eth': gas_eth, 'context': ctx, 'copy_block': copy_blk,
         'copy_profit_usd': (int(copy['lp']) / 1e6 if copy and copy.get('lp') else None),
         'copy_answer_ms': (copy.get('lrt') if copy else None), 'log_seen_ms': seen_ms,
         # who decided: 'local' = Rust copy, 'node' = node (copy unsure); node time in ms
         'decided_by': (copy.get('dec') if copy else None), 'node_ms': (copy.get('nms') if copy else None),
         'copy_unknown_why': (copy.get('lu') if copy else None),
         'check_to_log_ms': (seen_ms - copy['t'] if copy and copy.get('t') else None)}
    if ok:
        return f'{tx_hash[:10]} WON, landed {landed}, gas {gas_eth:.8f} ETH | {ctx}', d

    pools = touched_addresses(tx_hash)
    d['touched'] = sorted(pools)
    # 1. Block by block: when did the chance disappear?
    start = copy_blk if copy_blk and landed - copy_blk <= 12 else landed - 6
    steps = [(b, replay(tx, b)) for b in range(start, landed + 1)]
    d['replay'] = {str(b): s for b, s in steps}
    closed = next((b for (b, s), (_, prev) in zip(steps[1:], steps) if s == 'REVERT' and prev == 'OK'), None)
    d['closed_block'] = closed
    # 2. Who closed it (rival trades on our pools in the closing block)?
    rivals = []
    if closed is not None:
        for r in block_receipts(closed):
            sw = swaps_on(r, pools)
            if sw:
                rivals.append({'tx': r['transactionHash'], 'index': int(r['transactionIndex'], 16),
                               'from': r['from'], 'to': r['to'], 'swaps': len(sw), 'kinds': sorted({k for k, _ in sw}),
                               'gas_price_gwei': int(r.get('effectiveGasPrice', '0x0'), 16) / 1e9,
                               'status': r['status']})
    d['closers'] = rivals
    # 3. Who opened it (the last trade on our pools at or before the copy's block)?
    opener = None
    look_from = copy_blk if copy_blk else start
    for b in range(look_from, look_from - OPENER_LOOKBACK, -1):
        hits = [(int(r['transactionIndex'], 16), r) for r in block_receipts(b) if swaps_on(r, pools)]
        if hits:
            i, r = max(hits, key=lambda x: x[0])
            opener = {'block': b, 'index': i, 'tx': r['transactionHash'], 'swaps': len(swaps_on(r, pools))}
            break
    d['opener'] = opener
    # Plain summary
    rep = ' '.join(f'{b - (copy_blk or start):+d}:{s}' for b, s in steps)
    if closed is None:
        why = 'never worked in the replayed blocks (copy wrong, or the chance closed before the copy block)' \
            if all(s != 'OK' for _, s in steps) else 'unclear (no clean OK then REVERT)'
    else:
        arb = [r for r in rivals if r['swaps'] >= 2]
        who = f"rival {arb[0]['to'][:10]} (index {arb[0]['index']}, {arb[0]['swaps']} swaps)" if arb else \
            (f"normal trade {rivals[0]['to'][:10]}" if rivals else 'unknown')
        why = f'closed in block {closed} by {who}'
    op = f"opened in block {opener['block']} (copy block {'' if not copy_blk else copy_blk - opener['block']} later)" if opener else 'opener not found'
    dec = f"decided by {d['decided_by']}" + (f" (node {d['node_ms']} ms, copy unsure: {d['copy_unknown_why']})" if d['decided_by'] == 'node' else f" (copy {d['copy_answer_ms']} ms)")
    line = (f"{tx_hash[:10]} LOST | {ctx} | {dec}, check->send log {d['check_to_log_ms']} ms | copy blk {copy_blk} said ${d['copy_profit_usd']}, landed {landed} (+{landed - (copy_blk or start)}) idx {d['our_index']} | "
            f"{op} | {why} | replay {rep} | gas {gas_eth:.8f} ETH")
    return line, d


def write(line, d):
    stamp = time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime())
    with open(OUT_TXT, 'a') as f:
        f.write(f'{stamp} UTC {line}\n')
    with open(OUT_JSON, 'a') as f:
        f.write(json.dumps({'at': stamp, **d}) + '\n')
    print(f'{stamp} {line}', flush=True)


def handle(tx_hash, ctx, seen_ms):
    try:
        line, d = describe(tx_hash, ctx, seen_ms)
    except Exception as e:  # one bad analysis must never stop the watcher
        line, d = f'{tx_hash[:10]} analysis error: {e}', {'tx': tx_hash, 'error': str(e)}
    write(line, d)


FIRE = re.compile(r'\[fire\] robinhood LIVE \((\w+)\).*tx (0x[0-9a-f]{64})')
CTX = re.compile(r'(\[gap\] standing gap .*CONFIRMED.*|\[check-first\] PASSED.*|\[loop-live\] SENT.*)')


def follow(path, backfill):
    """tail -F: yields new lines (handles pm2 log rotation)."""
    f = open(path)
    if not backfill:
        f.seek(0, 2)
    ino = os.fstat(f.fileno()).st_ino
    while True:
        line = f.readline()
        if line:
            yield line
            continue
        time.sleep(0.2)
        try:
            if os.stat(path).st_ino != ino:  # rotated: reopen from the start
                f.close(); f = open(path); ino = os.fstat(f.fileno()).st_ino
        except OSError:
            pass


def one_off(args):
    """Analyse given sends now: misswatch.py 0xHASH[:COPYBLOCK] ... (for past trades)."""
    global latest_copy_record
    for a in args:
        h, _, blk = a.partition(':')
        fake = {'mode': 'on', 'lv': 'profit', 'c2blk': hex(int(blk)), 'lp': '0', 't': 0} if blk else None
        latest_copy_record = (lambda _ms, r=fake: r)
        line, d = describe(h, 'one-off', 0)
        print(line, flush=True)


def main():
    if len(sys.argv) > 1:
        return one_off(sys.argv[1:])
    backfill = os.environ.get('MISS_BACKFILL') == '1'
    print(f'misswatch: watching {LOG} with node {NODE_NAME if read_env(NODE_NAME) else "CHAINSTACK_RPC_ROBINHOOD"}'
          f'{" (backfill)" if backfill else ""}', flush=True)
    last_ctx = ''
    for line in follow(LOG, backfill):
        m = CTX.search(line)
        if m:
            last_ctx = m.group(1)[:160]
        m = FIRE.search(line)
        if m:
            kind, h = m.groups()
            threading.Thread(target=handle, args=(h, f'{kind}: {last_ctx}', int(time.time() * 1000)), daemon=True).start()


if __name__ == '__main__':
    main()
