import { checkNodesFromEnv, buildCheckRpc, budgetForCheckNode, DEFAULT_DAILY } from '../core/checkNodes';
import { budgetForUrl, nodeUsageToday, registerUrlBudget } from '../core/nodeBudget';
import { endpointLabel } from '../core/endpointLabel';
import { Rpc } from '../execution/simulator';

// Check nodes from .env: unset = exactly the old QuickNode/Alchemy setup;
// set = main + fallback on any provider, each with its own daily allowance.
// Fake URLs only; no network.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const CHAINSTACK = 'https://robinhood-mainnet.core.chainstack.com/FAKEKEY111';
const CHAINSTACK_WSS = 'wss://robinhood-mainnet.core.chainstack.com/FAKEKEY111';
const ALCHEMY = 'https://robinhood-mainnet.g.alchemy.com/v2/FAKEKEY222';
const QUICKNODE = 'https://fake-name.robinhood-mainnet.quiknode.pro/FAKEKEY333/';
const MYSTERY = 'https://rpc.someprovider.example/FAKEKEY444';

async function main() {
  // ---- provider names ----
  assert(endpointLabel(CHAINSTACK) === 'Chainstack' && endpointLabel('https://nd-1-2-3.p2pify.com/abc') === 'Chainstack', 'Chainstack recognised (both host styles)');
  assert(endpointLabel(ALCHEMY) === 'Alchemy' && endpointLabel(QUICKNODE) === 'QuickNode', 'existing provider names unchanged');

  // ---- unset: old behaviour ----
  assert(checkNodesFromEnv({}) === null, 'CHECK_RPC_MAIN unset -> null (old QuickNode/Alchemy code runs unchanged)');
  assert(checkNodesFromEnv({ CHECK_RPC_MAIN: '   ', CHECK_RPC_FALLBACK: ALCHEMY }) === null, 'blank CHECK_RPC_MAIN counts as unset (fallback alone does nothing)');
  const warned: string[] = [];
  assert(checkNodesFromEnv({ CHECK_RPC_MAIN: 'not a url' }, (m) => warned.push(m)) === null && warned.length === 1, 'invalid CHECK_RPC_MAIN -> old behaviour + a warning (checks never silently stop)');

  // ---- set: main + fallback with allowances ----
  const plan = checkNodesFromEnv({ CHECK_RPC_MAIN: CHAINSTACK, CHECK_RPC_FALLBACK: ALCHEMY, CHECK_RPC_MAIN_DAILY: '50,000', CHECK_RPC_FALLBACK_DAILY: '5000' })!;
  assert(!!plan && plan.main.url === CHAINSTACK && plan.main.label === 'Chainstack' && plan.main.daily === 50_000, 'main: Chainstack with its own 50,000/day allowance');
  assert(!!plan.fallback && plan.fallback.url === ALCHEMY && plan.fallback.label === 'Alchemy' && plan.fallback.daily === 5_000, 'fallback: Alchemy with its own 5,000/day allowance');
  assert(plan.warnings.length === 0, 'good settings: no warnings');

  const wssPlan = checkNodesFromEnv({ CHECK_RPC_MAIN: CHAINSTACK_WSS })!;
  assert(wssPlan.main.url === CHAINSTACK && wssPlan.fallback === null, 'wss:// main converted to https://; no fallback when unset');

  const same = checkNodesFromEnv({ CHECK_RPC_MAIN: CHAINSTACK, CHECK_RPC_FALLBACK: CHAINSTACK })!;
  assert(same.fallback === null && same.warnings.length === 1, 'fallback equal to main: ignored with a warning');

  // ---- build: allowances registered, main used first, fallback on refusal ----
  const calls: string[] = [];
  const answers: Record<string, () => Awaited<ReturnType<Rpc>>> = {
    [CHAINSTACK]: () => ({ result: '0xmain' }),
    [ALCHEMY]: () => ({ result: '0xfallback' }),
  };
  const make = (url: string): Rpc => async () => { calls.push(url); return answers[url]!(); };
  const logs: string[] = [];
  const built = buildCheckRpc(plan, (l) => logs.push(l), make);
  assert(built.budgets.main.daily === 50_000 && built.budgets.fallback!.daily === 5_000, 'each check node held to its own allowance');
  assert(budgetForUrl(CHAINSTACK) === built.budgets.main && budgetForUrl(CHAINSTACK + '/') === built.budgets.main, 'existing budget lookup (makeRpc) finds the main node by URL');
  assert(budgetForUrl(ALCHEMY) === built.budgets.fallback, 'exact-URL allowance wins over the built-in Alchemy allowance for that URL');
  assert(built.description.includes('Chainstack') && built.description.includes('50,000/day') && built.description.includes('Alchemy'), 'startup line names providers + allowances');
  assert(!built.description.includes('FAKEKEY'), 'startup line never contains the URL / key');

  const r1 = await built.rpc('eth_call', []);
  assert(r1.result === '0xmain' && calls[calls.length - 1] === CHAINSTACK, 'checks go to the main node first');
  answers[CHAINSTACK] = () => ({ error: { code: 429, message: 'rate limited (HTTP 429)' } });
  const r2 = await built.rpc('eth_call', []);
  assert(r2.result === '0xfallback', 'main refuses (rate/plan limit) -> same check retried on the fallback');
  assert(logs.length === 1 && logs[0]!.includes('Chainstack (checks main)') && logs[0]!.includes('Alchemy (checks backup)') && !logs[0]!.includes('FAKEKEY'), 'switch logged with provider names only');
  const r3 = await built.rpc('eth_call', []);
  assert(r3.result === '0xfallback' && calls[calls.length - 1] === ALCHEMY, 'main rested: next checks stay on the fallback');

  const names = nodeUsageToday().map((u) => u.name);
  assert(names.includes('Chainstack (checks)') && names.includes('Alchemy (checks backup)'), 'both check nodes appear in the "Node usage today" report');

  // ---- no allowance number ----
  const qn = checkNodesFromEnv({ CHECK_RPC_MAIN: QUICKNODE })!;
  assert(budgetForCheckNode(qn.main).name === 'quicknode' && budgetForCheckNode(qn.main).daily === 14_000, 'known provider, no number: keeps its existing allowance (QuickNode 14,000/day)');
  const unknown = checkNodesFromEnv({ CHECK_RPC_MAIN: MYSTERY, CHECK_RPC_MAIN_DAILY: 'lots' })!;
  assert(unknown.warnings.length === 1, 'non-numeric allowance: warning');
  assert(budgetForCheckNode(unknown.main).daily === DEFAULT_DAILY, `unknown provider, no number: safe default ${DEFAULT_DAILY}/day (never unmetered)`);

  // ---- registering twice reuses the same budget (no double counting) ----
  const again = registerUrlBudget(CHAINSTACK, 'Chainstack (checks)', 4, 999);
  assert(again === built.budgets.main && again.daily === 50_000, 'same URL registered twice: one budget');
}

main().catch((e) => { console.error('FAIL: unexpected error', e); process.exitCode = 1; });
