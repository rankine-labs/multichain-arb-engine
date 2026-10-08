import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
      ResearchLane, ResearchConfig, ResearchCandidate, ResearchDeps, researchConfigFromEnv, CallBudget, budgetedRpc,
      findResearchGaps, gapCandidate, planShallowCandidate,
} from '../core/researchLane';
import { PoolCache } from '../core/poolCache';
import { PoolState } from '../core/types';
import { Rpc, SimResult } from '../execution/simulator';

// Checks the research lane: it only samples what the main scanner threw
// away, stays inside its own request allowance, waits for the main checker,
// keeps score per rejection reason, never trades, and saves a small file.

function assert(cond: boolean, msg: string) {
      if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
      else console.log(`PASS: ${msg}`);
}

const TOK = '0x1111111111111111111111111111111111111111';
const USDG = '0x2222222222222222222222222222222222222222';
const v2 = (addr: string, rTok: number, rUsd: number, feeBps = 30, dex = 'uniswap-v2'): PoolState => ({
      chain: 'robinhood', dex, poolAddress: addr, poolType: 'v2', tokenA: TOK, tokenB: USDG,
      reserveA: BigInt(Math.round(rTok * 1e18)), reserveB: BigInt(Math.round(rUsd * 1e6)), feeBps, lastUpdatedBlock: 0, lastUpdatedMs: 0,
});
const POOL_A = v2('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 10_000, 1_000_000);
const POOL_B = v2('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 10_000, 1_010_000, 25, 'pancakeswap-v2');
const LENDER = { poolAddress: '0xcccccccccccccccccccccccccccccccccccccccc', dex: 'uniswap-v3', feeBps: 5 };
const dec = (t: string) => (t.toLowerCase() === TOK ? 18 : t.toLowerCase() === USDG ? 6 : undefined);

const cand = (over: Partial<ResearchCandidate> = {}): ResearchCandidate => ({
      reason: 'below_sim_bar', source: 'gap', tokenIn: USDG, buyPool: POOL_A, sellPool: POOL_B,
      sizeUsd: 300, modelGrossUsd: 0.3, usdPerToken: 1, vetted: true, ...over,
});

const baseConfig = (over: Partial<ResearchConfig> = {}): ResearchConfig => ({
      ...researchConfigFromEnv({ RESEARCH_LANE: '1' }), samplePct: 100, rpcPerMin: 6, ...over,
});

// A fake checking node: counts requests, answers nothing useful.
function fakeRpc(answers: Record<string, any> = {}): { rpc: Rpc; calls: string[] } {
      const calls: string[] = [];
      return { calls, rpc: async (m) => { calls.push(m); return answers[m] ?? { result: '0x' }; } };
}

// A fake simulator: returns the queued answers in order, and spends one
// request from whatever node it's handed (like the real one's eth_call).
function fakeSim(answers: SimResult[]) {
      const seen: { lender?: string; blockTag?: string }[] = [];
      const sim = async (rpc: Rpc, _chain: string, _trade: any, opts: any = {}): Promise<SimResult> => {
            seen.push({ lender: opts.v3Lender, blockTag: opts.blockTag });
            const r = await rpc('eth_call', [{ to: '0x' }, 'latest', {}]);
            if (r.error && /429/.test(r.error.message ?? '')) return { status: 'rate_limited', reason: r.error.message! };
            return answers.shift() ?? { status: 'loss' };
      };
      return { sim, seen };
}

function makeLane(over: Partial<ResearchConfig> = {}, deps: Partial<ResearchDeps> = {}) {
      let t = 1_000_000;
      const logs: string[] = [];
      const node = fakeRpc();
      const s = fakeSim([]);
      const lane = new ResearchLane(baseConfig(over), {
            rpc: node.rpc, decimalsOf: dec, symbolOf: (a) => (a.toLowerCase() === TOK ? 'TOK' : 'USDG'),
            pickLender: () => LENDER, gasUsd: () => 0.01, weth: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
            canRun: () => true, now: () => t, random: () => 0, log: (m) => logs.push(m), simulate: s.sim as any, ...deps,
      });
      return { lane, logs, node, sim: s, advance: (ms: number) => { t += ms; } };
}

(async () => {
      // ---- Settings ----
      const off = researchConfigFromEnv({});
      assert(off.enabled === false, 'lane is OFF unless RESEARCH_LANE=1');
      const on = researchConfigFromEnv({ RESEARCH_LANE: '1', RESEARCH_SAMPLE_PCT: '250', RESEARCH_RPC_PER_MIN: 'abc' });
      assert(on.enabled && on.samplePct === 100 && on.rpcPerMin === 6, 'bad settings are clamped or fall back to defaults (100%, 6/min)');

      // ---- Off: offer() does nothing at all ----
      {
            let built = 0;
            const { lane } = makeLane({ enabled: false });
            lane.offer('below_sim_bar', 'k', () => { built++; return cand(); });
            assert(lane.queued() === 0 && built === 0 && (await lane.tick()) === false, 'switched off: nothing queued, nothing planned, nothing tested');
      }

      // ---- Sampling, dedupe and the bounded queue ----
      {
            const { lane } = makeLane({ samplePct: 0 });
            lane.offer('below_sim_bar', 'k', () => cand());
            assert(lane.queued() === 0 && lane.statsFor('below_sim_bar').offered === 1, '0% sample: counted as thrown away, not queued');
      }
      {
            let built = 0;
            const { lane, advance } = makeLane({ queuePerReason: 2, dedupeMs: 60_000 });
            lane.offer('below_sim_bar', 'route1', () => { built++; return cand(); });
            lane.offer('below_sim_bar', 'route1', () => cand());
            assert(lane.queued() === 1, 'same route + reason within the window is sampled once');
            assert(built === 0, 'offer() never plans: building waits for the lane timer');
            lane.offer('below_sim_bar', 'route2', () => cand());
            lane.offer('below_sim_bar', 'route3', () => cand());
            const s = lane.statsFor('below_sim_bar');
            assert(lane.queued() === 2 && s.dropped === 1 && s.sampled === 3, 'queue holds 2 per reason, oldest dropped and counted');
            advance(61_000);
            lane.offer('below_sim_bar', 'route1', () => cand());
            assert(lane.statsFor('below_sim_bar').sampled === 4, 'after the window the same route can be sampled again');
      }
      {
            // Standing gaps pass a longer window (30 min): re-offers inside it are ignored.
            const { lane, advance } = makeLane({ dedupeMs: 60_000 });
            lane.offer('gap_below_min', 'g', () => cand(), 30 * 60_000);
            advance(5 * 60_000);
            lane.offer('gap_below_min', 'g', () => cand(), 30 * 60_000);
            assert(lane.statsFor('gap_below_min').sampled === 1, 'a per-offer window (30 min for gaps) overrides the default');
      }
      {
            const { lane } = makeLane();
            lane.offer('below_sim_bar', 'x', () => { throw new Error('boom'); });
            let threw = false;
            try { await lane.tick(); } catch { threw = true; }
            assert(!threw && lane.statsFor('below_sim_bar').noModelGap === 1, 'a candidate that fails to build never throws, counted as no gap');
      }

      // ---- Profit: own money and flash loan, scored per reason ----
      {
            // Own money: 0.5 USDG profit (6 decimals). Flash: loss.
            const s2 = fakeSim([{ status: 'profit', profit: 500_000n }, { status: 'loss' }]);
            const { lane: lane2, logs: logs2 } = makeLane({}, { simulate: s2.sim as any });
            lane2.offer('unvetted_token', 'r', () => cand({ reason: 'unvetted_token', vetted: false }));
            assert((await lane2.tick()) === true, 'tick tests one candidate');
            const st = lane2.statsFor('unvetted_token');
            assert(st.tested === 1 && st.profitable === 1 && Math.abs(st.profitUsd - 0.49) < 1e-9, `own money profit $0.50 - $0.01 gas = $0.49 counted (got ${st.profitUsd})`);
            assert(st.flashTested === 1 && st.flashProfitable === 0, 'flash-loan version tested too and scored separately');
            assert(s2.seen[0]!.lender === undefined && s2.seen[1]!.lender === LENDER.poolAddress, 'own money first, then the flash loan from the picked lender');
            const rec = lane2.recentRecords()[0]!;
            assert(rec.reason === 'unvetted_token' && rec.vetted === false && rec.own?.kind === 'profit' && rec.flash?.kind === 'loss' && rec.lenderFeeBps === 5,
                  'record keeps reason, vetted flag, both results and the lender fee');
            assert(logs2.some((l) => l.startsWith('[research] ') && l.includes('coin not vetted')), 'log line has the [research] prefix');
      }

      // ---- Fail groups and implausible profits ----
      {
            const s = fakeSim([{ status: 'fail', reason: 'UniswapV2: K' }, { status: 'fail', reason: 'UniswapV2: K' }]);
            const { lane } = makeLane({}, { simulate: s.sim as any });
            lane.offer('shallow_pool', 'r', () => cand({ reason: 'shallow_pool' }));
            await lane.tick();
            assert(lane.statsFor('shallow_pool').failed.tax === 1, 'revert "UniswapV2: K" counted as "coin takes a cut"');
      }
      {
            // 300 USDG put in, 200 USDG "profit" = 66%: bad data, not real.
            const s = fakeSim([{ status: 'profit', profit: 200_000_000n }]);
            const { lane } = makeLane({ flash: false }, { simulate: s.sim as any });
            lane.offer('gap_below_min', 'r', () => cand({ reason: 'gap_below_min' }));
            await lane.tick();
            const st = lane.statsFor('gap_below_min');
            assert(st.profitable === 0 && st.failed.stale === 1, 'implausible profit is not counted as money made');
      }
      {
            // Profit smaller than gas: tested, unprofitable.
            const s = fakeSim([{ status: 'profit', profit: 5_000n }]);
            const { lane } = makeLane({ flash: false }, { simulate: s.sim as any });
            lane.offer('below_sim_bar', 'r', () => cand());
            await lane.tick();
            const st = lane.statsFor('below_sim_bar');
            assert(st.tested === 1 && st.unprofitable === 1 && st.profitable === 0, 'profit under gas cost counts as unprofitable');
      }

      // ---- Request allowance and backing off ----
      {
            const b = new CallBudget(6, () => 0);
            let n = 0;
            while (b.tryTake(1)) n++;
            assert(n === 6, 'allowance: 6 requests a minute, no more');
            const node = fakeRpc();
            const r = await budgetedRpc(node.rpc, b)('eth_call', []);
            assert(!!r.error && /429/.test(r.error.message ?? '') && node.calls.length === 0, 'over the allowance: refused before reaching the node');
      }
      {
            let t = 0;
            const b = new CallBudget(6, () => t);
            while (b.tryTake(1)) { /* drain */ }
            t = 30_000;
            assert(b.available() === 3, 'allowance refills steadily (half a minute = 3 requests)');
      }
      {
            const { lane, advance } = makeLane({ rpcPerMin: 6 });
            for (let i = 0; i < 6; i++) lane.budget.tryTake(1);
            lane.offer('below_sim_bar', 'r', () => cand());
            assert((await lane.tick()) === false && lane.queued() === 1, 'no allowance left: waits, candidate kept');
            advance(30_000);
            assert((await lane.tick()) === true, 'allowance refilled: tests it');
      }
      {
            const { lane } = makeLane({}, { canRun: () => false });
            lane.offer('below_sim_bar', 'r', () => cand());
            assert((await lane.tick()) === false && lane.queued() === 1, 'main checker busy/paused: the lane waits its turn');
      }
      {
            const s = fakeSim([{ status: 'rate_limited', reason: 'rate limited (HTTP 429)' }]);
            const { lane, advance } = makeLane({ flash: false, pauseMs: 60_000 }, { simulate: s.sim as any });
            lane.offer('below_sim_bar', 'r1', () => cand());
            lane.offer('gap_below_min', 'r2', () => cand({ reason: 'gap_below_min' }));
            await lane.tick();
            assert(lane.statsFor('below_sim_bar').skipped === 1, 'node said slow down: not a trade result');
            assert((await lane.tick()) === false, 'node said slow down: the whole lane rests');
            advance(61_000);
            assert((await lane.tick()) === true, 'rest over: testing resumes');
      }

      {
            // A coin whose test runs out of the lane's allowance part way is left alone for a while.
            let simCalls = 0;
            const sim = async (): Promise<SimResult> => { simCalls++; return { status: 'rate_limited', reason: 'research lane allowance used up (429)' }; };
            const { lane, advance } = makeLane({ flash: false, rpcPerMin: 600 }, { simulate: sim as any });
            lane.offer('below_sim_bar', 'r1', () => cand());
            await lane.tick();
            lane.offer('below_sim_bar', 'r2', () => cand());
            await lane.tick();
            assert(simCalls === 1 && lane.statsFor('below_sim_bar').skipped === 2, 'coin that ran out the allowance is rested (no second attempt)');
            advance(11 * 60_000);
            lane.offer('below_sim_bar', 'r3', () => cand());
            await lane.tick();
            assert(simCalls === 2, 'after 10 min the coin is tried again');
      }

      // ---- Replay right after the trigger trade ----
      {
            const hash = '0x' + 'ab'.repeat(32);
            const node = fakeRpc({
                  eth_getTransactionReceipt: { result: { blockNumber: '0x10', transactionIndex: '0x1' } },
                  eth_getBlockByNumber: { result: { timestamp: '0x5', transactions: [
                        { hash: '0x' + '11'.repeat(32), from: '0x1', to: '0x2', input: '0x', type: '0x2' },
                        { hash, from: '0x3', to: '0x4', input: '0xdead', type: '0x2' },
                  ] } },
            });
            const calls: { method: string; params: any }[] = [];
            const rpc: Rpc = async (m, p) => { calls.push({ method: m, params: p }); return node.rpc(m, p); };
            // This fake simulator sends a real-looking call to our contract
            // address, so the replay wrapper turns it into eth_simulateV1.
            const sim = async (r: Rpc): Promise<SimResult> => {
                  await r('eth_call', [{ to: '0x00000000000000000000000000000000a7b51e00' }, 'latest', {}]);
                  return { status: 'loss' };
            };
            const { lane } = makeLane({ flash: false }, { rpc, simulate: sim as any });
            lane.offer('below_sim_bar', 'r', () => cand({ source: 'trigger', triggerHash: hash }));
            await lane.tick();
            const methods = calls.map((c) => c.method);
            assert(methods.join(',') === 'eth_getTransactionReceipt,eth_getBlockByNumber,eth_simulateV1', `trigger test replays the trigger's block (${methods.join(',')})`);
            const simCall = calls[2]!.params;
            assert(simCall[1] === '0xf' && simCall[0].blockStateCalls[0].calls.length === 3, 'replayed on the block before, trigger and the trade before it, then ours');
            assert(lane.recentRecords()[0]!.timing === 'right after trigger', 'record says the test ran right after the trigger');
      }

      // ---- Round robin between reasons ----
      {
            const order: string[] = [];
            const { lane } = makeLane({ flash: false });
            for (let i = 0; i < 3; i++) lane.offer('shallow_pool', `s${i}`, () => { order.push('shallow'); return cand({ reason: 'shallow_pool' }); });
            lane.offer('gap_below_min', 'g', () => { order.push('gap'); return cand({ reason: 'gap_below_min' }); });
            await lane.tick(); await lane.tick();
            assert(order.includes('gap'), 'a busy reason cannot crowd out the others (takes turns)');
      }

      // ---- Summary and file ----
      {
            const s = fakeSim([{ status: 'profit', profit: 2_000_000n }]);
            const { lane } = makeLane({ flash: false }, { simulate: s.sim as any });
            lane.offer('below_sim_bar', 'r', () => cand());
            await lane.tick();
            const text = lane.takeHour();
            assert(text.includes('Research lane') && text.includes('1 made money') && text.includes('$1.99'), 'hourly summary says what made money');
            assert(!/[\u2013\u2014]/.test(text), 'summary has no long dashes');
            assert(lane.statsFor('below_sim_bar', 'hour').tested === 0 && lane.statsFor('below_sim_bar', 'total').tested === 1, 'takeHour resets the hour, keeps the total');
            const dir = mkdtempSync(join(tmpdir(), 'research-'));
            const file = join(dir, 'research-lane.json');
            lane.save(file);
            const j = JSON.parse(readFileSync(file, 'utf8'));
            assert(j.version === 1 && j.records.length === 1, 'saved to disk');
            const { lane: again } = makeLane();
            assert(again.load(file) === 1 && again.statsFor('below_sim_bar').profitable === 1, 'restored after a restart');
            const { lane: small } = makeLane({ maxRecords: 10, flash: false, rpcPerMin: 600 }, { simulate: fakeSim([]).sim as any });
            for (let i = 0; i < 15; i++) { small.offer('below_sim_bar', `r${i}`, () => cand()); await small.tick(); }
            assert(small.recentRecords().length === 10, 'records are capped (file stays small)');
            assert(makeLane().lane.load(join(dir, 'missing.json')) === 0, 'missing file: starts fresh');
      }

      // ---- Standing gaps the main scanner ignores ----
      {
            const usd = (t: string) => (t.toLowerCase() === USDG ? 1 : null);
            const deepA = v2('0xa1', 10_000, 1_000_000), deepB = v2('0xb1', 10_000, 1_008_000, 5);
            const thin = v2('0xc1', 20, 2_100, 5); // ~$4k pool, 5% dearer
            const depth = (p: PoolState) => 2 * Number(p.reserveB) / 1e6;
            const isDeep = (p: PoolState) => depth(p) >= 25_000;
            const opts = { mainMinUsd: 20, researchMinUsd: 0.25, minDepthUsd: 1_000, gasUsd: 0.01, maxTradeUsd: 5_000 };
            const out = findResearchGaps([[deepA, deepB]], isDeep, depth, dec, usd, opts);
            assert(out.length === 1 && out[0]!.reason === 'gap_below_min' && out[0]!.gap.profitUsd < 20, `small gap between deep pools -> gap_below_min ($${out[0]?.gap.profitUsd.toFixed(2)})`);
            const out2 = findResearchGaps([[deepA, thin]], isDeep, depth, dec, usd, opts);
            assert(out2.some((g) => g.reason === 'shallow_pool'), 'gap with a thin pool -> shallow_pool');
            const big = findResearchGaps([[deepA, v2('0xb2', 10_000, 1_030_000)]], isDeep, depth, dec, usd, opts);
            assert(!big.some((g) => g.reason === 'gap_below_min'), 'gaps over $20 are left to the main scanner');
            const c = gapCandidate('gap_below_min', out[0]!.gap, true);
            assert(c.source === 'gap' && c.tokenIn === out[0]!.gap.quote && c.sizeUsd > 0, 'gap becomes a testable candidate');
      }

      // ---- Shallow partner pools for a trigger trade ----
      {
            const cache = new PoolCache();
            const victim = v2('0xd1', 10_000, 1_000_000);
            const thinPeer = v2('0xd2', 100, 10_000, 30); // $20k deep: under the $25k bar
            cache.upsert(victim); cache.upsert(thinPeer);
            const depth = (p: PoolState) => 2 * Number(p.reserveB) / 1e6;
            const base = {
                  cache, victim, swap: { tokenIn: TOK, tokenOut: USDG, amountIn: 200n * 10n ** 18n, stateType: 'SEQUENCED' },
                  usdPerToken: 100, tokenInDecimals: 18, isDeep: (p: PoolState) => depth(p) >= 25_000, depthUsd: depth,
                  minDepthUsd: 1_000, gasUsd: 0.01, vetted: true, triggerHash: '0xabc',
            };
            const c = planShallowCandidate(base);
            assert(!!c && c.reason === 'shallow_pool' && c.modelGrossUsd > 0 && c.triggerHash === '0xabc', `thin partner pool planned (gross $${c?.modelGrossUsd.toFixed(2)})`);
            assert(planShallowCandidate({ ...base, minDepthUsd: 50_000 }) === null, 'partner thinner than the research floor: skipped');
            assert(planShallowCandidate({ ...base, usdPerToken: null }) === null, 'no USD price: skipped');
      }
})().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; });
