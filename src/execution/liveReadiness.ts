import { ethers } from 'ethers';
import { runStartupValidation, AddressEntry } from '../core/startupValidation';
import { ChainName } from '../core/types';

// ============================================================================
// LIVE READINESS -- checks that must pass before the bot sends a real trade.
//
// Runs only when live mode is on. Until it passes, every live send is
// blocked ("live checks not passed"). It confirms, against the real chain:
//   1. the RPC is on the expected chain (Robinhood = 4663)
//   2. the executor contract, WETH and USDG have code (startupValidation)
//   3. the executor's `executor` role is THIS bot wallet (otherwise every
//      trade reverts NotExecutor and burns gas)
//   4. every flash lender in FLASH_LENDERS_* is approved on the contract
//   5. the ArbSys precompile (address 100) answers arbBlockNumber() within
//      the contract's 20k gas cap and matches eth_blockNumber, i.e. the
//      contract's trade deadline uses the right block number
// ============================================================================

const EXEC_ABI = [
  'function executor() view returns (address)',
  'function owner() view returns (address)',
  'function flashPools(address) view returns (bool)',
];
const ARBSYS = '0x0000000000000000000000000000000000000064';
const ARB_BLOCK = new ethers.Interface(['function arbBlockNumber() view returns (uint256)']);

// ArbSys answer vs the RPC's block number. Exported for the probe script.
export async function checkArbSys(provider: ethers.JsonRpcProvider): Promise<{ ok: boolean; arbBlock?: bigint; rpcBlock?: number; error?: string }> {
  try {
    const [ret, rpcBlock] = await Promise.all([
      provider.call({ to: ARBSYS, data: ARB_BLOCK.encodeFunctionData('arbBlockNumber'), gasLimit: 20_000n }),
      provider.getBlockNumber(),
    ]);
    const [arbBlock] = ARB_BLOCK.decodeFunctionResult('arbBlockNumber', ret);
    const diff = Number(BigInt(arbBlock) - BigInt(rpcBlock));
    // Both read "latest"; a few blocks apart is normal at 0.1 s blocks.
    return { ok: Math.abs(diff) <= 50, arbBlock: BigInt(arbBlock), rpcBlock };
  } catch (err) {
    return { ok: false, error: (err as Error).message?.slice(0, 120) };
  }
}

export async function checkLiveReady(provider: ethers.JsonRpcProvider, o: {
  chain: ChainName; executor?: string; sender: string; tokens: { address: string; label: string }[]; lenders: string[];
}): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  if (!o.executor) return { ok: false, problems: ['ARB_EXECUTOR not set'] };

  const entries: AddressEntry[] = [
    { address: o.executor, label: 'ArbExecutor', status: 'UNCHECKED' },
    ...o.tokens.map((t) => ({ address: t.address, label: t.label, status: 'VERIFIED' as const })),
  ];
  const v = await runStartupValidation(provider, o.chain, entries);
  if (!v.chainIdCheck.ok) problems.push(`wrong chain: RPC is ${v.chainIdCheck.actual}, expected ${v.chainIdCheck.expected}`);
  for (const r of v.results) if (!r.hasBytecode) problems.push(`${r.label} has no contract code`);

  try {
    const c = new ethers.Contract(o.executor, EXEC_ABI, provider);
    const role = String(await c.executor());
    if (role.toLowerCase() !== o.sender.toLowerCase()) problems.push(`contract executor is ${role.slice(0, 10)}…, not this bot wallet`);
    for (const l of o.lenders) {
      if (!(await c.flashPools(l))) problems.push(`lender ${l.slice(0, 10)}… is in FLASH_LENDERS but not approved on the contract`);
    }
  } catch (err) {
    problems.push(`could not read the executor contract: ${(err as Error).message?.slice(0, 80)}`);
  }

  if (o.chain === 'robinhood') {
    const a = await checkArbSys(provider);
    if (!a.ok) problems.push(`ArbSys block check failed (${a.error ?? `arb ${a.arbBlock} vs rpc ${a.rpcBlock}`})`);
  }
  return { ok: problems.length === 0, problems };
}
