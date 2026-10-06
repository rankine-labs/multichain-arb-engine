import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';

// ============================================================================
// NODE BUDGETS -- a speed limit and a daily allowance for every RPC node.
//
// Plain English:
//   Each node (Robinhood's free node, Nodeflare, QuickNode, Alchemy) is like a
//   phone data plan: a speed limit (requests per second) and a monthly cap.
//   We blew Alchemy's monthly cap in 6 days because nothing counted. Now:
//     - SPEED LIMIT: requests wait their turn at a steady pace instead of
//       bursting (bursts are what get us "slow down" / rate-limited).
//     - DAILY ALLOWANCE: monthly cap / 30-ish, per node. When a node's
//       allowance is used up, requests to it fail with a "budget used up"
//       error (treated like a rate limit), so that job pauses or moves to
//       its own backup. It never silently drains the month.
//     - Counts are saved to disk, so restarts don't reset them, and reset
//       at midnight UTC (when providers count their days).
//
// A request counts once per call inside it (a JSON-RPC batch of 5 = 5). A
// multicall bundle is ONE call, which is why bundling saves so much.
//
// Defaults (override in .env, e.g. NODE_BUDGET_QUICKNODE_DAILY=12000):
//   public     8 req/s, no daily cap (free, but throttles bursts)
//   nodeflare  3 req/s,  8,000/day   (3M units/month, backup only)
//   quicknode  4 req/s, 14,000/day   (10M credits/month, ~20 per call)
//   alchemy   10 req/s, 30,000/day   (30M units/month, ~26 per call)
// ============================================================================

export class BudgetExceeded extends Error {
  // Daily allowance used up: "429" in the text makes callers treat it like a
  // rate limit (rest that node, use its own backup). A full speed-limit
  // queue is NOT a sick node: no "429", so nothing gets rested or moved; the
  // request simply fails and its job retries later.
  constructor(node: string, why: string, readonly queueFull = false) { super(queueFull ? `${node} ${why}, try again shortly` : `${node} ${why} (429)`); }
}

export class NodeBudget {
  private tokens: number;
  private lastRefill: number;
  usedToday = 0;
  day: string;

  constructor(
    readonly name: string,
    readonly rps: number,
    readonly daily: number,                  // Infinity = no daily cap
    private readonly now: () => number = Date.now,
    private readonly maxWaitMs = 30_000,     // requests wait their turn up to this long
  ) {
    this.tokens = Math.max(1, rps);
    this.lastRefill = now();
    this.day = dayKey(now());
  }

  private rollDay() {
    const d = dayKey(this.now());
    if (d !== this.day) { this.day = d; this.usedToday = 0; }
  }

  // Wait for room under the speed limit, then count `n` calls. Throws
  // BudgetExceeded when the daily allowance is used up or the queue is too long.
  async take(n = 1): Promise<void> {
    this.rollDay();
    if (this.usedToday + n > this.daily) throw new BudgetExceeded(this.name, 'daily allowance used up');
    const t = this.now();
    this.tokens = Math.min(Math.max(1, this.rps), this.tokens + ((t - this.lastRefill) / 1000) * this.rps);
    this.lastRefill = t;
    this.tokens -= n;
    if (this.tokens < 0) {
      const waitMs = (-this.tokens / this.rps) * 1000;
      if (waitMs > this.maxWaitMs) { this.tokens += n; throw new BudgetExceeded(this.name, 'speed limit queue full', true); }
      await new Promise((r) => setTimeout(r, waitMs));
    }
    this.usedToday += n;
  }

  share() { return this.daily === Infinity ? 0 : this.usedToday / this.daily; }
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ---- Registry: one budget per node, picked by the node's URL -----------------
const DEFAULTS: Record<string, { rps: number; daily: number; match: RegExp }> = {
  alchemy:   { rps: 10, daily: 30_000, match: /alchemy\.com/i },
  quicknode: { rps: 4,  daily: 14_000, match: /quiknode|quicknode/i },
  nodeflare: { rps: 3,  daily: 8_000,  match: /nodeflare/i },
  public:    { rps: 8,  daily: Infinity, match: /rpc\.mainnet\.chain\.robinhood\.com/i },
};

const budgets = new Map<string, NodeBudget>();
let usageFile: string | null = null;

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function get(name: string): NodeBudget {
  let b = budgets.get(name);
  if (!b) {
    const d = DEFAULTS[name];
    b = new NodeBudget(name, envNum(`NODE_BUDGET_${name.toUpperCase()}_RPS`, d.rps), envNum(`NODE_BUDGET_${name.toUpperCase()}_DAILY`, d.daily));
    budgets.set(name, b);
  }
  return b;
}

// The budget for a node URL, or null for nodes we don't meter (e.g. the
// sequencer we send trades to).
export function budgetForUrl(url: string): NodeBudget | null {
  for (const [name, d] of Object.entries(DEFAULTS)) if (d.match.test(url)) return get(name);
  return null;
}

// How many calls a JSON-RPC request body holds (a batch counts each call).
export function callsInBody(body: unknown): number {
  try {
    const text = typeof body === 'string' ? body : body instanceof Uint8Array ? new TextDecoder().decode(body) : '';
    const j = JSON.parse(text);
    return Array.isArray(j) ? Math.max(1, j.length) : 1;
  } catch { return 1; }
}

// Usage survives restarts: load at startup, save every minute.
export function loadNodeUsage(file: string) {
  usageFile = file;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { day: string; used: number }>;
    const today = dayKey(Date.now());
    for (const [name, u] of Object.entries(j)) {
      if (!DEFAULTS[name] || u.day !== today) continue;
      const b = get(name);
      b.usedToday = Number(u.used) || 0;
    }
  } catch { /* first run */ }
}
export function saveNodeUsage() {
  if (!usageFile) return;
  try {
    const out: Record<string, { day: string; used: number }> = {};
    for (const [name, b] of budgets) out[name] = { day: b.day, used: b.usedToday };
    mkdirSync(dirname(usageFile), { recursive: true });
    writeFileSync(usageFile + '.tmp', JSON.stringify(out));
    renameSync(usageFile + '.tmp', usageFile);
  } catch { /* best effort */ }
}

// For the hourly report: today's usage per metered node.
export function nodeUsageToday(): { name: string; used: number; daily: number }[] {
  return [...budgets.values()].map((b) => ({ name: b.name, used: b.usedToday, daily: b.daily }));
}
