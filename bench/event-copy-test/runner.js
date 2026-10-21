// ============================================================================
// THE TEST RUNNER (same for every pool type)
//
// Plain English, step by step:
//   1. Start the TRUTH chain and let the pool-type file (types/*.js) build
//      coins + the pool under test + two "reference" pools (one priced high,
//      one priced low, never traded, so they never change).
//   2. Take ONE full snapshot of the truth chain and load it into a second
//      chain, the COPY. From now on the copy never looks at the truth's
//      state again; it only gets the truth's EVENTS (logs), block number and
//      block time. The only exception: "node re-reads" the pool-type file
//      asks for on rare events; we count every one.
//   3. Random workload on the truth chain: swaps both ways (tiny to huge),
//      liquidity add/remove, coin "donations" straight to the pool, flash
//      loans... 1-4 per block, with block times that jump by 0s to 1h.
//   4. After every block: hand the block's events to the pool-type file,
//      which writes what they say into the copy. Then compare the WHOLE
//      storage of every copied account, truth vs copy, and list every
//      slot that differs (by name). Any difference the pool-type file did not
//      declare "known unknown" = an unsound copy (counted as a bug).
//   5. About every 5 operations: build the bot's real check (ArbExecutor
//      round trips, minProfit = max, own money via a balance override) for
//      4 routes x 3 sizes, and run it with the bot's simulator engine on
//        (a) TRUE state (what the check touches on the truth chain),
//        (b) COPY state, "lenient": slots we couldn't keep exact keep their
//            last value (what an event-driven copy really holds),
//        (c) COPY state, "strict": those slots are UNKNOWN; if the check
//            needs one, the engine says "needs node".
//      and compare success + output bytes (+ gas separately).
//
// Run: node runner.js <type> [ops=320] [seed=1]
// Output: results/<type>.json (all numbers) + a short summary on screen.
// ============================================================================
const fs = require('fs');
const path = require('path');
const L = require('./lib');
const { ethers, hex32, lc } = L;

async function main() {
  const typeName = process.argv[2];
  const N_OPS = Number(process.argv[3] ?? 320);
  const SEED = Number(process.argv[4] ?? 1);
  const VARIANT = process.argv[5] ?? 'default'; // pool-type specific option (e.g. Algebra plugin replay on/off)
  const mod = require(`./types/${typeName}.js`);
  const rng = L.makeRng(SEED);
  const basePort = 8600 + (Math.abs([...typeName].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 300) * 2;
  const truth = await new L.Chain('truth', basePort).start();
  const copy = await new L.Chain('copy', basePort + 1).start();
  const engine = new L.Engine();
  const runtime = L.liveRuntimeCode();
  const t0 = Date.now();

  // Everything we count goes in here (saved to results/<type>.json).
  const R = {
    type: typeName, variant: VARIANT, seed: SEED, opsRequested: N_OPS,
    ops: { sent: 0, succeeded: 0, reverted: 0, byKind: {} }, blocks: 0,
    events: { total: 0, byName: {} },
    reReads: { events: 0, slots: 0, byReason: {} },
    replays: { calls: 0, byReason: {} },
    stateDiff: { checkpoints: 0, divergentSlotsMax: 0, byCategory: {}, unsound: 0, unsoundExamples: [] },
    checks: {
      total: 0, nodeVsEngineTruth: { outputMatch: 0, successMatch: 0, gasEqual: 0, gasDiffs: {} },
      profitPositive: 0, profitZero: 0, profitPositiveMatch: 0, otherRevert: 0, revertKinds: {},
      lenient: { outputMatch: 0, successMatch: 0, mismatch: 0, gasEqual: 0, gasDiffHist: {}, firstMismatches: [] },
      copyNode: { outputMatch: 0 },
      strict: { known: 0, knownMatch: 0, knownMismatch: 0, needsNode: 0, missingByCategory: {}, unknownOther: 0 },
      readDiffByCategory: {}, checksWithReadDiff: 0,
    },
    negativeControl: null,
  };
  const bump = (obj, key, n = 1) => { obj[key] = (obj[key] ?? 0) + n; };

  try {
    // ---- 1. build the pools on the truth chain ----
    const ctx = await mod.setup(truth, rng, { variant: VARIANT });
    ctx.variant = VARIANT;
    await truth.rpc('evm_mine', []);

    // ---- 2. one full snapshot -> the copy chain ----
    const snap = await truth.rpc('anvil_dumpState');
    await copy.rpc('anvil_loadState', [snap]);
    // The copy knows the storage of these accounts (from the snapshot).
    const copied = mod.copiedAccounts(ctx).map(lc);
    const botKnown = new Set([...copied, lc(L.SIM_EXECUTOR), lc(L.SIM_CALLER)]);
    // Pool-type bookkeeping that starts from the snapshot (e.g. known ticks).
    await mod.initCopy(copy, ctx);
    console.log(`[${typeName}] setup done, copied accounts: ${copied.length}`);

    await truth.rpc('evm_setAutomine', [false]);
    let lastTs = Number((await truth.rpc('eth_getBlockByNumber', ['latest', false])).timestamp);
    let opsSinceCheck = 0;
    let checkpoints = 0;

    // Compare whole storage of every copied account, truth vs copy.
    async function compareState() {
      const [dt, dc] = await Promise.all([truth.dump(), copy.dump()]);
      const unknown = mod.policyUnknown(ctx); // Map addr -> Set(slot)
      let n = 0;
      for (const a of copied) {
        const st = L.storageOf(dt, a), sc = L.storageOf(dc, a);
        const keys = new Set([...st.keys(), ...sc.keys()]);
        for (const k of keys) {
          if ((st.get(k) ?? 0n) === (sc.get(k) ?? 0n)) continue;
          n++;
          const cat = mod.slotName(ctx, a, k);
          bump(R.stateDiff.byCategory, cat);
          const u = unknown.get(a);
          if (!(u === 'ALL' || u?.has(k))) {
            R.stateDiff.unsound++;
            if (R.stateDiff.unsoundExamples.length < 10) {
              R.stateDiff.unsoundExamples.push({ block: R.blocks, account: a, slot: k, category: cat,
                truth: '0x' + (st.get(k) ?? 0n).toString(16), copy: '0x' + (sc.get(k) ?? 0n).toString(16) });
            }
          }
        }
        // Account basics too (code / ETH balance) for the copied accounts.
        const at = dt[a], ac = dc[a];
        if ((at?.code ?? '0x') !== (ac?.code ?? '0x')) { n++; R.stateDiff.unsound++; bump(R.stateDiff.byCategory, `${mod.label(ctx, a)}:code`); }
      }
      R.stateDiff.checkpoints++;
      R.stateDiff.divergentSlotsMax = Math.max(R.stateDiff.divergentSlotsMax, n);
    }

    // Run every check spec on truth and on the copy, compare.
    async function runChecks() {
      const env = await L.checkBlockEnv(truth);
      const specs = mod.checkSpecs(ctx);
      const unknown = mod.policyUnknown(ctx);
      for (const s of specs) {
        const tx = L.checkCall(s.token, s.amountIn, s.hops);
        const ov = L.checkOverrides(s.token, s.amountIn, runtime, s.execSlots ?? {});
        const { pre, expected } = await L.traceCheck(truth, tx, ov);
        // Same check on the copy chain, with the truth block's time/number.
        const bo = { time: env.timestamp, number: env.number };
        const copyPre = await copy.rpc('debug_traceCall', [tx, 'latest', { tracer: 'prestateTracer', stateOverrides: ov, blockOverrides: bo }]);
        const copyCt = await copy.rpc('debug_traceCall', [tx, 'latest', { tracer: 'callTracer', stateOverrides: ov, blockOverrides: bo }]);
        for (const a of Object.values(copyPre)) { a.balance ??= '0x0'; a.nonce ??= 0; a.code ??= '0x'; a.storage ??= {}; }
        const name = `${typeName}-${checkpoints}-${s.name}`;
        const base = { chainId: 4663, block: env, l2BlockNumber: null, tx, expected };
        const fxTrue = { ...base, name: name + '-true', prestate: pre };
        const fxLen = { ...base, name: name + '-copy', prestate: copyPre };
        // Strict: only accounts the copy (or the bot itself) knows; known-unknown slots marked.
        // An account whose storage is entirely unknown ('ALL') keeps its code
        // and basics but no storage, and is not "complete" (every slot unknown).
        const strictPre = {};
        const complete = [];
        for (const [a, v] of Object.entries(copyPre)) {
          if (!botKnown.has(lc(a))) continue;
          if (unknown.get(lc(a)) === 'ALL') { strictPre[a] = { ...v, storage: {} }; continue; }
          strictPre[a] = v;
          complete.push(a);
        }
        const unk = {};
        for (const [a, set] of unknown) if (set !== 'ALL') unk[a] = [...set];
        const fxStrict = { ...base, name: name + '-strict', prestate: strictPre,
          copyMode: { complete, unknown: unk } };
        const [rt, rl, rs] = await Promise.all([engine.run(fxTrue), engine.run(fxLen), engine.run(fxStrict)]);

        R.checks.total++;
        const C = R.checks;
        // (sanity) bot engine on true state vs the node's own answer
        if (rt.output === (expected.output ?? '0x').toLowerCase()) C.nodeVsEngineTruth.outputMatch++;
        if (rt.success === expected.success) C.nodeVsEngineTruth.successMatch++;
        const gNode = BigInt(expected.gasUsed), gT = BigInt(rt.gasUsed ?? 0);
        if (gNode === gT) C.nodeVsEngineTruth.gasEqual++; else bump(C.nodeVsEngineTruth.gasDiffs, String(gT - gNode));
        // What did the check say?
        const out = rt.output ?? '0x';
        if (out.startsWith(insufficientSel)) {
          const got = BigInt('0x' + out.slice(10, 74));
          if (got > 0n) C.profitPositive++; else C.profitZero++;
        } else {
          C.otherRevert++;
          // Readable reason: Error(string) text, or the raw bytes.
          let why = out.slice(0, 10);
          if (out.startsWith('0x08c379a0')) { try { why = 'Error(' + ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + out.slice(10))[0] + ')'; } catch {} }
          else if (out === '0x') why = 'empty revert' + (rt.halt ? ` (halt: ${rt.halt})` : '');
          bump(C.revertKinds, why);
        }
        // (b) lenient copy vs truth
        const outEq = rl.output === rt.output, sucEq = rl.success === rt.success;
        if (outEq) C.lenient.outputMatch++;
        if (outEq && out.startsWith(insufficientSel) && BigInt('0x' + out.slice(10, 74)) > 0n) C.profitPositiveMatch++;
        if (sucEq) C.lenient.successMatch++;
        if (!outEq || !sucEq) {
          C.lenient.mismatch++;
          if (C.lenient.firstMismatches.length < 8) {
            C.lenient.firstMismatches.push({ check: name, truth: { success: rt.success, output: rt.output }, copy: { success: rl.success, output: rl.output, unknown: rl.unknown }, decoded: decodeOut(rt.output, rl.output) });
          }
        }
        const gd = Number(BigInt(rl.gasUsed ?? 0) - gT);
        if (gd === 0) C.lenient.gasEqual++;
        bump(C.lenient.gasDiffHist, String(gd));
        if ((copyCt.output ?? '0x').toLowerCase() === rt.output) C.copyNode.outputMatch++;
        // (c) strict copy
        if (rs.unknown) {
          if (rs.unknown === 'miss') {
            C.strict.needsNode++;
            const cats = new Set(rs.missing.map((m) => m.slot ? mod.slotName(ctx, lc(m.account), L.norm(m.slot)) : `account ${mod.label(ctx, lc(m.account ?? m.code))}`));
            for (const c of cats) bump(C.strict.missingByCategory, c);
            if (process.env.DEBUG && C.strict.needsNode <= 2) console.log('\nstrict missing:', JSON.stringify(rs.missing));
          } else C.strict.unknownOther++;
        } else {
          C.strict.known++;
          if (rs.output === rt.output && rs.success === rt.success) C.strict.knownMatch++; else C.strict.knownMismatch++;
        }
        // Which slots the check READ that differ, truth vs copy
        let anyDiff = false;
        for (const [a, acct] of Object.entries(pre)) {
          const cAcct = copyPre[a] ?? copyPre[lc(a)];
          for (const [k, v] of Object.entries(acct.storage ?? {})) {
            const cv = cAcct?.storage?.[k];
            if (cv === undefined || BigInt(cv) !== BigInt(v)) {
              if (lc(a) === lc(L.SIM_EXECUTOR)) continue;
              anyDiff = true;
              if (process.env.DEBUG_REF && mod.slotName(ctx, lc(a), L.norm(k)).startsWith('ref') && !global._refShown) { global._refShown = 1; console.log('\nREF DIFF', name, a, k, 'truth', v, 'copy', cv, 'copyHasAcct', !!cAcct, 'truthOut', rt.output.slice(0, 80), 'copyOut', rl.output.slice(0, 80), 'halts', rt.halt, rl.halt, 'gas', rt.gasUsed, rl.gasUsed, 'node', JSON.stringify(expected).slice(0,200)); }
              bump(C.readDiffByCategory, mod.slotName(ctx, lc(a), L.norm(k)));
            }
          }
        }
        if (anyDiff) C.checksWithReadDiff++;
      }
    }

    // ---- 3./4./5. the workload ----
    while (R.ops.sent < N_OPS) {
      const k = rng.int(1, 4);
      const sent = [];
      for (let i = 0; i < k && R.ops.sent < N_OPS; i++) {
        const op = await mod.randomOp(rng, ctx, truth);
        const h = await truth.send(op.to, op.data);
        sent.push({ h, op });
        R.ops.sent++;
        bump(R.ops.byKind, op.kind);
      }
      const ts = lastTs + rng.pick([0, 0, 0, 1, 1, 2, 5, 12, 60, 300, 3600]);
      await truth.rpc('evm_setNextBlockTimestamp', ['0x' + ts.toString(16)]);
      await truth.rpc('evm_mine', []);
      lastTs = ts;
      R.blocks++;
      const blk = await truth.rpc('eth_getBlockByNumber', ['latest', false]);
      if (blk.transactions.length !== sent.length) throw new Error(`block has ${blk.transactions.length} txs, sent ${sent.length}`);
      for (const s of sent) {
        const rc = await truth.rpc('eth_getTransactionReceipt', [s.h]);
        if (rc.status === '0x1') { R.ops.succeeded++; s.op.onSuccess?.(); } else { R.ops.reverted++; bump(R.ops.byKind, s.op.kind + ':reverted'); }
      }
      // The copy only gets: this block's events + its number and time.
      const logs = await truth.rpc('eth_getLogs', [{ fromBlock: blk.number, toBlock: blk.number }]);
      R.events.total += logs.length;
      const io = {
        // node re-read: counted, read from the truth chain at this block.
        reRead: async (addr, slots, reason) => {
          R.reReads.events++;
          bump(R.reReads.byReason, reason);
          for (const sl of slots) {
            const v = await truth.rpc('eth_getStorageAt', [addr, hex32(sl), blk.number]);
            await copy.setSlot(addr, sl, v);
            R.reReads.slots++;
          }
        },
        replay: (reason) => { R.replays.calls++; bump(R.replays.byReason, reason); },
        countEvent: (name) => bump(R.events.byName, name),
      };
      await mod.applyLogs(copy, logs, { number: Number(blk.number), timestamp: Number(blk.timestamp) }, ctx, io);
      await compareState();

      opsSinceCheck += sent.length;
      if (opsSinceCheck >= 5) {
        opsSinceCheck = 0;
        await runChecks();
        checkpoints++;
        process.stdout.write(`\r[${typeName}] ops ${R.ops.sent}/${N_OPS} checks ${R.checks.total} lenient-mismatch ${R.checks.lenient.mismatch} strict-needsNode ${R.checks.strict.needsNode} unsound ${R.stateDiff.unsound}   `);
      }
    }
    await runChecks();
    console.log('');

    // ---- negative control: the comparison must catch a copy that missed one swap ----
    if (mod.swapOp) {
      // One more swap on the truth chain that the copy is deliberately NOT
      // told about. The comparison MUST now see a difference; if it didn't,
      // the test itself would be blind.
      await truth.rpc('evm_setAutomine', [true]);
      const op = mod.swapOp(ctx);
      try { await truth.rpc('eth_call', [{ from: truth.me, to: op.to, data: op.data }, 'latest']); } catch (e) { console.log('neg-control swap would fail:', e.message); }
      await truth.sendMined(op.to, op.data, lastTs + 1);
      const env = await L.checkBlockEnv(truth);
      let detected = 0, total = 0;
      for (const s of mod.checkSpecs(ctx)) {
        const tx = L.checkCall(s.token, s.amountIn, s.hops);
        const ov = L.checkOverrides(s.token, s.amountIn, runtime, s.execSlots ?? {});
        const { pre, expected } = await L.traceCheck(truth, tx, ov);
        const copyPre = await copy.rpc('debug_traceCall', [tx, 'latest', { tracer: 'prestateTracer', stateOverrides: ov, blockOverrides: { time: env.timestamp, number: env.number } }]);
        for (const a of Object.values(copyPre)) { a.balance ??= '0x0'; a.nonce ??= 0; a.code ??= '0x'; a.storage ??= {}; }
        const base = { chainId: 4663, block: env, l2BlockNumber: null, tx, expected };
        const [rt, rl] = await Promise.all([engine.run({ ...base, name: 'neg-true', prestate: pre }), engine.run({ ...base, name: 'neg-copy', prestate: copyPre })]);
        total++;
        if (rt.output !== rl.output) detected++;
      }
      R.negativeControl = { checks: total, differencesDetected: detected };
    }
    R.seconds = Math.round((Date.now() - t0) / 1000);
  } finally {
    engine.stop();
    truth.stop();
    copy.stop();
  }
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  const file = path.join(__dirname, 'results', `${typeName}${VARIANT === 'default' ? '' : '-' + VARIANT}-s${SEED}.json`);
  fs.writeFileSync(file, JSON.stringify(R, null, 1));
  summarize(R);
}

const insufficientSel = ethers.id('InsufficientProfit(uint256,uint256)').slice(0, 10);
function decodeOut(a, b) {
  const p = (o) => (o && o.startsWith(insufficientSel) ? BigInt('0x' + o.slice(10, 74)).toString() : o?.slice(0, 10));
  return { truthProfit: p(a), copyProfit: p(b) };
}

function summarize(R) {
  const C = R.checks;
  console.log(`== ${R.type} (${R.variant}) seed ${R.seed}: ${R.ops.succeeded}/${R.ops.sent} ops ok in ${R.blocks} blocks, ${R.events.total} events, ${R.seconds}s`);
  console.log(`   checks ${C.total}: profit>0 ${C.profitPositive} (copy identical on ${C.profitPositiveMatch}), profit=0 ${C.profitZero}, other revert ${C.otherRevert}`);
  console.log(`   engine vs node on TRUE state: output ${C.nodeVsEngineTruth.outputMatch}/${C.total}, gas equal ${C.nodeVsEngineTruth.gasEqual}/${C.total}`);
  console.log(`   LENIENT copy: output match ${C.lenient.outputMatch}/${C.total}, mismatches ${C.lenient.mismatch}, gas equal ${C.lenient.gasEqual}/${C.total}`);
  console.log(`   STRICT copy: answered ${C.strict.known} (match ${C.strict.knownMatch}, MISMATCH ${C.strict.knownMismatch}), needs node ${C.strict.needsNode}`);
  console.log(`   re-reads: ${R.reReads.events} events / ${R.reReads.slots} slots; replays ${R.replays.calls}; unsound state diffs ${R.stateDiff.unsound}`);
  console.log(`   state diff categories: ${JSON.stringify(R.stateDiff.byCategory)}`);
  if (R.negativeControl) console.log(`   negative control: ${JSON.stringify(R.negativeControl)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
