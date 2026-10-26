var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// scripts/sim-compare/liveReaction.ts
var import_fs2 = require("fs");
var import_path2 = require("path");
var import_perf_hooks2 = require("perf_hooks");
var import_ws = __toESM(require("ws"));
var import_ethers4 = require("ethers");

// src/chains/nitroFeed.ts
var import_ethers = require("ethers");
var HEADER_KIND_L2_MESSAGE = 3;
var L2_KIND_BATCH = 3;
var L2_KIND_SIGNED_TX = 4;
var MAX_BATCH_DEPTH = 16;
function parseL2MessageRaw(bytes, depth = 0) {
  if (bytes.length === 0 || depth > MAX_BATCH_DEPTH) return [];
  const kind = bytes[0];
  const body = bytes.subarray(1);
  if (kind === L2_KIND_SIGNED_TX) {
    try {
      const raw = "0x" + Buffer.from(body).toString("hex");
      return [{ tx: import_ethers.Transaction.from(raw), raw }];
    } catch {
      return [];
    }
  }
  if (kind === L2_KIND_BATCH) {
    const out = [];
    let i = 0;
    while (i + 8 <= body.length) {
      const len = Number(Buffer.from(body.subarray(i, i + 8)).readBigUInt64BE());
      i += 8;
      if (len <= 0 || i + len > body.length) break;
      out.push(...parseL2MessageRaw(body.subarray(i, i + len), depth + 1));
      i += len;
    }
    return out;
  }
  return [];
}
function safeFrom(tx) {
  try {
    return tx.from;
  } catch {
    return null;
  }
}
function lazySender() {
  return process.env.FEED_LAZY_SENDER !== "0";
}
function defineLazyFrom(target, tx) {
  let done = false;
  let value = null;
  Object.defineProperty(target, "from", {
    enumerable: true,
    configurable: true,
    get() {
      if (!done) {
        value = safeFrom(tx);
        done = true;
      }
      return value;
    }
  });
}
function parseFeedFrame(frame) {
  const messages = frame?.messages;
  if (!Array.isArray(messages)) return [];
  const txs2 = [];
  for (const m of messages) {
    const inner = m?.message?.message;
    if (inner?.header?.kind !== HEADER_KIND_L2_MESSAGE || typeof inner?.l2Msg !== "string") continue;
    const seq = typeof m?.sequenceNumber === "number" ? m.sequenceNumber : null;
    let bytes;
    try {
      bytes = Buffer.from(inner.l2Msg, "base64");
    } catch {
      continue;
    }
    for (const { tx, raw } of parseL2MessageRaw(bytes)) {
      try {
        if (!tx.to || !tx.data || tx.data === "0x") continue;
        const out = { sequenceNumber: seq, hash: (0, import_ethers.keccak256)(raw), to: tx.to, data: tx.data, value: tx.value.toString() };
        if (lazySender()) defineLazyFrom(out, tx);
        else out.from = safeFrom(tx);
        txs2.push(out);
      } catch {
      }
    }
  }
  return txs2;
}

// src/core/followMoney.ts
var import_ethers3 = require("ethers");

// src/core/rivalWatch.ts
var import_ethers2 = require("ethers");
var import_fs = require("fs");
var import_path = require("path");

// src/core/stallFinder.ts
var import_perf_hooks = require("perf_hooks");
var import_v8 = require("v8");
var MAX_STALLS = 6e3;
var MAX_SLICES = 512;
var MAX_GC = 1e3;
var MIN_SLICE_MS = 1;
function gcKindName(kind) {
  const c2 = import_perf_hooks.constants;
  if (kind === c2.NODE_PERFORMANCE_GC_MAJOR) return "major";
  if (kind === c2.NODE_PERFORMANCE_GC_MINOR) return "minor";
  if (kind === c2.NODE_PERFORMANCE_GC_INCREMENTAL) return "incremental";
  if (kind === c2.NODE_PERFORMANCE_GC_WEAKCB) return "weak-callback";
  return "other";
}
var emptyGc = () => ({ n: 0, totalMs: 0, maxMs: 0, maxKind: "", major: 0 });
var Window = class {
  constructor() {
    this.started = performance.now();
    this.jobs = /* @__PURE__ */ new Map();
    this.gc = emptyGc();
    this.freezes = 0;
    // exact freeze count in this window (not limited by the list size)
    this.worstMs = 0;
    this.allocBytes = 0;
    // heap growth seen between ticks (memory made, lower bound)
    this.allocMs = 0;
  }
  // time those readings cover
  reset(now) {
    this.started = now;
    this.jobs.clear();
    this.gc = emptyGc();
    this.freezes = 0;
    this.worstMs = 0;
    this.allocBytes = 0;
    this.allocMs = 0;
  }
};
var StallFinder = class {
  constructor(opts = {}) {
    this.timer = null;
    this.gcObs = null;
    this.lastTick = 0;
    this.stalls = [];
    this.slices = [];
    this.gcs = [];
    // Jobs running right now (a stack: a job may call another named job).
    this.stack = [];
    // Slow background jobs started but not finished (name -> how many).
    this.inFlight = /* @__PURE__ */ new Map();
    this.win = { fiveMin: new Window(), hour: new Window() };
    // Last heap size reading (for the memory-made-per-second estimate).
    this.lastHeap = -1;
    // Called with (freeze length in ms, the job that took most of it) for every freeze.
    this.listeners = [];
    this.thresholdMs = opts.thresholdMs ?? 50;
    this.tickMs = opts.tickMs ?? 20;
    this.enabled = opts.enabled ?? (process.env.STALL_FINDER !== "0" && process.env.STALL_FINDER !== "off");
    this.heapUsed = opts.heapUsed ?? (() => (0, import_v8.getHeapStatistics)().used_heap_size);
  }
  onStall(f) {
    this.listeners.push(f);
  }
  // ---- Start / stop the detector ------------------------------------------
  start() {
    if (!this.enabled || this.timer) return this;
    this.lastTick = performance.now();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
    try {
      this.gcObs = new import_perf_hooks.PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const kind = gcKindName(e.detail?.kind ?? e.kind);
          this.noteGc(e.startTime, e.duration, kind);
        }
      });
      this.gcObs.observe({ entryTypes: ["gc"] });
    } catch {
      this.gcObs = null;
    }
    return this;
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.gcObs?.disconnect();
    } catch {
    }
    this.gcObs = null;
  }
  // The 20 ms tick: a late tick means the bot was frozen in between.
  tick(now = performance.now()) {
    const gap = now - this.lastTick;
    this.lastTick = now;
    const late = gap - this.tickMs;
    if (late > this.thresholdMs) this.recordStall(now - gap, now, late);
    this.noteHeap(gap);
  }
  // Memory made per second (lower bound): the heap only grows between two
  // readings when new data is made; a clean-up makes it drop. Adding up the
  // growth between ticks misses what a clean-up removed in between, so the
  // real rate is higher. Exposed for tests.
  noteHeap(gapMs, heap = this.safeHeap()) {
    if (heap < 0) return;
    const grew = this.lastHeap >= 0 ? heap - this.lastHeap : 0;
    this.lastHeap = heap;
    for (const w of [this.win.fiveMin, this.win.hour]) {
      if (grew > 0) w.allocBytes += grew;
      w.allocMs += gapMs;
    }
  }
  safeHeap() {
    try {
      return this.heapUsed();
    } catch {
      return -1;
    }
  }
  // Exposed for tests: record a freeze between two times.
  recordStall(start, end, ms) {
    const jobs = /* @__PURE__ */ new Map();
    for (let i = this.slices.length - 1; i >= 0; i--) {
      const s = this.slices[i];
      if (s.end <= start) break;
      if (s.start >= end) continue;
      const dur = s.end - s.start;
      const overlap = Math.min(s.end, end) - Math.max(s.start, start);
      if (overlap <= 0 || dur <= 0) continue;
      const own = overlap * Math.min(1, Math.max(0, s.selfMs / dur));
      if (own > 0) jobs.set(s.name, (jobs.get(s.name) ?? 0) + own);
    }
    const during = this.inFlight.size ? [...this.inFlight.keys()].sort() : [];
    let gcMs = 0;
    for (let i = this.gcs.length - 1; i >= 0; i--) {
      const g = this.gcs[i];
      if (g.end + 1e4 < start) break;
      const o = Math.min(g.end, end) - Math.max(g.start, start);
      if (o > 0) gcMs += o;
    }
    this.stalls.push({ start, end, ms, jobs, during, gcMs });
    if (this.listeners.length) {
      let top = null, topMs = 0;
      for (const [name, t] of jobs) if (t > topMs) {
        top = name;
        topMs = t;
      }
      for (const f of this.listeners) {
        try {
          f(ms, top);
        } catch {
        }
      }
    }
    for (const w of [this.win.fiveMin, this.win.hour]) {
      w.freezes++;
      if (ms > w.worstMs) w.worstMs = ms;
    }
    if (this.stalls.length > MAX_STALLS + 500) this.stalls.splice(0, this.stalls.length - MAX_STALLS);
  }
  // A memory clean-up finished (Node tells us shortly after it happened).
  noteGc(start, durationMs, kind) {
    for (const w of [this.win.fiveMin, this.win.hour]) {
      const g = w.gc;
      g.n++;
      g.totalMs += durationMs;
      if (kind === "major") g.major++;
      if (durationMs > g.maxMs) {
        g.maxMs = durationMs;
        g.maxKind = kind;
      }
    }
    if (durationMs >= MIN_SLICE_MS) {
      const end = start + durationMs;
      this.gcs.push({ start, end, kind });
      if (this.gcs.length > MAX_GC + 200) this.gcs.splice(0, this.gcs.length - MAX_GC);
      for (let i = this.stalls.length - 1; i >= 0; i--) {
        const s = this.stalls[i];
        if (s.end <= start) break;
        const o = Math.min(end, s.end) - Math.max(start, s.start);
        if (o > 0) s.gcMs += o;
      }
    }
  }
  // ---- Wrapping jobs ---------------------------------------------------------
  // Record that job `name` held the thread from `start` to `end`.
  noteSlice(name, start, end, selfMs = end - start) {
    const ms = end - start;
    for (const w of [this.win.fiveMin, this.win.hour]) {
      const j = w.jobs.get(name) ?? { n: 0, totalMs: 0, maxMs: 0 };
      j.n++;
      j.totalMs += ms;
      if (ms > j.maxMs) j.maxMs = ms;
      w.jobs.set(name, j);
    }
    if (ms >= MIN_SLICE_MS) {
      this.slices.push({ name, start, end, selfMs });
      if (this.slices.length > MAX_SLICES) this.slices.splice(0, this.slices.length - MAX_SLICES);
    }
  }
  // Start timing a synchronous stretch by hand; call the returned function
  // when the stretch ends. Use for code that can't be put in a callback.
  begin(name) {
    const frame = { name, start: performance.now(), childMs: 0 };
    this.stack.push(frame);
    if (this.stack.length > 50) this.stack.splice(0, this.stack.length - 50);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const end = performance.now();
      const i = this.stack.lastIndexOf(frame);
      if (i >= 0) this.stack.splice(i, 1);
      const ms = end - frame.start;
      const parent = this.stack[this.stack.length - 1];
      if (parent) parent.childMs += ms;
      this.noteSlice(name, frame.start, end, Math.max(0, ms - frame.childMs));
    };
  }
  // Time a synchronous job. Returns what the job returns.
  run(name, fn) {
    const end = this.begin(name);
    try {
      return fn();
    } finally {
      end();
    }
  }
  // Name the rest of the current stretch of work, e.g. right after an
  // "await" (where run/runAsync stopped timing). The stretch ends when the
  // current piece of code gives the thread back (next microtask turn).
  mark(name) {
    const end = this.begin(name);
    queueMicrotask(end);
  }
  // Time an async job. The part before its first "await" is timed as one
  // stretch (that is where async jobs usually do their heavy work); the job
  // also counts as "in progress" until it finishes, so a freeze that no
  // named job explains says which slow jobs were running at the time.
  // track = false: don't list it as "in progress" (for jobs that are almost
  // always running, like feed trades waiting on a check).
  runAsync(name, fn, track = true) {
    if (track) this.inFlight.set(name, (this.inFlight.get(name) ?? 0) + 1);
    const done = () => {
      if (!track) return;
      const n = (this.inFlight.get(name) ?? 1) - 1;
      if (n <= 0) this.inFlight.delete(name);
      else this.inFlight.set(name, n);
    };
    const end = this.begin(name);
    let p;
    try {
      p = fn();
    } catch (err) {
      end();
      done();
      return Promise.reject(err);
    }
    end();
    return p.finally(done);
  }
  // ---- Reports ----------------------------------------------------------------
  // Summary for one window, then a fresh window starts.
  take(which, now = performance.now()) {
    const w = this.win[which];
    const from = w.started;
    const causes = /* @__PURE__ */ new Map();
    const add = (name, ms) => {
      const c2 = causes.get(name) ?? { n: 0, maxMs: 0 };
      c2.n++;
      if (ms > c2.maxMs) c2.maxMs = ms;
      causes.set(name, c2);
    };
    let seen = 0;
    for (const s of this.stalls) {
      if (s.end < from || s.end > now) continue;
      seen++;
      let explained = 0;
      for (const [name, ms] of s.jobs) {
        add(name, ms);
        explained += ms;
      }
      const gcMs = Math.min(s.gcMs, s.ms);
      if (gcMs > 0) {
        add("GC", gcMs);
        explained += gcMs;
      }
      const rest = s.ms - explained;
      if (rest > Math.max(20, s.ms * 0.3)) add(s.during.length ? `other (during ${s.during.slice(0, 2).join(", ")})` : "other", rest);
    }
    const list = [...causes.entries()].map(([name, c2]) => ({ name, n: c2.n, maxMs: c2.maxMs })).sort((a, b) => b.n * b.maxMs - a.n * a.maxMs || b.maxMs - a.maxMs);
    const longest = [...w.jobs.entries()].map(([name, j]) => ({ name, maxMs: j.maxMs, n: j.n })).sort((a, b) => b.maxMs - a.maxMs);
    const out = { freezes: w.freezes, worstMs: w.worstMs, thresholdMs: this.thresholdMs, causes: list, gc: { ...w.gc }, longest, enabled: this.enabled };
    if (seen < w.freezes) out.causesFrom = seen;
    if (w.allocMs >= 1e3) out.allocMbPerSec = w.allocBytes / 1048576 / (w.allocMs / 1e3);
    w.reset(now);
    return out;
  }
};
var stallFinder = new StallFinder();
var markStretch = (name) => stallFinder.mark(name);

// src/core/rivalWatch.ts
var MAX_PLAUSIBLE_PROFIT_SHARE = 0.05;
var MAX_PROFIT_NO_SIZE_USD = 5;
var MIN_PRICE_POOL_USD = 5e3;
var VERIFIED_BOT_WINS = 3;
var RIVAL_KEEP_MS = 24 * 36e5;
var MAX_RECS = 3e4;
var SAVE_CHUNK = 500;
var TRANSFER = import_ethers2.ethers.id("Transfer(address,address,uint256)");
var WETH_DEPOSIT = import_ethers2.ethers.id("Deposit(address,uint256)");
var WETH_WITHDRAWAL = import_ethers2.ethers.id("Withdrawal(address,uint256)");
var V4_SWAP = import_ethers2.ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
var SWAP_TOPICS = /* @__PURE__ */ new Set([
  import_ethers2.ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)"),
  // V2 / Solidly
  import_ethers2.ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)"),
  // V3
  import_ethers2.ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)"),
  // PancakeSwap V3
  V4_SWAP
  // Uniswap V4
]);
var FLASH_TOPICS = /* @__PURE__ */ new Set([
  import_ethers2.ethers.id("Flash(address,address,uint256,uint256,uint256,uint256)"),
  // Uniswap/Pancake V3 flash
  import_ethers2.ethers.id("FlashLoan(address,address,address,uint256,uint8,uint256,uint16)"),
  // Aave V3
  import_ethers2.ethers.id("FlashLoan(address,address,uint256,uint256)")
  // Balancer
]);
var addrFromTopic = (t) => "0x" + t.slice(26).toLowerCase();
function isJunkProfit(r) {
  if (r.failed || r.grossUsd === null) return false;
  if (r.thinPrice) return true;
  const g = Math.abs(r.grossUsd);
  if (r.sizeUsd !== null && r.sizeUsd > 0) return g > MAX_PLAUSIBLE_PROFIT_SHARE * r.sizeUsd;
  return g > MAX_PROFIT_NO_SIZE_USD;
}
function bucketOf(r) {
  if (r.failed) return "failed";
  if (r.grossUsd === null || r.conf === "unpriced") return "unpriced";
  if (isJunkProfit(r)) return "junk";
  if (r.conf === "uncertain") return "uncertain";
  return "confirmed";
}
var emptySample = () => ({ blocks: 0, arbs: 0, followed: 0, confirmedNetUsd: 0, firstBlock: null, lastBlock: null });
var median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
function summarize(recs, verified) {
  const byPair2 = /* @__PURE__ */ new Map();
  const byBot = /* @__PURE__ */ new Map();
  const out = {
    trades: recs.length,
    failed: 0,
    unpriced: 0,
    junk: 0,
    uncertain: 0,
    wins: 0,
    grossUsd: 0,
    gasUsd: 0,
    gasConfirmedUsd: 0,
    gasFailedUsd: 0,
    gasUnknownUsd: 0,
    gasNotPriced: 0,
    netUsd: 0,
    netWorstUsd: 0,
    medianSizeUsd: null,
    medianWinUsd: null,
    medianGasUsd: null,
    routes: { two: 0, three: 0, fourPlus: 0 },
    flash: 0,
    onOurPools: 0,
    byPair: [],
    byBot: [],
    bots: 0,
    verifiedBots: 0,
    whyUncertain: [],
    missed: { notWatched: 0, notWatchedUsd: 0, loops: 0, loopsUsd: 0 }
  };
  const why = /* @__PURE__ */ new Map();
  const sizes = [], wins = [], gases = [];
  for (const r of recs) {
    const gas = r.gasUsd ?? 0;
    if (r.gasUsd !== null) {
      gases.push(r.gasUsd);
      out.gasUsd += r.gasUsd;
    } else out.gasNotPriced++;
    if (r.flash) out.flash++;
    if (r.ours) out.onOurPools++;
    const b = byBot.get(r.bot) ?? { n: 0, usd: 0, sizes: [], okN: 0, okPools: 0, flash: 0, loopWins: 0 };
    b.n++;
    if (r.flash) b.flash++;
    byBot.set(r.bot, b);
    const bucket = bucketOf(r);
    if (bucket === "failed") {
      out.failed++;
      out.gasFailedUsd += gas;
      b.usd -= gas;
      continue;
    }
    b.okN++;
    b.okPools += r.pools;
    if (r.pools <= 2) out.routes.two++;
    else if (r.pools === 3) out.routes.three++;
    else out.routes.fourPlus++;
    if (bucket !== "confirmed") {
      out.gasUnknownUsd += gas;
      if (bucket === "unpriced") out.unpriced++;
      else if (bucket === "junk") {
        out.junk++;
        why.set("junk-price", (why.get("junk-price") ?? 0) + 1);
      } else out.uncertain++;
      for (const w of r.why ?? []) if (w !== "junk-price") why.set(w, (why.get(w) ?? 0) + 1);
      continue;
    }
    if (r.sizeUsd !== null && !r.thinPrice) {
      sizes.push(r.sizeUsd);
      b.sizes.push(r.sizeUsd);
    }
    out.gasConfirmedUsd += gas;
    out.grossUsd += r.grossUsd;
    const net = r.grossUsd - gas;
    b.usd += net;
    if (net > 0) {
      out.wins++;
      wins.push(net);
      if (r.closedLoop !== false) b.loopWins++;
      if (!r.ours) {
        out.missed.notWatched++;
        out.missed.notWatchedUsd += net;
      }
      if (r.pools >= 3) {
        out.missed.loops++;
        out.missed.loopsUsd += net;
      }
      const p = byPair2.get(r.pair) ?? { n: 0, usd: 0 };
      p.n++;
      p.usd += net;
      byPair2.set(r.pair, p);
    }
  }
  out.netUsd = out.grossUsd - out.gasConfirmedUsd - out.gasFailedUsd;
  out.netWorstUsd = out.netUsd - out.gasUnknownUsd;
  out.medianSizeUsd = median(sizes);
  out.medianWinUsd = median(wins);
  out.medianGasUsd = median(gases);
  out.byPair = [...byPair2.entries()].sort((a, b) => b[1].usd - a[1].usd).map(([p, e]) => [p, e.n, e.usd]);
  out.byBot = [...byBot.entries()].map(([bot, e]) => ({
    bot,
    trades: e.n,
    netUsd: e.usd,
    medianSizeUsd: median(e.sizes),
    avgPools: e.okN ? e.okPools / e.okN : 0,
    flash: e.flash,
    verified: verified ? verified.has(bot) : e.loopWins >= VERIFIED_BOT_WINS
  })).sort((a, b) => b.netUsd - a.netUsd);
  out.bots = byBot.size;
  out.verifiedBots = out.byBot.filter((b) => b.verified).length;
  out.whyUncertain = [...why.entries()].sort((a, b) => b[1] - a[1]);
  return out;
}
var emptySenderStats = () => ({ looked: 0, knownBot: 0, noOwners: 0, neverBot: 0, coinMove: 0, dupOrFull: 0, overCap: 0 });
var COIN_MOVE_SELECTORS = /* @__PURE__ */ new Set(["0xa9059cbb", "0x095ea7b3", "0x23b872dd"]);
var RivalWatch = class _RivalWatch {
  // sender look-ups in the current second
  constructor(rpc2, tokenUsd, symbol, isWatchedPool, weth, now = Date.now, delayMs = 3e3, opts) {
    this.rpc = rpc2;
    this.tokenUsd = tokenUsd;
    this.symbol = symbol;
    this.isWatchedPool = isWatchedPool;
    this.weth = weth;
    this.now = now;
    this.delayMs = delayMs;
    this.bots = /* @__PURE__ */ new Map();
    this.owners = /* @__PURE__ */ new Map();
    // wallet -> bot it runs (learned from confirmed wins)
    this.candidates = /* @__PURE__ */ new Map();
    // sampler/owner: address -> profitable multi-pool trades seen
    this.queue = [];
    this.queued = /* @__PURE__ */ new Set();
    // hashes already queued (no double counting)
    this.busy = false;
    this.recs = [];
    this.sample = emptySample();
    this.senders = emptySenderStats();
    this.senderWindow = { at: 0, n: 0 };
    // ---- Compact storage (Oct 13 memory trim) ----------------------------
    // The same bot, wallet, pair name and pool addresses appear in thousands
    // of records. Reading them from receipts (or from the saved file) makes a
    // fresh copy of the text every time, so one shared copy is kept here and
    // every record points at it. Routes and "why" lists that repeat are shared
    // the same way. The per-coin raw amounts (`deltas`) are not kept: no report
    // reads them (the tx hash is kept, so they can always be looked up again).
    this.shared = /* @__PURE__ */ new Map();
    this.sharedLists = /* @__PURE__ */ new Map();
    this.hourFrom = now();
    this.opts = typeof opts === "function" ? { priceDepthUsd: opts } : opts ?? {};
  }
  addBot(addr, src = "tracker") {
    if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return;
    const a = addr.toLowerCase();
    const have = this.bots.get(a);
    if (!have) this.bots.set(a, { src, trades: 0, wins: 0, firstSeen: this.now() });
    else if (src === "seed") have.src = "seed";
  }
  botCount() {
    return this.bots.size;
  }
  // Bots that have proven themselves in front of us (closed-loop wins).
  verifiedBots() {
    return new Set([...this.bots.entries()].filter(([, i]) => i.wins >= VERIFIED_BOT_WINS).map(([a]) => a));
  }
  // For reports: how many bots on the list are verified vs still unproven, by source.
  botStatus() {
    const bySource = { seed: { total: 0, verified: 0 }, tracker: { total: 0, verified: 0 }, sampler: { total: 0, verified: 0 }, owner: { total: 0, verified: 0 } };
    let verified = 0;
    for (const i of this.bots.values()) {
      bySource[i.src].total++;
      if (i.wins >= VERIFIED_BOT_WINS) {
        verified++;
        bySource[i.src].verified++;
      }
    }
    return { total: this.bots.size, verified, unproven: this.bots.size - verified, bySource };
  }
  // Every feed transaction: queue it if it went to a rival bot, or came from
  // a wallet that runs one (catches an operator's new or second contract).
  //
  // `from` (the sender) can be given as text, or as a function that works it
  // out only when called (RIVAL LAZY SENDER, Oct 14). Working out a feed
  // transaction's sender is a signature check of about 1-2 ms, and the old
  // code paid it for EVERY feed transaction: the biggest single cause of
  // freezes ("rival watch", ~1,000 a 5 min). The sender is only needed for
  // the owner-wallet check, so with a function it is skipped when:
  //   - the transaction went to a bot we already follow (queued anyway),
  //   - it is already queued, or the queue is full (nothing would happen),
  //   - we know no bot wallets yet (nothing to match it against),
  //   - it went to a router / pool / coin (can never be a new bot),
  //   - it is a plain coin transfer / approval, or an ETH send with no call
  //     (`data` = the call data or just its first 4 bytes; checked only when
  //     given; catches coins we don't have on our list), or
  //   - we already did `senderMaxPerSec` look-ups this second (counted).
  // Text senders behave exactly as before (older callers and tests).
  noteTx(to, hash, from, value, data) {
    if (!to || !hash) return;
    const bot = to.toLowerCase();
    const known = this.bots.has(bot);
    let viaOwner = false;
    if (typeof from === "function") {
      if (known) this.senders.knownBot++;
      else if (this.queue.length >= 100 || this.queued.has(hash)) {
        this.senders.dupOrFull++;
        return;
      } else if (!this.owners.size) {
        this.senders.noOwners++;
        return;
      } else if (this.opts.neverNewBot?.(bot)) {
        this.senders.neverBot++;
        return;
      } else if (typeof data === "string" && (data.length <= 2 || COIN_MOVE_SELECTORS.has(data.slice(0, 10).toLowerCase()))) {
        this.senders.coinMove++;
        return;
      } else {
        const t = this.now();
        if (t - this.senderWindow.at >= 1e3) this.senderWindow = { at: t, n: 0 };
        if (this.senderWindow.n >= (this.opts.senderMaxPerSec ?? 40)) {
          this.senders.overCap++;
          return;
        }
        this.senderWindow.n++;
        this.senders.looked++;
        let sender;
        try {
          sender = from();
        } catch {
          sender = null;
        }
        viaOwner = !!sender && this.owners.has(sender.toLowerCase());
      }
    } else {
      viaOwner = !known && !!from && this.owners.has(from.toLowerCase());
    }
    if (!known && !viaOwner || this.queue.length >= 100 || this.queued.has(hash)) return;
    let v;
    try {
      v = value !== void 0 && value !== null ? BigInt(value) : void 0;
    } catch {
      v = void 0;
    }
    this.queued.add(hash);
    if (this.queued.size > 5e3) this.queued.clear();
    this.queue.push({ hash, bot, dueAt: this.now() + this.delayMs, value: v, probe: viaOwner });
    void this.drain();
  }
  // Sender look-up counters since the last call, then reset (5-min status log).
  takeSenderStats() {
    const s = this.senders;
    this.senders = emptySenderStats();
    return s;
  }
  // Reads one trade from its receipt logs. `traders` = the bot contract plus
  // (optionally) the wallet that sent the transaction: profit is often swept
  // to the owner wallet in the same transaction, and moves between the two
  // are internal, not gains or losses.
  static analyze(logs, traders, v4PoolManager) {
    const who = new Set((Array.isArray(traders) ? traders : [traders]).filter(Boolean).map((x) => x.toLowerCase()));
    const bot = [...who][0];
    const pm = v4PoolManager?.toLowerCase();
    const net = /* @__PURE__ */ new Map();
    const outflow = /* @__PURE__ */ new Map();
    const pools = /* @__PURE__ */ new Set();
    const v4Pools = /* @__PURE__ */ new Set();
    const sentTo = /* @__PURE__ */ new Set();
    let flash = false, wrapped = false;
    for (const l of logs) {
      const t0 = l.topics?.[0];
      if (!t0) continue;
      if (FLASH_TOPICS.has(t0)) flash = true;
      if (t0 === TRANSFER && l.topics.length >= 3) {
        const from = addrFromTopic(l.topics[1]);
        const to = addrFromTopic(l.topics[2]);
        const fromUs = who.has(from), toUs = who.has(to);
        if (fromUs === toUs) continue;
        let v;
        try {
          v = BigInt(l.data);
        } catch {
          continue;
        }
        const tok = l.address.toLowerCase();
        net.set(tok, (net.get(tok) ?? 0n) + (toUs ? v : -v));
        if (fromUs) {
          outflow.set(tok, (outflow.get(tok) ?? 0n) + v);
          sentTo.add(to);
        }
      } else if ((t0 === WETH_DEPOSIT || t0 === WETH_WITHDRAWAL) && l.topics.length >= 2 && who.has(addrFromTopic(l.topics[1]))) {
        wrapped = true;
      } else if (SWAP_TOPICS.has(t0)) {
        if (t0 === V4_SWAP) {
          const id = l.topics[1].toLowerCase();
          pools.add(id);
          v4Pools.add(id);
        } else pools.add(l.address.toLowerCase());
      }
    }
    const external = [...sentTo].filter((a) => !pools.has(a) && a !== pm);
    return { bot, net, outflow, pools: [...pools], v4Pools: [...v4Pools], flash, wrapped, external };
  }
  // Receipt -> saved record (null if it isn't a multi-pool trade).
  // ctx.value = plain ETH the transaction carried (from the feed), if known.
  toRec(rcpt, bot, t = this.now(), ctx = {}) {
    const failed = rcpt.status === "0x0";
    const gasWei = BigInt(rcpt.gasUsed ?? "0x0") * BigInt(rcpt.effectiveGasPrice ?? "0x0");
    const gasUsd = this.tokenUsd(this.weth, gasWei);
    const hash = rcpt.transactionHash ?? void 0;
    const block = rcpt.blockNumber ? Number(BigInt(rcpt.blockNumber)) : void 0;
    const from = rcpt.from ? String(rcpt.from).toLowerCase() : void 0;
    const audit = { ...hash ? { hash } : {}, ...block !== void 0 ? { block } : {}, ...from ? { from } : {} };
    if (failed) return { t, bot, pair: "(failed)", pools: 0, sizeUsd: null, grossUsd: null, gasUsd, failed: true, flash: false, ours: false, ...audit };
    const traders = from && from !== bot.toLowerCase() ? [bot, from] : [bot];
    const tr = _RivalWatch.analyze(rcpt.logs ?? [], traders, this.opts.v4PoolManager);
    if (tr.pools.length < 2) return null;
    let gross = 0, priced = false, unpricedMove = false;
    for (const [tok, v] of tr.net) {
      if (v === 0n) continue;
      const u = this.tokenUsd(tok, v < 0n ? -v : v);
      if (u === null) {
        unpricedMove = true;
        continue;
      }
      priced = true;
      gross += v < 0n ? -u : u;
    }
    let size = null;
    for (const [tok, v] of tr.outflow) {
      const u = this.tokenUsd(tok, v);
      if (u !== null) size = Math.max(size ?? 0, u);
    }
    const pair = [...new Set([...tr.net.keys()].map((x) => this.symbol(x)))].sort().join("/") || "?";
    let thinPrice = false;
    if (this.opts.priceDepthUsd) {
      for (const tok of /* @__PURE__ */ new Set([...tr.net.keys(), ...tr.outflow.keys()])) {
        if ((tr.net.get(tok) ?? 0n) === 0n && !tr.outflow.get(tok)) continue;
        const d = this.opts.priceDepthUsd(tok);
        if (d !== null && d < MIN_PRICE_POOL_USD) {
          thinPrice = true;
          break;
        }
      }
    }
    const moves = [...tr.net.values()].filter((v) => v !== 0n);
    const closedLoop = moves.length > 0 && moves.every((v) => v > 0n);
    const why = [];
    for (const id of tr.v4Pools) {
      const native = this.opts.v4IsNative ? this.opts.v4IsNative(id) : null;
      if (native === true) {
        why.push("v4-native-leg");
        break;
      }
      if (native === null) {
        why.push("v4-pool-unknown");
        break;
      }
    }
    if (ctx.value && ctx.value > 0n) why.push("native-eth-sent");
    if (moves.some((v) => v < 0n)) why.push("open-position");
    if (!moves.some((v) => v > 0n) && tr.external.length) why.push("profit-sent-elsewhere");
    if (gasUsd === null) why.push("gas-unpriced");
    const grossUsd = priced && !unpricedMove ? gross : null;
    const base = {
      t,
      bot,
      pair,
      pools: tr.pools.length,
      sizeUsd: size,
      grossUsd,
      gasUsd,
      failed: false,
      flash: tr.flash,
      ours: tr.pools.every((p) => this.isWatchedPool(p)),
      ...thinPrice ? { thinPrice: true } : {},
      ...audit,
      route: tr.pools.slice(0, 6),
      deltas: [...tr.net.entries()].filter(([, v]) => v !== 0n).slice(0, 6).map(([k, v]) => [k, v.toString()]),
      closedLoop
    };
    if (isJunkProfit(base)) why.push("junk-price");
    const conf = grossUsd === null ? "unpriced" : why.length ? "uncertain" : "confirmed";
    return { ...base, conf, ...why.length ? { why } : {} };
  }
  async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const job = this.queue[0];
        const wait = job.dueAt - this.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.queue.shift();
        try {
          const r = await this.rpc("eth_getTransactionReceipt", [job.hash]);
          markStretch("rival watch");
          const rcpt = r?.result ?? r;
          if (rcpt?.blockNumber) {
            const rec = this.toRec(rcpt, job.bot, this.now(), { value: job.value });
            if (rec && job.probe) this.considerOwnerTrade(rec);
            else if (rec) this.add(rec);
          }
        } catch {
        }
        await new Promise((res) => setTimeout(res, 1e3));
      }
    } finally {
      this.busy = false;
    }
  }
  // A trade sent by a known bot's wallet to a contract we don't follow yet:
  // only a confirmed, closed-loop win counts, and two of them make it a bot.
  considerOwnerTrade(rec) {
    if (bucketOf(rec) !== "confirmed" || !rec.closedLoop || (rec.grossUsd ?? 0) - (rec.gasUsd ?? 0) <= 0) return;
    const n = (this.candidates.get(rec.bot) ?? 0) + 1;
    this.candidates.set(rec.bot, n);
    if (n >= 2) {
      this.addBot(rec.bot, "owner");
      this.candidates.delete(rec.bot);
      console.log(`[rivalwatch] new rival bot found via its owner wallet: ${rec.bot}`);
      this.add(rec);
    }
  }
  str(x) {
    const have = this.shared.get(x);
    if (have !== void 0) return have;
    this.shared.set(x, x);
    return x;
  }
  list(xs) {
    const k = xs.join(",");
    const have = this.sharedLists.get(k);
    if (have) return have;
    const l = Object.freeze(xs.map((x) => this.str(x)));
    this.sharedLists.set(k, l);
    return l;
  }
  // One record in the compact form kept in memory and on disk. Every record
  // gets the same fields in the same order (missing ones are left undefined,
  // which the reports treat exactly like "not there" and the file leaves out).
  compact(r) {
    return {
      t: r.t,
      bot: this.str(r.bot),
      pair: this.str(r.pair),
      pools: r.pools,
      sizeUsd: r.sizeUsd,
      grossUsd: r.grossUsd,
      gasUsd: r.gasUsd,
      failed: r.failed,
      flash: r.flash,
      ours: r.ours,
      thinPrice: r.thinPrice || void 0,
      hash: r.hash,
      block: r.block,
      from: r.from !== void 0 ? this.str(r.from) : void 0,
      route: r.route ? this.list(r.route) : void 0,
      conf: r.conf,
      why: r.why ? this.list(r.why) : void 0,
      closedLoop: r.closedLoop
    };
  }
  // After old records are dropped, forget shared text no record uses any
  // more (otherwise the shared tables would only ever grow).
  rebuildShared() {
    const keep = /* @__PURE__ */ new Map();
    const keepLists = /* @__PURE__ */ new Map();
    const k = (x) => {
      if (x !== void 0) keep.set(x, x);
    };
    for (const r of this.recs) {
      k(r.bot);
      k(r.pair);
      k(r.from);
      if (r.route) {
        keepLists.set(r.route.join(","), r.route);
        for (const p of r.route) k(p);
      }
      if (r.why) keepLists.set(r.why.join(","), r.why);
    }
    this.shared = keep;
    this.sharedLists = keepLists;
  }
  // For the [mem] line / tests: how many shared texts are held.
  sharedCount() {
    return this.shared.size;
  }
  add(rec) {
    this.recs.push(this.compact(rec));
    if (this.onRecord) {
      try {
        this.onRecord(rec);
      } catch {
      }
    }
    const cutoff = this.now() - RIVAL_KEEP_MS;
    if (this.recs.length > MAX_RECS || this.recs.length % 500 === 0 && this.recs[0]?.t < cutoff) {
      this.recs = this.recs.filter((r) => r.t >= cutoff).slice(-MAX_RECS);
      this.rebuildShared();
    }
    const info = this.bots.get(rec.bot);
    const bucket = bucketOf(rec);
    const net = rec.grossUsd !== null ? rec.grossUsd - (rec.gasUsd ?? 0) : null;
    if (info) {
      info.trades++;
      if (bucket === "confirmed" && rec.closedLoop !== false && net !== null && net > 0) {
        info.wins++;
        if (rec.from && rec.from !== rec.bot) this.owners.set(rec.from, rec.bot);
        if (this.owners.size > 2e3) this.owners.clear();
      }
    }
    const money = bucket === "failed" ? `gas $${(rec.gasUsd ?? 0).toFixed(4)}` : bucket === "unpriced" ? "unpriced" : bucket === "junk" ? `junk price (said $${net.toFixed(2)}, ignored)` : bucket === "uncertain" ? `uncertain (${(rec.why ?? []).join(",")}; said $${net.toFixed(4)}, ignored)` : `~$${net.toFixed(4)}`;
    console.log(`[rivalwatch] bot ${rec.bot.slice(0, 10)} ${rec.failed ? "FAILED" : rec.pair} ${money} | ${rec.pools} pools, size ${rec.sizeUsd === null ? "?" : "$" + rec.sizeUsd.toFixed(0)}, gas ${rec.gasUsd === null ? "?" : "$" + rec.gasUsd.toFixed(4)}${rec.flash ? ", flash loan" : ""}, ${rec.ours ? "all watched by us" : "NOT all watched by us"}${rec.hash ? ` tx ${rec.hash}` : ""}`);
  }
  // Sampler: read one recent block's receipts. Two jobs:
  //  1) find new rival bots: a contract becomes a "rival" after 2 trades
  //     where it went through 2+ pools and (together with the wallet that
  //     sent it) ended with more of some coin and less of none. A trading app
  //     passes coins on to its user, so the user ends with LESS of what they
  //     paid: not a closed loop, never counted.
  //  2) measure coverage: of the rival-style trades in sampled blocks, how
  //     many come from bots we already follow.
  async sampleBlock(blockTag) {
    const r = await this.rpc("eth_getBlockReceipts", [blockTag]);
    markStretch("rival watch sample");
    const rcpts = r?.result ?? r ?? [];
    if (!Array.isArray(rcpts)) return 0;
    const bn = Number(BigInt(blockTag));
    this.sample.blocks++;
    this.sample.firstBlock = this.sample.firstBlock === null ? bn : Math.min(this.sample.firstBlock, bn);
    this.sample.lastBlock = this.sample.lastBlock === null ? bn : Math.max(this.sample.lastBlock, bn);
    let added = 0;
    for (const rc of rcpts) {
      if (rc.status !== "0x1" || !rc.to) continue;
      const to = rc.to.toLowerCase();
      const from = rc.from ? String(rc.from).toLowerCase() : void 0;
      const tr = _RivalWatch.analyze(rc.logs ?? [], from ? [to, from] : [to], this.opts.v4PoolManager);
      if (tr.pools.length < 2) continue;
      const moves = [...tr.net.values()].filter((v) => v !== 0n);
      if (!moves.length || moves.some((v) => v < 0n)) continue;
      const followed = this.bots.has(to) || !!from && this.owners.has(from);
      this.sample.arbs++;
      if (followed) this.sample.followed++;
      const rec = this.toRec(rc, to);
      if (rec && bucketOf(rec) === "confirmed") this.sample.confirmedNetUsd += rec.grossUsd - (rec.gasUsd ?? 0);
      if (followed) continue;
      const n = (this.candidates.get(to) ?? 0) + 1;
      this.candidates.set(to, n);
      if (n >= 2) {
        this.addBot(to, "sampler");
        this.candidates.delete(to);
        added++;
        console.log(`[rivalwatch] new rival bot found by sampling: ${to}`);
      }
    }
    if (this.candidates.size > 5e3) this.candidates.clear();
    return added;
  }
  // How many trade records are kept in memory (for the [mem] line, core/memReport.ts).
  recordCount() {
    return this.recs.length;
  }
  // Summaries for the reports.
  summary(fromMs, toMs = this.now()) {
    return summarize(this.recs.filter((r) => r.t >= fromMs && r.t < toMs), this.verifiedBots());
  }
  // Pools (lower-case addresses / V4 pool ids) used by rival LOOP trades
  // (3+ pools, went through) since fromMs. The loop trader's extra pools
  // (core/loopExtraPools.ts) keep these first. Reads memory only.
  loopRoutePools(fromMs) {
    const out = /* @__PURE__ */ new Set();
    for (const r of this.recs) {
      if (r.t < fromMs || r.failed || r.pools < 3 || !r.route) continue;
      for (const p of r.route) out.add(p.toLowerCase());
    }
    return out;
  }
  // When the earliest saved record at/after fromMs is (for "last N hours" labels).
  firstRecordMs(fromMs) {
    const r = this.recs.find((x) => x.t >= fromMs);
    return r ? r.t : this.now();
  }
  // Hourly: the hour's trades plus the chain-wide sample for the same hour.
  takeHour() {
    const s = this.summary(this.hourFrom);
    s.sample = this.sample;
    this.sample = emptySample();
    this.hourFrom = this.now();
    return s;
  }
  load(botsFile, recsFile) {
    try {
      for (const b of JSON.parse((0, import_fs.readFileSync)(botsFile, "utf8"))) {
        if (typeof b === "string") {
          this.addBot(b, "tracker");
          continue;
        }
        this.addBot(b.a, b.src ?? "tracker");
        const i = this.bots.get(b.a.toLowerCase());
        if (i) {
          i.trades = b.trades ?? 0;
          i.wins = b.wins ?? 0;
          i.firstSeen = b.firstSeen ?? i.firstSeen;
        }
      }
    } catch {
    }
    try {
      const cutoff = this.now() - RIVAL_KEEP_MS;
      const rows2 = JSON.parse((0, import_fs.readFileSync)(recsFile, "utf8"));
      if (Array.isArray(rows2)) {
        this.recs = rows2.filter((r) => r && r.t >= cutoff).slice(-MAX_RECS).map((r) => this.compact(r));
        this.rebuildShared();
      }
    } catch {
    }
    return { bots: this.bots.size, recs: this.recs.length };
  }
  // Saves as a plain JSON list (same file format as before, so older
  // versions of the bot can still read it). Written a chunk of records at a
  // time to a temporary file, then swapped in, so a crash mid-save never
  // leaves a half-written file and memory never holds the whole file as text.
  save(botsFile, recsFile) {
    const write = (file, rows2) => {
      let fd = null;
      try {
        (0, import_fs.mkdirSync)((0, import_path.dirname)(file), { recursive: true });
        fd = (0, import_fs.openSync)(file + ".tmp", "w");
        (0, import_fs.writeSync)(fd, "[");
        for (let i = 0; i < rows2.length; i += SAVE_CHUNK) {
          const part = rows2.slice(i, i + SAVE_CHUNK).map((r) => JSON.stringify(r)).join(",");
          (0, import_fs.writeSync)(fd, (i > 0 ? "," : "") + part);
        }
        (0, import_fs.writeSync)(fd, "]");
        (0, import_fs.closeSync)(fd);
        fd = null;
        (0, import_fs.renameSync)(file + ".tmp", file);
      } catch {
        if (fd !== null) {
          try {
            (0, import_fs.closeSync)(fd);
          } catch {
          }
        }
      }
    };
    write(botsFile, [...this.bots.entries()].map(([a, i]) => ({ a, ...i })));
    write(recsFile, this.recs);
  }
};

// src/core/followMoney.ts
var FTM_TOPICS = {
  // Uniswap V2 copies (Uniswap V2, PancakeSwap V2, most "classic" pairs)
  V2_SWAP: import_ethers3.ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)"),
  // Solidly / Velodrome V2 style pairs (sender and recipient first)
  SOLIDLY_SWAP: import_ethers3.ethers.id("Swap(address,address,uint256,uint256,uint256,uint256)"),
  // Uniswap V3 copies, Ramses V3, SushiSwap V3, Algebra V1, Slipstream
  V3_SWAP: import_ethers3.ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)"),
  // PancakeSwap V3 copies (two extra protocol fee fields)
  PANCAKE_V3_SWAP: import_ethers3.ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)"),
  // Algebra Integral copies (Alandale, KittenSwap)
  ALGEBRA_SWAP: import_ethers3.ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24,uint24,uint24)"),
  // Uniswap V4 PoolManager (pool id instead of a pool address; Fables too)
  V4_SWAP: import_ethers3.ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"),
  // Trader Joe Liquidity Book / DLMM bins (Ramses DLMM style)
  LB_SWAP: import_ethers3.ethers.id("Swap(address,address,uint24,bytes32,bytes32,uint24,bytes32,bytes32)"),
  // Balancer V2 vault
  BALANCER_SWAP: import_ethers3.ethers.id("Swap(bytes32,address,address,uint256,uint256)"),
  // Curve pools (amounts need extra look-ups, so only counted)
  CURVE_EXCHANGE: import_ethers3.ethers.id("TokenExchange(address,int128,uint256,int128,uint256)")
};
var SWAP_KIND_BY_TOPIC = {
  [FTM_TOPICS.V2_SWAP]: "v2",
  [FTM_TOPICS.SOLIDLY_SWAP]: "solidly",
  [FTM_TOPICS.V3_SWAP]: "v3",
  [FTM_TOPICS.PANCAKE_V3_SWAP]: "pancake-v3",
  [FTM_TOPICS.ALGEBRA_SWAP]: "algebra",
  [FTM_TOPICS.V4_SWAP]: "v4",
  [FTM_TOPICS.LB_SWAP]: "lb",
  [FTM_TOPICS.BALANCER_SWAP]: "balancer",
  [FTM_TOPICS.CURVE_EXCHANGE]: "curve"
};
var ALL_SWAP_TOPICS = Object.keys(SWAP_KIND_BY_TOPIC);
var TRANSFER2 = import_ethers3.ethers.id("Transfer(address,address,uint256)");
var EXTRA_FLASH_TOPICS = /* @__PURE__ */ new Set([
  import_ethers3.ethers.id("FlashLoan(address,address,uint256)"),
  // Morpho Blue
  import_ethers3.ethers.id("FlashLoan(address,address,uint256,uint256,uint256)")
  // Euler style
]);
var V4_INITIALIZE = import_ethers3.ethers.id("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
var ZERO_ADDR = "0x0000000000000000000000000000000000000000";
var lc = (x) => (x ?? "").toLowerCase();
var addrFromTopic2 = (t) => "0x" + t.slice(26).toLowerCase();
var word = (data, i) => {
  const hex = data?.startsWith("0x") ? data.slice(2) : data ?? "";
  const w = hex.slice(i * 64, i * 64 + 64);
  return w.length === 64 ? w : null;
};
var uint = (w) => w === null ? null : BigInt("0x" + w);
var int = (w) => w === null ? null : BigInt.asIntN(256, BigInt("0x" + w));
var abs = (x) => x < 0n ? -x : x;
var MASK128 = (1n << 128n) - 1n;
function decodeSwapLog(l) {
  const t0 = l?.topics?.[0]?.toLowerCase();
  if (!t0) return null;
  const kind = SWAP_KIND_BY_TOPIC[t0];
  if (!kind) return null;
  try {
    switch (kind) {
      case "v2":
      case "solidly": {
        const [i0, i1, o0, o1] = [0, 1, 2, 3].map((i) => uint(word(l.data, i)));
        if (i0 === null || i1 === null || o0 === null || o1 === null) return { pool: lc(l.address), kind };
        return { pool: lc(l.address), kind, a0: i0 - o0, a1: i1 - o1 };
      }
      case "v3":
      case "pancake-v3":
      case "algebra": {
        const a0 = int(word(l.data, 0)), a1 = int(word(l.data, 1));
        return a0 === null || a1 === null ? { pool: lc(l.address), kind } : { pool: lc(l.address), kind, a0, a1 };
      }
      case "v4": {
        if (l.topics.length < 3) return null;
        const a0 = int(word(l.data, 0)), a1 = int(word(l.data, 1));
        const pool = l.topics[1].toLowerCase();
        const sender = addrFromTopic2(l.topics[2]);
        return a0 === null || a1 === null ? { pool, kind, sender } : { pool, kind, a0: -a0, a1: -a1, sender };
      }
      case "lb": {
        const inW = uint(word(l.data, 1)), outW = uint(word(l.data, 2));
        if (inW === null || outW === null) return { pool: lc(l.address), kind };
        return { pool: lc(l.address), kind, a0: (inW & MASK128) - (outW & MASK128), a1: (inW >> 128n) - (outW >> 128n) };
      }
      case "balancer": {
        if (l.topics.length < 4) return null;
        const ain = uint(word(l.data, 0)), aout = uint(word(l.data, 1));
        return { pool: l.topics[1].toLowerCase(), kind, tin: addrFromTopic2(l.topics[2]), tout: addrFromTopic2(l.topics[3]), ...ain !== null ? { ain } : {}, ...aout !== null ? { aout } : {} };
      }
      case "curve":
        return { pool: lc(l.address), kind };
    }
  } catch {
    return null;
  }
  return null;
}
function flowsFor(logs, who, pm) {
  return RivalWatch.analyze(logs, who, pm);
}
function recipientsOf(logs, who) {
  const out = /* @__PURE__ */ new Set();
  for (const l of logs) {
    if (l.topics?.[0] !== TRANSFER2 || l.topics.length < 3) continue;
    const from = addrFromTopic2(l.topics[1]), to = addrFromTopic2(l.topics[2]);
    if (who.has(from) && !who.has(to)) out.add(to);
  }
  return out;
}
function findHub(logs, exclude) {
  const tokens = new Set(logs.filter((l) => l.topics?.[0] === TRANSFER2).map((l) => lc(l.address)));
  const sends = /* @__PURE__ */ new Map(), gets = /* @__PURE__ */ new Map();
  for (const l of logs) {
    if (l.topics?.[0] !== TRANSFER2 || l.topics.length < 3) continue;
    const from = addrFromTopic2(l.topics[1]), to = addrFromTopic2(l.topics[2]);
    sends.set(from, (sends.get(from) ?? 0) + 1);
    gets.set(to, (gets.get(to) ?? 0) + 1);
  }
  let best = null, bestN = 0;
  for (const [a, s] of sends) {
    const g = gets.get(a) ?? 0;
    if (!g || exclude.has(a) || tokens.has(a) || a === ZERO_ADDR) continue;
    if (s + g > bestN) {
      best = a;
      bestN = s + g;
    }
  }
  return best;
}
function borrowRepay(logs, traders, pools) {
  const lent = /* @__PURE__ */ new Map(), back = /* @__PURE__ */ new Map();
  for (const l of logs) {
    if (l.topics?.[0] !== TRANSFER2 || l.topics.length < 3) continue;
    const from = addrFromTopic2(l.topics[1]), to = addrFromTopic2(l.topics[2]);
    let v;
    try {
      v = BigInt(l.data);
    } catch {
      continue;
    }
    const tok = lc(l.address);
    if (!traders.has(from) && traders.has(to) && !pools.has(from) && from !== ZERO_ADDR) {
      const k = tok + "|" + from;
      lent.set(k, (lent.get(k) ?? 0n) + v);
    } else if (traders.has(from) && !traders.has(to) && !pools.has(to)) {
      const k = tok + "|" + to;
      back.set(k, (back.get(k) ?? 0n) + v);
    }
  }
  for (const [k, v] of lent) if (v > 0n && (back.get(k) ?? 0n) >= v) return true;
  return false;
}
function poolEdges(logs, pool) {
  const net = /* @__PURE__ */ new Map();
  for (const l of logs) {
    if (l.topics?.[0] !== TRANSFER2 || l.topics.length < 3) continue;
    const from = addrFromTopic2(l.topics[1]), to = addrFromTopic2(l.topics[2]);
    if (from !== pool && to !== pool) continue;
    let v;
    try {
      v = BigInt(l.data);
    } catch {
      continue;
    }
    const tok = lc(l.address);
    net.set(tok, (net.get(tok) ?? 0n) + (to === pool ? v : -v));
  }
  let tin, tout, ain = 0n, aout = 0n;
  for (const [t, v] of net) {
    if (v > ain) {
      ain = v;
      tin = t;
    }
    if (-v > aout) {
      aout = -v;
      tout = t;
    }
  }
  return { ...tin ? { tin, ain } : {}, ...tout ? { tout, aout } : {} };
}
function classifyTx(logs, from, to, status, meta, opts) {
  if (status === "0x0" || status === 0) return { reason: "failed", arb: null };
  const pm = opts.poolManager?.toLowerCase();
  const weth = opts.weth.toLowerCase();
  const fromL = lc(from), toL = lc(to ?? "");
  const swaps = [];
  for (const l of logs ?? []) {
    const s = decodeSwapLog(l);
    if (s) swaps.push(s);
  }
  const pools = [];
  for (const s of swaps) if (!pools.includes(s.pool)) pools.push(s.pool);
  if (pools.length < 2) return { reason: "one-pool", arb: null };
  const poolSet = new Set(pools);
  let traders = [toL, fromL].filter((x) => x && x !== ZERO_ADDR);
  let tr = flowsFor(logs, traders, pm);
  let executor = toL, executorIsTo = true;
  if (tr.net.size === 0) {
    const hub = findHub(logs, /* @__PURE__ */ new Set([...poolSet, pm ?? "", fromL]));
    if (hub) {
      traders = [hub, toL, fromL].filter((x) => x && x !== ZERO_ADDR);
      tr = flowsFor(logs, traders, pm);
      executor = hub;
      executorIsTo = hub === toL;
    }
  }
  const who = new Set(traders);
  const net = new Map(tr.net);
  const uncertain = [];
  for (const s of swaps) {
    if (s.kind !== "v4" || s.a0 === void 0 || s.a1 === void 0) continue;
    const cur = opts.v4Currencies?.(s.pool) ?? null;
    if (!cur) {
      if (!uncertain.includes("v4-pool-unknown")) uncertain.push("v4-pool-unknown");
      continue;
    }
    const legs = [[lc(cur.c0), -s.a0], [lc(cur.c1), -s.a1]];
    for (const [c2, d] of legs) {
      if (c2 !== ZERO_ADDR) continue;
      if (s.sender && who.has(s.sender)) net.set(weth, (net.get(weth) ?? 0n) + d);
      else if (!uncertain.includes("v4-native-leg-hidden")) uncertain.push("v4-native-leg-hidden");
    }
  }
  const moves = () => [...net.values()].filter((v) => v !== 0n);
  let sentElsewhere = false;
  let externals = [];
  if (moves().some((v) => v < 0n)) return { reason: "user-swap", arb: null };
  if (!moves().some((v) => v > 0n)) {
    externals = [...recipientsOf(logs, who)].filter((a) => !poolSet.has(a) && a !== pm && a !== ZERO_ADDR);
    if (!externals.length) return { reason: "no-gain", arb: null };
    const wider = flowsFor(logs, [...traders, ...externals], pm);
    const m2 = [...wider.net.values()].filter((v) => v !== 0n);
    if (!m2.length || m2.some((v) => v < 0n)) return { reason: "no-gain", arb: null };
    net.clear();
    for (const [k, v] of wider.net) net.set(k, v);
    sentElsewhere = true;
  }
  let flashHow = null;
  if (tr.flash || (logs ?? []).some((l) => EXTRA_FLASH_TOPICS.has(l.topics?.[0]))) flashHow = "event";
  else if (borrowRepay(logs, who, /* @__PURE__ */ new Set([...poolSet, pm ?? ""]))) flashHow = "borrow-repay";
  const hops = pools.map((p) => {
    const s = swaps.find((x) => x.pool === p);
    if (s.kind === "balancer") return { pool: p, kind: s.kind, tin: s.tin, tout: s.tout, ain: s.ain?.toString(), aout: s.aout?.toString() };
    if (s.kind === "v4") {
      let a0 = 0n, a1 = 0n;
      for (const x of swaps) if (x.pool === p) {
        a0 += x.a0 ?? 0n;
        a1 += x.a1 ?? 0n;
      }
      const cur = opts.v4Currencies?.(p) ?? null;
      if (!cur) return { pool: p, kind: s.kind };
      const c0 = lc(cur.c0) === ZERO_ADDR ? weth : lc(cur.c0), c1 = lc(cur.c1) === ZERO_ADDR ? weth : lc(cur.c1);
      return a0 > 0n ? { pool: p, kind: s.kind, tin: c0, tout: c1, ain: a0.toString(), aout: abs(a1).toString() } : { pool: p, kind: s.kind, tin: c1, tout: c0, ain: a1.toString(), aout: abs(a0).toString() };
    }
    const e = poolEdges(logs, p);
    return { pool: p, kind: s.kind, tin: e.tin, tout: e.tout, ain: e.ain?.toString(), aout: e.aout?.toString() };
  });
  const arb = {
    hash: meta.hash,
    block: meta.block,
    txIndex: meta.txIndex,
    from: fromL,
    to: toL,
    executor,
    executorIsTo,
    swaps: swaps.length,
    pools,
    hops,
    net: [...net.entries()].filter(([, v]) => v !== 0n).map(([k, v]) => [k, v.toString()]),
    outflow: [...tr.outflow.entries()].filter(([, v]) => v !== 0n).map(([k, v]) => [k, v.toString()]),
    sentElsewhere,
    externals,
    flash: flashHow !== null,
    flashHow,
    uncertain,
    gasWei: meta.gasWei.toString(),
    ...meta.l1GasUsed !== void 0 ? { l1GasUsed: meta.l1GasUsed.toString() } : {},
    ...meta.value !== void 0 ? { value: meta.value.toString() } : {}
  };
  return { reason: "arb", arb };
}
function receiptGasWei(r) {
  const q = (x) => {
    try {
      return x === void 0 || x === null ? 0n : BigInt(x);
    } catch {
      return 0n;
    }
  };
  const gasWei = q(r?.gasUsed) * q(r?.effectiveGasPrice ?? r?.gasPrice) + q(r?.l1Fee);
  return r?.gasUsedForL1 !== void 0 ? { gasWei, l1GasUsed: q(r.gasUsedForL1) } : { gasWei };
}

// src/core/poolPrice.ts
var POOL_MIN_DEPTH_USD = Number(process.env.POOL_MIN_DEPTH_USD ?? 1e4);

// src/core/priceOracle.ts
var MIN_ANCHOR_USD = Number(process.env.ORACLE_MIN_ANCHOR_USD ?? 2500);
var SELECT_BY_REAL_DEPTH = process.env.ORACLE_REAL_DEPTH_SELECT === "1";
var MID_MEMO_ON = process.env.ORACLE_MID_MEMO !== "0";

// src/config/knownAddresses.ts
var ROBINHOOD_V3 = {
  FACTORY: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  SWAP_ROUTER_02: "0xCaf681a66D020601342297493863E78C959E5cb2",
  QUOTER_V2: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7"
};
var ROBINHOOD_V2 = {
  FACTORY: "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f",
  // lowercase, no checksum -- same fix as MONAD_BEAN
  ROUTER: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba"
};
var ROBINHOOD_PANCAKE = {
  V3_FACTORY: "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865",
  V3_QUOTER_V2: "0x8553aa1615549a86882151784b329b017aa7c832",
  V3_UNIVERSAL_ROUTER: "0xe28c0e44f4016b073db20cf28971cac6ce3664d3",
  SMART_ROUTER: "0x13f4ea83d0bd40e75c8222255bc855a974568dd4",
  V2_FACTORY: "0x02a84c1b3bbd7401a5f7fa98a384ebc70bb5749e",
  V2_ROUTER: "0x8cfe327cec66d1c090dd72bd0ff11d690c33a2eb"
};
var ROBINHOOD_RAMSES = {
  V2_FACTORY: "0x43b2bf9f33036a02fc7a00935571c2a6b0108e66",
  V2_ROUTER: "0x33d3cdd45e4d64ea762574789a2db4842ec8262e",
  V3_FACTORY: "0xe0c4ceb92d08ca985bb70fe0a22feb121a9854a8",
  V3_QUOTER_V2: "0x4730e03eb4a58a5e20244062d5f9a99bcf5770a6",
  V3_SWAP_ROUTER: "0xfcbbe2af83f94e7e2a9c35a535b3a04719afd2ae",
  DLMM_FACTORY: "0xdcd5f77697914e27f56fd263ef82923c8524abac",
  DLMM_ROUTER: "0xd0019e86edb35e1fedaab03aed5c3c60f115d28b",
  DLMM_QUOTER: "0xb722efaabe807faea16068f595eaa9aa1a62cecd"
};
var ROBINHOOD_TOKENS = {
  WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  NATIVE_ETH_SENTINEL: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
};
var ROBINHOOD_SCAN_FACTORIES = [
  { dex: "uniswap-v2", kind: "v2", factory: ROBINHOOD_V2.FACTORY },
  { dex: "pancakeswap-v2", kind: "v2", factory: ROBINHOOD_PANCAKE.V2_FACTORY },
  { dex: "ramses-v2", kind: "solidly", factory: ROBINHOOD_RAMSES.V2_FACTORY },
  { dex: "uniswap-v3", kind: "v3", factory: ROBINHOOD_V3.FACTORY },
  { dex: "pancakeswap-v3", kind: "v3", factory: ROBINHOOD_PANCAKE.V3_FACTORY },
  { dex: "ramses-v3", kind: "v3", factory: ROBINHOOD_RAMSES.V3_FACTORY }
];

// scripts/sim-compare/liveReaction.ts
var BOT_DIR = process.env.BOT_DIR || `${process.env.HOME}/multichain-arb-engine`;
var args = process.argv.slice(2);
var arg = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
var MINUTES = Number(arg("minutes", "60"));
var OUT = arg("out", `${process.env.HOME}/sim-compare-runs/reaction1`);
var ENGINE_MS = Number(arg("engine-ms", "5"));
var RPS = Number(arg("rps", "8"));
var FEED_URL = arg("feed", "wss://feed.mainnet.chain.robinhood.com");
var RH_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
var WETH = ROBINHOOD_TOKENS.WETH.toLowerCase();
(0, import_fs2.mkdirSync)(OUT, { recursive: true });
var lc2 = (s) => String(s ?? "").toLowerCase();
var envFile = (0, import_fs2.readFileSync)((0, import_path2.join)(BOT_DIR, ".env"), "utf8");
var envVar = (k) => {
  const m = envFile.match(new RegExp(`^\\s*${k}\\s*=\\s*["']?([^"'\\s#]+)`, "m"));
  return m ? m[1] : null;
};
var WSS = envVar("CHAINSTACK_WSS_ROBINHOOD");
var HTTP = envVar("CHAINSTACK_RPC_ROBINHOOD");
var SEND = envVar("ROBINHOOD_SEND_RPC") ?? HTTP;
if (!WSS || !HTTP) {
  console.error("CHAINSTACK_WSS_ROBINHOOD / CHAINSTACK_RPC_ROBINHOOD missing in .env");
  process.exit(1);
}
var watch = JSON.parse((0, import_fs2.readFileSync)((0, import_path2.join)(BOT_DIR, "data", "watched-pools.json"), "utf8"));
var all = (watch.pools || []).filter((p) => p && p.chain === "robinhood" && p.poolAddress && p.tokenA && p.tokenB);
var byPair = /* @__PURE__ */ new Map();
for (const p of all) {
  const k = [lc2(p.tokenA), lc2(p.tokenB)].sort().join("/");
  (byPair.get(k) ?? byPair.set(k, []).get(k)).push(p);
}
var ours = /* @__PURE__ */ new Map();
for (const list of byPair.values()) if (new Set(list.map((p) => p.dex)).size >= 2) for (const p of list) ours.set(lc2(p.poolAddress), p);
var addrs = [...ours.keys()].filter((a) => a.length === 42);
var ids = [...ours.keys()].filter((a) => a.length === 66);
var v4Currencies = (id) => {
  const p = ours.get(lc2(id));
  if (!p) return null;
  const n = (t) => p.v4?.native && lc2(t) === WETH ? "0x0000000000000000000000000000000000000000" : lc2(t);
  return { c0: n(p.tokenA), c1: n(p.tokenB) };
};
var feedSeen = /* @__PURE__ */ new Map();
var lastChange = /* @__PURE__ */ new Map();
var txs = /* @__PURE__ */ new Map();
var headSeen = /* @__PURE__ */ new Map();
var signMs = [];
var sendRttMs = [];
var c = { feedFrames: 0, swapReportsAccepted: 0, reportsNotOurPools: 0, txsOnOurPools: 0, candidates: 0, receiptsRead: 0, receiptErrors: 0, droppedBusy: 0, arbs: 0, wsErrors: 0, feedErrors: 0 };
var arbsFile = (0, import_path2.join)(OUT, "arbs.jsonl");
(0, import_fs2.writeFileSync)(arbsFile, "");
var rows = [];
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var later = (a, b) => a.block > b.block || a.block === b.block && a.txIndex > b.txIndex;
var last = 0;
var rid = 0;
var requests = 0;
async function rpc(method, params) {
  const w = last + 1e3 / RPS - Date.now();
  if (w > 0) await sleep(w);
  last = Date.now();
  requests++;
  try {
    const r = await fetch(HTTP, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }), signal: AbortSignal.timeout(1e4) });
    return await r.json();
  } catch {
    return { error: { message: "network" } };
  }
}
var queue = [];
async function receiptWorker() {
  for (; ; ) {
    const t = queue.shift();
    if (!t) {
      await sleep(100);
      continue;
    }
    let r = null, tx = null;
    for (let a = 0; a < 3 && !(r?.result && tx?.result); a++) {
      [r, tx] = [await rpc("eth_getTransactionReceipt", [t.hash]), await rpc("eth_getTransactionByHash", [t.hash])];
      if (!(r?.result && tx?.result)) await sleep(500);
    }
    if (!r?.result || !tx?.result) {
      c.receiptErrors++;
      continue;
    }
    c.receiptsRead++;
    const g = receiptGasWei(r.result);
    const cl = classifyTx(
      r.result.logs,
      tx.result.from,
      tx.result.to,
      r.result.status,
      { hash: t.hash, block: t.block, txIndex: t.txIndex, gasWei: g.gasWei, l1GasUsed: g.l1GasUsed },
      { weth: WETH, poolManager: RH_POOL_MANAGER, v4Currencies }
    );
    if (!cl.arb) continue;
    c.arbs++;
    const feedMs = feedSeen.get(t.hash) ?? null;
    const p = t.prev;
    const gapBlocks = p ? t.block - p.block : null;
    const bucket = gapBlocks === null ? "none seen" : gapBlocks === 0 ? "same block" : gapBlocks === 1 ? "1 block" : gapBlocks <= 4 ? "2-4 blocks" : gapBlocks <= 40 ? "5-40 blocks (1-10 s)" : ">40 blocks";
    const row = {
      hash: t.hash,
      block: t.block,
      txIndex: t.txIndex,
      by: lc2(tx.result.to),
      pools: [...t.pools],
      bucket,
      gapBlocks,
      rivalFeedMs: feedMs,
      rivalReportMs: t.reportMs,
      prevHash: p?.hash ?? null,
      prevBlock: p?.block ?? null,
      prevReportMs: p?.reportMs ?? null,
      prevFeedMs: p ? feedSeen.get(p.hash) ?? null : null,
      // headroom: time between the gap's last change reaching us and the rival showing up
      headroomFromReportMs: feedMs !== null && p ? feedMs - p.reportMs : null,
      headroomFromFeedMs: feedMs !== null && p && feedSeen.has(p.hash) ? feedMs - feedSeen.get(p.hash) : null
    };
    rows.push(row);
    (0, import_fs2.appendFileSync)(arbsFile, JSON.stringify(row) + "\n");
  }
}
var throwaway = import_ethers4.ethers.Wallet.createRandom();
async function measureSelf() {
  const data = import_ethers4.ethers.hexlify(import_ethers4.ethers.randomBytes(800));
  let nonce = 0;
  for (; ; ) {
    const t0 = import_perf_hooks2.performance.now();
    await throwaway.signTransaction({ type: 2, chainId: 4663, nonce: nonce++, to: "0x7e0f847dd429e7c15ab08686d28710389c1f7837", data, gasLimit: 15e5, maxFeePerGas: 10n ** 8n, maxPriorityFeePerGas: 0n });
    signMs.push(import_perf_hooks2.performance.now() - t0);
    const t1 = import_perf_hooks2.performance.now();
    try {
      await fetch(SEND, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(5e3) });
      sendRttMs.push(import_perf_hooks2.performance.now() - t1);
    } catch {
    }
    await sleep(5e3);
  }
}
function pct(v, p) {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2);
}
function main() {
  console.log(`pools we trade: ${addrs.length} contracts + ${ids.length} V4 pools; running ${MINUTES} min; engine ${ENGINE_MS} ms`);
  const openFeed = () => {
    const ws = new import_ws.default(FEED_URL);
    ws.on("message", (d) => {
      const now = Date.now();
      c.feedFrames++;
      try {
        for (const t2 of parseFeedFrame(JSON.parse(d.toString()))) if (t2.hash && !feedSeen.has(lc2(t2.hash))) feedSeen.set(lc2(t2.hash), now);
      } catch {
        c.feedErrors++;
      }
    });
    ws.on("close", () => setTimeout(openFeed, 2e3));
    ws.on("error", () => {
      c.feedErrors++;
    });
  };
  openFeed();
  const addrSet = new Set(addrs), idSet = new Set(ids);
  const openPush = () => {
    const ws = new import_ws.default(WSS);
    let sid = 0;
    ws.on("open", () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: ++sid, method: "eth_subscribe", params: ["newHeads"] }));
      for (let i = 0; i < addrs.length; i += 200) ws.send(JSON.stringify({ jsonrpc: "2.0", id: ++sid, method: "eth_subscribe", params: ["logs", { address: addrs.slice(i, i + 200) }] }));
      for (let i = 0; i < ids.length; i += 100) ws.send(JSON.stringify({ jsonrpc: "2.0", id: ++sid, method: "eth_subscribe", params: ["logs", { address: RH_POOL_MANAGER, topics: [null, ids.slice(i, i + 100)] }] }));
    });
    ws.on("message", (d) => {
      const now = Date.now();
      try {
        const m = JSON.parse(d.toString());
        const r = m?.params?.result;
        if (!r) return;
        if (r.parentHash && r.number && !r.transactionHash) {
          const n = parseInt(r.number, 16);
          if (!headSeen.has(n)) headSeen.set(n, now);
          return;
        }
        const s = r.transactionHash ? decodeSwapLog(r) : null;
        if (!s) return;
        const pool = lc2(s.pool);
        const isOurs = lc2(r.address) === RH_POOL_MANAGER ? idSet.has(pool) : addrSet.has(lc2(r.address)) && addrSet.has(pool);
        if (!isOurs) {
          c.reportsNotOurPools++;
          return;
        }
        if (r.removed) return;
        c.swapReportsAccepted++;
        const hash = lc2(r.transactionHash), block = parseInt(r.blockNumber, 16), txIndex = parseInt(r.transactionIndex, 16);
        let t2 = txs.get(hash);
        if (!t2) {
          t2 = { hash, block, txIndex, pools: /* @__PURE__ */ new Set(), swaps: 0, reportMs: now, prev: null, queued: false };
          txs.set(hash, t2);
          c.txsOnOurPools++;
        }
        const lc0 = lastChange.get(pool);
        if (lc0 && lc0.hash !== hash && later(t2, lc0) && (!t2.prev || later(lc0, t2.prev))) t2.prev = lc0;
        t2.pools.add(pool);
        t2.swaps++;
        const cur = lastChange.get(pool);
        if (!cur || later(t2, cur)) lastChange.set(pool, { hash, block, txIndex, reportMs: t2.reportMs });
        if (t2.swaps === 2 && !t2.queued) {
          t2.queued = true;
          c.candidates++;
          if (queue.length > 300) c.droppedBusy++;
          else setTimeout(() => queue.push(t2), 300);
        }
      } catch {
        c.wsErrors++;
      }
    });
    ws.on("close", () => setTimeout(openPush, 2e3));
    ws.on("error", () => {
      c.wsErrors++;
    });
  };
  openPush();
  receiptWorker();
  measureSelf();
  setInterval(() => {
    const cut = Date.now() - 5 * 6e4;
    for (const [h, t2] of feedSeen) if (t2 < cut) feedSeen.delete(h);
    else break;
    for (const [h, t2] of txs) if (t2.reportMs < cut) txs.delete(h);
    else break;
  }, 6e4);
  const summary = () => {
    const signP50 = pct(signMs, 0.5) ?? 0, oneWay = (pct(sendRttMs, 0.5) ?? 0) / 2;
    const needMs = +(ENGINE_MS + signP50 + oneWay).toFixed(2);
    const byBucket = {};
    for (const r of rows) {
      const b = byBucket[r.bucket] ?? (byBucket[r.bucket] = { arbs: 0, timed: 0, inTime: 0, headroomMs: [] });
      b.arbs++;
      if (r.headroomFromReportMs !== null) {
        b.timed++;
        b.headroomMs.push(r.headroomFromReportMs);
        if (r.headroomFromReportMs > needMs) b.inTime++;
      }
    }
    const buckets = Object.fromEntries(Object.entries(byBucket).map(([k, b]) => [k, { arbs: b.arbs, timed: b.timed, inTime: b.inTime, pctInTime: b.timed ? +(100 * b.inTime / b.timed).toFixed(1) : null, headroomMs_median: pct(b.headroomMs, 0.5), headroomMs_p10: pct(b.headroomMs, 0.1) }]));
    const timed = rows.filter((r) => r.headroomFromReportMs !== null);
    const minutesRun = (Date.now() - started) / 6e4;
    return {
      minutes: +minutesRun.toFixed(1),
      ...c,
      txsOnOurPoolsPerSec: +(c.txsOnOurPools / (minutesRun * 60)).toFixed(2),
      ourTime: { engineMs_assumed: ENGINE_MS, signMs_median: signP50, signMs_p99: pct(signMs, 0.99), sendRoundTripMs_median: pct(sendRttMs, 0.5), sendRoundTripMs_p90: pct(sendRttMs, 0.9), totalNeedMs: needMs },
      arbsTimed: timed.length,
      arbsInTime: timed.filter((r) => r.headroomFromReportMs > needMs).length,
      pctInTime: timed.length ? +(100 * timed.filter((r) => r.headroomFromReportMs > needMs).length / timed.length).toFixed(1) : null,
      byGapAge: buckets,
      nodeRequestsUsed: requests
    };
  };
  const started = Date.now();
  const t = setInterval(() => console.log((/* @__PURE__ */ new Date()).toISOString().slice(11, 19), JSON.stringify(summary())), 6e4);
  setTimeout(async () => {
    clearInterval(t);
    await sleep(5e3);
    const s = summary();
    (0, import_fs2.writeFileSync)((0, import_path2.join)(OUT, "reaction.json"), JSON.stringify(s, null, 1));
    console.log("SUMMARY " + JSON.stringify(s));
    process.exit(0);
  }, MINUTES * 6e4);
}
main();
