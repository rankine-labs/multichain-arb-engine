// Compile Mocks.sol into mocks.json (ABI + creation bytecode) with solc-js.
// Only needed if Mocks.sol changes:
//   npm install solc@0.8.24 && node tests/fixtures/compile.js
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const src = fs.readFileSync(path.join(__dirname, 'Mocks.sol'), 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'Mocks.sol': { content: src } },
  settings: { viaIR: true, optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
if (errors.length) {
  console.error(errors.map((e) => e.formattedMessage).join('\n'));
  process.exit(1);
}
const result = {};
for (const [name, c] of Object.entries(out.contracts['Mocks.sol'])) {
  result[name] = { bytecode: '0x' + c.evm.bytecode.object };
}
result.solc = solc.version();
fs.writeFileSync(path.join(__dirname, 'mocks.json'), JSON.stringify(result, null, 1));
console.log('wrote mocks.json with', Object.keys(result).join(', '));
