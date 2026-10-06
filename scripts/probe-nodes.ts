// ============================================================================
// NODE PROBE -- which free Robinhood Chain RPC nodes are usable?
//
// Plain English:
//   For each candidate node: is it really chain 4663, how far behind the
//   official node's block is it, and how fast does it answer (20 requests on
//   one connection: best and median)? Also sends a burst of 30 parallel
//   requests to see if it rate-limits. Read-only, no keys.
//   npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/probe-nodes.js
// ============================================================================

const NODES: Record<string, string> = {
  'robinhood public': 'https://rpc.mainnet.chain.robinhood.com',
  'nodeflare public': 'https://rpc.nodeflare.app/robinhood/public',
};

async function rpc(url: string, method: string, params: unknown[] = []): Promise<{ ms: number; result?: any; error?: string }> {
  const t = performance.now();
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5_000) });
    const ms = performance.now() - t;
    if (res.status !== 200) return { ms, error: `HTTP ${res.status}` };
    const j = await res.json() as any;
    return j.error ? { ms, error: String(j.error.message ?? 'error').slice(0, 60) } : { ms, result: j.result };
  } catch (e) {
    return { ms: performance.now() - t, error: String((e as Error).message).slice(0, 60) };
  }
}

(async () => {
  const ref = await rpc(NODES['robinhood public'], 'eth_blockNumber');
  const refBlock = ref.result ? parseInt(ref.result, 16) : 0;
  for (const [name, url] of Object.entries(NODES)) {
    const chain = await rpc(url, 'eth_chainId');
    const block = await rpc(url, 'eth_blockNumber');
    const times: number[] = [];
    let errs = 0;
    for (let i = 0; i < 20; i++) { const r = await rpc(url, 'eth_blockNumber'); r.error ? errs++ : times.push(r.ms); }
    times.sort((a, b) => a - b);
    const burst = await Promise.all(Array.from({ length: 30 }, () => rpc(url, 'eth_blockNumber')));
    const burstErr = burst.filter((b) => b.error);
    const lag = block.result ? refBlock - parseInt(block.result, 16) : NaN;
    console.log(`${name}: chain ${chain.result ? parseInt(chain.result, 16) : chain.error} · behind official by ${lag} blocks · ` +
      `best ${times[0]?.toFixed(0) ?? '?'} ms, median ${times[Math.floor(times.length / 2)]?.toFixed(0) ?? '?'} ms (${errs}/20 errors) · ` +
      `burst of 30: ${30 - burstErr.length} ok${burstErr.length ? ` (${burstErr[0].error})` : ''}`);
  }
})();
