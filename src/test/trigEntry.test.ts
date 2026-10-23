import { Wallet, keccak256 } from 'ethers';
import { parseFeedMessages, FeedMsg } from '../chains/nitroFeed';
import { TriggerFirst, TrigCopy2, trigFirstSettings } from '../execution/triggerFirst';
import { TrigEntry, EntryCandidate, EntryDeps, entrySettings, enumerateRoutes, quickSkip, rankRoutes } from '../execution/trigEntry';
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
// Calculated size (sizes.calc): the fake works it out by trying 400 sizes
// between lo and the main amount (the real sidecar: sim/src/check/sizing.rs)
// and answers like the real one: calc + backup rows (src), the ladder rows
// only when comparing or when the calculation failed, and `calc`.
// calcHow: 'fit' (default) / 'none' / 'failed' / 'old' (an older sidecar: ignores calc).
function fakeSidecar(o: { pools?: string[]; discover?: Asked; profitAt?: (amount: bigint) => bigint; profitFor?: (pool: string) => bigint | undefined; conf?: string; assumed?: string[]; delayMs?: number; calcHow?: 'fit' | 'none' | 'failed' | 'old'; calcAbove?: boolean } = {}) {
  const asked: Asked[] = [];
  const conc = { now: 0, max: 0 };
  const profitAt = o.profitAt ?? (() => 2_000_000n);
  const client = {
    isConnected: () => true,
    stats: { fallbacks: 0 },
    request: async (m: Asked) => {
      asked.push(m);
      if (m.type === 'trig_discover') return { id: 1, ...(o.discover ?? { ok: true, pools: o.pools ?? [POOL_A], conf: 'high', assumed: [] }) };
      if (m.type === 'call' && m.calls?.[0]?.to?.toLowerCase() === SIM_EXECUTOR_ADDRESS) {
        conc.now++; conc.max = Math.max(conc.max, conc.now);
        if (o.delayMs) await sleep(o.delayMs);
        conc.now--;
        const data: string = m.calls[0].data;
        const amount = BigInt('0x' + data.slice(2 + 8 + 192, 2 + 8 + 256));
        // Which candidate: its first route key (the buy pool), sent as feed.route.
        const forPool = o.profitFor?.((m.feed?.route ?? [])[0] ?? '');
        const pf = (a: bigint) => forPool ?? profitAt(a);
        const row = (a: bigint, src?: string) => { const p = pf(a); return { amount: '0x' + a.toString(16), status: p > 0n ? 'profit' : 'loss', profit: '0x' + p.toString(16), gasUsed: '0x1', ...(src ? { src } : {}) }; };
        const how = o.calcHow ?? 'fit';
        const cq = m.sizes?.calc && how !== 'old' ? m.sizes.calc : undefined;
        let calc: Asked | undefined;
        let sizes = m.sizes ? (m.sizes.amounts as string[]).map((a) => ({ ...row(BigInt(a)), status: 'profit' })) : undefined;
        if (cq) {
          const lo = BigInt(cq.lo);
          let best = lo;
          for (let i = 0; i <= 400; i++) {
            const x = BigInt(Math.floor(Math.exp(Math.log(Number(lo)) + (Math.log(Number(amount)) - Math.log(Number(lo))) * i / 400)));
            if (x >= lo && x <= amount && pf(x) > pf(best)) best = x;
          }
          if (o.calcAbove) best = amount * 2n;
          const back = (best * 6n) / 10n;
          const ladder = cq.compare || how === 'failed' ? sizes ?? [] : [];
          sizes = [...ladder, ...(how === 'fit' ? [row(best, 'calc'), row(back, 'backup')] : [])];
          calc = { how, ...(how === 'fit' ? { size: '0x' + best.toString(16), backup: '0x' + back.toString(16) } : {}), probes: 4, us: 37, ladder: ladder.length > 0, why: how === 'failed' ? 'the smallest size can\'t be answered' : null };
        }
        return { id: 1, ok: true, us: 500, results: [{ success: false, output: insufficient(pf(amount)), gasUsed: '0x5208' }],
          trig: { snapBlock: 100, included: false, triggerOk: true, msgs: 1, txs: 1, later: 0, lastSeq: 101, conf: o.conf ?? 'high', assumed: o.assumed ?? [] }, ...(sizes ? { sizes } : {}), ...(calc ? { calc } : {}) };
      }
      return { id: 1, ok: false, unknown: 'bad_request' };
    },
  } as unknown as LocalSimClient;
  return { client, asked, conc };
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
function cand(label = 'USDG/COIN dexA>dexB', maxSizeUsd = 1_000, buyPool = POOL_A): EntryCandidate {
  return {
    label, buyPool, sellPool: POOL_B, tokenIn: USDG, tokens: [USDG, COIN], keys: [buyPool, POOL_B], maxSizeUsd, gasUsd: 0.05,
    build: (usd) => ({ trade: { token: USDG, amountIn: BigInt(Math.round(usd * 1e6)), hops: [{ kind: 0, pool: POOL_A, tokenIn: USDG, tokenOut: COIN, feeBps: 30 }] as any }, simOpts: { v3Lender: LENDER } }),
    usdOf: (u) => Number(u) / 1e6,
  };
}

type Spies = { sends: number; sendWaits: number[]; candKeys: string[][]; limits: number[] };
function setup(o: { mode?: 'shadow' | 'on'; hostOn?: boolean; env?: Record<string, string>; sidecar?: ReturnType<typeof fakeSidecar>; cands?: EntryCandidate[]; deps?: Partial<EntryDeps> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trigentry-'));
  const file = join(dir, 'shadow.jsonl');
  const log = new JsonlLog(file, 1_000_000, 0);
  const sc = o.sidecar ?? fakeSidecar();
  const c2 = fakeCopy2();
  const env = { LOCAL_SIM_TRIGGER_FIRST: o.mode ?? 'on', ...(o.env ?? {}) };
  const tf = new TriggerFirst({ client: sc.client, settings: { ...trigFirstSettings(env), finalizeMs: 30, agreeWaitMs: 30 }, copy2: () => c2, shadowLog: log, hostOn: () => o.hostOn ?? true, log: () => {} });
  const spies: Spies = { sends: 0, sendWaits: [], candKeys: [], limits: [] };
  const te = new TrigEntry({
    tf, client: sc.client, shadowLog: log, settings: { ...entrySettings(env, 0.25), deadlineMs: 2_000, discoverTimeoutMs: 500 },
    candidatesFor: (keys, limit) => { spies.candKeys.push(keys); spies.limits.push(limit); const all = o.cands ?? [cand()]; return { cands: all.slice(0, limit), found: all.length }; },
    isOurTx: () => false, ourAddresses: [EXECUTOR],
    killed: () => false, safety: () => null, failBlocked: () => null, pausedWhy: () => null,
    send: async () => { spies.sends++; spies.sendWaits.push(c2.waits); return { signedMs: Date.now() }; },
    log: () => {},
    ...(o.deps ?? {}),
  });
  return { tf, te, log, file, sc, c2, spies };
}

async function main() {
  // (each block below builds its own fakes)
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
    const { tf, te, sc, spies } = setup({ mode: 'shadow', cands: many, env: { TRIG_ENTRY_MAX_CANDIDATES: '2' }, sidecar: fakeSidecar({ profitAt: () => 100_000n }) });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    const checks = sc.asked.filter((m) => m.type === 'call');
    assert(spies.limits[0] === 2, 'the cap is given to the host BEFORE it builds anything');
    assert(rec!.found === 5 && rec!.candidates === 2 && rec!.tried === 2 && checks.length === 2, `candidates capped (TRIG_ENTRY_MAX_CANDIDATES): found ${rec!.found}, built ${rec!.candidates}, checked ${rec!.tried}`);
    // Ranking: a coin we hold first, then the model's price check.
    const rs = [{ n: 'a', held: false, s: 9 }, { n: 'b', held: true, s: 1 }, { n: 'c', held: true, s: 5 }, { n: 'd', held: true, s: null }];
    assert(rankRoutes(rs, (r) => r.held, (r) => r.s, 3).map((r) => r.n).join() === 'c,b,d', 'rank: held start coin first, then the best quick price check; capped');
  }

  // ---- size ladder: the best size wins ------------------------------------------------------
  {
    const profitAt = (a: bigint) => (a === 50_000_000n ? 500_000n : a === 150_000_000n ? 2_000_000n : a === 400_000_000n ? 1_000_000n : 0n);
    const { tf, te, sc } = setup({ mode: 'shadow', sidecar: fakeSidecar({ profitAt }), env: { TRIG_ENTRY_SIZE_MODE: 'ladder' } });
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
    const { tf, te, spies, file, log } = setup({ mode: 'shadow', env: { TRIG_ENTRY_SIZE_MODE: 'ladder' } });
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

  // ---- GUARD: too many moved pools = suspicious, skipped -------------------------------------------
  {
    const five = [1, 2, 3, 4, 5].map((i) => '0x' + String(i).repeat(64));
    const { tf, te, spies, sc, file, log } = setup({ mode: 'on', sidecar: fakeSidecar({ pools: five }) });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    assert(rec!.unknown === 'too_many_pools' && spies.candKeys.length === 0 && sc.asked.length === 1 && spies.sends === 0, 'more than TRIG_ENTRY_MAX_POOLS (4) moved pools: "too_many_pools", nothing enumerated or sent');
    await log.flush();
    const l = readFileSync(file, 'utf8').trim().split('\n').map((x) => JSON.parse(x)).find((x) => x.k === 'trig_entry');
    assert(!!l && l.u === 'too_many_pools' && l.np === 5, 'logged with the pool count');
  }
  {
    const { tf, te, spies } = setup({ mode: 'shadow', sidecar: fakeSidecar({ pools: [POOL_A, POOL_B] }) });
    tf.onFeedMsgs(msgs, Date.now());
    await te.process(hash, Date.now());
    assert(spies.candKeys.length === 1, 'two moved pools (a router through both): enumerated');
  }

  // ---- debug field: which kinds of each moved pool's values changed ---------------------------------
  {
    const { tf, te, file, log } = setup({ mode: 'shadow', sidecar: fakeSidecar({ discover: { ok: true, pools: [POOL_A], moved: [[POOL_A, ['liquidity', 'slot0', 'ticks']]], conf: 'high', assumed: [] } }) });
    tf.onFeedMsgs(msgs, Date.now());
    await te.process(hash, Date.now());
    await sleep(80);
    await log.flush();
    const l = readFileSync(file, 'utf8').trim().split('\n').map((x) => JSON.parse(x)).find((x) => x.k === 'trig_entry');
    assert(!!l && Array.isArray(l.mv) && l.mv[0] === `${POOL_A.slice(0, 12)}:liquidity+slot0+ticks`, `log "mv": ${JSON.stringify(l?.mv)}`);
  }

  // ---- best-ranked first, stop at the first answer good enough to send ------------------------------
  {
    const P = (n: number) => '0x' + String(n).repeat(40);
    const cs = [1, 2, 3, 4].map((i) => cand(`c${i}`, 1_000, P(i)));
    const { tf, te, sc } = setup({ mode: 'shadow', cands: cs, env: { TRIG_ENTRY_PARALLEL: '1' }, sidecar: fakeSidecar({ profitFor: (p) => (p === P(1).toLowerCase() ? 2_000_000n : 0n) }) });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    const checks = sc.asked.filter((m) => m.type === 'call');
    assert(checks.length === 1 && rec!.tried === 1 && rec!.early === true && rec!.best?.label === 'c1', 'the best-ranked candidate is asked first; a sure profitable answer stops the rest');
  }
  {
    const P = (n: number) => '0x' + String(n).repeat(40);
    const cs = [1, 2, 3, 4].map((i) => cand(`c${i}`, 1_000, P(i)));
    const { tf, te, sc } = setup({ mode: 'shadow', cands: cs, env: { TRIG_ENTRY_PARALLEL: '1' }, sidecar: fakeSidecar({ profitFor: (p) => (p === P(3).toLowerCase() ? 2_000_000n : 0n) }) });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    const order = sc.asked.filter((m) => m.type === 'call').map((m) => m.feed.route[0]);
    assert(order.join() === [P(1), P(2), P(3)].map((x) => x.toLowerCase()).join() && rec!.best?.label === 'c3', 'no good answer yet: next in rank order, until one is good');
  }

  // ---- concurrency: bounded per trigger and over all triggers -----------------------------------------
  {
    const cs = [1, 2, 3, 4, 5, 6].map((i) => cand(`c${i}`));
    const sc = fakeSidecar({ profitAt: () => 0n, delayMs: 15 });
    const { tf, te } = setup({ mode: 'shadow', cands: cs, sidecar: sc, env: { TRIG_ENTRY_PARALLEL: '3', TRIG_ENTRY_MAX_CHECKS: '2' } });
    tf.onFeedMsgs(msgs, Date.now());
    const t0 = Date.now();
    const [r1, r2] = await Promise.all([te.process(hash, Date.now()), te.process(hash, Date.now())]);
    assert(sc.conc.max === 2, `never more than TRIG_ENTRY_MAX_CHECKS (2) candidate checks at once over all triggers (max seen ${sc.conc.max})`);
    assert(r1!.tried === 6 && r2!.tried === 6, 'every candidate still checked within the deadline');
    assert(Date.now() - t0 < 6 * 15 * 2, 'two at a time: about half the serial time');
  }

  // ---- CALCULATED SIZE (TRIG_ENTRY_SIZE_MODE=calc, the default) ------------------------------------------
  // A profit hill with its top at $640 ($12.80 before gas): the ladder's
  // best would be $400 ($11.00), the cap $1000 makes $8.75.
  const X = 640_000_000n;
  const hill = (a: bigint) => (a >= 2n * X ? 0n : (a * (2n * X - a)) / (X * 50n));
  {
    const s = entrySettings({}, 0.25);
    assert(s.sizeMode === 'calc' && s.calcMinUsd === 10 && s.calcBackup === 0.6 && s.calcProbes === 12 && s.calcCompare === 'auto', 'defaults: size calculated ($10 up to the cap, backup 60%, 12 runs, compare in shadow)');
    assert(entrySettings({ TRIG_ENTRY_SIZE_MODE: 'ladder' }, 0.25).sizeMode === 'ladder', 'TRIG_ENTRY_SIZE_MODE=ladder: back to the ladder');
  }
  {
    const { tf, te, sc, file, log } = setup({ mode: 'shadow', sidecar: fakeSidecar({ profitAt: hill }) });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    const call = sc.asked.find((m) => m.type === 'call')!;
    const amt = BigInt('0x' + call.calls[0].data.slice(2 + 8 + 192, 2 + 8 + 256));
    assert(amt === 1_000_000_000n, 'calc: our check is asked at the cap ($1000 = maxSizeUsd)');
    assert(call.sizes?.calc?.lo === '0x' + (10_000_000).toString(16) && call.sizes.calc.compare === true && call.sizes.amounts.length === 3,
      'calc: the sidecar calculates between $10 and the cap; the ladder ($50/$150/$400) rides along; shadow compares');
    assert(!!rec!.best && Math.abs(rec!.best.sizeUsd - 640) / 640 < 0.01 && Math.abs(rec!.best.netUsd - 12.75) < 0.01, `calc: the calculated size is picked ($${rec!.best?.sizeUsd.toFixed(0)}, net $${rec!.best?.netUsd.toFixed(2)})`);
    await sleep(80);
    await log.flush();
    const l = readFileSync(file, 'utf8').trim().split('\n').map((x) => JSON.parse(x)).find((x) => x.k === 'trig_entry');
    const z = l?.sz;
    assert(!!z && z.m === 'calc' && z.how === 'fit' && Math.abs(z.calc - 640) < 7 && Math.abs(z.ch - 640) < 7 && Math.abs(z.pc - 12.8) < 0.01 && Math.abs(z.pb - 10.75) < 0.05 && z.pr === 4 && z.us === 37,
      `log "sz": mode, how, calculated / chosen size, profit at calc vs backup, runs, sizing us (${JSON.stringify(z)})`);
    assert(z.lad === 10.95 && z.cn > z.lad, `shadow: what the ladder would have made ($${z?.lad}) next to the calculated size ($${z?.cn})`);
    const line = te.takeHourLine() ?? '';
    assert(/sizing: 100% of 1 answers sized by calculation \(fit 1\), sizing time median 37 us/.test(line) && /calc vs ladder \(same replay\): calc better 1/.test(line), `hourly: share sized by calculation, median sizing time, calc vs ladder (${line.slice(line.indexOf('sizing'), line.indexOf('sizing') + 200)})`);
  }
  // KEY ACCEPTANCE (calc mode): a profitable trigger reaches the sender at
  // the calculated size, without waiting for reports / receipts, no node.
  {
    let sentSize = 0;
    const { tf, te, sc, spies } = setup({ mode: 'on', sidecar: fakeSidecar({ profitAt: hill }), deps: { send: async (p) => { spies.sends++; spies.sendWaits.push(0); sentSize = p.sizeUsd; return { signedMs: Date.now() }; } } });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    const call = sc.asked.find((m) => m.type === 'call')!;
    assert(spies.sends === 1 && rec!.submitMs !== undefined && Math.abs(sentSize - 640) / 640 < 0.01, `calc, on: sent at the calculated size ($${sentSize.toFixed(0)})`);
    assert(sc.asked.every((m) => m.type === 'trig_discover' || (m.type === 'call' && !!m.feed)), 'calc, on: only fast-check questions on the replayed feed (no waiting, no node)');
    assert(call.sizes?.calc?.compare === undefined, 'on mode: no ladder comparison (fewer runs)');
  }
  {
    // The real waiting counter: nothing waited before the send.
    const { tf, te, spies } = setup({ mode: 'on', sidecar: fakeSidecar({ profitAt: hill }) });
    tf.onFeedMsgs(msgs, Date.now());
    await te.process(hash, Date.now());
    assert(spies.sends === 1 && spies.sendWaits[0] === 0, 'calc, on: sent WITHOUT copy2WaitForTx / waitForTrade before the send');
  }
  {
    // Hook pool + lender fee: told to the sidecar.
    const c = { ...cand(), hooked: true, loanPips: 500 };
    const { tf, te, sc } = setup({ mode: 'shadow', cands: [c], sidecar: fakeSidecar({ profitAt: hill }) });
    tf.onFeedMsgs(msgs, Date.now());
    await te.process(hash, Date.now());
    const call = sc.asked.find((m) => m.type === 'call')!;
    assert(call.sizes?.calc?.fit === false && call.sizes.calc.loanPips === 500, 'hooked route: the sidecar is told to search (no curve fit); the lender fee is passed');
  }
  {
    // Calculation failed: the ladder rows (same replay) decide, as before.
    const { tf, te } = setup({ mode: 'shadow', sidecar: fakeSidecar({ profitAt: hill, calcHow: 'failed' }) });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    assert(rec!.best?.sizeUsd === 400 && rec!.sz?.how === 'failed', `calc failed: the ladder's best size is used ($${rec!.best?.sizeUsd})`);
  }
  {
    // An older sidecar (no calc answer): the ladder rows decide.
    const { tf, te } = setup({ mode: 'shadow', sidecar: fakeSidecar({ profitAt: hill, calcHow: 'old' }) });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    assert(rec!.best?.sizeUsd === 400 && rec!.sz?.how === 'no_answer', 'older sidecar: the ladder decides');
  }
  {
    // Tiny gap: no profitable size (calc "none") -> nothing to send.
    const { tf, te, spies } = setup({ mode: 'on', sidecar: fakeSidecar({ profitAt: () => 0n, calcHow: 'none' }) });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    assert(spies.sends === 0 && !rec!.best && rec!.sz?.how === 'none', 'tiny gap: no size, nothing sent');
    // A tiny profit under gas + minimum: calculated, not sent.
    const t = setup({ mode: 'on', sidecar: fakeSidecar({ profitAt: (a) => hill(a) / 100n }) });
    t.tf.onFeedMsgs(msgs, Date.now());
    const r2 = await t.te.process(hash, Date.now());
    assert(t.spies.sends === 0 && !!r2!.best && r2!.best.netUsd < 0.25, `tiny gap: best size still under the send minimum after gas (net $${r2!.best?.netUsd.toFixed(3)}), not sent`);
  }
  {
    // Caps: a smaller cap (wallet room) moves the main size; a calculated
    // row above the cap (bad data) is never used.
    const { tf, te, sc } = setup({ mode: 'shadow', cands: [cand('capped', 300)], sidecar: fakeSidecar({ profitAt: hill }) });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    const call = sc.asked.find((m) => m.type === 'call')!;
    const amt = BigInt('0x' + call.calls[0].data.slice(2 + 8 + 192, 2 + 8 + 256));
    assert(amt === 300_000_000n && call.sizes.amounts.length === 2 && rec!.best!.sizeUsd <= 300, `cap $300: asked at $300, ladder $50/$150, picked $${rec!.best?.sizeUsd.toFixed(0)}`);
    const x = setup({ mode: 'shadow', sidecar: fakeSidecar({ profitAt: () => 2_000_000n, calcAbove: true }) });
    x.tf.onFeedMsgs(msgs, Date.now());
    const r = await x.te.process(hash, Date.now());
    assert(!!r!.best && r!.best.sizeUsd <= 1_000, 'a calculated size above the cap is ignored');
  }
  {
    // Ladder mode: no calculation asked.
    const { tf, te, sc } = setup({ mode: 'shadow', sidecar: fakeSidecar({ profitAt: hill }), env: { TRIG_ENTRY_SIZE_MODE: 'ladder' } });
    tf.onFeedMsgs(msgs, Date.now());
    const rec = await te.process(hash, Date.now());
    const call = sc.asked.find((m) => m.type === 'call')!;
    assert(!call.sizes?.calc && rec!.best?.sizeUsd === 400 && rec!.sz?.m === 'ladder', 'TRIG_ENTRY_SIZE_MODE=ladder: the old ladder, unchanged');
  }

  // ---- timing (TEST NUMBERS, fake sidecar answering at once: the bot's own overhead) -------------------
  {
    const cs = [cand('c1'), cand('c2')];
    const { tf, te } = setup({ mode: 'shadow', cands: cs, sidecar: fakeSidecar({ profitAt: () => 0n }) });
    tf.onFeedMsgs(msgs, Date.now());
    const ms: number[] = [];
    for (let i = 0; i < 50; i++) { const t = performance.now(); await te.process(hash, Date.now()); ms.push(performance.now() - t); }
    ms.sort((a, b) => a - b);
    console.log(`[bench, test numbers only] entry point bot-side overhead per trigger (2 candidates, fake sidecar): p50 ${ms[25].toFixed(2)} ms, p90 ${ms[45].toFixed(2)} ms`);
    assert(ms[25] < 40, 'bot-side overhead per trigger well under the 40 ms target');
  }
}

main().catch((e) => { console.error('FAIL: test crashed', e); process.exitCode = 1; });
