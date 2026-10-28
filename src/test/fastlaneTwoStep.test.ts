import { Wallet, keccak256 } from 'ethers';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FeedMsg } from '../chains/nitroFeed';
import { TriggerFirst, TrigCopy2, trigFirstSettings } from '../execution/triggerFirst';
import { TrigEntry, EntryCandidate, TablePool, TableRoute, entrySettings, nodeAsksOn } from '../execution/trigEntry';
import { JsonlLog } from '../execution/localSimHost';
import { LocalSimClient } from '../execution/localSim';
import { SIM_EXECUTOR_ADDRESS } from '../execution/simulator';
import { KIND_V2, KIND_V3 } from '../execution/executorCalldata';

// ============================================================================
// FAST LANE TABLE IN TWO-STEP MODE (Oct 27, second practice run).
//
// Plain English:
//   The live bot runs TRIG_ENTRY_ONE_TRIP=0 ("two steps": ask "which pools
//   does it move?", then check our candidates). The candidate table the Rust
//   standing-gap scanner reads its routes from was only ever sent in one-trip
//   mode, so the scanner saw 0 routes. Now the table is also sent when the
//   fast lane is on (FASTLANE=practice|live), WITHOUT changing anything the
//   two-step path does. This test proves:
//     1. ONE_TRIP=0 + FASTLANE=practice: the table goes to the sidecar, every
//        row with its check ("c") and the scanner's facts ("f").
//     2. ONE_TRIP=0 + FASTLANE=off: no table at all (nothing new sent).
//     3. The two-step path asks EXACTLY the same questions in the same order
//        and reaches the same decision with or without the table (the
//        one-trip question `trig_entry` is never asked in two-step mode).
//     4. Cost on the bot's one thread: an unchanged refresh (the every-second
//        case) reuses every route, sends nothing and takes little time
//        (printed as TEST numbers).
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const USDG = '0x' + '11'.repeat(20);
const WETH = '0x' + '22'.repeat(20);
const MEME = '0x' + '33'.repeat(20);
const LENDER = '0x' + 'cd'.repeat(20);
const EXECUTOR = '0x' + 'ee'.repeat(20);
const poolAddr = (i: number) => '0x' + (0xa000 + i).toString(16).padStart(40, '0');
const POOL_A = poolAddr(0);
const POOL_B = poolAddr(1);

const word = (n: bigint) => n.toString(16).padStart(64, '0');
const insufficient = (got: bigint) => '0x4e88422a' + word(got) + 'f'.repeat(64);

// The sidecar: answers "which pools?" (POOL_A), our checks (profit $2 at
// every size), the table builder's coin balance-slot lookups (a balanceOf
// with a pretend balance reads it back), and records everything asked.
function fakeSidecar() {
  const asked: Array<Record<string, any>> = [];
  const client = {
    isConnected: () => true,
    stats: { fallbacks: 0 },
    request: async (m: Record<string, any>) => {
      asked.push(JSON.parse(JSON.stringify(m)));
      if (m.type === 'trig_table') return { ok: true, gen: m.gen };
      if (m.type === 'trig_discover') return { id: 1, ok: true, pools: [POOL_A], conf: 'high', assumed: [] };
      if (m.type === 'call' && m.calls?.[0]?.data?.startsWith('0x70a08231')) {
        const sd = m.overrides?.[m.calls[0].to]?.stateDiff ?? {};
        const v = Object.values(sd)[0] as string | undefined;
        return { id: m.id, ok: true, results: [{ success: true, output: v ?? '0x' + '0'.repeat(64), gasUsed: '0x1' }] };
      }
      if (m.type === 'call' && m.calls?.[0]?.to?.toLowerCase() === SIM_EXECUTOR_ADDRESS) {
        const sizes = m.sizes ? (m.sizes.amounts as string[]).map((a) => ({ amount: a, status: 'profit', profit: '0x' + (2_000_000n).toString(16), gasUsed: '0x1' })) : undefined;
        return { id: 1, ok: true, us: 500, results: [{ success: false, output: insufficient(2_000_000n), gasUsed: '0x5208' }],
          trig: { snapBlock: 100, included: false, triggerOk: true, msgs: 1, txs: 1, later: 0, lastSeq: 101, conf: 'high', assumed: [] }, ...(sizes ? { sizes } : {}) };
      }
      return { id: m.id, ok: false, unknown: 'bad_request' };
    },
  } as unknown as LocalSimClient;
  return { client, asked };
}

const copy2: TrigCopy2 = { running: () => true, notReadyWhy: () => null, waitForTx: async () => 101, forwarder: { newestBlock: () => 100, txBlockOf: () => null } };

// `n` watched pools in pairs (MEME/USDG, MEME/WETH on two exchanges each);
// each pool's routes: buy here / sell on its peer, both ways.
function universe(n: number) {
  const pools = Array.from({ length: n }, (_, i) => ({ addr: poolAddr(i), start: (i >> 1) % 2 === 0 ? USDG : WETH, kind: i % 2 ? KIND_V3 : KIND_V2 }));
  const peerOf = (i: number) => pools[i ^ 1];
  let builds = 0;
  const candOf = (buy: typeof pools[0], sell: typeof pools[0]): EntryCandidate => {
    builds++;
    const usdg = buy.start === USDG;
    const dec = usdg ? 6 : 18;
    const px = usdg ? 1 : 3456.78;
    return {
      label: `MEME/${usdg ? 'USDG' : 'WETH'} ${buy.addr.slice(-4)}>${sell.addr.slice(-4)}`, buyPool: buy.addr, sellPool: sell.addr, tokenIn: buy.start, tokens: [buy.start, MEME],
      keys: usdg ? [buy.addr, sell.addr] : [buy.addr, sell.addr, LENDER], maxSizeUsd: 400, gasUsd: 0.0123,
      build: (usd) => ({
        trade: { token: buy.start, amountIn: BigInt(Math.round((usd / px) * 10 ** Math.min(dec, 9))) * 10n ** BigInt(dec - Math.min(dec, 9)), hops: [
          { kind: buy.kind, pool: buy.addr, tokenIn: buy.start, tokenOut: MEME, feeBps: 30 },
          { kind: sell.kind, pool: sell.addr, tokenIn: MEME, tokenOut: buy.start, feeBps: 5 },
        ] },
        simOpts: usdg ? {} : { v3Lender: LENDER },
      }),
      usdOf: (u) => Number(u) / 10 ** dec * px,
      fx: { px, d: dec, lp: usdg ? 0 : 500 },
    };
  };
  const routesOf = (i: number): TableRoute[] => [[pools[i], peerOf(i)], [peerOf(i), pools[i]]].map(([buy, sell]) => ({
    rid: `${buy.addr}>${sell.addr}:${buy.start}`, held: true, score: 1, build: () => candOf(buy, sell), inputs: [buy.addr, sell.addr, 1],
  }));
  return { table: (): TablePool[] => pools.map((p, i) => ({ pool: p.addr, routes: () => routesOf(i) })), cand: (i: number) => candOf(pools[i], peerOf(i)), builds: () => builds };
}

function setup(env: Record<string, string>, nPools = 4) {
  const sc = fakeSidecar();
  const log = new JsonlLog(join(mkdtempSync(join(tmpdir(), 'fl2step-')), 'x.jsonl'), 1_000_000, 0);
  const tf = new TriggerFirst({ client: sc.client, settings: { ...trigFirstSettings(env), finalizeMs: 30, agreeWaitMs: 30 }, copy2: () => copy2, shadowLog: log, hostOn: () => true, log: () => {} });
  const u = universe(nPools);
  const spies = { sends: 0 };
  const te = new TrigEntry({
    tf, client: sc.client, shadowLog: log, settings: { ...entrySettings(env, 0.1), deadlineMs: 2_000, discoverTimeoutMs: 500 },
    candidatesFor: (_keys, limit) => ({ cands: [u.cand(0)].slice(0, limit), found: 1 }), tableRoutes: u.table,
    isOurTx: () => false, ourAddresses: [EXECUTOR], killed: () => false, safety: () => null, failBlocked: () => null, pausedWhy: () => null,
    send: async () => { spies.sends++; return { signedMs: Date.now() }; }, log: () => {}, lag: () => 0,
  });
  return { tf, te, sc, u, spies };
}

// A trigger: one swap-like call to POOL_A in feed message 101.
const wallet = new Wallet('0x' + '11'.repeat(32));
async function trigger(): Promise<{ msgs: FeedMsg[]; hash: string }> {
  const raw = await wallet.signTransaction({ type: 2, chainId: 4663, nonce: 0, to: POOL_A, data: '0x12345678' + '00'.repeat(32), value: 0n, gasLimit: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n });
  const msgs: FeedMsg[] = [{ seq: 100, ts: 1_700_000_100, l1: 9000, complete: true, txs: [] }, { seq: 101, ts: 1_700_000_101, l1: 9000, complete: true, txs: [{ hash: keccak256(raw), raw }] }];
  return { msgs, hash: keccak256(raw).toLowerCase() };
}

// The questions of the two-step path (the table and its coin lookups left out).
const twoStepQuestions = (asked: Array<Record<string, any>>) =>
  asked.filter((m) => m.type !== 'trig_table' && !(m.type === 'call' && m.calls?.[0]?.data?.startsWith('0x70a08231'))).map((m) => ({ type: m.type, feed: m.feed?.trigger ?? null, sizes: m.sizes?.amounts ?? null, data: m.calls?.[0]?.data ?? null }));

async function main() {
  const base = { LOCAL_SIM_TRIGGER_FIRST: 'shadow', TRIG_ENTRY_TABLE_MS: '0', TRIG_ENTRY_ONE_TRIP: '0' };

  // ---- 1. two steps + FASTLANE=practice: the table goes out ----------------------------
  const P = setup({ ...base, FASTLANE: 'practice' });
  assert(!P.te.oneTripOn() && P.te.tableOn(), 'ONE_TRIP=0 + FASTLANE=practice: two steps, but the fast lane table is kept');
  assert(await P.te.refreshTable(), 'the table refresh ran and the sidecar took it');
  const tables = P.sc.asked.filter((m) => m.type === 'trig_table');
  assert(tables.length === 1 && tables[0].full === true, 'one full trig_table message sent');
  const rows = Object.values(tables[0].pools as Record<string, any[]>).flat();
  assert(rows.length === 8 && rows.every((r) => typeof r.e === 'string' && r.c && Array.isArray(r.c.calls) && r.f && r.f.px > 0), `every route row carries an entry id, its check and the scanner's facts (${rows.length} rows)`);

  // ---- 2. two steps + FASTLANE=off: nothing new ---------------------------------------
  const O = setup({ ...base, FASTLANE: 'off' });
  assert(!O.te.oneTripOn() && !O.te.tableOn(), 'ONE_TRIP=0 + FASTLANE=off: no table');
  assert(!(await O.te.refreshTable()), 'refresh does nothing');
  assert(O.sc.asked.length === 0, 'nothing at all sent to the sidecar');

  // ---- 3. the two-step path is unchanged by the table -----------------------------------
  const t = await trigger();
  P.tf.onFeedMsgs(t.msgs, Date.now());
  O.tf.onFeedMsgs(t.msgs, Date.now());
  const before = P.sc.asked.length;
  const recP = await P.te.process(t.hash, Date.now());
  const recO = await O.te.process(t.hash, Date.now());
  const qP = twoStepQuestions(P.sc.asked.slice(before));
  const qO = twoStepQuestions(O.sc.asked);
  assert(qP.length >= 2 && qP[0].type === 'trig_discover', `two steps with the table: asks "which pools?" first (${qP.map((q) => q.type).join(', ')})`);
  assert(!P.sc.asked.some((m) => m.type === 'trig_entry'), 'the one-trip question is never asked in two-step mode');
  assert(JSON.stringify(qP) === JSON.stringify(qO), 'exactly the same questions, same order, with or without the fast lane table');
  assert(!!recP && !!recO && recP.tried === recO.tried && JSON.stringify(recP.best) === JSON.stringify(recO.best) && recP.one === recO.one, `same decision (best ${JSON.stringify(recP?.best)} vs ${JSON.stringify(recO?.best)})`);
  assert(P.spies.sends === O.spies.sends, 'same sends (shadow: none)');

  // ---- 4. cost on the bot's thread --------------------------------------------------------
  const B = setup({ ...base, FASTLANE: 'practice' }, 300);
  await B.te.refreshTable();
  const first = B.te.tableInfo();
  const sentBefore = B.sc.asked.filter((m) => m.type === 'trig_table').length;
  const buildsBefore = B.u.builds();
  await B.te.refreshTable();
  const again = B.te.tableInfo();
  const sentAfter = B.sc.asked.filter((m) => m.type === 'trig_table').length;
  console.log(`[bench, TEST numbers] fast lane table in two-step mode, 300 pools / 600 routes: first build ${first.lastMs} ms (bot thread busy ${first.busyMs} ms), unchanged refresh ${again.lastMs} ms (busy ${again.busyMs} ms), ${again.reused} routes reused`);
  assert(again.routes === 600 && again.reused === 600, 'unchanged refresh: every route\'s question reused (none written again)');
  assert(sentAfter === sentBefore, 'unchanged refresh: nothing sent to the sidecar');
  assert(B.u.builds() - buildsBefore === 600, 'unchanged refresh: only the host\'s cheap route list is walked');
  assert(again.busyMs <= again.lastMs + 0.01, 'busy time is measured apart from waiting');

  // ---- 5. SPEED FIX (Oct 28): the bot stops asking when Rust decides -------------------
  // Default rules: Node asks unless the Rust fast lane is the sender; the setting wins.
  assert(nodeAsksOn({}) === true, 'no fast lane: the bot asks (unchanged)');
  assert(nodeAsksOn({ FASTLANE: 'practice', RUST_SENDER: 'off' }) === true, 'practice with Node as sender: the bot still asks (its fire-first is the live path)');
  assert(nodeAsksOn({ FASTLANE: 'live', RUST_SENDER: 'on' }) === false, 'Rust is the sender: the bot stops asking by default');
  assert(nodeAsksOn({ FASTLANE: 'live', RUST_SENDER: 'on', TRIG_ENTRY_NODE_ASKS: 'on' }) === true, 'TRIG_ENTRY_NODE_ASKS=on wins');
  assert(nodeAsksOn({ FASTLANE: 'practice', TRIG_ENTRY_NODE_ASKS: 'off' }) === false, 'TRIG_ENTRY_NODE_ASKS=off wins');
  // Asking off: a feed trigger asks nothing, but the table still goes to the sidecar.
  const N = setup({ ...base, FASTLANE: 'practice', TRIG_ENTRY_NODE_ASKS: 'off' });
  const tn = await trigger();
  N.tf.onFeedMsgs(tn.msgs, Date.now());
  N.te.onFeedMsgs(tn.msgs, Date.now());
  await new Promise((r) => setTimeout(r, 50));
  assert(!N.sc.asked.some((m) => m.type === 'trig_discover' || m.type === 'trig_entry'), 'asking off: no trigger question sent for a feed trigger');
  await N.te.refreshTable();
  assert(N.sc.asked.some((m) => m.type === 'trig_table'), 'asking off: the candidate table is still sent (Rust needs it)');
  assert(N.spies.sends === 0, 'asking off: nothing sent');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
