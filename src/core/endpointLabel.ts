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
  if (PUBLIC_HOSTS.some((h) => host.endsWith(h))) return `free public node (${host})`;
  return host;
}

export const isPublicEndpoint = (url: string | undefined) => endpointLabel(url).startsWith('free public node');
