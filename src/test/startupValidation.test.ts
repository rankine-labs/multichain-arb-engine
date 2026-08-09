import { runStartupValidation, AddressEntry } from '../core/startupValidation';

function assert(cond: boolean, msg: string) {
if (!cond) {
console.error(`FAIL: ${msg}`);
process.exitCode = 1;
} else {
console.log(`PASS: ${msg}`);
}
}

function mockProvider(chainId: number, codeMap: Record<string, string>): any {
return {
getNetwork: async () => ({ chainId: BigInt(chainId) }),
getCode: async (address: string) => codeMap[address.toLowerCase()] ?? '0x',
};
}

const goodAddress: AddressEntry = { address: '0xRealContract', label: 'Real Router', status: 'VERIFIED' };
const badAddress: AddressEntry = { address: '0xNotDeployed', label: 'Fake Router', status: 'PENDING_VERIFICATION' };

const provider1 = mockProvider(143, { '0xrealcontract': '0x608060405234801561001057600080fd5b50' });
runStartupValidation(provider1, 'monad', [goodAddress]).then(result => {
assert(result.safe === true, 'validation passes when chain ID matches and bytecode exists');
});

const provider2 = mockProvider(143, {});
runStartupValidation(provider2, 'monad', [goodAddress, badAddress]).then(result => {
assert(result.safe === false, 'validation BLOCKS when an address has no deployed bytecode');
assert(result.results.some(r => !r.hasBytecode), 'validation correctly identifies which address failed');
});

const provider3 = mockProvider(1, { '0xrealcontract': '0x608060405234801561001057600080fd5b50' });
runStartupValidation(provider3, 'monad', [goodAddress]).then(result => {
assert(result.safe === false, 'validation BLOCKS when connected chain ID does not match expected chain');
assert(result.chainIdCheck.actual === 1 && result.chainIdCheck.expected === 143, 'validation reports the actual vs expected chain ID mismatch clearly');
});
