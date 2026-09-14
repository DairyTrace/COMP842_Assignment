// Compiles the contract and writes dist/abi.json, which the page fetches.
// Settings here must match the ones the README gives for Remix.
import fs from 'node:fs';
import solc from 'solc';

export function compile() {
  const source = fs.readFileSync(new URL('../contracts/DairyTrace.sol', import.meta.url), 'utf8');

  const input = {
    language: 'Solidity',
    sources: { 'DairyTrace.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  const errors = (output.errors || []).filter(e => e.severity === 'error');
  if (errors.length) throw Error(errors.map(e => e.formattedMessage).join('\n'));

  return output.contracts['DairyTrace.sol'].DairyTrace;
}

const artifact = compile();
fs.writeFileSync(new URL('../dist/abi.json', import.meta.url), JSON.stringify(artifact.abi, null, 2));
console.log('Solidity compiled; ABI generated. Bytecode bytes:', artifact.evm.bytecode.object.length / 2);
