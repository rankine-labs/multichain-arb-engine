// Tests which free Robinhood WebSocket endpoints give newHeads (with logsBloom). Run from the bot folder (needs ws).
const W = require(process.env.HOME + '/multichain-arb-engine/node_modules/ws');
for (const u of ['wss://rpc.mainnet.chain.robinhood.com', 'wss://rpc.mainnet.chain.robinhood.com/ws', 'wss://ws.mainnet.chain.robinhood.com']) {
  const w = new W(u); let n = 0;
  const t = setTimeout(() => { console.log(u, 'headers in 5s:', n); w.terminate(); }, 5000);
  w.on('open', () => w.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] })));
  w.on('message', (m) => { const j = JSON.parse(m); if (j.id) console.log(u, 'sub', JSON.stringify(j).slice(0, 120)); else { n++; if (n === 1) console.log(u, 'bloom?', !!j.params?.result?.logsBloom); } });
  w.on('error', (e) => { console.log(u, 'ERR', e.message); clearTimeout(t); });
}
