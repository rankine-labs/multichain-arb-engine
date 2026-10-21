// ============================================================================
// SHARED TOOLS for the "event-only copy" test.
//
// Plain English:
//   We run TWO practice chains (anvil) side by side:
//     - TRUTH:   the "real" chain. Random traders hit the pools here.
//     - COPY:    our copy, kept up to date ONLY from the truth chain's events
//                (plus counted node re-reads on rare events).
//   The copy starts from one full snapshot of the truth chain, and after
//   that it only ever sees the truth chain's EVENTS (logs), never its state,
//   except for counted "node re-reads".
//
//   Every few operations we build the bot's real check (an ArbExecutor round
//   trip through the pool) on the truth state and on each copy, run both with
//   the bot's own simulator engine (arbsim), and compare the answers byte for
//   byte.
// ============================================================================
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const solc = require('solc');
const { ethers } = require('ethers');

const ANVIL = `${process.env.HOME}/.foundry/bin/anvil`;
const COPYCHECK = path.join(__dirname, 'copycheck/target/release/copycheck');
const MAX = (1n << 256n) - 1n;
const abi = ethers.AbiCoder.defaultAbiCoder();

// Same made-up addresses the bot's simulator uses (src/execution/simulator.ts).
const SIM_EXECUTOR = '0x00000000000000000000000000000000a7b51e00';
const SIM_CALLER = '0x00000000000000000000000000000000000b0751';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex32 = (v) => '0x' + BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const lc = (a) => a.toLowerCase();

// ---------------------------------------------------------------------------
// Seeded random numbers, so every run can be repeated exactly.
// ---------------------------------------------------------------------------
function makeRng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    // log-uniform between lo and hi (BigInt): many small, some huge values
    logBig: (lo, hi) => {
      const a = Math.log(Number(lo)), b = Math.log(Number(hi));
      return BigInt(Math.floor(Math.exp(a + (b - a) * next())));
    },
  };
}

// ---------------------------------------------------------------------------
// One anvil chain + a tiny JSON-RPC client.
// ---------------------------------------------------------------------------
class Chain {
  constructor(name, port) {
    this.name = name;
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
    this.id = 0;
  }
  async start() {
    this.proc = spawn(ANVIL, ['--port', String(this.port), '--chain-id', '4663', '--hardfork', 'cancun',
      '--gas-limit', '1000000000', '--code-size-limit', '100000', '--silent', '--no-request-size-limit'], { stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      try { await this.rpc('eth_blockNumber'); break; } catch { await sleep(100); }
    }
    // A leftover chain from an earlier run on the same port would silently be
    // reused (our new one fails to start); refuse instead.
    if (Number(await this.rpc('eth_blockNumber')) !== 0) throw new Error(`${this.name}: port ${this.port} already has a used chain (leftover anvil?)`);
    this.provider = new ethers.JsonRpcProvider(this.url, undefined, { staticNetwork: true, cacheTimeout: -1 });
    // Fixed gas for every setup transaction. ethers' gas guess is made on the
    // previous block's time; V3 pools do extra work (a price-history write)
    // when the time moves on, so the guess was sometimes too low (out of gas).
    this.provider.estimateGas = async () => 25_000_000n;
    this.accounts = await this.rpc('eth_accounts');
    this.me = this.accounts[0];
    return this;
  }
  stop() { try { this.proc.kill(); } catch {} }
  async rpc(method, params = []) {
    const res = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }) });
    const j = await res.json();
    if (j.error) { const e = new Error(`${this.name} ${method}: ${j.error.message}`); e.rpc = j.error; throw e; }
    return j.result;
  }
  // Whole state of the chain (every account, all non-zero storage slots).
  async dump() {
    const d = await this.rpc('anvil_dumpState');
    return JSON.parse(zlib.gunzipSync(Buffer.from(d.slice(2), 'hex'))).accounts;
  }
  async setSlot(addr, slot, value) {
    await this.rpc('anvil_setStorageAt', [addr, hex32(slot), hex32(value)]);
  }
  async getSlot(addr, slot) { return BigInt(await this.rpc('eth_getStorageAt', [addr, hex32(slot), 'latest'])); }
  // Send a transaction from the unlocked test account (no waiting).
  async send(to, data, from) {
    return this.rpc('eth_sendTransaction', [{ from: from ?? this.me, to, data, gas: '0x2dc6c0' }]);
  }
  // Send and mine right away (automine must be on), throw if it reverted.
  async sendMined(to, data, ts, from) {
    if (ts !== undefined) await this.rpc('evm_setNextBlockTimestamp', ['0x' + ts.toString(16)]);
    const h = await this.send(to, data, from);
    let r = null;
    for (let i = 0; i < 50 && !r; i++) { r = await this.rpc('eth_getTransactionReceipt', [h]); if (!r) await sleep(20); }
    if (!r || r.status !== '0x1') throw new Error(`${this.name}: tx to ${to} failed (${data.slice(0, 10)}) receipt=${JSON.stringify(r)?.slice(0, 120)}`);
    return r;
  }
}

// ---------------------------------------------------------------------------
// Compile our helper contracts (Helpers.sol) with solc 0.8.26.
// ---------------------------------------------------------------------------
let _helpers;
function helpers() {
  if (_helpers) return _helpers;
  const input = {
    language: 'Solidity',
    sources: { 'Helpers.sol': { content: fs.readFileSync(path.join(__dirname, 'Helpers.sol'), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  for (const e of out.errors || []) if (e.severity === 'error') throw new Error(e.formattedMessage);
  _helpers = out.contracts['Helpers.sol'];
  return _helpers;
}

async function deploy(chain, abiJson, bytecode, ...args) {
  const signer = await chain.provider.getSigner(0);
  const bc = bytecode.startsWith('0x') ? bytecode : '0x' + bytecode;
  const c = await new ethers.ContractFactory(abiJson, bc, signer).deploy(...args, { gasLimit: 30_000_000 });
  await c.waitForDeployment();
  return new ethers.Contract(await c.getAddress(), abiJson, signer);
}

// The live contract's runtime code, read straight from the bot's source file.
function liveRuntimeCode() {
  const src = fs.readFileSync('/home/claude/multichain-arb-engine/src/execution/arbExecutorBytecode.ts', 'utf8');
  const m = src.match(/ARB_EXECUTOR_RUNTIME_CODE\s*=\s*\n?\s*['"`](0x[0-9a-fA-F]+)['"`]/);
  if (!m) throw new Error('runtime code not found');
  return m[1];
}

// Where a coin keeps `holder`'s balance (our Token: mapping at slot 0).
const balSlot = (holder) => ethers.keccak256(abi.encode(['address', 'uint256'], [holder, 0]));
// Storage key of mapping[key] for a mapping at slot `base` (key type given).
const mapSlot = (keyType, key, base) => ethers.keccak256(abi.encode([keyType, 'uint256'], [key, base]));

// ---------------------------------------------------------------------------
// The bot's check: ArbExecutor.execute(trade, address(0)) with minProfit = max,
// own-money style (executor given amountIn of the start coin by an override).
// ---------------------------------------------------------------------------
const EXEC_IFACE = new ethers.Interface([
  'function execute((address token,uint256 amountIn,uint256 minProfit,uint256 maxBlock,(uint8 kind,address pool,address tokenIn,address tokenOut,uint16 feeBps,uint24 v4Fee,int24 v4TickSpacing,bool v4Native)[] hops) t, address flashPool)',
]);
if (EXEC_IFACE.getFunction('execute').selector !== '0x8da2b32d') throw new Error('selector mismatch vs bot');
const hop = (kind, pool, tokenIn, tokenOut, extra = {}) => ({
  kind, pool, tokenIn, tokenOut, feeBps: extra.feeBps ?? 0, v4Fee: extra.v4Fee ?? 0,
  v4TickSpacing: extra.v4TickSpacing ?? 0, v4Native: false,
});
function checkCall(token, amountIn, hops) {
  const data = EXEC_IFACE.encodeFunctionData('execute', [{ token, amountIn, minProfit: MAX, maxBlock: MAX, hops }, ethers.ZeroAddress]);
  return { from: SIM_CALLER, to: SIM_EXECUTOR, data, gas: '0x7a1200', value: '0x0', gasPrice: '0x0' };
}
// Overrides exactly like simulateRoundTrip: our code at the sim address,
// executor = SIM_CALLER (slot 0), start-coin balance = amountIn.
// extraExecSlots: V4 needs PoolManager (slot 6) and WETH (slot 7) set.
function checkOverrides(token, amountIn, runtime, extraExecSlots = {}) {
  const execDiff = { [hex32(0)]: hex32(SIM_CALLER) };
  for (const [k, v] of Object.entries(extraExecSlots)) execDiff[hex32(k)] = hex32(v);
  return {
    [SIM_EXECUTOR]: { code: runtime, stateDiff: execDiff },
    [token]: { stateDiff: { [balSlot(SIM_EXECUTOR)]: hex32(amountIn) } },
  };
}

// Block details a check runs with (what eth_call on 'latest' uses on anvil).
async function checkBlockEnv(chain) {
  const probe = '0x' + '43600052' + '42602052' + '48604052' + '41606052' + '45608052' + '4460a052' + '60c06000f3';
  const P = '0x00000000000000000000000000000000000ccccc';
  const env = await chain.rpc('eth_call', [{ to: P, data: '0x' }, 'latest', { [P]: { code: probe } }]);
  const w = (i) => '0x' + BigInt('0x' + env.slice(2 + 64 * i, 2 + 64 * (i + 1))).toString(16);
  return { number: w(0), timestamp: w(1), baseFee: w(2), coinbase: ethers.getAddress('0x' + env.slice(2 + 64 * 3 + 24, 2 + 64 * 4)),
    gasLimit: w(4), prevrandao: hex32(w(5)), difficulty: '0x1' };
}

// Runs the check on the TRUTH chain: everything it touched (prestate) + the
// node's own answer (callTracer).
async function traceCheck(chain, tx, overrides) {
  const pre = await chain.rpc('debug_traceCall', [tx, 'latest', { tracer: 'prestateTracer', stateOverrides: overrides }]);
  const ct = await chain.rpc('debug_traceCall', [tx, 'latest', { tracer: 'callTracer', stateOverrides: overrides }]);
  for (const a of Object.values(pre)) { a.balance ??= '0x0'; a.nonce ??= 0; a.code ??= '0x'; a.storage ??= {}; }
  return { pre, expected: { success: !ct.error, output: ct.output ?? '0x', gasUsed: ct.gasUsed, error: ct.error ?? null } };
}

// ---------------------------------------------------------------------------
// The engine: one long-running copycheck process (bot's arbsim library).
// ---------------------------------------------------------------------------
class Engine {
  constructor() {
    this.p = spawn(COPYCHECK, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.waiting = [];
    readline.createInterface({ input: this.p.stdout }).on('line', (l) => this.waiting.shift()(JSON.parse(l)));
  }
  run(fixture) {
    return new Promise((res) => { this.waiting.push(res); this.p.stdin.write(JSON.stringify(fixture) + '\n'); });
  }
  stop() { this.p.stdin.end(); }
}

// ---------------------------------------------------------------------------
// Storage helpers on dumps.
// ---------------------------------------------------------------------------
const norm = (k) => hex32(BigInt(k));
function storageOf(dump, addr) {
  const a = dump[lc(addr)];
  const out = new Map();
  if (!a) return out;
  for (const [k, v] of Object.entries(a.storage || {})) if (BigInt(v) !== 0n) out.set(norm(k), BigInt(v));
  return out;
}

module.exports = {
  ethers, abi, MAX, SIM_EXECUTOR, SIM_CALLER, Chain, Engine, makeRng, helpers, deploy, liveRuntimeCode,
  balSlot, mapSlot, hop, checkCall, checkOverrides, checkBlockEnv, traceCheck, hex32, lc, norm, storageOf, sleep,
};
