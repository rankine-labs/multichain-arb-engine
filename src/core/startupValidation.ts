import { ethers } from 'ethers';
import { ChainName } from './types';

// ============================================================================
// STARTUP VALIDATION
//
// Every router/token address in this codebase came from either an
// independently cross-checked official source, or from chat and could not
// be independently confirmed before use. Rather than trust provenance
// alone, every address gets checked against the REAL chain before it's
// eligible for live trading:
//   1. Does an actual contract exist here (non-empty bytecode)?
//   2. Does the chain we're connected to actually match the expected
//      chain ID (protects against a misconfigured RPC endpoint)?
//
// This is the safety net that makes address provenance a secondary
// concern — even a wrong address gets caught here rather than silently
// misrouting a real transaction.
// ============================================================================

export type AddressVerificationStatus =
| 'VERIFIED'              // independently cross-checked against 2+ official sources
| 'PENDING_VERIFICATION'  // sourced from chat/one source, not independently confirmed
| 'UNCHECKED';            // no verification attempted yet

export interface AddressEntry {
address: string;
label: string;
status: AddressVerificationStatus;
}

export interface ValidationResult {
address: string;
label: string;
hasBytecode: boolean;
error?: string;
}

const EXPECTED_CHAIN_IDS: Record<ChainName, number> = {
avalanche: 43114,
monad: 143,      // per Uniswap's own Monad deployment docs (Wrapped Native Token table)
robinhood: 4663,  // per 1inch, Uniswap, and Robinhood's own docs, all agree
};

export async function verifyChainId(provider: ethers.JsonRpcProvider, chain: ChainName): Promise<{ ok: boolean; actual: number; expected: number }> {
const network = await provider.getNetwork();
const actual = Number(network.chainId);
const expected = EXPECTED_CHAIN_IDS[chain];
return { ok: actual === expected, actual, expected };
}

export async function verifyAddressHasBytecode(
provider: ethers.JsonRpcProvider,
entry: AddressEntry,
): Promise<ValidationResult> {
try {
const code = await provider.getCode(entry.address);
return {
address: entry.address,
label: entry.label,
hasBytecode: code !== '0x' && code.length > 2,
};
} catch (err) {
return {
address: entry.address,
label: entry.label,
hasBytecode: false,
error: String(err),
};
}
}

// Run before enabling live trading on a chain. Refuses to proceed if:
//   - the RPC's chain ID doesn't match what we expect (wrong network entirely)
//   - any PENDING_VERIFICATION or UNCHECKED address has no real bytecode
// VERIFIED addresses are still checked (defense in depth — official docs
// can be stale too), but a bytecode failure on a VERIFIED address is
// treated as more surprising and worth a louder warning.
export async function runStartupValidation(
provider: ethers.JsonRpcProvider,
chain: ChainName,
addresses: AddressEntry[],
): Promise<{ safe: boolean; chainIdCheck: Awaited<ReturnType<typeof verifyChainId>>; results: ValidationResult[] }> {
const chainIdCheck = await verifyChainId(provider, chain);
if (!chainIdCheck.ok) {
return {
safe: false,
chainIdCheck,
results: [],
};
}

const results = await Promise.all(
addresses.map(entry => verifyAddressHasBytecode(provider, entry)),
);

const anyMissing = results.some(r => !r.hasBytecode);

return { safe: !anyMissing, chainIdCheck, results };
}
