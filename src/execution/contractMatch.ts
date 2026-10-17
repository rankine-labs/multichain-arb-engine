import { ethers } from 'ethers';
import { ARB_EXECUTOR_RUNTIME_CODE } from './arbExecutorBytecode';

// ============================================================================
// IS THE DEPLOYED CONTRACT THE TESTED ONE? (Oct 17, owner approved)
//
// Plain English:
//   Every exchange we add is tested ("fork-tested") with the contract code in
//   this repo. If the contract deployed on chain is EXACTLY that code, those
//   tests prove the real contract can trade those exchanges too. This reads
//   the deployed contract's code and compares it, byte for byte (by hash),
//   with the repo's compiled copy (src/execution/arbExecutorBytecode.ts,
//   which CI checks against a fresh `forge build`).
//
//   The contract has no "immutable" values, so a contract deployed from
//   this repo with the normal build has exactly this code; the owner, bot
//   wallet, lenders and V4 settings live in storage, not in the code.
//
//   Read-only: one eth_getCode call. Never throws.
// ============================================================================

export interface ContractMatch { match: boolean; reason: string }

export function sameCode(deployed: string, tested: string = ARB_EXECUTOR_RUNTIME_CODE): boolean {
  if (!deployed || deployed === '0x' || !tested) return false;
  return ethers.keccak256(deployed.toLowerCase()) === ethers.keccak256(tested.toLowerCase());
}

export async function checkDeployedContract(provider: ethers.JsonRpcProvider, address: string | undefined): Promise<ContractMatch> {
  if (!address) return { match: false, reason: 'ARB_EXECUTOR_ROBINHOOD not set' };
  try {
    const code: string = await provider.getCode(address);
    if (!code || code === '0x') return { match: false, reason: 'no contract code at ARB_EXECUTOR_ROBINHOOD' };
    if (sameCode(code)) return { match: true, reason: 'deployed contract is exactly the tested code' };
    return { match: false, reason: `deployed contract is a different version (${(code.length - 2) / 2} bytes vs tested ${(ARB_EXECUTOR_RUNTIME_CODE.length - 2) / 2}); redeploy from this repo to use the tested exchanges` };
  } catch (err) {
    return { match: false, reason: `could not read the contract code: ${String((err as Error).message).slice(0, 80)}` };
  }
}
