import { scrub, urlSecretParts } from '../core/logSanitizer';
// ============================================================================
// ROBINHOOD ENDPOINTS -- which servers the bot reads from and sends to
//
// Facts (Oct 2026): Robinhood Chain's sequencer runs in AWS us-east-2 (Ohio),
// orders transactions strictly first come, first served (no Timeboost / no
// paid priority), and accepts transactions directly at
// sequencer.mainnet.chain.robinhood.com. So:
//   READ  : a paid RPC if we have one (Alchemy supports Robinhood mainnet),
//           else the free public RPC.
//   SEND  : straight to the sequencer (skips the public RPC hop).
//
// Read endpoint, in order of preference (first one that answers with chain id
// 4663 wins, checked at startup):
//   1. ROBINHOOD_RPC_HTTP in .env (any provider)
//   2. Alchemy, using the API key already in AVALANCHE_ALCHEMY_WSS (the same
//      Alchemy key works across networks when Robinhood is enabled in the app)
//   3. the public RPC
// Send endpoint: ROBINHOOD_SEND_RPC in .env, else the sequencer.
// ============================================================================

export const ROBINHOOD_PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const ROBINHOOD_SEQUENCER_RPC = 'https://sequencer.mainnet.chain.robinhood.com';
const CHAIN_ID_HEX = '0x1237'; // 4663

// Alchemy key from an Alchemy URL like wss://avax-mainnet.g.alchemy.com/v2/KEY
export function alchemyKeyFrom(url: string | undefined): string | null {
  const m = /alchemy\.com\/v2\/([A-Za-z0-9_-]+)/.exec(url ?? '');
  return m ? m[1] : null;
}

export function readCandidates(env: Record<string, string | undefined> = process.env): { url: string; label: string }[] {
  const out: { url: string; label: string }[] = [];
  if (env.ROBINHOOD_RPC_HTTP) out.push({ url: env.ROBINHOOD_RPC_HTTP, label: 'your ROBINHOOD_RPC_HTTP' });
  const key = alchemyKeyFrom(env.AVALANCHE_ALCHEMY_WSS) ?? alchemyKeyFrom(env.ALCHEMY_URL);
  if (key) out.push({ url: `https://robinhood-mainnet.g.alchemy.com/v2/${key}`, label: 'Alchemy (your key)' });
  out.push({ url: ROBINHOOD_PUBLIC_RPC, label: 'public RPC' });
  return out;
}

// Picks the read endpoint for heavy work (simulations, scan, pool lookups).
// A candidate is checked with eth_chainId, up to 3 tries:
//   - answers chain 4663            -> use it
//   - answers a DIFFERENT chain     -> wrong URL in .env: skip it
//   - no answer / rate limited      -> your own ROBINHOOD_RPC_HTTP is still
//     used (a one-off blip at startup must not drop the paid node for the
//     whole run, which is what happened on 2026-10-05); auto-found keys are
//     skipped instead, since nobody asked for them.
export async function pickRobinhoodReadRpc(
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
  sleepMs = 1_000,
): Promise<{ url: string; label: string }> {
  for (const c of readCandidates(env)) {
    if (c.url === ROBINHOOD_PUBLIC_RPC) return c; // last resort: no need to test
    let wrongChain = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetchFn(c.url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
          signal: AbortSignal.timeout(4000),
        });
        const j = await r.json() as { result?: string };
        if (j.result?.toLowerCase() === CHAIN_ID_HEX) return c;
        if (typeof j.result === 'string') { wrongChain = true; break; } // answered, but another chain
      } catch { /* blip: try again */ }
      if (attempt < 2 && sleepMs > 0) await new Promise((res) => setTimeout(res, sleepMs));
    }
    if (!wrongChain && c.url === env.ROBINHOOD_RPC_HTTP) {
      console.warn(`[robinhood] ${redact(c.url)} did not answer the startup check; using it anyway (it's your ROBINHOOD_RPC_HTTP)`);
      return c;
    }
  }
  return { url: ROBINHOOD_PUBLIC_RPC, label: 'public RPC' };
}

export function robinhoodSendRpc(env: Record<string, string | undefined> = process.env): string {
  return env.ROBINHOOD_SEND_RPC || ROBINHOOD_SEQUENCER_RPC;
}

// Redacts API keys for logs.
// Hides long path segments (Alchemy /v2/KEY, QuickNode /KEY/), query-string
// keys and user:pass, whatever the provider's URL layout.
export const redact = (url: string) => scrub(url, urlSecretParts(url));
