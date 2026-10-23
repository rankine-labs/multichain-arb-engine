import { Wallet, keccak256 } from 'ethers';
import { parseFeedMessages, FeedMsg } from '../chains/nitroFeed';
import { TriggerFirst, TrigCopy2, trigFirstSettings } from '../execution/triggerFirst';
import { TrigEntry, EntryCandidate, EntryDeps, entrySettings, enumerateRoutes, quickSkip } from '../execution/trigEntry';
import { JsonlLog } from '../execution/localSimHost';
import { LocalSimClient } from '../execution/localSim';
import { SIM_EXECUTOR_ADDRESS } from '../execution/simulator';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// TRIGGER-FIRST ENTRY POINT (execution/trigEntry.ts): every feed transaction
// is a possible trigger. Tests: the cheap skip, "which pools does it move?",
// candidate routes (capped, venue / coin rules), the size ladder's best size,
// on mode reaching the sender WITHOUT the old guess / 6 h lists / any waiting
// or node request but still through every safeguard, shadow never sending,
// one send per trigger, and overload drops. The fast check is faked.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const walletA = new Wallet('0x' + '11'.repeat(32));
async function signed(nonce: number, to: string | null, data = '0x'): Promise<string> {
  return walletA.signTransaction({ type: 2, chainId: 4663, nonce, to, data, value: 0n, gasLimit: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n });
}
const msgOf = (seq: number, raws: string[]): FeedMsg => ({ seq, ts: 1_700_000_000 + seq, l1: 9000, complete: true, txs: raws.map((r) => ({ hash: keccak256(r), raw: r })) });

const word = (n: bigint) => n.toString(16).padStart(64, '0');
const insufficient = (got: bigint) => '0x4e88422a' + word(got) + 'f'.repeat(64);
type Asked = Record<string, any>;

const POOL_A = '0x' + 'a1'.repeat(20);   // the pool the trigger moves
const POOL_B = '0x' + 'b2'.repeat(20);   // same pair, another exchange
const USDG = '0x' + '01'.repeat(20);
const COIN = '0x' + '02'.repeat(20);
const LENDER = '0x' + 'cd'.repeat(20);
const EXECUTOR = '0x' + 'ee'.repeat(20);

// Fake fast check. Profit (start-coin units, 6 decimals = $) by trade amount.
function fakeSidecar(o: { pools?: string[]; discover?: Asked; profitAt?: (amount: bigint) => bigint; conf?: string; assumed?: string[] } = {}) {
  const asked: Asked[] = [];
  const profitAt = o.profitAt ?? (() => 2_000_000n);
  const client = {
    isConnected: () => true,
    stats: { fallbacks: 0 },
    request: async (m: Asked) => {
      asked.push(m);
      if (m.type === 'trig_discover') return { id: 1, ...(o.discover ?? { ok: true, pools: o.pools ?? [POOL_A], conf: 'high', assumed: [] }) };
      if (m.type === 'call' && m.calls?.[0]?.to?.toLowerCase() === SIM_EXECUTOR_ADDRESS) {
        const data: string = m.calls[0].data;
        const amount = BigInt('0x' + data.slice(2 + 8 + 192, 2 + 8 + 256));
        const sizes = m.sizes ? (m.sizes.amounts as string[]).map((a) => ({ amount: a, status: 'profit', profit: '0x' + profitAt(BigInt(a)).toString(16), gasUsed: '0x1' })) : undefined;
        return { id: 1, ok: true, us: 500, results: [{ success: false, output: insufficient(profitAt(amount)), gasUsed: '0x5208' }],
          trig: { snapBlock: 100, included: false, triggerOk: true, msgs: 1, txs: 1, later: 0, lastSeq: 101, conf: o.conf ?? 'high', assumed: o.assumed ?? [] }, ...(sizes ? { sizes } : {}) };
      }
      return { id: 1, ok: false, unknown: 'bad_request' };
    },
  } as unknown as LocalSimClient;
  return { client, asked };
}
function fakeCopy2(): TrigCopy2 & { waits: number } {
  const c = {
    waits: 0,
    running: () => true,
    notReadyWhy: () => null,
    waitForTx: async () => { c.waits++; await sleep(2); return 101; },
    forwarder: { newestBlock: () => 100, txBlockOf: () => null },
  };
  return c;
}

// One candidate: USDG start, $1 per unit of 1e6, amountIn = size x 1e6.
function cand(label = 'USDG/COIN dexA>dexB', maxSizeUsd = 1_000): EntryCandidate {
  return {
    label, buyPool: POOL_A, sellPool: POOL_B, tokenIn: USDG, tokens: [USDG, COIN], keys: [POOL_A, POOL_B], maxSizeUsd, gasUsd: 0.05,
    build: (usd) => ({ trade: { token: USDG, amountIn: BigInt(Math.round(usd * 1e6)), hops: [{ kind: 0, pool: POOL_A, tokenIn: USDG, tokenOut: COIN, feeBps: 30 }] as any }, simOpts: { v3Lender: LENDER } }),
    usdOf: (u) => Number(u) / 1e6,
  };
}

type Spies = { sends: number; sendWaits: number[]; candKeys: string[][] };
function setup(o: { mode?: 'shadow' | 'on'; hostOn?: boolean; env?: Record<string, string>; sidecar?: ReturnType<typeof fakeSidecar>; cands?: EntryCandidate[]; deps?: Partial<EntryDeps> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trigentry-'));
  const file = join(dir, 'shadow.jsonl');
  const log = new JsonlLog(file, 1_000_000, 0);
  const sc = o.sidecar ?? fakeSidecar();
  const c2 = fakeCopy2();
  const env = { LOCAL_SIM_TRIGGER_FIRST: o.mode ?? 'on', ...(o.env ?? {}) };
  const tf = new TriggerFirst({ client: sc.client, settings: { ...trigFirstSettings(env), finalizeMs: 30, agreeWaitMs: 30 }, copy2: () => c2, shadowLog: log, hostOn: () => o.hostOn ?? true, log: () => {} });
  const spies: Spies = { sends: 0, sendWaits: [], candKeys: [] };
  const te = new TrigEntry({
    tf, client: sc.client, shadowLog: log, settings: { ...entrySettings(env, 0.25), deadlineMs: 2_000, discoverTimeoutMs: 500 },
    candidatesFor: (keys) => { spies.candKeys.push(keys); return o.cands ?? [cand()]; },
    isOurTx: () => false, ourAddresses: [EXECUTOR],
    killed: () => false, safety: () => null, failBlocked: () => null, pausedWhy: () => null,
    send: async () => { spies.sends++; spies.sendWaits.push(c2.waits); return { signedMs: Date.now() }; },
    log: () => {},
    ...(o.deps ?? {}),
  });
  return { tf, te, log, file, sc, c2, spies };
}

async function main() {
  const swapData = '0x12345678' + '00'.repeat(32);
  const tSwap = await signed(0, POOL_A, swapData);
  const tSwap2 = await signed(1, POOL_A, swapData);
  const tSwap3 = await signed(2, POOL_A, swapData);
  const msgs = [msgOf(100, []), msgOf(101, [tSwap])];
  const hash = keccak256(tSwap).toLowerCase();

  // ---- settings --------------------------------------------------------------
  {
    const s = entrySettings({}, 0.25);
    assert(s.enabled && s.maxInFlight === 4 && s.maxCandidates === 6 && s.sizesUsd.join() === '50,150,400', 'defaults: TRIG_FIRST_ENTRY on, 4 in flight, 6 candidates, sizes $50/$150/$400');
    assert(!entrySettings({ TRIG_FIRST_ENTRY: '0' }).enabled, 'TRIG_FIRST_ENTRY=0 switches it off');
    const { te } = setup({ mode: 'shadow', env: { LOCAL_SIM_TRIGGER_FIRST: 'off' } });
    assert(!te.active(), 'LOCAL_SIM_TRIGGER_FIRST=off: the entry point does nothing either');
  }

  // ---- cheap skip ----------------------------------------------------------------
  {
    const ours = { isOurTx: (h: string) => h === 'mine', addresses: new Set([EXECUTOR]) };
    assert(quickSkip(await signed(0, COIN), '0x1', ours) === 'plain_transfer', 'plain ETH transfer: skipped');
    assert(quickSkip(await signed(0, COIN, '0x095ea7b3' + '00'.repeat(64)), '0x1', ours) === 'coin_call', 'approve: skipped');
    assert(quickSkip(await signed(0, COIN, '0xd0e30db0'), '0x1', ours) === 'coin_call', 'WETH wrap: skipped');
    assert(quickSkip(await signed(0, null, '0x6000'), '0x1', ours) === 'create', 'contract creation: skipped');
    assert(quickSkip(await signed(0, EXECUTOR, swapData), '0x1', ours) === 'ours', 'a call to our own contract: skipped');
    assert(quickSkip(tSwap, 'mine', ours) === 'ours', 'our own transaction (by hash): skipped');
    assert(quickSkip(tSwap, '0x1', ours) === null, 'a swap-like call: looked at');
  }

  // ---- discover: a feed tx moving a watched pool -> candidates -----------------------
  {
    const { tf, te, sc, spies } = setup({ mode: 'shadow' });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    const d = sc.asked.find((m) => m.type === 'trig_discover')!;
    assert(!!d && d.at?.after === 'head' && d.feed?.trigger === hash && d.feed?.triggerSeq === 101, 'asks the fast check "which pools?" with the trigger and the ordered feed');
    assert(JSON.stringify(spies.candKeys) === JSON.stringify([[POOL_A]]), 'the moved pool goes to the candidate builder');
    assert(rec !== null && rec.pools.join() === POOL_A && rec.tried === 1, 'the discovered pools are recorded');
  }
  {
    const { tf, te, sc, spies } = setup({ mode: 'shadow', sidecar: fakeSidecar({ pools: [] }) });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    assert(rec === null && spies.candKeys.length === 0 && sc.asked.length === 1, 'a tx moving none of our pools: no candidates, no checks');
  }
  {
    const { tf, te, sc } = setup({ mode: 'shadow', sidecar: fakeSidecar({ discover: { ok: false, unknown: 'already_in_copy' } }) });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    assert(rec === null && sc.asked.length === 1, 'discover unknown: nothing more asked');
  }

  // ---- candidates: routes, venue / coin rules, cap -------------------------------------
  {
    type P = { a: string; t: [string, string]; dex: string };
    const pA: P = { a: POOL_A, t: [USDG, COIN], dex: 'x' };
    const pB: P = { a: POOL_B, t: [COIN, USDG], dex: 'y' };
    const pC: P = { a: '0x' + 'c3'.repeat(20), t: [USDG, COIN], dex: 'blocked-dex' };
    const rules = {
      pool: (k: string) => [pA, pB, pC].find((p) => p.a === k), peers: (p: P) => [pA, pB, pC].filter((x) => x !== p),
      addr: (p: P) => p.a, tokens: (p: P) => p.t, startCoins: [USDG],
      coinAllowed: () => true, venueBlocked: (b: P, s: P) => (b.dex === 'blocked-dex' || s.dex === 'blocked-dex' ? 'not live' : null),
    };
    const r = enumerateRoutes([POOL_A], rules);
    assert(r.length === 2 && r.some((x) => x.buy === pA && x.sell === pB) && r.some((x) => x.buy === pB && x.sell === pA), 'both directions with the same pair on another exchange');
    assert(r.every((x) => x.tokenIn === USDG && x.tokenOut === COIN), 'starts from a coin we hold');
    assert(!r.some((x) => x.buy === pC || x.sell === pC), 'an exchange not cleared for trading is left out (venue rule)');
    assert(enumerateRoutes([POOL_A], { ...rules, coinAllowed: (t: string) => t !== COIN }).length === 0, 'a coin not on the allowed list: no routes (coin rule)');
    assert(enumerateRoutes([POOL_A], { ...rules, startCoins: ['0x' + '09'.repeat(20)] }).length === 0, 'no coin we hold in the pair: no routes');
    const many = [1, 2, 3, 4, 5].map((i) => cand(`c${i}`));
    const { tf, te, sc } = setup({ mode: 'shadow', cands: many, env: { TRIG_ENTRY_MAX_CANDIDATES: '2' } });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    const checks = sc.asked.filter((m) => m.type === 'call');
    assert(rec!.candidates === 5 && rec!.tried === 2 && checks.length === 2, 'candidates capped (TRIG_ENTRY_MAX_CANDIDATES)');
  }

  // ---- size ladder: the best size wins ------------------------------------------------------
  {
    const profitAt = (a: bigint) => (a === 50_000_000n ? 500_000n : a === 150_000_000n ? 2_000_000n : a === 400_000_000n ? 1_000_000n : 0n);
    const { tf, te, sc } = setup({ mode: 'shadow', sidecar: fakeSidecar({ profitAt }) });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    const call = sc.asked.find((m) => m.type === 'call')!;
    assert(call.sizes?.amountOffset === 96 && call.sizes.amounts.join() === ['0x' + (50_000_000).toString(16), '0x' + (150_000_000).toString(16)].join(), 'one request: biggest size checked, the smaller sizes as a ladder on the same replay');
    assert(!!call.feed && call.feed.trigger === hash, 'the ladder runs on the replayed feed');
    assert(rec!.best?.sizeUsd === 150 && Math.abs(rec!.best.netUsd - 1.95) < 1e-9, 'the size with the best net after gas is picked ($150: $2.00 - $0.05)');
  }

  // ---- ON: reaches the sender, no guess, no 6 h lists, no waiting, no node --------------------
  {
    const { tf, te, sc, spies, c2 } = setup({ mode: 'on' });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    assert(spies.sends === 1 && rec!.submitMs !== undefined, 'on: a profitable candidate is sent');
    assert(spies.sendWaits[0] === 0, 'sent WITHOUT waiting for the trigger\'s pool reports (copy2WaitForTx not called before the send)');
    assert(sc.asked.every((m) => m.type === 'trig_discover' || (m.type === 'call' && !!m.feed)), 'only fast-check questions on the replayed feed: no receipt polling, no node request');
    // The old model guess and the 6 h liveBlocks / bench lists are not inputs of
    // the entry point at all: the only gates are the ones below.
    assert(te.gates({ cand: cand(), sizeUsd: 150, amountIn: 1n, profitUnits: 1n, netUsd: 1, out: { sure: true, confidence: 'high' } as any, q: {} as any }) === null, 'with every safeguard passing, nothing else (no guess, no 6 h list) stops it');
    await sleep(80);
    assert(c2.waits >= 1, 'the later same-block re-check runs AFTER the send (measurement only)');
  }

  // ---- ON: every safeguard still applies -------------------------------------------------------
  const blockedBy = async (name: string, o: Parameters<typeof setup>[0], re: RegExp) => {
    const { tf, te, spies } = setup({ mode: 'on', ...o });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    assert(spies.sends === 0 && re.test(rec?.held ?? ''), `${name}: not sent (${rec?.held})`);
  };
  await blockedBy('kill file', { deps: { killed: () => true } }, /kill switch/);
  await blockedBy('SafetyGate', { deps: { safety: () => 'daily loss cap reached' } }, /safety: daily loss cap/);
  await blockedBy('30-min live-fail block on the pair', { deps: { failBlocked: () => 'live trade failed on chain' } }, /pair blocked 30 min/);
  await blockedBy('scoreboard pause', { deps: { pausedWhy: () => 'trig_first medium paused' } }, /scoreboard/);
  await blockedBy('confidence floor', { sidecar: fakeSidecar({ conf: 'medium', assumed: ['sender_funds'] }), env: { TRIG_FIRST_MIN_CONFIDENCE: 'high' } }, /confidence medium below high/);
  {
    const { tf, te, spies } = setup({ mode: 'on', sidecar: fakeSidecar({ profitAt: () => 100_000n }) });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    assert(spies.sends === 0 && !rec!.wouldSend && rec!.best!.netUsd < 0.25, 'under the send minimum ($0.10 - gas < $0.25): not sent');
  }
  {
    const { tf, te, spies } = setup({ mode: 'on', hostOn: false });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    assert(spies.sends === 0 && rec!.wouldSend === true, 'on, but the fast check is not ON: practice only (would send)');
  }

  // ---- SHADOW never sends ---------------------------------------------------------------------
  {
    const { tf, te, spies, file, log } = setup({ mode: 'shadow' });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    assert(spies.sends === 0 && rec!.wouldSend === true, 'shadow: computed and logged as "would send", never sent');
    await sleep(120);
    await log.flush();
    const lines = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    const l = lines.find((x) => x.k === 'trig_entry');
    assert(!!l && l.pools?.[0] === POOL_A && l.best === 'USDG/COIN dexA>dexB' && l.size === 400 && l.would === true && typeof l.discMs === 'number' && typeof l.ansMs === 'number' && l.conf === 'high', 'a "trig_entry" log line: pools, best route / size / net, confidence, timing');
    assert(!!l && (l.agree !== undefined || l.agSkip !== undefined), `with the later same-block re-check (agree ${l?.agree}, ${l?.agSkip ?? ''})`);
    const hour = te.takeHourLine() ?? '';
    assert(/would send 1/.test(hour) && /moving our pools 1/.test(hour) && /profitable 1/.test(hour) && /feed->discover p50/.test(hour), `hour line: ${hour}`);
  }

  // ---- one send per trigger (shared with the old path) ------------------------------------------
  {
    const { tf, te, spies } = setup({ mode: 'on' });
    tf.onFeedMsgs(msgs, Date.now());
    assert(te.claim(hash, 'old'), 'the old path claims the trigger first');
    const rec = await te.process(hash, Date.now());
    assert(spies.sends === 0 && /already sent by the old path/.test(rec!.held ?? ''), 'the entry point then does not send it again');
  }
  {
    const { tf, te, spies } = setup({ mode: 'on' });
    tf.onFeedMsgs(msgs, Date.now());
    await te.process(hash, Date.now());
    assert(spies.sends === 1 && !te.claim(hash, 'old'), 'the entry point sent: the old path\'s claim is refused (no double send)');
    assert(te.claim(hash, 'entry'), 'the same caller may go on (its own claim)');
  }

  // ---- overload: bounded, dropped and counted, never blocks the feed ------------------------------
  {
    const { tf, te } = setup({ mode: 'shadow', env: { TRIG_ENTRY_MAX_IN_FLIGHT: '1' } });
    const m3 = [msgOf(100, []), msgOf(101, [tSwap, tSwap2, tSwap3])];
    tf.onFeedMsgs(m3, Date.now());
    const t0 = Date.now();
    te.onFeedMsgs(m3, Date.now());
    assert(Date.now() - t0 < 50 && te.inFlightNow() === 1, 'the feed handler returns at once; one in flight');
    await sleep(100);
    const hour = te.takeHourLine() ?? '';
    assert(/dropped 2 overloaded/.test(hour), `extra triggers dropped and counted: ${hour}`);
    assert(te.inFlightNow() === 0, 'work finished, nothing left in flight');
  }
}

main().catch((e) => { console.error('FAIL: test crashed', e); process.exitCode = 1; });
