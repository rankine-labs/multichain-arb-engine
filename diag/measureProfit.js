// scripts/sim-compare/measureProfit.ts
var import_fs3 = require("fs");
var import_path3 = require("path");
var import_ethers5 = require("ethers");

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

// src/core/followMoney.ts
var import_ethers2 = require("ethers");

// src/core/rivalWatch.ts
var import_ethers = require("ethers");
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
  const c = import_perf_hooks.constants;
  if (kind === c.NODE_PERFORMANCE_GC_MAJOR) return "major";
  if (kind === c.NODE_PERFORMANCE_GC_MINOR) return "minor";
  if (kind === c.NODE_PERFORMANCE_GC_INCREMENTAL) return "incremental";
  if (kind === c.NODE_PERFORMANCE_GC_WEAKCB) return "weak-callback";
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
      const c = causes.get(name) ?? { n: 0, maxMs: 0 };
      c.n++;
      if (ms > c.maxMs) c.maxMs = ms;
      causes.set(name, c);
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
    const list = [...causes.entries()].map(([name, c]) => ({ name, n: c.n, maxMs: c.maxMs })).sort((a, b) => b.n * b.maxMs - a.n * a.maxMs || b.maxMs - a.maxMs);
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
var TRANSFER = import_ethers.ethers.id("Transfer(address,address,uint256)");
var WETH_DEPOSIT = import_ethers.ethers.id("Deposit(address,uint256)");
var WETH_WITHDRAWAL = import_ethers.ethers.id("Withdrawal(address,uint256)");
var V4_SWAP = import_ethers.ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
var SWAP_TOPICS = /* @__PURE__ */ new Set([
  import_ethers.ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)"),
  // V2 / Solidly
  import_ethers.ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)"),
  // V3
  import_ethers.ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)"),
  // PancakeSwap V3
  V4_SWAP
  // Uniswap V4
]);
var FLASH_TOPICS = /* @__PURE__ */ new Set([
  import_ethers.ethers.id("Flash(address,address,uint256,uint256,uint256,uint256)"),
  // Uniswap/Pancake V3 flash
  import_ethers.ethers.id("FlashLoan(address,address,address,uint256,uint8,uint256,uint16)"),
  // Aave V3
  import_ethers.ethers.id("FlashLoan(address,address,uint256,uint256)")
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
  const byPair = /* @__PURE__ */ new Map();
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
      const p = byPair.get(r.pair) ?? { n: 0, usd: 0 };
      p.n++;
      p.usd += net;
      byPair.set(r.pair, p);
    }
  }
  out.netUsd = out.grossUsd - out.gasConfirmedUsd - out.gasFailedUsd;
  out.netWorstUsd = out.netUsd - out.gasUnknownUsd;
  out.medianSizeUsd = median(sizes);
  out.medianWinUsd = median(wins);
  out.medianGasUsd = median(gases);
  out.byPair = [...byPair.entries()].sort((a, b) => b[1].usd - a[1].usd).map(([p, e]) => [p, e.n, e.usd]);
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
    const pools2 = /* @__PURE__ */ new Set();
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
          pools2.add(id);
          v4Pools.add(id);
        } else pools2.add(l.address.toLowerCase());
      }
    }
    const external = [...sentTo].filter((a) => !pools2.has(a) && a !== pm);
    return { bot, net, outflow, pools: [...pools2], v4Pools: [...v4Pools], flash, wrapped, external };
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
      const rows = JSON.parse((0, import_fs.readFileSync)(recsFile, "utf8"));
      if (Array.isArray(rows)) {
        this.recs = rows.filter((r) => r && r.t >= cutoff).slice(-MAX_RECS).map((r) => this.compact(r));
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
    const write = (file, rows) => {
      let fd = null;
      try {
        (0, import_fs.mkdirSync)((0, import_path.dirname)(file), { recursive: true });
        fd = (0, import_fs.openSync)(file + ".tmp", "w");
        (0, import_fs.writeSync)(fd, "[");
        for (let i = 0; i < rows.length; i += SAVE_CHUNK) {
          const part = rows.slice(i, i + SAVE_CHUNK).map((r) => JSON.stringify(r)).join(",");
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
  V2_SWAP: import_ethers2.ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)"),
  // Solidly / Velodrome V2 style pairs (sender and recipient first)
  SOLIDLY_SWAP: import_ethers2.ethers.id("Swap(address,address,uint256,uint256,uint256,uint256)"),
  // Uniswap V3 copies, Ramses V3, SushiSwap V3, Algebra V1, Slipstream
  V3_SWAP: import_ethers2.ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)"),
  // PancakeSwap V3 copies (two extra protocol fee fields)
  PANCAKE_V3_SWAP: import_ethers2.ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)"),
  // Algebra Integral copies (Alandale, KittenSwap)
  ALGEBRA_SWAP: import_ethers2.ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24,uint24,uint24)"),
  // Uniswap V4 PoolManager (pool id instead of a pool address; Fables too)
  V4_SWAP: import_ethers2.ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"),
  // Trader Joe Liquidity Book / DLMM bins (Ramses DLMM style)
  LB_SWAP: import_ethers2.ethers.id("Swap(address,address,uint24,bytes32,bytes32,uint24,bytes32,bytes32)"),
  // Balancer V2 vault
  BALANCER_SWAP: import_ethers2.ethers.id("Swap(bytes32,address,address,uint256,uint256)"),
  // Curve pools (amounts need extra look-ups, so only counted)
  CURVE_EXCHANGE: import_ethers2.ethers.id("TokenExchange(address,int128,uint256,int128,uint256)")
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
var TRANSFER2 = import_ethers2.ethers.id("Transfer(address,address,uint256)");
var EXTRA_FLASH_TOPICS = /* @__PURE__ */ new Set([
  import_ethers2.ethers.id("FlashLoan(address,address,uint256)"),
  // Morpho Blue
  import_ethers2.ethers.id("FlashLoan(address,address,uint256,uint256,uint256)")
  // Euler style
]);
var V4_INITIALIZE = import_ethers2.ethers.id("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
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
function borrowRepay(logs, traders, pools2) {
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
    if (!traders.has(from) && traders.has(to) && !pools2.has(from) && from !== ZERO_ADDR) {
      const k = tok + "|" + from;
      lent.set(k, (lent.get(k) ?? 0n) + v);
    } else if (traders.has(from) && !traders.has(to) && !pools2.has(to)) {
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
  const pools2 = [];
  for (const s of swaps) if (!pools2.includes(s.pool)) pools2.push(s.pool);
  if (pools2.length < 2) return { reason: "one-pool", arb: null };
  const poolSet = new Set(pools2);
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
    for (const [c, d] of legs) {
      if (c !== ZERO_ADDR) continue;
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
  const hops = pools2.map((p) => {
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
    pools: pools2,
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
function obsFromSwap(block, pool, t0, t1, a0, a1, dec0, dec1, isQuote) {
  if (a0 === 0n || a1 === 0n || a0 > 0n === a1 > 0n) return [];
  const x0 = Number(abs(a0)) / 10 ** dec0, x1 = Number(abs(a1)) / 10 ** dec1;
  if (!(x0 > 0) || !(x1 > 0) || !isFinite(x0) || !isFinite(x1)) return [];
  const out = [];
  if (isQuote(t1)) out.push({ block, pool, token: lc(t0), quote: lc(t1), rate: x1 / x0, quoteAmt: x1 });
  if (isQuote(t0)) out.push({ block, pool, token: lc(t1), quote: lc(t0), rate: x0 / x1, quoteAmt: x0 });
  return out;
}
function nearestMedian(series, block, k) {
  if (!series.length) return null;
  let lo = 0, hi = series.length;
  while (lo < hi) {
    const mid = lo + hi >> 1;
    if (series[mid].block < block) lo = mid + 1;
    else hi = mid;
  }
  let l = lo - 1, r = lo;
  const pick = [];
  while (pick.length < k && (l >= 0 || r < series.length)) {
    const dl = l >= 0 ? block - series[l].block : Infinity;
    const dr = r < series.length ? series[r].block - block : Infinity;
    if (dl <= dr) pick.push(series[l--].usd);
    else pick.push(series[r++].usd);
  }
  pick.sort((a, b) => a - b);
  return pick[Math.floor(pick.length / 2)] ?? null;
}
function buildPriceBook(obs, stables, weth, opts = {}) {
  const k = opts.k ?? 7;
  const W = weth.toLowerCase();
  const st = new Set([...stables].map(lc));
  const ethSeries = obs.filter((o) => o.token === W && st.has(o.quote)).map((o) => ({ block: o.block, usd: o.rate })).sort((a, b) => a.block - b.block);
  const fallback = opts.ethFallbackUsd ?? null;
  const ethAt = (b) => nearestMedian(ethSeries, b, k) ?? fallback;
  const quoteUsd = (q, b) => st.has(q) ? 1 : q === W ? ethAt(b) : null;
  const per = /* @__PURE__ */ new Map();
  for (const o of obs) {
    if (st.has(o.token) || o.token === W) continue;
    const qp = quoteUsd(o.quote, o.block);
    if (qp === null) continue;
    const m = per.get(o.token) ?? /* @__PURE__ */ new Map();
    const e = m.get(o.pool) ?? { series: [], vol: 0 };
    e.series.push({ block: o.block, usd: o.rate * qp });
    e.vol += o.quoteAmt * qp;
    m.set(o.pool, e);
    per.set(o.token, m);
  }
  const main2 = /* @__PURE__ */ new Map();
  for (const [t, m] of per) {
    let best = null;
    for (const [pool, e] of m) if (!best || e.vol > best.vol) best = { pool, ...e };
    if (best) {
      best.series.sort((a, b) => a.block - b.block);
      main2.set(t, best);
    }
  }
  const ethVol = obs.filter((o) => o.token === W && st.has(o.quote)).reduce((s, o) => s + o.quoteAmt, 0);
  return {
    ethAt,
    usdAt(token, block) {
      const t = lc(token);
      if (st.has(t)) return { usd: 1, how: "stable", volumeUsd: Infinity };
      if (t === W) {
        const e = ethAt(block);
        return e === null ? null : { usd: e, how: ethSeries.length ? "pool" : "fixed", volumeUsd: ethSeries.length ? ethVol : Infinity };
      }
      const m = main2.get(t);
      if (!m) return null;
      const u = nearestMedian(m.series, block, k);
      return u === null ? null : { usd: u, how: "pool", pool: m.pool, volumeUsd: m.vol };
    },
    priced: () => [...st, ...ethSeries.length || fallback ? [W] : [], ...main2.keys()]
  };
}
function usdOf(ctx, token, raw, block) {
  const d = ctx.decimals(token);
  const p = ctx.book.usdAt(token, block);
  if (d === null || d === void 0 || !p) return null;
  return { usd: Number(raw) / 10 ** d * p.usd, thin: false, volumeUsd: p.volumeUsd };
}
function priceArb(rec, ctx) {
  const thinV = ctx.thinVolumeUsd ?? 1e3;
  const doubtWhy = [];
  const localUsd = (token) => {
    for (const h of rec.hops) {
      if (!h.tin || !h.tout || !h.ain || !h.aout) continue;
      const other = h.tin === token ? h.tout : h.tout === token ? h.tin : null;
      if (!other) continue;
      const amtT = BigInt(h.tin === token ? h.ain : h.aout), amtO = BigInt(h.tin === token ? h.aout : h.ain);
      const u = usdOf(ctx, other, amtO, rec.block);
      const d = ctx.decimals(token);
      if (u && d !== null && amtT > 0n) return u.usd / (Number(amtT) / 10 ** d);
    }
    return null;
  };
  const value = (token, raw) => {
    const u = usdOf(ctx, token, raw, rec.block);
    if (u) {
      if (u.volumeUsd < thinV && !doubtWhy.includes("thin-price")) doubtWhy.push("thin-price");
      return u.usd;
    }
    const per = localUsd(token);
    const d = ctx.decimals(token);
    if (per !== null && d !== null) {
      if (!doubtWhy.includes("same-trade-price")) doubtWhy.push("same-trade-price");
      return Number(raw) / 10 ** d * per;
    }
    return null;
  };
  let gross = 0, unpriced = false;
  for (const [t, v] of rec.net) {
    const u = value(t, BigInt(v));
    if (u === null) unpriced = true;
    else gross += u;
  }
  let size = null;
  const h0 = rec.hops[0];
  if (h0?.tin && h0.ain) size = value(h0.tin, BigInt(h0.ain));
  if (size === null) for (const [t, v] of rec.outflow) {
    const u = value(t, BigInt(v));
    if (u !== null) size = Math.max(size ?? 0, u);
  }
  const eth = ctx.book.ethAt(rec.block);
  const gasUsd = eth === null ? null : Number(BigInt(rec.gasWei)) / 1e18 * eth;
  const grossUsd = unpriced || !rec.net.length ? null : gross;
  if (grossUsd !== null) {
    if (size !== null && size > 0 ? grossUsd > MAX_PLAUSIBLE_PROFIT_SHARE * size : grossUsd > MAX_PROFIT_NO_SIZE_USD) doubtWhy.push("too-good-to-be-true");
  }
  for (const u of rec.uncertain) if (u === "v4-native-leg-hidden") doubtWhy.push(u);
  const trust = grossUsd === null ? "unpriced" : doubtWhy.some((w) => w === "too-good-to-be-true" || w === "thin-price" || w === "v4-native-leg-hidden") ? "doubtful" : "ok";
  const gainers = rec.net.filter(([, v]) => BigInt(v) > 0n).map(([t]) => ctx.symbol(t));
  const profitToken = gainers.length === 1 ? gainers[0] : gainers.length ? "mixed" : "?";
  const path = [];
  for (const h of rec.hops) {
    if (!path.length) path.push(h.tin ? ctx.symbol(h.tin) : "?");
    path.push(h.tout ? ctx.symbol(h.tout) : "?");
  }
  const dexes = rec.pools.map((p) => ctx.dexOf(p));
  const watchedN = rec.pools.filter((p) => ctx.isWatched(p)).length;
  return {
    rec,
    timeMs: ctx.timeOf(rec.block),
    sizeUsd: size,
    grossUsd,
    gasUsd,
    netUsd: grossUsd === null ? null : grossUsd - (gasUsd ?? 0),
    trust,
    doubtWhy,
    profitToken,
    path: path.join(" > "),
    dexes,
    watched: watchedN === rec.pools.length ? "all" : watchedN ? "some" : "none",
    unwatchedPools: rec.pools.filter((p) => !ctx.isWatched(p)),
    supportedAll: dexes.every((d) => ctx.botCanTrade(d)),
    timing: ctx.timing(rec)
  };
}
function sizeBucket(v) {
  if (v === null) return "unknown";
  return v < 500 ? "under $500" : v < 2e3 ? "$500-2k" : v < 5e3 ? "$2k-5k" : "$5k+";
}

// src/execution/simulator.ts
var import_fs2 = require("fs");
var import_path2 = require("path");
var import_ethers4 = require("ethers");

// src/execution/arbExecutorBytecode.ts
var ARB_EXECUTOR_RUNTIME_CODE = "0x6080604052600436106101bd575f3560e01c80638da5cb5b116100f2578063c0c8eca611610092578063e30c397811610062578063e30c397814610541578063e9cbafb014610465578063f2fde38b1461056d578063fa461e33146102df575f80fd5b8063c0c8eca6146104cb578063c34c08e5146104f7578063d9caed1214610522578063de5f4ecc14610465575f80fd5b8063a1d48336116100cd578063a1d4833614610465578063a20d3f4e14610484578063b0fa7d8514610498578063bf9cbd2d146104b7575f80fd5b80638da5cb5b146103ee5780638eb596551461041a57806391dd734614610439575f80fd5b80632c8958f61161015d578063654b648711610138578063654b6487146102df57806369ff1487146103a757806379ba5097146103bb5780638da2b32d146103cf575f80fd5b80632c8958f6146102df578063330ec614146103435780633fc8cef314610356575f80fd5b80631c3c0ea8116101985780631c3c0ea8146102c057806323a69e75146102df578063260bfc99146102fe57806328a83e3614610324575f80fd5b8063041701d91461023f5780631b11d0ff146102825780631b9a91a4146102a1575f80fd5b3661023b5760075473ffffffffffffffffffffffffffffffffffffffff163314801590610202575060065473ffffffffffffffffffffffffffffffffffffffff163314155b15610239576040517fcc43410f00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b005b5f80fd5b34801561024a575f80fd5b5061026d61025936600461402a565b60016020525f908152604090205460ff1681565b60405190151581526020015b60405180910390f35b34801561028d575f80fd5b5061026d61029c366004614091565b61058c565b3480156102ac575f80fd5b506102396102bb366004614108565b61070d565b3480156102cb575f80fd5b506102396102da36600461402a565b610904565b3480156102ea575f80fd5b506102396102f9366004614132565b610a56565b348015610309575f80fd5b50610312600281565b60405160ff9091168152602001610279565b34801561032f575f80fd5b5061023961033e366004614181565b610a66565b34801561034e575f80fd5b506103125f81565b348015610361575f80fd5b506007546103829073ffffffffffffffffffffffffffffffffffffffff1681565b60405173ffffffffffffffffffffffffffffffffffffffff9091168152602001610279565b3480156103b2575f80fd5b50610312600481565b3480156103c6575f80fd5b50610239610b39565b3480156103da575f80fd5b506102396103e93660046141b8565b610c61565b3480156103f9575f80fd5b506008546103829073ffffffffffffffffffffffffffffffffffffffff1681565b348015610425575f80fd5b50610239610434366004614208565b6110f1565b348015610444575f80fd5b50610458610453366004614234565b6111cb565b60405161027991906142de565b348015610470575f80fd5b5061023961047f366004614132565b611986565b34801561048f575f80fd5b50610312600381565b3480156104a3575f80fd5b506102396104b23660046141b8565b611992565b3480156104c2575f80fd5b50610312600181565b3480156104d6575f80fd5b506006546103829073ffffffffffffffffffffffffffffffffffffffff1681565b348015610502575f80fd5b505f546103829073ffffffffffffffffffffffffffffffffffffffff1681565b34801561052d575f80fd5b5061023961053c3660046142f0565b612010565b34801561054c575f80fd5b506009546103829073ffffffffffffffffffffffffffffffffffffffff1681565b348015610578575f80fd5b5061023961058736600461402a565b612194565b6002545f9073ffffffffffffffffffffffffffffffffffffffff16331415806105cb575073ffffffffffffffffffffffffffffffffffffffff84163014155b15610602576040517ff5c6c81a00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b600354838360405161061592919061432e565b604051809103902014610654576040517ff5c6c81a00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f610661838501856144ef565b9050805f015173ffffffffffffffffffffffffffffffffffffffff168873ffffffffffffffffffffffffffffffffffffffff161415806106a5575080602001518714155b156106dc576040517ff5c6c81a00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b6106ea8160800151886122d0565b506106ff88336106fa898b61463a565b61255e565b506001979650505050505050565b60085473ffffffffffffffffffffffffffffffffffffffff16331461075e576040517f30cd747100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60055474010000000000000000000000000000000000000000900460ff16156107b3576040517fab143c0600000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b600580547fffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffff16740100000000000000000000000000000000000000001790556040515f9073ffffffffffffffffffffffffffffffffffffffff84169083908381818185875af1925050503d805f8114610847576040519150601f19603f3d011682016040523d82523d5f602084013e61084c565b606091505b5050905080610887576040517f90b8ec1800000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b8273ffffffffffffffffffffffffffffffffffffffff167f8455ae6be5d92f1df1c3c1484388e247a36c7e60d72055ae216dbc258f257d4b836040516108cf91815260200190565b60405180910390a25050600580547fffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffff16905550565b60085473ffffffffffffffffffffffffffffffffffffffff163314610955576040517f30cd747100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b73ffffffffffffffffffffffffffffffffffffffff811615801590610994575060085473ffffffffffffffffffffffffffffffffffffffff8281169116145b156109cb576040517f855b5e2100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f805460405173ffffffffffffffffffffffffffffffffffffffff808516939216917f54a57d849b9d8af1a8883dad9184e599aa67ef60814f6c91db7f864abd4325fc91a35f80547fffffffffffffffffffffffff00000000000000000000000000000000000000001673ffffffffffffffffffffffffffffffffffffffff92909216919091179055565b610a6084846126e5565b50505050565b60085473ffffffffffffffffffffffffffffffffffffffff163314610ab7576040517f30cd747100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b600680547fffffffffffffffffffffffff000000000000000000000000000000000000000090811673ffffffffffffffffffffffffffffffffffffffff858116918217909355600780549092169284169283179091556040517f327e432843adecb9facc86460c7aa2c695919d71488972aa4f741ff8f1a9286a905f90a35050565b60095473ffffffffffffffffffffffffffffffffffffffff1633141580610b5e575033155b15610b95576040517f1853971c00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f5473ffffffffffffffffffffffffffffffffffffffff163303610be5576040517f855b5e2100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b600854604051339173ffffffffffffffffffffffffffffffffffffffff16907f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0905f90a3600880547fffffffffffffffffffffffff00000000000000000000000000000000000000009081163317909155600980549091169055565b5f5473ffffffffffffffffffffffffffffffffffffffff163314610cb1576040517fc32d1d7600000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60055474010000000000000000000000000000000000000000900460ff1615610d06576040517fab143c0600000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b600580547fffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffff16740100000000000000000000000000000000000000001790556060820135610d526127f1565b1115610d8a576040517f203d82d800000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60208201351580610d9d57506040820135155b15610dd4576040517f1f2a200500000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b610ddd826128d9565b5f80610de884612c69565b909250905073ffffffffffffffffffffffffffffffffffffffff8316610e7957610e73610e18608086018661464d565b808060200260200160405190810160405280939291908181526020015f905b82821015610e6457610e5561010083028601368190038101906146b1565b81526020019060010190610e37565b505050505085602001356122d0565b50611036565b73ffffffffffffffffffffffffffffffffffffffff83165f9081526001602052604090205460ff16610ef4576040517f4460c61000000000000000000000000000000000000000000000000000000000815273ffffffffffffffffffffffffffffffffffffffff841660048201526024015b60405180910390fd5b5f84604051602001610f0691906147e0565b604080518083037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0018152919052600280547fffffffffffffffffffffffff00000000000000000000000000000000000000001673ffffffffffffffffffffffffffffffffffffffff87169081179091558151602080840191909120600355919250906342b0b77c903090610f9d9089018961402a565b8860200135855f6040518663ffffffff1660e01b8152600401610fc49594939291906148b0565b5f604051808303815f87803b158015610fdb575f80fd5b505af1158015610fed573d5f803e3d5ffd5b5050600280547fffffffffffffffffffffffff000000000000000000000000000000000000000016905550505f60035561103461102d602087018761402a565b855f61255e565b505b5f611053611047602087018761402a565b8660400135858561301a565b9050611062602086018661402a565b604080516020888101358252810184905273ffffffffffffffffffffffffffffffffffffffff878116151582840152915192909116917f7accaf7c2e75a94fdb567d7d6ab142bbdd6f439cc7d162af9b6b233dc4b5d2369181900360600190a25050600580547fffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffff169055505050565b60085473ffffffffffffffffffffffffffffffffffffffff163314611142576040517f30cd747100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b73ffffffffffffffffffffffffffffffffffffffff82165f8181526001602090815260409182902080547fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff001685151590811790915591519182527f953dd40175619d4c5fbc02d381bf596ef4597268b18bc7209130d41d84b94ef0910160405180910390a25050565b60065460609073ffffffffffffffffffffffffffffffffffffffff16331415806111f3575033155b8061121b5750600554760100000000000000000000000000000000000000000000900460ff16155b15611252576040517ff5c6c81a00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f8061126084860186614916565b6040820151606083015160e08401519395509193503392909190156113065760075473ffffffffffffffffffffffffffffffffffffffff908116908316036112aa575f9150611306565b60075473ffffffffffffffffffffffffffffffffffffffff908116908216036112d457505f611306565b6040517fc4c321d100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f8173ffffffffffffffffffffffffffffffffffffffff168373ffffffffffffffffffffffffffffffffffffffff161090505f6040518060a001604052808361134f5784611351565b855b73ffffffffffffffffffffffffffffffffffffffff168152602001836113775785611379565b845b73ffffffffffffffffffffffffffffffffffffffff16815260a089015162ffffff16602082015260c089015160020b6040820152885160609091019060ff166004146113c5575f6113cb565b88602001515b73ffffffffffffffffffffffffffffffffffffffff1681525090505f8573ffffffffffffffffffffffffffffffffffffffff1663f3cd914c83604051806060016040528087151581526020018b61142190614941565b8152602001876114455773fffd8963efd1fc6a506488495d951d5263988d2561144c565b6401000276a45b73ffffffffffffffffffffffffffffffffffffffff169052604080515f815260208101918290527fffffffff0000000000000000000000000000000000000000000000000000000060e086901b169091526114ac92919060248101614977565b6020604051808303815f875af11580156114c8573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906114ec9190614a38565b9050608081901d815f856115005781611502565b825b90505f866115105783611512565b825b90505f82600f0b12158061152957505f81600f0b13155b15611560576040517f1f2a200500000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f61156a83614a4f565b6fffffffffffffffffffffffffffffffff908116915082168c8211156115bc576040517fc4c321d100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b73ffffffffffffffffffffffffffffffffffffffff8b16611746576007546040517f2e1a7d4d0000000000000000000000000000000000000000000000000000000081526004810184905273ffffffffffffffffffffffffffffffffffffffff90911690632e1a7d4d906024015f604051808303815f87803b158015611640575f80fd5b505af1158015611652573d5f803e3d5ffd5b50506040517fa58411940000000000000000000000000000000000000000000000000000000081525f600482015273ffffffffffffffffffffffffffffffffffffffff8f16925063a584119491506024015f604051808303815f87803b1580156116ba575f80fd5b505af11580156116cc573d5f803e3d5ffd5b505050508b73ffffffffffffffffffffffffffffffffffffffff166311da60b4836040518263ffffffff1660e01b815260040160206040518083038185885af115801561171b573d5f803e3d5ffd5b50505050506040513d601f19601f820116820180604052508101906117409190614a38565b5061183d565b6040517fa584119400000000000000000000000000000000000000000000000000000000815273ffffffffffffffffffffffffffffffffffffffff8c811660048301528d169063a5841194906024015f604051808303815f87803b1580156117ac575f80fd5b505af11580156117be573d5f803e3d5ffd5b505050506117cd8b8d8461328e565b8b73ffffffffffffffffffffffffffffffffffffffff166311da60b46040518163ffffffff1660e01b81526004016020604051808303815f875af1158015611817573d5f803e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061183b9190614a38565b505b6040517f0b0d9c0900000000000000000000000000000000000000000000000000000000815273ffffffffffffffffffffffffffffffffffffffff8b81166004830152306024830152604482018390528d1690630b0d9c09906064015f604051808303815f87803b1580156118b0575f80fd5b505af11580156118c2573d5f803e3d5ffd5b50505073ffffffffffffffffffffffffffffffffffffffff8b1690506119615760075f9054906101000a900473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1663d0e30db0826040518263ffffffff1660e01b81526004015f604051808303818588803b158015611949575f80fd5b505af115801561195b573d5f803e3d5ffd5b50505050505b5050604080515f8152602081019091529c505050505050505050505050505b92915050565b610a60848484846132e6565b5f5473ffffffffffffffffffffffffffffffffffffffff1633146119e2576040517fc32d1d7600000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60055474010000000000000000000000000000000000000000900460ff1615611a37576040517fab143c0600000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b600580547fffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffff16740100000000000000000000000000000000000000001790556060820135611a836127f1565b1115611abb576040517f203d82d800000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60208201351580611ace57506040820135155b15611b05576040517f1f2a200500000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b611b0e826128d9565b73ffffffffffffffffffffffffffffffffffffffff81165f9081526001602052604090205460ff16611b84576040517f4460c61000000000000000000000000000000000000000000000000000000000815273ffffffffffffffffffffffffffffffffffffffff82166004820152602401610eeb565b5f5b611b93608084018461464d565b9050811015611c3e5773ffffffffffffffffffffffffffffffffffffffff8216611bc0608085018561464d565b83818110611bd057611bd0614a8b565b905061010002016020016020810190611be9919061402a565b73ffffffffffffffffffffffffffffffffffffffff1603611c36576040517fc4c321d100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b600101611b86565b505f611c4d602084018461402a565b73ffffffffffffffffffffffffffffffffffffffff168273ffffffffffffffffffffffffffffffffffffffff16630dfe16816040518163ffffffff1660e01b8152600401602060405180830381865afa158015611cac573d5f803e3d5ffd5b505050506040513d601f19601f82011682018060405250810190611cd09190614ab8565b73ffffffffffffffffffffffffffffffffffffffff16149050801581611d9a5750611cfe602084018461402a565b73ffffffffffffffffffffffffffffffffffffffff168273ffffffffffffffffffffffffffffffffffffffff1663d21220a76040518163ffffffff1660e01b8152600401602060405180830381865afa158015611d5d573d5f803e3d5ffd5b505050506040513d601f19601f82011682018060405250810190611d819190614ab8565b73ffffffffffffffffffffffffffffffffffffffff1614155b15611dd1576040517fc4c321d100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f80611ddc85612c69565b915091505f85604051602001611df291906147e0565b604080518083037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0018152919052600280547fffffffffffffffffffffffff00000000000000000000000000000000000000001673ffffffffffffffffffffffffffffffffffffffff881690811790915581516020830120600355600580547fffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffffff1675010000000000000000000000000000000000000000008815150217905590915063490e6cbc3086611ec5575f611ecb565b88602001355b87611eda578960200135611edc565b5f5b856040518563ffffffff1660e01b8152600401611efc9493929190614ad3565b5f604051808303815f87803b158015611f13575f80fd5b505af1158015611f25573d5f803e3d5ffd5b5050600280547fffffffffffffffffffffffff000000000000000000000000000000000000000016905550505f6003819055611f73611f67602089018961402a565b8860400135868661301a565b9050611f82602088018861402a565b6040805160208a81013582528101849052600181830152905173ffffffffffffffffffffffffffffffffffffffff92909216917f7accaf7c2e75a94fdb567d7d6ab142bbdd6f439cc7d162af9b6b233dc4b5d2369181900360600190a25050600580547fffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffff1690555050505050565b60085473ffffffffffffffffffffffffffffffffffffffff163314612061576040517f30cd747100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b60055474010000000000000000000000000000000000000000900460ff16156120b6576040517fab143c0600000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b600580547fffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffff167401000000000000000000000000000000000000000017905561210083838361328e565b8173ffffffffffffffffffffffffffffffffffffffff168373ffffffffffffffffffffffffffffffffffffffff167fd1c19fbcd4551a5edfb66d43d2e337c04837afda3482b42bdf569a8fccdae5fb8360405161215f91815260200190565b60405180910390a35050600580547fffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffff16905550565b60085473ffffffffffffffffffffffffffffffffffffffff1633146121e5576040517f30cd747100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b73ffffffffffffffffffffffffffffffffffffffff81161580159061222357505f5473ffffffffffffffffffffffffffffffffffffffff8281169116145b1561225a576040517f855b5e2100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b600980547fffffffffffffffffffffffff00000000000000000000000000000000000000001673ffffffffffffffffffffffffffffffffffffffff838116918217909255600854604051919216907f38d16b8cac22d99fc7c124b9cd0de2d3fa1faef420bfe791d8c362d765e22700905f90a350565b805f5b8351811015612557575f8482815181106122ef576122ef614a8b565b602090810291909101015160608101516040517f70a082310000000000000000000000000000000000000000000000000000000081523060048201529192505f9173ffffffffffffffffffffffffffffffffffffffff909116906370a0823190602401602060405180830381865afa15801561236d573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906123919190614a38565b825190915060ff166123ac576123a7828561340a565b612476565b815160ff167fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff016123e1576123a7828561373e565b815160ff167ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe01612416576123a78285613a7a565b815160ff166003148061242d5750815160ff166004145b1561243c576123a78285613cd7565b81516040517f68efdae800000000000000000000000000000000000000000000000000000000815260ff9091166004820152602401610eeb565b60608201516040517f70a08231000000000000000000000000000000000000000000000000000000008152306004820152829173ffffffffffffffffffffffffffffffffffffffff16906370a0823190602401602060405180830381865afa1580156124e4573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906125089190614a38565b6125129190614b17565b9350835f0361254d576040517f1f2a200500000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b50506001016122d3565b5092915050565b60405173ffffffffffffffffffffffffffffffffffffffff8381166024830152604482018390525f9182918616907f095ea7b300000000000000000000000000000000000000000000000000000000906064015b604080517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08184030181529181526020820180517bffffffffffffffffffffffffffffffffffffffffffffffffffffffff167fffffffff0000000000000000000000000000000000000000000000000000000090941693909317909252905161263b9190614b2a565b5f604051808303815f865af19150503d805f8114612674576040519150601f19603f3d011682016040523d82523d5f602084013e612679565b606091505b50915091508115806126a757508051158015906126a75750808060200190518101906126a59190614b45565b155b156126de576040517f90b8ec1800000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5050505050565b60045473ffffffffffffffffffffffffffffffffffffffff163314158061270a575033155b15612741576040517ff5c6c81a00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f80831361274f5781612751565b825b90505f811361278c576040517ff5c6c81a00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b600a548111156127c8576040517fc4c321d100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b6005546127ec9073ffffffffffffffffffffffffffffffffffffffff16338361328e565b505050565b60408051600481526024810182526020810180517bffffffffffffffffffffffffffffffffffffffffffffffffffffffff167fa3b1b31d0000000000000000000000000000000000000000000000000000000017905290515f9182918291606491614e209161285f91614b2a565b5f604051808303818686fa925050503d805f8114612898576040519150601f19603f3d011682016040523d82523d5f602084013e61289d565b606091505b50915091508180156128b157506020815110155b156128d157808060200190518101906128ca9190614a38565b9250505090565b439250505090565b5f6128e7608083018361464d565b9150506002811015612925576040517fc4c321d100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b612932602083018361402a565b73ffffffffffffffffffffffffffffffffffffffff16612955608084018461464d565b5f81811061296557612965614a8b565b90506101000201604001602081019061297e919061402a565b73ffffffffffffffffffffffffffffffffffffffff16141580612a1857506129a9602083018361402a565b73ffffffffffffffffffffffffffffffffffffffff166129cc608084018461464d565b6129d7600185614b17565b8181106129e6576129e6614a8b565b9050610100020160600160208101906129ff919061402a565b73ffffffffffffffffffffffffffffffffffffffff1614155b15612a4f576040517fc4c321d100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f5b818110156127ec5736612a67608085018561464d565b83818110612a7757612a77614a8b565b610100029190910191505f9050612a94604083016020840161402a565b73ffffffffffffffffffffffffffffffffffffffff161480612aff5750612ac1608082016060830161402a565b73ffffffffffffffffffffffffffffffffffffffff16612ae7606083016040840161402a565b73ffffffffffffffffffffffffffffffffffffffff16145b15612b36576040517fc4c321d100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f82118015612bbf5750612b50606082016040830161402a565b73ffffffffffffffffffffffffffffffffffffffff16612b73608086018661464d565b612b7e600186614b17565b818110612b8d57612b8d614a8b565b905061010002016060016020810190612ba6919061402a565b73ffffffffffffffffffffffffffffffffffffffff1614155b15612bf6576040517fc4c321d100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f612c046020830183614b60565b60ff16148015612c295750612710612c2260a0830160808401614b79565b61ffff1610155b15612c60576040517fc4c321d100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b50600101612a51565b6060805f612c7a608085018561464d565b91505f9050612c8a82600161463a565b67ffffffffffffffff811115612ca257612ca261433d565b604051908082528060200260200182016040528015612ccb578160200160208202803683370190505b5090505f612cdc602087018761402a565b8282612ce781614b92565b935081518110612cf957612cf9614a8b565b602002602001019073ffffffffffffffffffffffffffffffffffffffff16908173ffffffffffffffffffffffffffffffffffffffff16815250505f5b83811015612e47575f612d4b608089018961464d565b83818110612d5b57612d5b614a8b565b905061010002016060016020810190612d74919061402a565b90505f805b84811015612dde578273ffffffffffffffffffffffffffffffffffffffff16868281518110612daa57612daa614a8b565b602002602001015173ffffffffffffffffffffffffffffffffffffffff1603612dd65760019150612dde565b600101612d79565b5080612e3d57818585612df081614b92565b965081518110612e0257612e02614a8b565b602002602001019073ffffffffffffffffffffffffffffffffffffffff16908173ffffffffffffffffffffffffffffffffffffffff16815250505b5050600101612d35565b508067ffffffffffffffff811115612e6157612e6161433d565b604051908082528060200260200182016040528015612e8a578160200160208202803683370190505b5094508067ffffffffffffffff811115612ea657612ea661433d565b604051908082528060200260200182016040528015612ecf578160200160208202803683370190505b5093505f5b8181101561301157828181518110612eee57612eee614a8b565b6020026020010151868281518110612f0857612f08614a8b565b602002602001019073ffffffffffffffffffffffffffffffffffffffff16908173ffffffffffffffffffffffffffffffffffffffff1681525050828181518110612f5457612f54614a8b565b60209081029190910101516040517f70a0823100000000000000000000000000000000000000000000000000000000815230600482015273ffffffffffffffffffffffffffffffffffffffff909116906370a0823190602401602060405180830381865afa158015612fc8573d5f803e3d5ffd5b505050506040513d601f19601f82011682018060405250810190612fec9190614a38565b858281518110612ffe57612ffe614a8b565b6020908102919091010152600101612ed4565b50505050915091565b6040517f70a082310000000000000000000000000000000000000000000000000000000081523060048201525f90819073ffffffffffffffffffffffffffffffffffffffff8716906370a0823190602401602060405180830381865afa158015613086573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906130aa9190614a38565b9050825f815181106130be576130be614a8b565b602002602001015181116130d2575f6130f7565b825f815181106130e4576130e4614a8b565b6020026020010151816130f79190614b17565b91508482101561313d576040517f4e88422a0000000000000000000000000000000000000000000000000000000081526004810183905260248101869052604401610eeb565b60015b84518110156132845783818151811061315b5761315b614a8b565b602002602001015185828151811061317557613175614a8b565b60209081029190910101516040517f70a0823100000000000000000000000000000000000000000000000000000000815230600482015273ffffffffffffffffffffffffffffffffffffffff909116906370a0823190602401602060405180830381865afa1580156131e9573d5f803e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061320d9190614a38565b101561327c5784818151811061322557613225614a8b565b60200260200101516040517f6e2d3a4f000000000000000000000000000000000000000000000000000000008152600401610eeb919073ffffffffffffffffffffffffffffffffffffffff91909116815260200190565b600101613140565b5050949350505050565b60405173ffffffffffffffffffffffffffffffffffffffff8381166024830152604482018390525f9182918616907fa9059cbb00000000000000000000000000000000000000000000000000000000906064016125b2565b60025473ffffffffffffffffffffffffffffffffffffffff163314158061330b575033155b15613342576040517ff5c6c81a00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b600354828260405161335592919061432e565b604051809103902014613394576040517ff5c6c81a00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5f6133a1828401846144ef565b90506133b5816080015182602001516122d0565b506005545f907501000000000000000000000000000000000000000000900460ff166133e157846133e3565b855b9050613402825f0151338385602001516133fd919061463a565b61328e565b505050505050565b5f826020015190505f836040015173ffffffffffffffffffffffffffffffffffffffff168273ffffffffffffffffffffffffffffffffffffffff16630dfe16816040518163ffffffff1660e01b8152600401602060405180830381865afa158015613477573d5f803e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061349b9190614ab8565b73ffffffffffffffffffffffffffffffffffffffff161490505f808373ffffffffffffffffffffffffffffffffffffffff16630902f1ac6040518163ffffffff1660e01b8152600401606060405180830381865afa1580156134ff573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906135239190614be6565b50915091505f808461355657826dffffffffffffffffffffffffffff16846dffffffffffffffffffffffffffff16613579565b836dffffffffffffffffffffffffffff16836dffffffffffffffffffffffffffff165b91509150613590886040015189602001518961328e565b60408089015160208a015191517f70a0823100000000000000000000000000000000000000000000000000000000815273ffffffffffffffffffffffffffffffffffffffff92831660048201525f92859216906370a0823190602401602060405180830381865afa158015613607573d5f803e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061362b9190614a38565b6136359190614b17565b90505f896080015161271061364a9190614c32565b6136589061ffff1683614c4c565b90505f8161366886612710614c4c565b613672919061463a565b61367c8584614c4c565b6136869190614c63565b90505f808961369657825f613699565b5f835b604080515f815260208101918290527f022c0d9f00000000000000000000000000000000000000000000000000000000909152919350915073ffffffffffffffffffffffffffffffffffffffff8c169063022c0d9f906137029085908590309060248101614c9b565b5f604051808303815f87803b158015613719575f80fd5b505af115801561372b573d5f803e3d5ffd5b5050505050505050505050505050505050565b5f826020015190505f836040015173ffffffffffffffffffffffffffffffffffffffff168273ffffffffffffffffffffffffffffffffffffffff16630dfe16816040518163ffffffff1660e01b8152600401602060405180830381865afa1580156137ab573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906137cf9190614ab8565b73ffffffffffffffffffffffffffffffffffffffff161490505f808373ffffffffffffffffffffffffffffffffffffffff16630902f1ac6040518163ffffffff1660e01b8152600401606060405180830381865afa158015613833573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906138579190614cd5565b50915091505f83613868578161386a565b825b905061387f876040015188602001518861328e565b604080880151602089015191517f70a0823100000000000000000000000000000000000000000000000000000000815273ffffffffffffffffffffffffffffffffffffffff92831660048201525f92849216906370a0823190602401602060405180830381865afa1580156138f6573d5f803e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061391a9190614a38565b6139249190614b17565b6040808a015190517ff140a35a0000000000000000000000000000000000000000000000000000000081526004810183905273ffffffffffffffffffffffffffffffffffffffff91821660248201529192505f919088169063f140a35a90604401602060405180830381865afa1580156139a0573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906139c49190614a38565b90505f80876139d457825f6139d7565b5f835b604080515f815260208101918290527f022c0d9f00000000000000000000000000000000000000000000000000000000909152919350915073ffffffffffffffffffffffffffffffffffffffff8a169063022c0d9f90613a409085908590309060248101614c9b565b5f604051808303815f87803b158015613a57575f80fd5b505af1158015613a69573d5f803e3d5ffd5b505050505050505050505050505050565b5f826020015190505f836040015173ffffffffffffffffffffffffffffffffffffffff168273ffffffffffffffffffffffffffffffffffffffff16630dfe16816040518163ffffffff1660e01b8152600401602060405180830381865afa158015613ae7573d5f803e3d5ffd5b505050506040513d601f19601f82011682018060405250810190613b0b9190614ab8565b73ffffffffffffffffffffffffffffffffffffffff161490507f7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff831115613b7e576040517fc4c321d100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b6020840151600480547fffffffffffffffffffffffff000000000000000000000000000000000000000090811673ffffffffffffffffffffffffffffffffffffffff93841617909155604086015160058054909216908316179055600a849055821663128acb0830838681613c075773fffd8963efd1fc6a506488495d951d5263988d25613c0e565b6401000276a45b604080515f815260208101918290527fffffffff0000000000000000000000000000000000000000000000000000000060e088901b16909152613c58949392919060248101614d00565b60408051808303815f875af1158015613c73573d5f803e3d5ffd5b505050506040513d601f19601f82011682018060405250810190613c979190614d63565b5050600480547fffffffffffffffffffffffff000000000000000000000000000000000000000090811690915560058054909116905550505f600a555050565b60065473ffffffffffffffffffffffffffffffffffffffff16801580613d13575060075473ffffffffffffffffffffffffffffffffffffffff16155b15613d4a576040517f20d6f21e00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b825160ff167ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffd01613de3578073ffffffffffffffffffffffffffffffffffffffff16836020015173ffffffffffffffffffffffffffffffffffffffff1614613dde576040517fc4c321d100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b613e71565b8073ffffffffffffffffffffffffffffffffffffffff16836020015173ffffffffffffffffffffffffffffffffffffffff161480613e3a5750602083015173ffffffffffffffffffffffffffffffffffffffff1630145b15613e71576040517fc4c321d100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b7f7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff821115613ecb576040517fc4c321d100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b600580547fffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffffffff1676010000000000000000000000000000000000000000000017905560405173ffffffffffffffffffffffffffffffffffffffff8216906348c8949190613f3d9086908690602001614d85565b6040516020818303038152906040526040518263ffffffff1660e01b8152600401613f6891906142de565b5f604051808303815f875af1158015613f83573d5f803e3d5ffd5b505050506040513d5f823e601f3d9081017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0168201604052613fc89190810190614e60565b5050600580547fffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffffffff1690555050565b73ffffffffffffffffffffffffffffffffffffffff81168114614017575f80fd5b50565b803561402581613ff6565b919050565b5f6020828403121561403a575f80fd5b813561404581613ff6565b9392505050565b5f8083601f84011261405c575f80fd5b50813567ffffffffffffffff811115614073575f80fd5b60208301915083602082850101111561408a575f80fd5b9250929050565b5f805f805f8060a087890312156140a6575f80fd5b86356140b181613ff6565b9550602087013594506040870135935060608701356140cf81613ff6565b9250608087013567ffffffffffffffff8111156140ea575f80fd5b6140f689828a0161404c565b979a9699509497509295939492505050565b5f8060408385031215614119575f80fd5b823561412481613ff6565b946020939093013593505050565b5f805f8060608587031215614145575f80fd5b8435935060208501359250604085013567ffffffffffffffff811115614169575f80fd5b6141758782880161404c565b95989497509550505050565b5f8060408385031215614192575f80fd5b823561419d81613ff6565b915060208301356141ad81613ff6565b809150509250929050565b5f80604083850312156141c9575f80fd5b823567ffffffffffffffff8111156141df575f80fd5b830160a0818603121561419d575f80fd5b8015158114614017575f80fd5b8035614025816141f0565b5f8060408385031215614219575f80fd5b823561422481613ff6565b915060208301356141ad816141f0565b5f8060208385031215614245575f80fd5b823567ffffffffffffffff81111561425b575f80fd5b6142678582860161404c565b90969095509350505050565b5f5b8381101561428d578181015183820152602001614275565b50505f910152565b5f81518084526142ac816020860160208601614273565b601f017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0169290920160200192915050565b602081525f6140456020830184614295565b5f805f60608486031215614302575f80fd5b833561430d81613ff6565b9250602084013561431d81613ff6565b929592945050506040919091013590565b818382375f9101908152919050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52604160045260245ffd5b604051610100810167ffffffffffffffff8111828210171561438e5761438e61433d565b60405290565b60405160a0810167ffffffffffffffff8111828210171561438e5761438e61433d565b604051601f82017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe016810167ffffffffffffffff811182821017156143fe576143fe61433d565b604052919050565b803560ff81168114614025575f80fd5b803561ffff81168114614025575f80fd5b803562ffffff81168114614025575f80fd5b8035600281900b8114614025575f80fd5b5f610100828403121561445b575f80fd5b61446361436a565b905061446e82614406565b8152602082013561447e81613ff6565b602082015261448f6040830161401a565b60408201526144a06060830161401a565b60608201526144b160808301614416565b60808201526144c260a08301614427565b60a08201526144d360c08301614439565b60c08201526144e460e083016141fd565b60e082015292915050565b5f602082840312156144ff575f80fd5b813567ffffffffffffffff811115614515575f80fd5b820160a08185031215614526575f80fd5b61452e614394565b813561453981613ff6565b8152602082810135908201526040808301359082015260608083013590820152608082013567ffffffffffffffff811115614572575f80fd5b80830192505084601f830112614586575f80fd5b813567ffffffffffffffff8111156145a0576145a061433d565b6145af60208260051b016143b7565b8082825260208201915060208360081b8601019250878311156145d0575f80fd5b6020850194505b828510156145fd576145e9888661444a565b8252602082019150610100850194506145d7565b6080840152509095945050505050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52601160045260245ffd5b808201808211156119805761198061460d565b5f8083357fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe1843603018112614680575f80fd5b83018035915067ffffffffffffffff82111561469a575f80fd5b6020019150600881901b360382131561408a575f80fd5b5f61010082840312156146c2575f80fd5b614045838361444a565b8183526020830192505f815f5b848110156147d65760ff6146ec83614406565b16865260208201356146fd81613ff6565b73ffffffffffffffffffffffffffffffffffffffff166020870152604082013561472681613ff6565b73ffffffffffffffffffffffffffffffffffffffff16604087015261474d6060830161401a565b73ffffffffffffffffffffffffffffffffffffffff16606087015261477460808301614416565b61ffff16608087015261478960a08301614427565b62ffffff1660a087015261479f60c08301614439565b6147ae60c088018260020b9052565b506147bb60e083016141fd565b151560e08701526101009586019591909101906001016146d9565b5093949350505050565b602081525f82356147f081613ff6565b73ffffffffffffffffffffffffffffffffffffffff16602083810191909152830135604080840191909152830135606080840191909152830135608080840191909152830135368490037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe1018112614866575f80fd5b830160208101903567ffffffffffffffff811115614882575f80fd5b8060081b3603821315614893575f80fd5b60a0808501526148a760c0850182846146cc565b95945050505050565b73ffffffffffffffffffffffffffffffffffffffff8616815273ffffffffffffffffffffffffffffffffffffffff8516602082015283604082015260a060608201525f61490060a0830185614295565b905061ffff831660808301529695505050505050565b5f806101208385031215614928575f80fd5b614932848461444a565b94610100939093013593505050565b5f7f800000000000000000000000000000000000000000000000000000000000000082036149715761497161460d565b505f0390565b73ffffffffffffffffffffffffffffffffffffffff845116815273ffffffffffffffffffffffffffffffffffffffff602085015116602082015262ffffff6040850151166040820152606084015160020b606082015273ffffffffffffffffffffffffffffffffffffffff60808501511660808201528251151560a0820152602083015160c082015273ffffffffffffffffffffffffffffffffffffffff60408401511660e08201526101206101008201525f6148a7610120830184614295565b5f60208284031215614a48575f80fd5b5051919050565b5f81600f0b7fffffffffffffffffffffffffffffffff800000000000000000000000000000008103614a8357614a8361460d565b5f0392915050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52603260045260245ffd5b5f60208284031215614ac8575f80fd5b815161404581613ff6565b73ffffffffffffffffffffffffffffffffffffffff85168152836020820152826040820152608060608201525f614b0d6080830184614295565b9695505050505050565b818103818111156119805761198061460d565b5f8251614b3b818460208701614273565b9190910192915050565b5f60208284031215614b55575f80fd5b8151614045816141f0565b5f60208284031215614b70575f80fd5b61404582614406565b5f60208284031215614b89575f80fd5b61404582614416565b5f7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8203614bc257614bc261460d565b5060010190565b80516dffffffffffffffffffffffffffff81168114614025575f80fd5b5f805f60608486031215614bf8575f80fd5b614c0184614bc9565b9250614c0f60208501614bc9565b9150604084015163ffffffff81168114614c27575f80fd5b809150509250925092565b61ffff82811682821603908111156119805761198061460d565b80820281158282048414176119805761198061460d565b5f82614c96577f4e487b71000000000000000000000000000000000000000000000000000000005f52601260045260245ffd5b500490565b84815283602082015273ffffffffffffffffffffffffffffffffffffffff83166040820152608060608201525f614b0d6080830184614295565b5f805f60608486031215614ce7575f80fd5b5050815160208301516040909301519094929350919050565b73ffffffffffffffffffffffffffffffffffffffff86168152841515602082015283604082015273ffffffffffffffffffffffffffffffffffffffff8316606082015260a060808201525f614d5860a0830184614295565b979650505050505050565b5f8060408385031215614d74575f80fd5b505080516020909101519092909150565b5f6101208201905060ff845116825273ffffffffffffffffffffffffffffffffffffffff602085015116602083015273ffffffffffffffffffffffffffffffffffffffff60408501511660408301526060840151614dfb606084018273ffffffffffffffffffffffffffffffffffffffff169052565b506080840151614e11608084018261ffff169052565b5060a0840151614e2860a084018262ffffff169052565b5060c0840151614e3d60c084018260020b9052565b5060e0840151614e5160e084018215159052565b50826101008301529392505050565b5f60208284031215614e70575f80fd5b815167ffffffffffffffff811115614e86575f80fd5b8201601f81018413614e96575f80fd5b805167ffffffffffffffff811115614eb057614eb061433d565b614ee160207fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f840116016143b7565b818152856020838501011115614ef5575f80fd5b6148a782602083016020860161427356fea2646970667358221220ed0de2114a218d49500d4c8dd74dcd313b336011bd19a0ffed252c1b9fc7da6164736f6c634300081a0033";
var EXECUTOR_STORAGE_SLOT = 0;
var FLASH_POOLS_STORAGE_SLOT = 1;
var V4_POOL_MANAGER_STORAGE_SLOT = 6;
var WETH_STORAGE_SLOT = 7;

// src/execution/executorCalldata.ts
var import_ethers3 = require("ethers");
var HOP_TUPLE = "(uint8 kind,address pool,address tokenIn,address tokenOut,uint16 feeBps,uint24 v4Fee,int24 v4TickSpacing,bool v4Native)";
var EXECUTE_ABI = [
  `function execute((address token,uint256 amountIn,uint256 minProfit,uint256 maxBlock,${HOP_TUPLE}[] hops) t, address flashPool)`,
  `function executeWithV3Flash((address token,uint256 amountIn,uint256 minProfit,uint256 maxBlock,${HOP_TUPLE}[] hops) t, address lendPool)`
];
var KIND_V2 = 0;
var KIND_SOLIDLY = 1;
var KIND_V3 = 2;
var KIND_V4 = 3;
var KIND_V4_HOOKED = 4;
var SOLIDLY_DEXES = /* @__PURE__ */ new Set(["ramses", "ramses-v2", "pharaoh"]);
var UNSUPPORTED_DEXES = /* @__PURE__ */ new Set([
  "lfj-lb",
  "traderjoe-lb",
  // Liquidity Book bins
  "bean-exchange",
  // Bean DLMM (bins)
  "ramses-dlmm",
  "kuru"
  // orderbook
]);
var iface = new import_ethers3.Interface(EXECUTE_ABI);
function fullHop(h) {
  return {
    kind: h.kind,
    pool: h.pool,
    tokenIn: h.tokenIn,
    tokenOut: h.tokenOut,
    feeBps: h.feeBps,
    v4Fee: h.v4Fee ?? 0,
    v4TickSpacing: h.v4TickSpacing ?? 0,
    v4Native: h.v4Native ?? false
  };
}
var ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
function kindForPool(pool) {
  const dex = pool.dex.toLowerCase();
  if (UNSUPPORTED_DEXES.has(dex)) return null;
  const hooked = isHookedV4(pool);
  if (dex === "uniswap-v4") return pool.v4 ? hooked ? KIND_V4_HOOKED : KIND_V4 : null;
  if (pool.variant === "algebra") return pool.v4 ? null : KIND_V3;
  if (pool.v4) return hooked ? KIND_V4_HOOKED : null;
  if (pool.poolType === "v3") return KIND_V3;
  if (pool.poolType === "v2") return SOLIDLY_DEXES.has(dex) ? KIND_SOLIDLY : KIND_V2;
  return null;
}
function isHookedV4(pool) {
  return !!pool.v4?.hooks && pool.v4.hooks.toLowerCase() !== ZERO_ADDRESS;
}
function v4KeyOf(pool) {
  const v4 = pool.v4;
  return {
    currency0: v4.native ? import_ethers3.ZeroAddress : pool.tokenA,
    currency1: pool.tokenB,
    fee: v4.fee,
    tickSpacing: v4.tickSpacing,
    hooks: v4.hooks && isHookedV4(pool) ? v4.hooks : import_ethers3.ZeroAddress
  };
}
function v4KeyMatchesId(pool) {
  if (!pool.v4) return false;
  const k = v4KeyOf(pool);
  try {
    const id = (0, import_ethers3.keccak256)(import_ethers3.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint24", "int24", "address"],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]
    ));
    return id.toLowerCase() === pool.poolAddress.toLowerCase();
  } catch {
    return false;
  }
}
function hopFor(kind, pool, tokenIn, tokenOut) {
  if (kind === KIND_V4) {
    return {
      // getAddress(lowercase): accept any capitalisation (a stored address with
      // a wrong checksum would otherwise make the encoder throw).
      kind,
      pool: (0, import_ethers3.getAddress)(pool.v4.poolManager.toLowerCase()),
      tokenIn,
      tokenOut,
      feeBps: 0,
      v4Fee: pool.v4.fee,
      v4TickSpacing: pool.v4.tickSpacing,
      v4Native: pool.v4.native
    };
  }
  if (kind === KIND_V4_HOOKED) {
    return {
      kind,
      pool: (0, import_ethers3.getAddress)(pool.v4.hooks.toLowerCase()),
      tokenIn,
      tokenOut,
      feeBps: 0,
      v4Fee: pool.v4.fee,
      v4TickSpacing: pool.v4.tickSpacing,
      v4Native: pool.v4.native,
      v4PoolManager: (0, import_ethers3.getAddress)(pool.v4.poolManager.toLowerCase())
    };
  }
  return {
    kind,
    pool: pool.poolAddress,
    tokenIn,
    tokenOut,
    feeBps: kind === KIND_V2 ? pool.feeBps : 0,
    v4Fee: 0,
    v4TickSpacing: 0,
    v4Native: false
  };
}
function encodeExecuteRaw(trade, flashPool = ZERO_ADDRESS) {
  return iface.encodeFunctionData("execute", [{ ...trade, hops: trade.hops.map(fullHop) }, flashPool]);
}
function encodeExecuteV3FlashRaw(trade, lendPool) {
  return iface.encodeFunctionData("executeWithV3Flash", [{ ...trade, hops: trade.hops.map(fullHop) }, lendPool]);
}

// src/core/failReasons.ts
var RULES = [
  // A pool that gave back nothing / took nothing for our coins. Oct 12: these
  // were counted as "our bot built the trade wrong", but in a practice check
  // they can only mean the pool had no coins to trade at its price (our saved
  // pool info was old or wrong), not a mistake in the trade we built:
  //   ZeroAmount           a hop paid out 0 coins (the check always sends a
  //                        non-zero amount, so the contract's other ZeroAmount
  //                        reason can't happen here)
  //   UnauthorizedCallback a V3 pool asked to be paid 0 (it had no liquidity
  //                        in that direction); the contract's other callback
  //                        guards can't trip in a check (we set them up)
  //   SPL / invalidLimitSqrtPrice / PriceLimitAlreadyExceeded
  //                        the pool's price already sits at the very end of
  //                        its range (drained pool); we pass the standard
  //                        "no limit" value every exchange accepts
  // Checked BEFORE the "ours" rules on purpose.
  ["stale", /ZeroAmount|UnauthorizedCallback|invalidLimitSqrtPrice|PriceLimitAlreadyExceeded|PriceLimitOutOfBounds|pool (gave back|took) nothing/],
  ["stale", /\bSPL\b/],
  // Our own contract's errors that mean the route/setup we built was wrong.
  // LOK = V3 pool locked (we re-entered it), locked() = same on Algebra.
  // CurrencyNotSettled / PoolNotInitialized = Uniswap V4 says we paid wrong
  // or named a pool that doesn't exist (our pool key).
  ["ours", /BadRoute|UnsupportedKind|FlashPoolNotAllowed|V4NotEnabled|NotExecutor|NotOwner|NotPendingOwner|OwnerIsExecutor|Reentrancy|UnexpectedEth|CurrencyNotSettled|PoolNotInitialized|call unexpectedly succeeded/i],
  // "Expired()" only as our contract's own error (case-sensitive, with the
  // brackets), so a node message that merely contains "expired" can't land here.
  ["ours", /\bExpired\(\)|\bLOK\b|^locked\(\)/],
  // Uniswap V2 "K" check / insufficient input: the pair received fewer coins
  // than we sent (our contract sends the full amount and asks for the matching
  // output), which is exactly what a transfer tax causes. V3 "IIA" is the same
  // thing on a V3 pool. TokenBalanceDropped = a coin in the middle of the route
  // shrank between hops, also a transfer cut.
  ["tax", /INSUFFICIENT_INPUT_AMOUNT|TokenBalanceDropped|insufficientInputAmount/i],
  ["tax", /: K\b|^K$|\bIIA\b/],
  // The coin itself refused to move: transfer helpers failing, blacklists,
  // trading switched off, max-transaction limits.
  // Explicit refusals from the coin itself.
  ["blocked", /blacklist|not allowed|trading (is )?not (enabled|open|active)|tradingEnabled|max ?tx|exceeds (the )?max/i],
  // A transfer failed without saying why (TF / TransferFailed), or the lender
  // pool had no active liquidity (L). Oct 7: seen on WETH/USDG, where fork
  // tests show the coins, lender and routes all work, so the cause is being
  // traced in our own test setup. Could also be a coin that blocks transfers.
  ["transfer", /TRANSFER_FAILED|TransferFailed|transfer amount exceeds/i],
  ["transfer", /\bSTF\b|\bTF\b|^L$/],
  // Pool math didn't match what we expected: price moved or our cached state
  // was off, or the simulated profit was too good to be true.
  ["stale", /INSUFFICIENT_OUTPUT_AMOUNT|INSUFFICIENT_LIQUIDITY|implausible profit|Too little received/i],
  ["stale", /\bAS\b/],
  // The chain reverted with no data at all.
  ["silent", /reverted without data|execution reverted\s*$|^revert$/i]
];
function classifyFailReason(raw) {
  const text = (raw ?? "").trim();
  if (!text) return "silent";
  for (const [group, re] of RULES) if (re.test(text)) return group;
  return "other";
}
var SampleLimiter = class {
  constructor(perHour = 5, now = Date.now) {
    this.perHour = perHour;
    this.now = now;
    this.windowStart = 0;
    this.used = /* @__PURE__ */ new Map();
  }
  // True if one more example of `kind` may be logged this hour.
  take(kind) {
    const t = this.now();
    if (t - this.windowStart >= 36e5) {
      this.windowStart = t;
      this.used.clear();
    }
    const n = this.used.get(kind) ?? 0;
    if (n >= this.perHour) return false;
    this.used.set(kind, n + 1);
    return true;
  }
  // Forget this hour's count (used by tests).
  reset() {
    this.windowStart = 0;
    this.used.clear();
  }
};
function classifySimOutcome(status, reason = "") {
  if (status === "profit") return "profit";
  if (status === "loss") return "real_loss";
  if (status === "rate_limited") return "rpc_failure";
  const r = (reason ?? "").trim();
  if (/^replay (unavailable|returned no result)/i.test(r)) return "replay_unavailable";
  if (status === "unsupported") {
    return /override|does not support|too many arguments|invalid params/i.test(r) ? "override_unsupported" : "not_simulable";
  }
  if (!r || /reverted without data|^execution reverted\s*:?\s*$|^revert$|^revert 0x$/i.test(r)) return "missing_revert_data";
  const g = classifyFailReason(r);
  if (g === "transfer" || g === "tax" || g === "blocked" || /exceeds balance|insufficient balance/i.test(r)) return "token_transfer";
  if (g === "silent") return "missing_revert_data";
  return "contract_revert";
}

// src/execution/simulator.ts
var SIM_EXECUTOR_ADDRESS = "0x00000000000000000000000000000000a7b51e00";
var SIM_CALLER = "0x00000000000000000000000000000000000b0751";
var MAX_UINT = (1n << 256n) - 1n;
var abi = import_ethers4.ethers.AbiCoder.defaultAbiCoder();
var errIface = new import_ethers4.ethers.Interface([
  // ArbExecutor
  "error InsufficientProfit(uint256 got, uint256 wanted)",
  "error TokenBalanceDropped(address token)",
  "error UnsupportedKind(uint8 kind)",
  "error BadRoute()",
  "error ZeroAmount()",
  "error Expired()",
  "error UnauthorizedCallback()",
  "error TransferFailed()",
  "error NotExecutor()",
  "error NotOwner()",
  "error NotPendingOwner()",
  "error OwnerIsExecutor()",
  "error FlashPoolNotAllowed(address pool)",
  "error V4NotEnabled()",
  "error UnexpectedEth()",
  "error Reentrancy()",
  // Solidity built-ins
  "error Error(string)",
  "error Panic(uint256)",
  // Uniswap V4
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
  "error CurrencyNotSettled()",
  "error PoolNotInitialized()",
  "error PriceLimitAlreadyExceeded(uint160 sqrtPriceCurrentX96, uint160 sqrtPriceLimitX96)",
  "error PriceLimitOutOfBounds(uint160 sqrtPriceLimitX96)",
  "error SwapAmountCannotBeZero()",
  "error ManagerLocked()",
  "error ERC20TransferFailed()",
  "error NativeTransferFailed()",
  "error HookDeltaExceedsSwapAmount()",
  "error InvalidHookResponse()",
  // Algebra Integral
  "error locked()",
  "error notInitialized()",
  "error zeroAmountRequired()",
  "error invalidAmountRequired()",
  "error insufficientInputAmount()",
  "error invalidLimitSqrtPrice()"
]);
var PANIC_WORDS = {
  1: "assert failed",
  17: "arithmetic over/underflow",
  18: "division by zero",
  33: "bad enum value",
  34: "bad storage data",
  49: "pop on empty array",
  50: "array index out of range",
  65: "out of memory",
  81: "call to zero function"
};
var diagLog = (m) => console.log(m);
var diagSamples = new SampleLimiter(5);
var first10Bytes = (hex) => hex.slice(0, 22);
var KIND_NAMES = { 0: "V2", 1: "Solidly", 2: "V3", 3: "V4", 4: "V4-hooked" };
var routeText = (hops) => hops.map((h) => `${KIND_NAMES[h.kind] ?? `kind${h.kind}`}@${h.pool.slice(0, 10)}`).join(" -> ");
var BALANCE_OF = new import_ethers4.ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
function tag(r) {
  if (r.bucket) return r;
  return { ...r, bucket: classifySimOutcome(r.status, "reason" in r ? r.reason : "") };
}
var pad32 = (v) => import_ethers4.ethers.zeroPadValue(typeof v === "bigint" ? import_ethers4.ethers.toBeHex(v) : v, 32);
var HEX_RE = /0x[0-9a-fA-F]*/;
var isRevertShape = (h) => /^0x[0-9a-fA-F]{8}([0-9a-fA-F]{64})*$/.test(h);
function extractRevertData(err) {
  const seen = /* @__PURE__ */ new Set();
  const fromValue = (v, depth) => {
    if (v === null || v === void 0 || depth > 4 || seen.has(v)) return null;
    if (typeof v === "string") {
      const s = v.trim();
      if (/^0x[0-9a-fA-F]*$/.test(s)) return s;
      const m = /^Reverted\s+(0x[0-9a-fA-F]*)$/i.exec(s);
      return m ? m[1] : null;
    }
    if (typeof v !== "object") return null;
    seen.add(v);
    const o = v;
    for (const k of ["data", "originalError", "error", "result", "return", "revert"]) {
      const found = fromValue(o[k], depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  const direct = fromValue(err?.data, 0) ?? fromValue(err?.error, 0);
  if (direct !== null && direct !== "0x") return direct;
  const msg = String(err?.message ?? "");
  for (const piece of msg.split(/[\s,:;()"'\[\]{}]+/)) {
    const h = HEX_RE.exec(piece)?.[0];
    if (h && h === piece && isRevertShape(h)) return h;
  }
  return direct;
}
var revertData = (err) => extractRevertData(err);
var STATE_GONE_RE = /missing trie node|historical state|state.*(not available|unavailable)|header not found|unknown block|pruned/i;
var REPLAY_BLOCK_GAS = "0x" + 2e9.toString(16);
function replayRpc(base, parentBlock, prefix, blockTime) {
  return async (method, params) => {
    const p = params;
    if (method !== "eth_call" || p[0]?.to?.toLowerCase() !== SIM_EXECUTOR_ADDRESS) return base(method, params);
    const r = await base("eth_simulateV1", [{
      blockStateCalls: [{
        blockOverrides: { gasLimit: REPLAY_BLOCK_GAS, ...blockTime ? { time: blockTime } : {} },
        stateOverrides: p[2] ?? {},
        calls: [...prefix, p[0]]
      }],
      validation: false
      // replayed trades skip nonce/fee checks
    }, parentBlock]);
    if (r.error) {
      if (isRateLimited(r.error) || (r.error.message ?? "").startsWith("network:")) return r;
      return { error: { message: `replay unavailable${STATE_GONE_RE.test(r.error.message ?? "") ? " (state gone)" : ""}` } };
    }
    return readReplayAnswer(r.result, prefix.length + 1);
  };
}
function readReplayAnswer(result, expectedCalls) {
  const block = Array.isArray(result) ? result[0] : result;
  const calls = Array.isArray(block?.calls) ? block.calls : [];
  if (!calls.length) return { error: { message: "replay unavailable (no answer)" } };
  if (calls.length !== expectedCalls) return { error: { message: `replay unavailable (${calls.length} answers for ${expectedCalls} calls)` } };
  const ours = calls[calls.length - 1];
  const err = typeof ours?.error === "string" ? { message: ours.error } : ours?.error;
  const st = ours?.status;
  const failed = st === "0x0" || st === 0 || st === false || st === "0" || st === void 0 && !!err;
  if (!failed) return { result: ours?.returnData ?? "0x" };
  const fromErr = err ? extractRevertData(err) : null;
  const revert = fromErr && fromErr !== "0x" ? fromErr : typeof ours?.returnData === "string" && ours.returnData !== "0x" ? ours.returnData : void 0;
  return { error: { message: err?.message ?? "execution reverted", code: err?.code, data: revert, via: "eth_simulateV1", ...ours?.gasUsed !== void 0 ? { gasUsed: String(ours.gasUsed) } : {} } };
}
function isRateLimited(err) {
  const m = (err?.message ?? "").toLowerCase();
  return err?.code === 429 || err?.code === -32005 || err?.code === -32007 || m.includes("rate limit") || m.includes("too many requests") || m.includes("exceeded") || m.includes("quota") || m.includes("limit reached");
}
function overridesUnsupported(err) {
  const m = (err?.message ?? "").toLowerCase();
  return err?.code === -32602 || m.includes("override") || m.includes("too many arguments") || m.includes("invalid params");
}
var RateLimited = class extends Error {
};
var slotCache = /* @__PURE__ */ new Map();
var sideSlotCache = /* @__PURE__ */ new Map();
var NOT_FOUND_TTL_MS = 24 * 60 * 6e4;
var MAX_SLOT = 60;
var slotFile = null;
var savedSpecs = {};
function solidityKey(holder, slot) {
  return import_ethers4.ethers.keccak256(abi.encode(["address", "uint256"], [holder, slot]));
}
function vyperKey(holder, slot) {
  return import_ethers4.ethers.keccak256(abi.encode(["uint256", "address"], [slot, holder]));
}
var keyFnFor = (s) => (h) => s.layout === "solidity" ? solidityKey(h, s.slot) : vyperKey(h, s.slot);
function saveSlot(cacheKey, spec) {
  savedSpecs[cacheKey] = spec;
  if (!slotFile) return;
  try {
    (0, import_fs2.mkdirSync)((0, import_path2.dirname)(slotFile), { recursive: true });
    (0, import_fs2.writeFileSync)(slotFile + ".tmp", JSON.stringify(savedSpecs));
    (0, import_fs2.renameSync)(slotFile + ".tmp", slotFile);
  } catch {
  }
}
async function findBalanceSlot(rpc2, cacheKey, token, readOnly = false) {
  const fresh = (h) => !!h && (h.info !== null || Date.now() - h.at < NOT_FOUND_TTL_MS);
  const hit = slotCache.get(cacheKey);
  if (fresh(hit)) return hit.info;
  if (readOnly) {
    const side = sideSlotCache.get(cacheKey);
    if (fresh(side)) return side.info;
  }
  const data = BALANCE_OF.encodeFunctionData("balanceOf", [SIM_EXECUTOR_ADDRESS]);
  const BASE = 0x1234567890abcdef0000n;
  const call = async (stateDiff) => {
    const r = await rpc2("eth_call", [{ to: token, data }, "latest", { [token]: { stateDiff } }]);
    if (r.error) {
      if (isRateLimited(r.error) || (r.error.message ?? "").startsWith("network:")) throw new RateLimited(r.error.message ?? "rate limited");
      return overridesUnsupported(r.error) ? "unsupported" : null;
    }
    try {
      return BigInt(r.result);
    } catch {
      return null;
    }
  };
  const specs = [];
  for (let slot = 0; slot <= MAX_SLOT; slot++) specs.push({ layout: "solidity", slot }, { layout: "vyper", slot });
  const diff = {};
  specs.forEach((sp, i) => {
    diff[keyFnFor(sp)(SIM_EXECUTOR_ADDRESS)] = pad32(BASE + BigInt(i));
  });
  let found = null;
  let spec = null;
  const got = await call(diff);
  if (got === "unsupported") found = { unsupported: "RPC does not support eth_call state overrides" };
  else if (got !== null && got >= BASE && got < BASE + BigInt(specs.length)) spec = specs[Number(got - BASE)];
  else {
    const magic1 = 0x1234567890abcdefn;
    for (const sp of specs.filter((x) => x.slot <= 30)) {
      const r = await call({ [keyFnFor(sp)(SIM_EXECUTOR_ADDRESS)]: pad32(magic1) });
      if (r === "unsupported") {
        found = { unsupported: "RPC does not support eth_call state overrides" };
        break;
      }
      if (r === magic1) {
        spec = sp;
        break;
      }
    }
  }
  if (spec) {
    const magic = 0x1234567890abcdefn;
    const check = await call({ [keyFnFor(spec)(SIM_EXECUTOR_ADDRESS)]: pad32(magic) });
    if (check === magic) {
      found = { key: keyFnFor(spec) };
      if (!readOnly) saveSlot(cacheKey, spec);
    }
  }
  if (readOnly) {
    if (sideSlotCache.size > 2e3) sideSlotCache.clear();
    sideSlotCache.set(cacheKey, { info: found, at: Date.now() });
  } else slotCache.set(cacheKey, { info: found, at: Date.now() });
  return found;
}
async function simulateRoundTrip(rpc2, chain, trade, opts = {}) {
  return tag(await simulateInner(rpc2, chain, trade, opts));
}
async function simulateInner(rpc2, chain, trade, opts) {
  const flash = !!opts.v3Lender;
  let balanceKey = null;
  if (!flash) {
    let slot;
    try {
      slot = await findBalanceSlot(rpc2, `${chain}:${trade.token.toLowerCase()}`, trade.token, !!opts.slotReadOnly);
    } catch (err) {
      if (err instanceof RateLimited) return { status: "rate_limited", reason: err.message };
      throw err;
    }
    if ("unsupported" in (slot ?? {})) return { status: "unsupported", reason: slot.unsupported };
    if (slot === null) return { status: "unsupported", reason: "could not find token balance storage" };
    balanceKey = "key" in slot ? slot.key(SIM_EXECUTOR_ADDRESS) : null;
  }
  const tradeArgs = {
    token: trade.token,
    amountIn: trade.amountIn,
    minProfit: MAX_UINT,
    // force the "report profit and refuse" path
    maxBlock: MAX_UINT,
    hops: trade.hops
  };
  const data = flash ? encodeExecuteV3FlashRaw(tradeArgs, opts.v3Lender) : encodeExecuteRaw(tradeArgs);
  const executorDiff = { [pad32(import_ethers4.ethers.toBeHex(EXECUTOR_STORAGE_SLOT))]: pad32(SIM_CALLER) };
  const v4Hop = trade.hops.find((h) => h.kind === KIND_V4 || h.kind === KIND_V4_HOOKED);
  if (v4Hop) {
    if (!opts.weth) return { status: "unsupported", reason: "V4 trade needs the chain WETH address" };
    const pm = v4Hop.kind === KIND_V4 ? v4Hop.pool : v4Hop.v4PoolManager;
    if (!pm) return { status: "unsupported", reason: "hooked V4 hop without its PoolManager" };
    executorDiff[pad32(import_ethers4.ethers.toBeHex(V4_POOL_MANAGER_STORAGE_SLOT))] = pad32(pm);
    executorDiff[pad32(import_ethers4.ethers.toBeHex(WETH_STORAGE_SLOT))] = pad32(opts.weth);
  }
  if (flash) {
    const allowKey = import_ethers4.ethers.keccak256(abi.encode(["address", "uint256"], [opts.v3Lender, FLASH_POOLS_STORAGE_SLOT]));
    executorDiff[allowKey] = pad32(1n);
  }
  const overrides = {
    [SIM_EXECUTOR_ADDRESS]: { code: ARB_EXECUTOR_RUNTIME_CODE, stateDiff: executorDiff }
  };
  if (balanceKey) overrides[trade.token] = { stateDiff: { [balanceKey]: pad32(trade.amountIn) } };
  const r = await rpc2("eth_call", [
    { from: SIM_CALLER, to: SIM_EXECUTOR_ADDRESS, data, gas: "0x" + 8e6.toString(16) },
    opts.blockTag ?? "latest",
    overrides
  ]);
  if (!r.error) return { status: "fail", reason: "call unexpectedly succeeded", bucket: "contract_revert" };
  const rd = revertData(r.error);
  const parsed = parseRevert(rd);
  if (parsed) {
    const v = verdictFrom(parsed, flash);
    const gu = gasUsedOf(r.error.gasUsed);
    if (gu !== null && parsed.name === "InsufficientProfit" && (v.status === "profit" || v.status === "loss")) return { ...v, gasUsed: gu };
    return v;
  }
  if (isRateLimited(r.error)) return { status: "rate_limited", reason: r.error.message ?? "rate limited" };
  if ((r.error.message ?? "").startsWith("network:")) return { status: "rate_limited", reason: r.error.message };
  if (overridesUnsupported(r.error)) return { status: "unsupported", reason: r.error.message ?? "overrides unsupported", bucket: "override_unsupported" };
  if (!rd || rd === "0x") {
    const reason = r.error.message ?? "reverted without data";
    if (!/^replay /.test(reason) && classifySimOutcome("fail", reason) === "missing_revert_data") {
      diagnose("no-data", `no revert data | node said ${describeError(r.error)}`, trade.hops, flash, opts.blockTag);
    }
    return { status: "fail", reason };
  }
  diagnose("unknown", `unknown revert data ${first10Bytes(rd)} (${(rd.length - 2) / 2} bytes) | node said ${describeError(r.error)}`, trade.hops, flash, opts.blockTag);
  return { status: "fail", reason: `revert ${first10Bytes(rd)}`, bucket: "contract_revert" };
}
function gasUsedOf(v) {
  if (v === void 0 || v === null || v === "") return null;
  try {
    const g = BigInt(v);
    return g > 0n ? g : null;
  } catch {
    return null;
  }
}
function diagnose(kind, what, hops, flash, blockTag) {
  if (!diagSamples.take(kind)) return;
  diagLog(`[sim-diag] ${what} | route ${routeText(hops)} | ${flash ? "flash loan" : "own money"}${blockTag ? ` | block ${blockTag}` : ""}`);
}
function describeError(e) {
  const fields = Object.keys(e ?? {}).filter((k) => k !== "via").join(",");
  const data = typeof e?.data === "string" ? ` data=${first10Bytes(e.data)}` : e?.data !== void 0 ? ` data=<${typeof e.data}>` : "";
  return `code=${e?.code ?? "-"} msg="${String(e?.message ?? "").slice(0, 100)}"${data} fields=[${fields}] via ${e?.via ?? "eth_call"}`;
}
function parseRevert(rd) {
  if (!rd || rd === "0x") return null;
  try {
    return errIface.parseError(rd);
  } catch {
    return null;
  }
}
function errorText(parsed) {
  if (parsed.name === "Error") return String(parsed.args[0]);
  if (parsed.name === "Panic") {
    const code = Number(parsed.args[0]);
    return `Panic(0x${code.toString(16)}: ${PANIC_WORDS[code] ?? "unknown"})`;
  }
  if (parsed.name === "WrappedError") {
    const inner = parseRevert(String(parsed.args[2]));
    const innerText = inner ? errorText(inner) : `revert ${first10Bytes(String(parsed.args[2]))}`;
    return `${innerText} (inside V4 call to ${String(parsed.args[0]).slice(0, 10)}, WrappedError)`;
  }
  return `${parsed.name}(${parsed.args.join(", ")})`;
}
function verdictFrom(parsed, flash) {
  if (parsed.name === "InsufficientProfit") {
    const got = parsed.args[0];
    return got > 0n ? { status: "profit", profit: got, bucket: "profit" } : { status: "loss", bucket: "real_loss", detail: "ends with no more than it started" };
  }
  if (parsed.name === "TransferFailed" && flash) {
    return { status: "loss", bucket: "real_loss", detail: "flash loan could not be repaid (trade lost money, or a token refused to move)" };
  }
  if (parsed.name === "ZeroAmount") return { status: "fail", reason: "ZeroAmount(): pool gave back nothing" };
  if (parsed.name === "UnauthorizedCallback") return { status: "fail", reason: "UnauthorizedCallback(): pool took nothing (no liquidity at its price)" };
  return { status: "fail", reason: errorText(parsed) };
}

// src/core/eventFees.ts
var enabled = !/^(0|false|off|no)$/i.test((process.env.FEE_FROM_EVENTS ?? "").trim());
var maxAgeMs = (() => {
  const n = Number(process.env.FEE_EVENT_MAX_AGE_MS ?? 6e5);
  return Number.isFinite(n) && n >= 1e3 ? n : 6e5;
})();
var clock = Date.now;

// src/core/dexMath.ts
var Q96 = 1n << 96n;

// src/core/venueMath.ts
var Q962 = 1n << 96n;

// src/core/loopFinder.ts
var Q963 = 2 ** 96;
var LOG_TICK = Math.log(1.0001);

// src/core/gasModel.ts
var DEFAULT_GAS_OWN = 335e3;

// scripts/sim-compare/measureProfit.ts
var BOT_DIR = process.env.BOT_DIR || `${process.env.HOME}/multichain-arb-engine`;
var args = process.argv.slice(2);
var arg = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
var ARBS = arg("arbs");
var OUT = arg("out", `${process.env.HOME}/sim-compare-runs/profit1`);
var RPS = Number(arg("rps", "10"));
var CAP_USD = Number(arg("cap-usd", "2000"));
var LIMIT = Number(arg("limit", "0"));
var NODE_VAR = arg("node", "CHAINSTACK_RPC_ROBINHOOD");
if (!ARBS) {
  console.error('need --arbs FILE (jsonl with "arb" or "hash")');
  process.exit(1);
}
(0, import_fs3.mkdirSync)(OUT, { recursive: true });
var lc2 = (s) => String(s ?? "").toLowerCase();
var WETH = lc2(ROBINHOOD_TOKENS.WETH);
var USDG = lc2(ROBINHOOD_TOKENS.USDG);
var RH_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
var ZERO = "0x0000000000000000000000000000000000000000";
var USER_TX_TYPES = /* @__PURE__ */ new Set(["0x0", "0x1", "0x2", "0x3", "0x4"]);
function nodeUrl() {
  if (process.env[NODE_VAR]) return process.env[NODE_VAR];
  const m = (0, import_fs3.readFileSync)((0, import_path3.join)(BOT_DIR, ".env"), "utf8").match(new RegExp(`^\\s*${NODE_VAR}\\s*=\\s*["']?([^"'\\s#]+)`, "m"));
  if (!m) throw new Error(`${NODE_VAR} not found in .env`);
  return m[1];
}
var NODE = nodeUrl();
var rid = 0;
var last = 0;
var requests = 0;
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var rpc = async (method, params) => {
  for (let a = 0; a < 3; a++) {
    const w = last + 1e3 / RPS - Date.now();
    if (w > 0) await sleep(w);
    last = Date.now();
    requests++;
    try {
      const r = await fetch(NODE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }), signal: AbortSignal.timeout(2e4) });
      const j = await r.json();
      if (j.error && /limit|busy|429|timeout/i.test(j.error.message || "")) {
        await sleep(2e3);
        continue;
      }
      return j;
    } catch {
      await sleep(1e3);
    }
  }
  return { error: { message: "network: gave up" } };
};
var watch = JSON.parse((0, import_fs3.readFileSync)((0, import_path3.join)(BOT_DIR, "data", "watched-pools.json"), "utf8"));
var pools = /* @__PURE__ */ new Map();
for (const p of watch.pools || []) if (p && p.chain === "robinhood" && p.poolAddress && p.tokenA && p.tokenB) pools.set(lc2(p.poolAddress), p);
function coinsOf(id) {
  const p = pools.get(lc2(id));
  if (!p) return null;
  if (lc2(id).length === 66) {
    const n = (t) => p.v4?.native && lc2(t) === WETH ? "0x0000000000000000000000000000000000000000" : lc2(t);
    return { c0: n(p.tokenA), c1: n(p.tokenB) };
  }
  const [c0, c1] = [lc2(p.tokenA), lc2(p.tokenB)].sort();
  return { c0, c1 };
}
var asWeth = (t) => /^0x0+$/.test(t) ? WETH : t;
var LEARN = args.includes("--learn");
var learnedInfo = /* @__PURE__ */ new Map();
var FACTORY_DEX = new Map(ROBINHOOD_SCAN_FACTORIES.map((f) => [lc2(f.factory), f]));
var POOL_IFACE = new import_ethers5.ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function fee() view returns (uint24)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function globalState() view returns (uint160,int24,uint16,uint8,uint16,bool)"
]);
var V4_SWAP_SIG = new import_ethers5.ethers.Interface(["function swap((address,address,uint24,int24,address) key,(bool,int256,uint160) params,bytes hookData)"]);
var V4_SWAP_SELECTOR = V4_SWAP_SIG.getFunction("swap").selector;
async function poolCall(addr, fn) {
  const r = await rpc("eth_call", [{ to: addr, data: POOL_IFACE.encodeFunctionData(fn) }, "latest"]);
  if (!r.result || r.result === "0x") return null;
  try {
    return [...POOL_IFACE.decodeFunctionResult(fn, r.result)];
  } catch {
    return null;
  }
}
async function learnPool(id, txHash) {
  id = lc2(id);
  if (pools.has(id) || learnedInfo.has(id)) return;
  const fail = (kind, why) => {
    learnedInfo.set(id, { kind, dex: "?", ok: false, why });
  };
  if (id.length === 66) {
    const t = await rpc("debug_traceTransaction", [txHash, { tracer: "callTracer" }]);
    if (!t.result) return fail("v4", "trace unavailable");
    const calls = [];
    const walk = (c) => {
      calls.push(c);
      for (const s of c.calls ?? []) walk(s);
    };
    walk(t.result);
    for (const c of calls) {
      if (lc2(c.to) !== RH_POOL_MANAGER || !String(c.input ?? "").startsWith(V4_SWAP_SELECTOR)) continue;
      let k;
      try {
        k = V4_SWAP_SIG.decodeFunctionData("swap", c.input).key;
      } catch {
        continue;
      }
      const key = { c0: lc2(k[0]), c1: lc2(k[1]), fee: Number(k[2]), ts: Number(k[3]), hooks: lc2(k[4]) };
      const kid = import_ethers5.ethers.keccak256(import_ethers5.ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], [key.c0, key.c1, key.fee, key.ts, key.hooks]));
      if (lc2(kid) !== id) continue;
      const native = /^0x0+$/.test(key.c0), hooked = !/^0x0+$/.test(key.hooks);
      pools.set(id, {
        chain: "robinhood",
        dex: "uniswap-v4",
        poolAddress: id,
        poolType: "v3",
        tokenA: native ? ROBINHOOD_TOKENS.WETH : import_ethers5.ethers.getAddress(key.c0),
        tokenB: import_ethers5.ethers.getAddress(key.c1),
        feeBps: Math.round(key.fee / 100),
        lastUpdatedBlock: 0,
        lastUpdatedMs: 0,
        learned: true,
        v4: { fee: key.fee, tickSpacing: key.ts, native, poolManager: import_ethers5.ethers.getAddress(RH_POOL_MANAGER), stateView: ZERO, ...hooked ? { hooks: import_ethers5.ethers.getAddress(key.hooks) } : {} }
      });
      learnedInfo.set(id, { kind: hooked ? "v4 hooked" : "v4 no-hook", dex: hooked ? `hook ${key.hooks.slice(0, 10)}` : "uniswap-v4", hooked, ok: true });
      return;
    }
    return fail("v4", "pool key not found in the rival call");
  }
  const [t0, t1, fac] = [await poolCall(id, "token0"), await poolCall(id, "token1"), await poolCall(id, "factory")];
  if (!t0 || !t1) return fail("?", "not a pool we can read (no token0/token1)");
  const f = fac ? FACTORY_DEX.get(lc2(fac[0])) : void 0;
  const fee = await poolCall(id, "fee");
  const gs = fee ? null : await poolCall(id, "globalState");
  const res = fee || gs ? null : await poolCall(id, "getReserves");
  const base = { chain: "robinhood", poolAddress: import_ethers5.ethers.getAddress(id), tokenA: t0[0], tokenB: t1[0], lastUpdatedBlock: 0, lastUpdatedMs: 0, learned: true };
  if (fee) {
    const dex = f && f.kind === "v3" ? f.dex : "unknown-v3";
    pools.set(id, { ...base, dex, poolType: "v3", feeBps: Math.round(Number(fee[0]) / 100), feePips: Number(fee[0]) });
    learnedInfo.set(id, { kind: "v3", dex, ok: true });
    return;
  }
  if (gs) {
    pools.set(id, { ...base, dex: "unknown-algebra", poolType: "v3", variant: "algebra", feeBps: 0 });
    learnedInfo.set(id, { kind: "algebra", dex: "unknown-algebra", ok: true });
    return;
  }
  if (res) {
    const dex = f && f.kind !== "v3" ? f.dex : "unknown-v2";
    pools.set(id, { ...base, dex, poolType: "v2", feeBps: 30 });
    learnedInfo.set(id, { kind: f?.kind === "solidly" ? "solidly" : "v2", dex, ok: true });
    return;
  }
  return fail("?", "pool type not recognised");
}
var ERC20 = new import_ethers5.ethers.Interface(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
var decs = /* @__PURE__ */ new Map();
var syms = /* @__PURE__ */ new Map();
async function learnCoin(t) {
  t = lc2(t);
  if (decs.has(t)) return;
  if (t === WETH) {
    decs.set(t, 18);
    syms.set(t, "WETH");
    return;
  }
  const d = await rpc("eth_call", [{ to: t, data: ERC20.encodeFunctionData("decimals") }, "latest"]);
  try {
    decs.set(t, Number(ERC20.decodeFunctionResult("decimals", d.result)[0]));
  } catch {
    decs.set(t, null);
  }
  const s = await rpc("eth_call", [{ to: t, data: ERC20.encodeFunctionData("symbol") }, "latest"]);
  try {
    syms.set(t, String(ERC20.decodeFunctionResult("symbol", s.result)[0]).slice(0, 12));
  } catch {
    syms.set(t, t.slice(0, 8));
  }
}
var missingPools = /* @__PURE__ */ new Map();
function fillHopsFromLogs(rec, logs) {
  const legs = [];
  for (const l of logs) {
    const s = decodeSwapLog(l);
    const cc = s && coinsOf(s.pool);
    if (!s || !cc || s.a0 === void 0 || s.a1 === void 0 || s.a0 === 0n || s.a1 === 0n) continue;
    const in0 = s.a0 > 0n;
    legs.push({ pool: lc2(s.pool), tin: asWeth(in0 ? cc.c0 : cc.c1), tout: asWeth(in0 ? cc.c1 : cc.c0), ain: in0 ? s.a0 : s.a1, aout: -(in0 ? s.a1 : s.a0) });
  }
  if (legs.length !== rec.hops.length || legs.some((g, i) => g.pool !== lc2(rec.hops[i].pool))) return;
  legs.forEach((g, i) => {
    const h = rec.hops[i];
    h.tin ??= g.tin;
    h.tout ??= g.tout;
    h.ain ??= g.ain.toString();
    h.aout ??= g.aout.toString();
  });
}
function ourRoute(rec) {
  if (!rec.hops.length || rec.hops.length < 2) return { ok: false, why: "fewer than 2 hops" };
  const missing = rec.hops.filter((h) => !pools.has(lc2(h.pool)));
  if (missing.length) {
    for (const h of missing) missingPools.set(lc2(h.pool), (missingPools.get(lc2(h.pool)) ?? 0) + 1);
    return { ok: false, why: `${missing.length} of ${rec.hops.length} pools not on our watch list` };
  }
  const hops = [];
  for (const h of rec.hops) {
    if (!h.tin || !h.tout) return { ok: false, why: "route coins unreadable" };
    const p = pools.get(lc2(h.pool));
    if (!p) return { ok: false, why: "pool not on our watch list" };
    const kind = kindForPool(p);
    if (kind === null) return { ok: false, why: `${p.dex} pool type not supported by our contract` };
    if (kind === KIND_V4_HOOKED && !v4KeyMatchesId(p)) return { ok: false, why: `${p.dex} hooked V4 key mismatch` };
    const tin = lc2(p.tokenA) === h.tin ? p.tokenA : lc2(p.tokenB) === h.tin ? p.tokenB : null;
    const tout = lc2(p.tokenA) === h.tout ? p.tokenA : lc2(p.tokenB) === h.tout ? p.tokenB : null;
    if (!tin || !tout) return { ok: false, why: "route coin not in pool" };
    try {
      hops.push(hopFor(kind, p, tin, tout));
    } catch (e) {
      return { ok: false, why: `could not encode hop (${e.message})` };
    }
  }
  for (let i = 1; i < hops.length; i++) if (lc2(hops[i - 1].tokenOut) !== lc2(hops[i].tokenIn)) return { ok: false, why: "route does not chain" };
  const firstIn = rec.hops[0].ain ? BigInt(rec.hops[0].ain) : 0n;
  if (lc2(hops[0].tokenIn) !== lc2(hops[hops.length - 1].tokenOut)) {
    if (!CLOSE) return { ok: false, why: "not a loop (ends in another coin)" };
    return { ok: true, token: hops[0].tokenIn, hops, firstIn, open: { start: lc2(hops[0].tokenIn), end: lc2(hops[hops.length - 1].tokenOut) } };
  }
  return { ok: true, token: hops[0].tokenIn, hops, firstIn };
}
var CLOSE = args.includes("--close");
var MAX_DIRECT = 5;
var MAX_PER_STEP = 2;
function poolsForPair(a, b) {
  const out = [];
  for (const p of pools.values()) {
    const x = lc2(p.tokenA), y = lc2(p.tokenB);
    if (!(x === a && y === b || x === b && y === a)) continue;
    const kind = kindForPool(p);
    if (kind === null || kind === KIND_V4_HOOKED && !v4KeyMatchesId(p)) continue;
    out.push(p);
  }
  return out;
}
function hopVia(p, tin, tout) {
  const kind = kindForPool(p);
  if (kind === null) return null;
  const a = lc2(p.tokenA) === tin ? p.tokenA : p.tokenB, b = lc2(p.tokenA) === tout ? p.tokenA : p.tokenB;
  try {
    return hopFor(kind, p, a, b);
  } catch {
    return null;
  }
}
function closers(start, end) {
  const out = [];
  for (const p of poolsForPair(end, start).slice(0, MAX_DIRECT)) {
    const h = hopVia(p, end, start);
    if (h) out.push({ hops: [h], label: `direct ${p.dex}` });
  }
  for (const hub of [WETH, USDG]) {
    if (hub === start || hub === end) continue;
    for (const p1 of poolsForPair(end, hub).slice(0, MAX_PER_STEP)) for (const p2 of poolsForPair(hub, start).slice(0, MAX_PER_STEP)) {
      const h1 = hopVia(p1, end, hub), h2 = hopVia(p2, hub, start);
      if (h1 && h2) out.push({ hops: [h1, h2], label: `via ${hub === WETH ? "WETH" : "USDG"} (${p1.dex}, ${p2.dex})` });
    }
  }
  return out;
}
async function main() {
  const lines = (0, import_fs3.readFileSync)(ARBS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  let list = lines.map((r) => ({ hash: lc2(r.arb ?? r.hash), hadTrigger: r.trigger === void 0 ? null : !!r.trigger, bucket: r.bucket ?? null, extra: r })).filter((r) => r.hash.length === 66);
  if (LIMIT > 0) list = list.slice(0, LIMIT);
  console.log(`arbitrages to check: ${list.length}`);
  const obs = [];
  const recs = /* @__PURE__ */ new Map();
  const isQuote = (t) => t === USDG || t === WETH;
  for (const a of list) {
    const [tx, rc] = [await rpc("eth_getTransactionByHash", [a.hash]), await rpc("eth_getTransactionReceipt", [a.hash])];
    if (!tx.result || !rc.result) continue;
    const g = receiptGasWei(rc.result);
    const block = parseInt(rc.result.blockNumber, 16), txIndex = parseInt(rc.result.transactionIndex, 16);
    const c = classifyTx(
      rc.result.logs,
      tx.result.from,
      tx.result.to,
      rc.result.status,
      { hash: a.hash, block, txIndex, gasWei: g.gasWei, l1GasUsed: g.l1GasUsed, value: BigInt(tx.result.value ?? 0) },
      { weth: WETH, poolManager: RH_POOL_MANAGER, v4Currencies: (id) => coinsOf(id) }
    );
    if (!c.arb) continue;
    if (LEARN) {
      for (const h of c.arb.hops) if (!pools.has(lc2(h.pool))) await learnPool(h.pool, a.hash);
    }
    fillHopsFromLogs(c.arb, rc.result.logs);
    recs.set(a.hash, { rec: c.arb, rc: rc.result });
    for (const l of rc.result.logs) {
      const s = decodeSwapLog(l);
      const cc = s && coinsOf(s.pool);
      if (!s || !cc || s.a0 === void 0 || s.a1 === void 0) continue;
      const t0 = asWeth(cc.c0), t1 = asWeth(cc.c1);
      await learnCoin(t0);
      await learnCoin(t1);
      const d0 = decs.get(t0), d1 = decs.get(t1);
      if (d0 == null || d1 == null) continue;
      obs.push(...obsFromSwap(block, s.pool, t0, t1, s.a0, s.a1, d0, d1, isQuote));
    }
    for (const [t] of c.arb.net) await learnCoin(t);
    for (const h of c.arb.hops) {
      if (h.tin) await learnCoin(h.tin);
      if (h.tout) await learnCoin(h.tout);
    }
    if (recs.size % 100 === 0) console.log(`${recs.size} receipts \xB7 node requests ${requests}`);
  }
  obs.sort((x, y) => x.block - y.block);
  const book = buildPriceBook(obs, /* @__PURE__ */ new Set([USDG]), WETH);
  const ctx = {
    book,
    decimals: (t) => decs.get(lc2(t)) ?? null,
    symbol: (t) => syms.get(lc2(t)) ?? lc2(t).slice(0, 8),
    dexOf: (p) => pools.get(lc2(p))?.dex ?? "?",
    isWatched: (p) => pools.has(lc2(p)),
    botCanTrade: () => true,
    timeOf: () => 0,
    timing: () => "standalone"
  };
  console.log(`classified ${recs.size} arbitrages; price points ${obs.length}`);
  const rows = [];
  const outFile = (0, import_path3.join)(OUT, "per-arb.jsonl");
  (0, import_fs3.writeFileSync)(outFile, "");
  for (const a of list) {
    const got = recs.get(a.hash);
    if (!got) {
      rows.push({ hash: a.hash, skipped: "not an arbitrage / no receipt" });
      continue;
    }
    const { rec, rc } = got;
    const pr = priceArb(rec, ctx);
    const row = {
      hash: a.hash,
      block: rec.block,
      hadTrigger: a.hadTrigger,
      bucket: a.bucket,
      path: pr.path,
      rival: { sizeUsd: pr.sizeUsd, grossUsd: pr.grossUsd, gasUsd: pr.gasUsd, netUsd: pr.netUsd, trust: pr.trust, doubt: pr.doubtWhy }
    };
    const learnedHere = rec.hops.filter((h) => pools.get(lc2(h.pool))?.learned).map((h) => lc2(h.pool));
    if (learnedHere.length) row.learnedPools = learnedHere;
    const built = ourRoute(rec);
    if (built.ok === false) {
      row.ours = { status: "not-ours", why: built.why };
      rows.push(row);
      (0, import_fs3.appendFileSync)(outFile, JSON.stringify(row) + "\n");
      continue;
    }
    const b = await rpc("eth_getBlockByNumber", ["0x" + rec.block.toString(16), true]);
    const txs = b.result?.transactions ?? [];
    const prefix = txs.slice(0, rec.txIndex).filter((t) => t.to && USER_TX_TYPES.has(String(t.type ?? "0x0").toLowerCase())).map((t) => ({ from: t.from, to: t.to, data: t.input ?? t.data ?? "0x", value: t.value, gas: t.gas }));
    const sim = replayRpc(rpc, "0x" + (rec.block - 1).toString(16), prefix, b.result?.timestamp);
    const tokenUsd = book.usdAt(lc2(built.token), rec.block);
    const dec = decs.get(lc2(built.token));
    const eth = book.ethAt(rec.block);
    const gasPrice = BigInt(rc.effectiveGasPrice ?? rc.gasPrice ?? 0);
    const l1Gas = BigInt(rc.gasUsedForL1 ?? 0);
    const toUsd = (raw) => tokenUsd && dec != null ? Number(raw) / 10 ** dec * tokenUsd.usd : null;
    const gasUsdOf = (r) => eth === null ? null : Number((("gasUsed" in r && r.gasUsed ? r.gasUsed : BigInt(DEFAULT_GAS_OWN)) + l1Gas) * gasPrice) / 1e18 * eth;
    const base = built.firstIn > 0n ? built.firstIn : tokenUsd && dec != null ? BigInt(Math.floor(500 / tokenUsd.usd * 10 ** dec)) : 0n;
    const capRaw = tokenUsd && dec != null ? BigInt(Math.floor(CAP_USD / tokenUsd.usd * 10 ** dec)) : null;
    if (built.open) {
      const cands = closers(built.open.start, built.open.end);
      if (!cands.length) {
        row.ours = { status: "not-ours", why: "open route, no pool to close the loop" };
        rows.push(row);
        (0, import_fs3.appendFileSync)(outFile, JSON.stringify(row) + "\n");
        continue;
      }
      let pick = cands[0], pickProfit = -1n;
      for (const c of cands) {
        if (base <= 0n) break;
        const r = await simulateRoundTrip(sim, "robinhood", { token: built.token, amountIn: base, hops: [...built.hops, ...c.hops] }, { weth: ROBINHOOD_TOKENS.WETH });
        const pr2 = r.status === "profit" ? r.profit : -1n;
        if (pr2 > pickProfit) {
          pick = c;
          pickProfit = pr2;
        }
      }
      built.hops = [...built.hops, ...pick.hops];
      row.closedWith = pick.label;
      row.closeOptionsTried = cands.length;
    }
    const tried = [];
    const run = async (amt) => {
      if (amt <= 0n || tried.some((t) => t.amt === amt)) return;
      tried.push({ amt, r: await simulateRoundTrip(sim, "robinhood", { token: built.token, amountIn: amt, hops: built.hops }, { weth: ROBINHOOD_TOKENS.WETH }) });
    };
    for (const m of [1n, 2n, 4n, 8n, 16n, 32n]) await run(base * m / 8n);
    if (capRaw) await run(capRaw);
    const profitOf = (t) => t.r.status === "profit" ? t.r.profit : -1n;
    let best = tried.reduce((x, y) => profitOf(y) > profitOf(x) ? y : x, tried[0]);
    if (best && best.r.status === "profit") {
      await run(best.amt * 7n / 10n);
      await run(best.amt * 14n / 10n);
      best = tried.reduce((x, y) => profitOf(y) > profitOf(x) ? y : x, tried[0]);
    }
    const inCap = capRaw ? tried.filter((t) => t.amt <= capRaw) : tried;
    const bestCap = inCap.length ? inCap.reduce((x, y) => profitOf(y) > profitOf(x) ? y : x, inCap[0]) : null;
    const describe = (t) => {
      if (!t) return null;
      const sizeUsd = toUsd(t.amt);
      if (t.r.status !== "profit") return { status: t.r.status, why: "reason" in t.r ? t.r.reason.slice(0, 80) : t.r.status === "loss" ? "loss" : void 0, sizeUsd };
      const grossUsd = toUsd(t.r.profit), gasUsd = gasUsdOf(t.r);
      return { status: "profit", sizeUsd, grossUsd, gasUsd, netUsd: grossUsd === null ? null : grossUsd - (gasUsd ?? 0), gasUsed: t.r.gasUsed?.toString() };
    };
    row.ours = { status: best?.r.status ?? "none", best: describe(best), withinCap: describe(bestCap), sims: tried.length, priceHow: tokenUsd?.how ?? "none", thinPrice: !!tokenUsd && tokenUsd.volumeUsd < 1e3 };
    rows.push(row);
    (0, import_fs3.appendFileSync)(outFile, JSON.stringify(row) + "\n");
    if (rows.length % 50 === 0) console.log(`${rows.length}/${list.length} replayed \xB7 node requests ${requests}`);
  }
  const sum = (xs) => +xs.reduce((s, x) => s + (typeof x === "number" && isFinite(x) ? x : 0), 0).toFixed(2);
  const done = rows.filter((r) => r.rival);
  const trusted = (r) => r.rival.trust === "ok";
  const oursNet = (r, k) => r.ours?.[k]?.status === "profit" && (r.ours[k].netUsd ?? 0) > 0 ? r.ours[k].netUsd : 0;
  const group = (name, rs) => ({
    group: name,
    arbs: rs.length,
    rivalNetUsd_trusted: sum(rs.filter(trusted).map((r) => r.rival.netUsd)),
    rivalNetUsd_all: sum(rs.map((r) => r.rival.netUsd)),
    ourRouteSupported: rs.filter((r) => r.ours && r.ours.status !== "not-ours").length,
    weProfitAfterGas_noLimit: rs.filter((r) => oursNet(r, "best") > 0).length,
    weProfitAfterGas_withinCap: rs.filter((r) => oursNet(r, "withinCap") > 0).length,
    ourNetUsd_noLimit: sum(rs.map((r) => oursNet(r, "best"))),
    ourNetUsd_withinCap: sum(rs.map((r) => oursNet(r, "withinCap"))),
    ourNetUsd_withinCap_trustedPriceOnly: sum(rs.filter((r) => trusted(r) && !r.ours?.thinPrice).map((r) => oursNet(r, "withinCap")))
  });
  const groups = [group("all", done)];
  if (CLOSE) {
    groups.push(group("rival loop (no closing step needed)", done.filter((r) => r.ours && r.ours.status !== "not-ours" && !r.closedWith)));
    groups.push(group("rival open route, we added a closing step", done.filter((r) => r.closedWith)));
  }
  if (done.some((r) => r.hadTrigger !== null)) {
    groups.push(group("right after a trade (trigger)", done.filter((r) => r.hadTrigger)));
    groups.push(group("sitting gap / after another arb", done.filter((r) => r.hadTrigger === false)));
  }
  for (const bk of [...new Set(done.map((r) => r.bucket).filter(Boolean))]) groups.push(group(`gap age: ${bk}`, done.filter((r) => r.bucket === bk)));
  const bySize = /* @__PURE__ */ new Map();
  for (const r of done) {
    const k = sizeBucket(r.rival.sizeUsd);
    (bySize.get(k) ?? bySize.set(k, []).get(k)).push(r);
  }
  const notOurs = /* @__PURE__ */ new Map();
  for (const r of done) if (r.ours?.status === "not-ours") notOurs.set(r.ours.why, (notOurs.get(r.ours.why) ?? 0) + 1);
  const replayOutcome = /* @__PURE__ */ new Map();
  for (const r of done) if (r.ours && r.ours.status !== "not-ours") {
    const k = r.ours.best?.status ?? r.ours.status;
    replayOutcome.set(k, (replayOutcome.get(k) ?? 0) + 1);
  }
  const summary = {
    arbsInFile: list.length,
    classified: recs.size,
    priced: done.length,
    ownMoneyLimitUsd: CAP_USD,
    rivalTrust: Object.fromEntries(["ok", "doubtful", "unpriced"].map((t) => [t, done.filter((r) => r.rival.trust === t).length])),
    groups,
    byRivalTradeSize: [...bySize.entries()].map(([k, rs]) => group(`rival size ${k}`, rs)),
    whyNotOurs: Object.fromEntries([...notOurs.entries()].sort((x, y) => y[1] - x[1])),
    ourReplayOutcome: Object.fromEntries(replayOutcome),
    closingSteps: CLOSE ? Object.fromEntries([...done.filter((r) => r.closedWith).reduce((m, r) => {
      const k = r.closedWith.replace(/ \(.*\)$/, "");
      const e = m.get(k) ?? { tried: 0, weProfit: 0, netUsd: 0 };
      e.tried++;
      const n = oursNet(r, "withinCap");
      if (n > 0) {
        e.weProfit++;
        e.netUsd = +(e.netUsd + n).toFixed(2);
      }
      m.set(k, e);
      return m;
    }, /* @__PURE__ */ new Map())]) : void 0,
    unwatchedPoolsUsedByRivals: missingPools.size,
    topUnwatchedPools: [...missingPools.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([pool, n]) => ({ pool, arbs: n })),
    top10_ourNetWithinCap: done.filter((r) => oursNet(r, "withinCap") > 0).sort((x, y) => oursNet(y, "withinCap") - oursNet(x, "withinCap")).slice(0, 10).map((r) => ({ hash: r.hash, path: r.path, closedWith: r.closedWith, trust: r.rival.trust, ourNetUsd: +oursNet(r, "withinCap").toFixed(2), sizeUsd: r.ours.withinCap.sizeUsd && +r.ours.withinCap.sizeUsd.toFixed(0), rivalNetUsd: r.rival.netUsd && +r.rival.netUsd.toFixed(2) })),
    // --learn: each pool we don't watch, what it is, and what our replay found on it.
    learnedPools: LEARN ? (() => {
      const proven = (i) => i.kind === "v4 no-hook" || i.kind === "v2" || i.kind === "algebra" || i.kind === "v3" && ["uniswap-v3", "pancakeswap-v3"].includes(i.dex) ? "proven" : i.kind === "v4 hooked" ? "hooked: not tested" : "fork: not checked";
      const per = /* @__PURE__ */ new Map();
      for (const r of done) for (const id of r.learnedPools ?? []) {
        const e = per.get(id) ?? { arbs: 0, ourRouteSupported: 0, weProfitAfterGas_withinCap: 0, ourNetUsd_withinCap: 0, rivalNetUsd_trusted: 0, replay: {} };
        e.arbs++;
        if (r.rival.trust === "ok" && typeof r.rival.netUsd === "number") e.rivalNetUsd_trusted += r.rival.netUsd;
        if (r.ours && r.ours.status !== "not-ours") {
          e.ourRouteSupported++;
          const k = r.ours.best?.status ?? r.ours.status;
          e.replay[k] = (e.replay[k] ?? 0) + 1;
        } else if (r.ours?.why) e.replay[r.ours.why] = (e.replay[r.ours.why] ?? 0) + 1;
        const n = oursNet(r, "withinCap");
        if (n > 0) {
          e.weProfitAfterGas_withinCap++;
          e.ourNetUsd_withinCap += n;
        }
        per.set(id, e);
      }
      return {
        found: learnedInfo.size,
        readable: [...learnedInfo.values()].filter((i) => i.ok).length,
        byKind: [...learnedInfo.values()].reduce((m, i) => {
          const k = `${i.kind} | ${i.dex}${i.ok ? "" : " | " + i.why}`;
          m[k] = (m[k] ?? 0) + 1;
          return m;
        }, {}),
        top: [...per.entries()].sort((x, y) => y[1].arbs - x[1].arbs).slice(0, 15).map(([id, e]) => {
          const i = learnedInfo.get(id);
          const p = pools.get(id);
          return {
            pool: id,
            kind: i.kind,
            dex: i.dex,
            copy: proven(i),
            coins: p ? `${syms.get(lc2(p.tokenA)) ?? lc2(p.tokenA).slice(0, 8)}/${syms.get(lc2(p.tokenB)) ?? lc2(p.tokenB).slice(0, 8)}` : "?",
            fee: p?.v4?.fee ?? p?.feePips ?? null,
            ...e,
            rivalNetUsd_trusted: +e.rivalNetUsd_trusted.toFixed(2),
            ourNetUsd_withinCap: +e.ourNetUsd_withinCap.toFixed(2)
          };
        })
      };
    })() : void 0,
    nodeRequestsUsed: requests
  };
  (0, import_fs3.writeFileSync)((0, import_path3.join)(OUT, "profit.json"), JSON.stringify(summary, null, 1));
  console.log("SUMMARY " + JSON.stringify(summary));
}
main().catch((e) => {
  console.error("ERROR", e?.stack ?? e);
  process.exit(1);
});
