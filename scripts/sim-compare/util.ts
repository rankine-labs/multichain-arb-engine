// ============================================================================
// SIM-COMPARE helpers: files, node access, speed limit, small maths.
//
// Safety rules kept here, in one place:
//   - From the bot's .env we read ONLY the node URL lines named in NODE_VARS.
//     Nothing else in that file is looked at, and URLs are never printed
//     (they contain API keys): logs show the provider name only.
//   - Every node request goes through one speed limit (--rps), the bot's own
//     per-node daily allowance (core/nodeBudget.ts, loaded read-only from
//     data/node-usage.json) and a hard cap on requests for the whole run.
// ============================================================================
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { createInterface } from 'readline';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { makeRpc, Rpc, isRateLimited, wssToHttps } from '../../src/execution/simulator';
import { endpointLabel } from '../../src/core/endpointLabel';
import { loadNodeUsage, budgetForUrl } from '../../src/core/nodeBudget';

// ---- JSON with big whole numbers ------------------------------------------
// Same convention as the bot's watch-list file: a bigint is saved as {"$b":"123"}.
export const bigReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? { $b: v.toString() } : v);
export const bigReviver = (_k: string, v: any) => (v && typeof v === 'object' && typeof v.$b === 'string' ? BigInt(v.$b) : v);

export const sha = (s: string, n = 16) => createHash('sha256').update(s).digest('hex').slice(0, n);
export const hex = (n: number | bigint) => '0x' + BigInt(n).toString(16);
export const lc = (s: string) => s.toLowerCase();

// Append one record as a line (survives Ctrl-C: each line is written whole).
export function appendJsonl(file: string, rec: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(rec, bigReplacer) + '\n');
}

// Read a JSONL file line by line (low memory). A half-written last line
// (power cut / kill -9) is skipped, never fatal.
export async function* readJsonl<T>(file: string): AsyncGenerator<T> {
  if (!existsSync(file)) return;
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line, bigReviver) as T; } catch { /* torn line: skip */ }
  }
}

// Load a JSONL file into a map by id (the LAST record for an id wins).
export async function loadById<T extends { id: string }>(file: string): Promise<Map<string, T>> {
  const m = new Map<string, T>();
  for await (const r of readJsonl<T>(file)) if (r && typeof r.id === 'string') m.set(r.id, r);
  return m;
}

export function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(data, bigReplacer, 2));
  renameSync(file + '.tmp', file);
}

export function readJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, 'utf8'), bigReviver) as T; } catch { return null; }
}

// ---- Repeatable "random" numbers (same seed = same sample every run) -------
export function rng(seed: string): () => number {
  let a = parseInt(sha(seed, 8), 16) >>> 0;
  return () => { // mulberry32
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pick k items without repeats, repeatably.
export function sample<T>(items: T[], k: number, seed: string): T[] {
  if (items.length <= k) return [...items];
  const r = rng(seed);
  const idx = items.map((_, i) => i);
  for (let i = 0; i < k; i++) { const j = i + Math.floor(r() * (idx.length - i)); [idx[i], idx[j]] = [idx[j]!, idx[i]!]; }
  return idx.slice(0, k).map((i) => items[i]!);
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
}
export function pct(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}

// ---- Which node to use -----------------------------------------------------
// Same preference order as the bot's simulator (simRpcUrl) and the fixture
// grabber: the explicit check node first, then the paid nodes.
export const NODE_VARS = ['SIM_RPC_ROBINHOOD', 'QUICKNODE_RPC_ROBINHOOD', 'ROBINHOOD_RPC_HTTP'] as const;

// Returns the first usable node URL. Looks at the process environment first,
// then ONLY the NODE_VARS lines of <botDir>/.env. `only` = use just that variable.
export function findNodeUrl(botDir: string, env: Record<string, string | undefined> = process.env, only?: string): { name: string; url: string; label: string } | null {
  let text = '';
  try { text = readFileSync(join(botDir, '.env'), 'utf8'); } catch { /* no .env */ }
  const vars = only ? [only] : [...NODE_VARS];
  for (const v of vars) {
    if (!(NODE_VARS as readonly string[]).includes(v)) continue; // never read any other line
    const m = text.match(new RegExp(`^\\s*${v}\\s*=\\s*["']?([^"'\\s#]+)`, 'm'));
    let url = env[v] || (m ? m[1] : undefined);
    if (!url) continue;
    if (url.startsWith('wss://')) url = wssToHttps(url) ?? undefined; // QuickNode serves HTTP on the same URL
    if (url && /^https?:\/\//.test(url)) return { name: v, url, label: endpointLabel(url) };
  }
  return null;
}

// ---- Speed limit -----------------------------------------------------------
export class RateLimiter {
  private next = 0;
  constructor(private readonly rps: number, private readonly now: () => number = Date.now) {}
  async take(): Promise<void> {
    const gap = 1000 / Math.max(0.1, this.rps);
    const t = this.now();
    const at = Math.max(t, this.next);
    this.next = at + gap;
    if (at > t) await new Promise((r) => setTimeout(r, at - t));
  }
}

export interface RpcStats { total: number; byMethod: Record<string, number>; retries: number; capHit: boolean }

// The harness's node connection:
//   speed limit (--rps) -> request cap (--max-requests) -> the bot's own
//   per-node budget (makeRpc: speed limit + daily allowance, the bot's usage
//   today loaded read-only) -> the node. "Slow down" answers are retried with
//   growing pauses (2, 4, 8, 16 s) before giving up; a give-up is NOT stored
//   as an answer, so --resume tries that check again later.
export function makeHarnessRpc(
  url: string,
  opts: { rps: number; maxRequests: number; timeoutMs?: number; usageFile?: string; base?: Rpc; sleep?: (ms: number) => Promise<void> },
): { rpc: Rpc; stats: RpcStats } {
  if (opts.usageFile && !opts.base) loadNodeUsage(opts.usageFile); // read only: we never save it (the bot owns that file)
  const base = opts.base ?? makeRpc(url, opts.timeoutMs ?? 30_000);
  const limiter = new RateLimiter(opts.rps);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stats: RpcStats = { total: 0, byMethod: {}, retries: 0, capHit: false };
  const rpc: Rpc = async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      if (stats.total >= opts.maxRequests) { stats.capHit = true; return { error: { code: 429, message: 'harness request cap reached (--max-requests)' } }; }
      await limiter.take();
      stats.total++;
      stats.byMethod[method] = (stats.byMethod[method] ?? 0) + 1;
      const r = await base(method, params);
      const trouble = r.error && (isRateLimited(r.error) || String(r.error.message ?? '').startsWith('network:'));
      if (!trouble || attempt >= 4 || /daily allowance/.test(String(r.error?.message))) return r;
      stats.retries++;
      await sleep(2000 * 2 ** attempt);
    }
  };
  return { rpc, stats };
}

// Today's use of that node by the bot, for the "is there room?" check at start.
export function nodeAllowance(url: string): { name: string; used: number; daily: number } | null {
  const b = budgetForUrl(url);
  return b ? { name: b.name, used: b.usedToday, daily: b.daily } : null;
}
