// Read-only: the live contract's coin balances and the bot wallet's gas (Oct 19).
import { ethers } from 'ethers';
import { writeFileSync, mkdirSync } from 'fs';
const p = new ethers.JsonRpcProvider('https://rpc.mainnet.chain.robinhood.com', 4663, { staticNetwork: true });
const CONTRACT = '0x7E0f847dd429E7C15Ab08686d28710389c1F7837';
const BOT = '0x09B4fb908ff646Afa9c9878C082Add7e4b3784D6';
const TOKENS: Record<string, string> = { WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' };
const I = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)']);
(async () => {
  const out: any = { at: new Date().toISOString(), block: await p.getBlockNumber(), contract: CONTRACT };
  for (const [k, t] of Object.entries(TOKENS)) {
    const bal = I.decodeFunctionResult('balanceOf', await p.call({ to: t, data: I.encodeFunctionData('balanceOf', [CONTRACT]) }))[0] as bigint;
    const dec = Number(I.decodeFunctionResult('decimals', await p.call({ to: t, data: I.encodeFunctionData('decimals') }))[0]);
    out[k] = ethers.formatUnits(bal, dec);
  }
  out.contractNativeETH = ethers.formatEther(await p.getBalance(CONTRACT));
  out.botWalletETH = ethers.formatEther(await p.getBalance(BOT));
  mkdirSync('results', { recursive: true });
  writeFileSync('results/balances.json', JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
})();
