import { endpointLabel } from './endpointLabel';
import { budgetForUrl, registerUrlBudget, NodeBudget } from './nodeBudget';
import { nodeUsage, NodeUsageCounter } from './nodeUsage';
import { makeRpc, makeFallbackRpc, wssToHttps, Rpc } from '../execution/simulator';

// ============================================================================
// CHECK NODES FROM .env -- run practice checks on ANY node provider.
//
// Plain English:
//   "Checks" are the practice tests of a trade on the real chain (eth_call
//   with a pretend balance + eth_simulateV1). Nothing is sent, nothing is
//   spent. Today they run on QuickNode with Alchemy as backup, and those two
//   names are built into the code.
//
//   These settings let the owner pick any provider instead, just by editing
//   .env (see docs/NODE_PROVIDERS.md):
//     CHECK_RPC_MAIN            the node checks run on (https:// or wss:// URL)
//     CHECK_RPC_FALLBACK        optional backup node, used for 5 minutes
//                               whenever the main one refuses (rate or plan
//                               limit, or can't be reached)
//     CHECK_RPC_MAIN_DAILY      daily allowance (requests) for the main node
//     CHECK_RPC_FALLBACK_DAILY  daily allowance for the backup node
//     CHECK_RPC_MAIN_RPS / CHECK_RPC_FALLBACK_RPS   optional speed limits
//                               (requests per second, default 4)
//
//   CHECK_RPC_MAIN NOT set  ->  nothing changes: QuickNode + Alchemy exactly
//                               as before (this file returns null).
//   CHECK_RPC_MAIN set      ->  checks use main, then fallback, each held to
//                               its own daily allowance by the existing
//                               allowance system (core/nodeBudget.ts).
//
//   No allowance number given:
//     - a provider the bot already knows (QuickNode, Alchemy, ...) keeps its
//       existing allowance (e.g. QuickNode 14,000/day)
//     - any other provider gets DEFAULT_DAILY (10,000/day) so it can never
//       drain a monthly plan silently.
//
//   Logs only ever show the provider name taken from the URL's host (e.g.
//   "Chainstack"), never the URL itself (URLs hold API keys).
// ============================================================================

// Safe defaults for a provider the bot has never heard of.
export const DEFAULT_DAILY = 10_000;
export const DEFAULT_RPS = 4;

// One check node, fully described (no network yet).
export interface CheckNode {
  url: string;            // https URL used for requests (never logged)
  label: string;          // provider name for logs, e.g. "Chainstack"
  budgetName: string;     // name in the "Node usage today" report
  daily: number | null;   // allowance from .env, null = use the provider's existing one / default
  rps: number;            // speed limit (requests per second)
}

// What .env asks for. null = CHECK_RPC_MAIN not set (keep today's behaviour).
export interface CheckNodePlan {
  main: CheckNode;
  fallback: CheckNode | null;
  warnings: string[];     // plain-English problems with the settings (already safe to log)
}

// Accept https:// or wss:// (converted to https, same path). Anything else
// is not usable for checks.
function toHttp(raw: string | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  if (/^wss:\/\//i.test(v)) return wssToHttps(v);
  if (/^https?:\/\//i.test(v)) {
    try { new URL(v); return v; } catch { return null; }
  }
  return null;
}

// A positive number from .env, or null when unset / not a number.
function positive(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw.replace(/[_,]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Read the CHECK_RPC_* settings. Pure (no network, no global changes), so it
// can be tested with a plain object instead of the real .env.
// warn: told about a CHECK_RPC_MAIN that can't be used (the plan is null then,
// so there is no warnings list to carry the message).
export function checkNodesFromEnv(env: Record<string, string | undefined> = process.env, warn: (msg: string) => void = () => {}): CheckNodePlan | null {
  const rawMain = env.CHECK_RPC_MAIN;
  if (!rawMain || !rawMain.trim()) return null;            // not set: old behaviour
  const warnings: string[] = [];
  const mainUrl = toHttp(rawMain);
  if (!mainUrl) {
    // A typo must not silently stop all checks: fall back to old behaviour and say so.
    warn('CHECK_RPC_MAIN is not a valid https:// or wss:// URL; ignoring it and keeping QuickNode/Alchemy');
    return null;
  }
  const mainLabel = endpointLabel(mainUrl);
  const main: CheckNode = {
    url: mainUrl, label: mainLabel, budgetName: `${mainLabel} (checks)`,
    daily: positive(env.CHECK_RPC_MAIN_DAILY), rps: positive(env.CHECK_RPC_MAIN_RPS) ?? DEFAULT_RPS,
  };
  if (env.CHECK_RPC_MAIN_DAILY && main.daily === null) warnings.push('CHECK_RPC_MAIN_DAILY is not a positive number; using the default allowance');

  let fallback: CheckNode | null = null;
  if (env.CHECK_RPC_FALLBACK && env.CHECK_RPC_FALLBACK.trim()) {
    const fbUrl = toHttp(env.CHECK_RPC_FALLBACK);
    if (!fbUrl) warnings.push('CHECK_RPC_FALLBACK is not a valid https:// or wss:// URL; checks will run without a backup');
    else if (fbUrl === mainUrl) warnings.push('CHECK_RPC_FALLBACK is the same URL as CHECK_RPC_MAIN; no separate backup');
    else {
      const fbLabel = endpointLabel(fbUrl);
      fallback = {
        url: fbUrl, label: fbLabel, budgetName: `${fbLabel} (checks backup)`,
        daily: positive(env.CHECK_RPC_FALLBACK_DAILY), rps: positive(env.CHECK_RPC_FALLBACK_RPS) ?? DEFAULT_RPS,
      };
      if (env.CHECK_RPC_FALLBACK_DAILY && fallback.daily === null) warnings.push('CHECK_RPC_FALLBACK_DAILY is not a positive number; using the default allowance');
    }
  }
  return { main, fallback, warnings };
}

// Give a check node its daily allowance in the existing allowance system:
//   - allowance set in .env  -> its own exact-URL budget with that number
//   - known provider, no number -> keep the provider's existing budget
//   - unknown provider, no number -> its own budget at DEFAULT_DAILY
// Returns the budget that will meter this node.
export function budgetForCheckNode(n: CheckNode): NodeBudget {
  if (n.daily !== null) return registerUrlBudget(n.url, n.budgetName, n.rps, n.daily);
  return budgetForUrl(n.url) ?? registerUrlBudget(n.url, n.budgetName, n.rps, DEFAULT_DAILY);
}

// Wrap an Rpc so every request is also tallied in the per-node usage counter
// (metered = the allowance report already lists it, so it isn't repeated).
export function countedRpc(rpc: Rpc, label: string, counter: NodeUsageCounter = nodeUsage): Rpc {
  counter.track(label, true);
  return (method, params) => { counter.countRequest(label, 1, true); return rpc(method, params); };
}

// Build the check Rpc from a plan: allowances registered first (makeRpc looks
// up the budget by URL when it is created), then main -> fallback.
// `make` is swappable so tests never touch the network.
export function buildCheckRpc(
  plan: CheckNodePlan,
  log: (line: string) => void = console.warn,
  make: (url: string) => Rpc = makeRpc,
): { rpc: Rpc; description: string; budgets: { main: NodeBudget; fallback: NodeBudget | null } } {
  const mainBudget = budgetForCheckNode(plan.main);
  const fbBudget = plan.fallback ? budgetForCheckNode(plan.fallback) : null;
  const mainRpc = countedRpc(make(plan.main.url), plan.main.budgetName);
  let rpc: Rpc = mainRpc;
  if (plan.fallback) {
    const fb = plan.fallback;
    const fbRpc = countedRpc(make(fb.url), fb.budgetName);
    // makeFallbackRpc's message talks about "paid node" / "public node";
    // name the real providers instead (names only, never URLs).
    rpc = makeFallbackRpc(mainRpc, fbRpc, (m) => log(`[sim] robinhood ${m.replace('paid node', `${plan.main.label} (checks main)`).replace('the public node', `${fb.label} (checks backup)`)}`));
  }
  const allow = (b: NodeBudget) => (b.daily === Infinity ? 'no daily cap' : `${b.daily.toLocaleString('en-US')}/day`);
  const description = `checks on ${plan.main.label} (${allow(mainBudget)})` + (plan.fallback && fbBudget ? `, fallback ${plan.fallback.label} (${allow(fbBudget)})` : ', no fallback');
  return { rpc, description, budgets: { main: mainBudget, fallback: fbBudget } };
}
