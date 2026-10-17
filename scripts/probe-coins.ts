// Read-only: name, symbol and EIP-1967 beacon of the coins the bot trades most,
// to check which ones the live coin rule (core/liveCoins.ts) will allow.
import { ethers } from 'ethers';
import { writeFileSync, mkdirSync } from 'fs';
const p = new ethers.JsonRpcProvider('https://rpc.mainnet.chain.robinhood.com', 4663, { staticNetwork: true });
const SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const I = new ethers.Interface(['function name() view returns (string)', 'function symbol() view returns (string)']);
const COINS: Record<string, string> = {
  SPY: '0x117cc2133c37b721f49de2a7a74833232b3b4c0c', NVDA: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', TSLA: '0x322f0929c4625ed5bad873c95208d54e1c003b2d',
  META: '0xc0d6457c16cc70d6790dd43521c899c87ce02f35', AAPL: '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9', GOOGL: '0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3',
  gld: '0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e', SPCX: '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea', MSTR: '0xec262a75e413fafd0df80480274532c79d42da09',
  CRCL: '0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5', amc: '0x05a3d1cd21d0c88145e82600e62e7e496e0f222b', HIMS: '0xccee82fe024c36fa15e1005ede3e9e4787e23d09',
  USO: '0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344', PLTR: '0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a', cbBTC: '0xcec185eb182c47d1ba1efc84e6959e18cd620be4',
  MU: '0xff080c8ce2e5feadaca0da81314ae59d232d4afd', INTC: '0xc72b96e0e48ecd4dc75e1e45396e26300bc39681', AMD: '0x86923f96303d656e4aa86d9d42d1e57ad2023fdc',
  GME: '0x1b0e319c6a659f002271b69db8a7df2f911c153e', NET: '0xca9c78dd337a67f6e0077f65f5e9218719d30edf', LLY: '0x8005d266423c7ea827372c9c864491e5786600ea',
  MRNA: '0x43b07d15ce533bec5476d70c22a78a1b2b662155', RBLX: '0xf0c4bf4c582cb3836e98394b1d4e7b7281101be8', SGOV: '0x92fd66527192e3e61d4ddd13322aa222de86f9b5',
  CASHCAT: '0x020bfc650a365f8bb26819deaabf3e21291018b4', PONS: '0x39dbed3a2bd333467115de45665cc57f813c4571', VIRTUAL: '0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31',
  HOOD: '0x0', U: '0xce24439f2d9c6a2289f741120fe202248b666666', USDG: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
};
(async () => {
  const out: any = {};
  for (const [k, a] of Object.entries(COINS)) {
    if (a === '0x0') continue;
    try {
      const raw = await p.getStorage(a, SLOT);
      const call = async (f: string) => { try { return String(I.decodeFunctionResult(f, await p.call({ to: a, data: I.encodeFunctionData(f) }))[0]); } catch { return ''; } };
      out[k] = { address: a, beacon: '0x' + raw.slice(-40), name: await call('name'), symbol: await call('symbol') };
    } catch (e) { out[k] = { address: a, error: String((e as Error).message).slice(0, 80) }; }
  }
  mkdirSync('results', { recursive: true });
  writeFileSync('results/coins.json', JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
})();
