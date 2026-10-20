#!/usr/bin/env node
// ============================================================================
// gas-diff.js: WHERE does arbsim's gas differ from the real Robinhood node?
// (workstream B; runs on the EC2 server, READ ONLY)
//
// Plain English:
//   For each saved real trade (fixtures live-*.json), asks the node:
//     - the receipt          -> gasUsed and gasUsedForL1 (Nitro's L1 data fee
//                               expressed as gas; NOT execution)
//     - callTracer            -> gas used by every call frame
//     - the block header      -> ArbOS version, tips setting
//   and (if built) runs arbsim's twin tool `gas_trace` on the same fixture.
//   It then prints, per trade, ONE summary line plus the first call frame
//   whose gas differs. Theory being tested (from Nitro source):
//       node gasUsed = execution gas + gasUsedForL1
//   so arbsim should equal  gasUsed - gasUsedForL1  exactly.
//
// Safety:
//   - Only reads (receipt / trace / block / storage). Sends nothing, signs nothing.
//   - Node URL from env ROBINHOOD_RPC_HTTP / QUICKNODE_RPC_ROBINHOOD /
//     SIM_RPC_ROBINHOOD (or those lines of ~/multichain-arb-engine/.env).
//     The URL is NEVER printed (it contains an API key).
//
// Usage (from ~/multichain-arb-engine/sim):
//   cargo build --release --example gas_trace        # once, for the arbsim side
//   node tools/gas-diff.js [fixtureDirOrFile ...] [--max N] [--frames] [--ops FIXTURE] [--json out.json]
//     default fixture dir: ~/inbot-bench/bench/inbot-sim/fixtures (then ~/inbot-bench/fixtures)
//     --frames : print every call frame side by side (node vs arbsim), not only the first difference
//     --ops F  : opcode-level comparison for ONE fixture (struct logger, limited);
//                prints the first opcode where remaining gas diverges
//     --no-arbsim : node side only (prints frames in gas_trace's line format)
// Output line format (same as `cargo run --example gas_trace`):
//   F <path> <TYPE> <to> in=<bytes> gas=<given> used=<used> <ok|revert|halt:..> out=0x<4 bytes>
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const BOT_DIR = process.env.BOT_DIR || path.join(HOME, 'multichain-arb-engine');
const SIM_DIR = path.join(__dirname, '..');
const NODE_VARS = ['ROBINHOOD_RPC_HTTP', 'QUICKNODE_RPC_ROBINHOOD', 'SIM_RPC_ROBINHOOD'];
const ARBOS_STATE = '0xa4b05fffffffffffffffffffffffffffffffffff';
const ARBSYS = '0x0000000000000000000000000000000000000064';

// ---------- args ----------
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes(n);
const MAX = Number(opt('--max') || 1000);
const OPS_FIXTURE = opt('--ops');
const JSON_OUT = opt('--json');
const valued = new Set(['--max', '--ops', '--json']);
const positional = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]));

// ---------- node URL (never printed) ----------
function nodeUrls() {
  let text = '';
  try { text = fs.readFileSync(path.join(BOT_DIR, '.env'), 'utf8'); } catch { /* none */ }
  const out = [];
  for (const v of NODE_VARS) {
    const m = text.match(new RegExp(`^\\s*${v}\\s*=\\s*["']?([^"'\\s#]+)`, 'm'));
    const url = process.env[v] || (m && m[1]);
    if (url && url.startsWith('http') && !out.some((u) => u.url === url)) out.push({ name: v, url });
  }
  return out;
}
let rpcId = 0;
async function rpc(url, method, params) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${String(j.error.message).slice(0, 160)}`);
  return j.result;
}

// ---------- ArbOS storage slot math (same as sim/src/arb/arbos.rs) ----------
// ethers v6 from the bot repo (BOT_DIR, else the repo this script lives in).
function loadEthers() {
  for (const d of [BOT_DIR, path.join(SIM_DIR, '..')]) {
    try { return require(path.join(d, 'node_modules', 'ethers')); } catch { /* next */ }
  }
  return require('ethers');
}
const { keccak256, getBytes, concat, zeroPadValue, toBeHex } = loadEthers();
function subKey(pathIds) { let k = new Uint8Array(0); for (const id of pathIds) k = getBytes(keccak256(concat([k, new Uint8Array([id])]))); return k; }
function arbosSlot(pathIds, offset) {
  const key = getBytes(zeroPadValue(toBeHex(offset), 32));
  const h = getBytes(keccak256(concat([subKey(pathIds), key.slice(0, 31)])));
  return '0x' + Buffer.from([...h.slice(0, 31), key[31]]).toString('hex');
}

// ---------- fixtures ----------
function fixtureFiles() {
  const dirs = positional.length ? positional : [
    path.join(HOME, 'inbot-bench', 'bench', 'inbot-sim', 'fixtures'),
    path.join(HOME, 'inbot-bench', 'fixtures'),
  ];
  const files = [];
  for (const d of dirs) {
    let st; try { st = fs.statSync(d); } catch { continue; }
    if (st.isFile()) { files.push(d); continue; }
    for (const f of fs.readdirSync(d).sort()) if (/^live-.*\.json$/.test(f)) files.push(path.join(d, f));
    if (!positional.length && files.length) break; // first default dir that has fixtures
  }
  return files.slice(0, MAX);
}
function txHashOf(fx) {
  const m = String(fx.source || '').match(/0x[0-9a-fA-F]{64}/);
  return m ? m[0] : null;
}

// ---------- callTracer -> lines ----------
function frameLines(frame, p = '0', out = []) {
  const ok = !frame.error ? 'ok' : (/revert/i.test(frame.error) ? 'revert' : `halt:${frame.error.replace(/\s+/g, '_')}`);
  const inLen = frame.input ? (frame.input.length - 2) / 2 : 0;
  const out4 = (frame.output || '0x').slice(0, 10);
  out.push({ path: p, type: frame.type, to: (frame.to || '').toLowerCase(), inLen, gas: BigInt(frame.gas || 0),
    used: BigInt(frame.gasUsed || 0), status: ok, out4 });
  (frame.calls || []).forEach((c, i) => frameLines(c, `${p}.${i}`, out));
  return out;
}
const fmt = (f) => `F ${f.path} ${f.type} ${f.to} in=${f.inLen} gas=${f.gas} used=${f.used} ${f.status} out=${f.out4}`;

// ---------- arbsim side ----------
function arbsimBin() {
  for (const p of [path.join(SIM_DIR, 'target', 'release', 'examples', 'gas_trace'), path.join(SIM_DIR, 'target', 'debug', 'examples', 'gas_trace')]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
function arbsimTrace(bin, file, extra = []) {
  const txt = execFileSync(bin, [file, '--json', ...extra], { encoding: 'utf8', maxBuffer: 256 << 20 });
  const j = JSON.parse(txt.trim().split('\n').pop());
  j.frameObjs = j.frames.map((l) => {
    const m = l.match(/^F (\S+) (\S+) (\S+) in=(\d+) gas=(\d+) used=(\d+) (\S+) out=(\S+)/);
    return m && { path: m[1], type: m[2], to: m[3].toLowerCase(), inLen: +m[4], gas: BigInt(m[5]), used: BigInt(m[6]), status: m[7], out4: m[8] };
  }).filter(Boolean);
  return j;
}

function intrinsic(dataHex, accessList) {
  const b = getBytes(dataHex || '0x');
  let g = 21000n;
  for (const x of b) g += x === 0 ? 4n : 16n;
  for (const it of accessList || []) g += 2400n + 1900n * BigInt((it.storageKeys || []).length);
  return g;
}

// ---------- opcode-level comparison for one fixture ----------
async function opsCompare(url, file, bin) {
  const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
  const hash = txHashOf(fx);
  if (!hash) throw new Error('fixture has no tx hash in .source');
  const LIMIT = 200000;
  const t = await rpc(url, 'debug_traceTransaction', [hash, { disableStorage: true, disableMemory: true, disableStack: true, enableReturnData: false, limit: LIMIT }]);
  const logs = t.structLogs || [];
  // Nitro adds fake SLOAD entries (pc 0, gas 0) for ArbOS storage reads inside
  // precompiles (arbos/util/tracing.go RecordStorageGet): count them, skip them.
  const fake = logs.filter((l) => l.op === 'SLOAD' && l.pc === 0 && l.gas === 0);
  const node = logs.filter((l) => !(l.op === 'SLOAD' && l.pc === 0 && l.gas === 0)).map((l) => ({ depth: l.depth, pc: l.pc, op: l.op, gas: BigInt(l.gas) }));
  console.log(`# ops ${path.basename(file)} node: ${node.length} opcodes (limit ${LIMIT}), ${fake.length} ArbOS storage reads inside precompiles, node gasUsed=${BigInt(t.gas)} failed=${t.failed}`);
  if (!bin) { console.log('# arbsim gas_trace not built; node side only'); return; }
  const txt = execFileSync(bin, [file, '--ops'], { encoding: 'utf8', maxBuffer: 1 << 30 });
  const sim = txt.split('\n').filter((l) => l.startsWith('O ')).map((l) => {
    const m = l.match(/^O (\d+) pc=(\d+) (\S+) gas=(\d+)/); return { depth: +m[1], pc: +m[2], op: m[3], gas: BigInt(m[4]) };
  });
  const n = Math.min(node.length, sim.length);
  let offset = null;
  for (let i = 0; i < n; i++) {
    const a = node[i], b = sim[i];
    if (a.pc !== b.pc || a.op !== b.op || a.depth !== b.depth) {
      console.log(`# PATH differs at op #${i}: node d${a.depth} pc=${a.pc} ${a.op} | arbsim d${b.depth} pc=${b.pc} ${b.op}`);
      return;
    }
    const d = a.gas - b.gas;
    if (offset === null) offset = d; // top-level start differs by intrinsic+poster gas: use first op as baseline
    if (d !== offset) {
      console.log(`# GAS diverges at op #${i} (d${a.depth} pc=${a.pc} ${a.op}): node remaining-arbsim remaining went ${offset} -> ${d}`);
      for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 2); k++) console.log(`   #${k} d${node[k].depth} pc=${node[k].pc} ${node[k].op} node=${node[k].gas} arbsim=${sim[k].gas}`);
      return;
    }
  }
  console.log(`# no divergence in ${n} common opcodes (constant start offset ${offset}: = node's L1 poster gas + any intrinsic difference). node ops=${node.length} arbsim ops=${sim.length}`);
}

// ---------- main ----------
async function main() {
  const nodes = nodeUrls();
  if (!nodes.length) throw new Error(`no node URL (set one of ${NODE_VARS.join(', ')})`);
  const url = nodes[0].url;
  console.log(`# node from ${nodes[0].name} (URL not shown)`);
  const bin = has('--no-arbsim') ? null : arbsimBin();
  if (!bin && !has('--no-arbsim')) console.log('# arbsim side: gas_trace not built (cargo build --release --example gas_trace); node side only');

  if (OPS_FIXTURE) { await opsCompare(url, OPS_FIXTURE, bin); return; }

  // Chain facts (once): ArbOS version + genesis block number from ArbOS state, ArbSys.arbOSVersion().
  try {
    const [ver, gen, cid] = await Promise.all([
      rpc(url, 'eth_getStorageAt', [ARBOS_STATE, arbosSlot([], 0), 'latest']),
      rpc(url, 'eth_getStorageAt', [ARBOS_STATE, arbosSlot([], 5), 'latest']),
      rpc(url, 'eth_getStorageAt', [ARBOS_STATE, arbosSlot([], 4), 'latest']),
    ]);
    let sysVer = null;
    try { sysVer = BigInt(await rpc(url, 'eth_call', [{ to: ARBSYS, data: '0x051038f2' }, 'latest'])) - 55n; } catch { /* ignore */ }
    console.log(`# chain: ArbOS state version=${BigInt(ver)} ArbSys.arbOSVersion()-55=${sysVer} genesisBlockNum=${BigInt(gen)} chainId=${BigInt(cid)}`);
  } catch (e) { console.log(`# chain facts unavailable: ${e.message}`); }

  const files = fixtureFiles();
  if (!files.length) throw new Error('no live-*.json fixtures found');
  console.log(`# ${files.length} fixtures`);
  console.log('# columns: fixture | node gasUsed | gasUsedForL1 | node compute (=gasUsed-L1) | arbsim | arbsim-compute | arbsim-gasUsed | arbos tips | first differing frame');

  const rows = [];
  for (const file of files) {
    const name = path.basename(file, '.json');
    try {
      const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
      const hash = txHashOf(fx);
      if (!hash) { console.log(`${name}: no tx hash in fixture.source, skipped`); continue; }
      const [rcpt, tx, ct] = await Promise.all([
        rpc(url, 'eth_getTransactionReceipt', [hash]),
        rpc(url, 'eth_getTransactionByHash', [hash]),
        rpc(url, 'debug_traceTransaction', [hash, { tracer: 'callTracer', tracerConfig: { withLog: false } }]),
      ]);
      const blk = await rpc(url, 'eth_getBlockByNumber', [rcpt.blockNumber, false]);
      const mix = getBytes(blk.mixHash);
      const arbos = Number(BigInt('0x' + Buffer.from(mix.slice(16, 24)).toString('hex')));
      const tips = arbos === 9 || (mix[25] & 1) === 1;
      const l1BlockFromMix = BigInt('0x' + Buffer.from(mix.slice(8, 16)).toString('hex'));
      const gasUsed = BigInt(rcpt.gasUsed);
      const l1 = BigInt(rcpt.gasUsedForL1 || 0);
      const compute = gasUsed - l1;
      const nodeFrames = frameLines(ct);
      const intr = intrinsic(tx.input, tx.accessList);
      const row = { name, hash, gasUsed: String(gasUsed), gasUsedForL1: String(l1), compute: String(compute), arbos, tips,
        txType: Number(tx.type), accessListItems: (tx.accessList || []).length, intrinsicNode: String(intr),
        callTracerTop: String(BigInt(ct.gasUsed)), l1BlockFromMix: String(l1BlockFromMix), fixtureNumber: String(BigInt(fx.block.number)) };

      let simTxt = 'n/a', first = '';
      if (bin) {
        const s = arbsimTrace(bin, file, ['--arbos', String(arbos)]);
        row.arbsim = s.txGasUsed; row.arbsimUnsupported = s.unsupported;
        simTxt = `${s.txGasUsed} | ${BigInt(s.txGasUsed) - compute} | ${BigInt(s.txGasUsed) - gasUsed}`;
        // Children compare exactly (frame gasUsed = gas given - gas left); the
        // TOP frame on the node is the whole receipt gasUsed, so compare it via compute.
        const simByPath = new Map(s.frameObjs.map((f) => [f.path, f]));
        for (const f of nodeFrames) {
          if (f.path === '0') continue;
          const g = simByPath.get(f.path);
          if (!g) { first = `${f.path} missing in arbsim (${f.type} ${f.to})`; break; }
          if (g.to !== f.to || g.used !== f.used || g.status !== f.status) {
            first = `${f.path} ${f.type} ${f.to} node used=${f.used} ${f.status} | arbsim used=${g.used} ${g.status} (diff ${g.used - f.used})`;
            break;
          }
        }
        if (!first && s.frameObjs.length !== nodeFrames.length) first = `frame count node=${nodeFrames.length} arbsim=${s.frameObjs.length}`;
        if (has('--frames')) {
          console.log(`## ${name}`);
          for (const f of nodeFrames) {
            const g = simByPath.get(f.path);
            console.log(`${fmt(f)}${g ? ` | arbsim used=${g.used}${g.used !== f.used ? ` DIFF ${g.used - f.used}` : ''}` : ' | arbsim -'}`);
          }
        }
        row.firstDiff = first || null;
      } else if (has('--frames')) {
        console.log(`## ${name}`); for (const f of nodeFrames) console.log(fmt(f));
      }
      if (fx.block && BigInt(fx.block.number) !== l1BlockFromMix) first += ` [NUMBER: fixture ${BigInt(fx.block.number)} vs header mix ${l1BlockFromMix}]`;
      if (row.accessListItems) first += ` [tx has access list: ${row.accessListItems} items, fixture dropped it]`;
      console.log(`${name} | ${gasUsed} | ${l1} | ${compute} | ${simTxt} | arbos=${arbos} tips=${tips} type=${row.txType} | ${first || 'all child frames equal'}`);
      rows.push(row);
    } catch (e) {
      console.log(`${name}: failed (${e.message.slice(0, 160)})`);
    }
  }
  // Summary
  const withSim = rows.filter((r) => r.arbsim !== undefined);
  if (withSim.length) {
    const eqCompute = withSim.filter((r) => BigInt(r.arbsim) === BigInt(r.compute)).length;
    const eqGas = withSim.filter((r) => BigInt(r.arbsim) === BigInt(r.gasUsed)).length;
    const zeroL1 = withSim.filter((r) => r.gasUsedForL1 === '0').length;
    console.log(`# SUMMARY ${withSim.length} trades: arbsim == node gasUsed-gasUsedForL1: ${eqCompute}; arbsim == node gasUsed: ${eqGas}; trades with gasUsedForL1=0: ${zeroL1}`);
  }
  if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify(rows, null, 1)); console.log(`# wrote ${JSON_OUT}`); }
}
main().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
