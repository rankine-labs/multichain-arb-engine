// Names an RPC/websocket endpoint by what it ACTUALLY is (from its host), not
// by the setting it came from. A setting called AVALANCHE_ALCHEMY_WSS that
// holds the free public Avalanche URL is the public node, and the logs must
// say so (it hid why Avalanche saw no pending transactions).
const PUBLIC_HOSTS = ['api.avax.network', 'rpc.monad.xyz', 'rpc.mainnet.chain.robinhood.com'];

export function endpointLabel(url: string | undefined): string {
  if (!url) return 'not set';
  let host = '';
  try { host = new URL(url).host; } catch { return 'invalid URL'; }
  if (host.includes('alchemy.com')) return 'Alchemy';
  if (host.includes('quiknode') || host.includes('quicknode')) return 'QuickNode';
  if (host.includes('blockrazor')) return 'BlockRazor';
  // Other paid providers, so "any provider" setups (docs/NODE_PROVIDERS.md)
  // show a friendly name instead of a raw host. Chainstack hosts look like
  // nd-123-456-789.p2pify.com or *.core.chainstack.com.
  if (host.includes('chainstack') || host.endsWith('p2pify.com')) return 'Chainstack';
  if (host.includes('infura.io')) return 'Infura';
  if (host.includes('ankr.com')) return 'Ankr';
  if (host.includes('drpc.org')) return 'dRPC';
  if (host.includes('getblock.io')) return 'GetBlock';
  if (host.includes('blastapi.io')) return 'Blast';
  if (PUBLIC_HOSTS.some((h) => host.endsWith(h))) return `free public node (${host})`;
  return host;
}

export const isPublicEndpoint = (url: string | undefined) => endpointLabel(url).startsWith('free public node');
