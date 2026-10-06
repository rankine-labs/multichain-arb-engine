// ============================================================================
// ARBSYS PROBE -- does the contract's trade deadline read the right block?
//
// Plain English:
//   ArbExecutor checks its deadline with ArbSys.arbBlockNumber() (address
//   100), with a 20,000 gas cap on that call. Fork tests can't run the real
//   precompile, so this asks the LIVE chain directly, with the same gas cap,
//   and compares the answer to eth_blockNumber. They should be within a few
//   blocks. Read-only, no keys.
//   npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/probe-arbsys.js
// ============================================================================
import { ethers } from 'ethers';
import { checkArbSys } from '../src/execution/liveReadiness';

const provider = new ethers.JsonRpcProvider(process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com', 4663, { staticNetwork: true });

(async () => {
  let pass = 0;
  for (let i = 0; i < 5; i++) {
    const r = await checkArbSys(provider);
    const line = r.error ? `error: ${r.error}` : `arbBlockNumber ${r.arbBlock} vs eth_blockNumber ${r.rpcBlock} (diff ${Number(r.arbBlock! - BigInt(r.rpcBlock!))})`;
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${line}`);
    if (r.ok) pass++;
    await new Promise((res) => setTimeout(res, 500));
  }
  console.log(pass === 5 ? 'RESULT: ArbSys deadline check works on the live chain (20k gas cap is enough)' : `RESULT: ${5 - pass}/5 checks failed`);
  process.exit(pass === 5 ? 0 : 1);
})();
