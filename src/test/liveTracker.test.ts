import { ethers } from 'ethers';
import { LiveTradeTracker } from '../execution/liveTracker';

// Checks live result handling: profit read from the contract's Executed
// event, reverts charged to the daily loss cap, gas fed to the gas tuner,
// one Telegram message per trade.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const losses: number[] = [], gas: bigint[] = [], msgs: string[] = [];
const t = new LiveTradeTracker({
  provider: { getTransactionReceipt: async () => null } as any,
  ethUsd: () => 3000,
  tokenUsd: (_tok, raw) => Number(raw) / 1e6, // USDG-like, 6 decimals
  recordLoss: (u) => losses.push(u), noteGasUsed: (g) => gas.push(g), notify: (h) => { msgs.push(h); },
});
const TOKEN = '0x' + '55'.repeat(20);
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const executed = {
  topics: [ethers.id('Executed(address,uint256,uint256,bool)'), '0x' + '00'.repeat(12) + TOKEN.slice(2)],
  data: '0x' + word(1_000_000_000n) + word(42_500_000n) + word(1n), // amountIn, profit = $42.50, flash
};
t.record('0xwin', { expectedProfitUsd: 40, label: 'X/USDG' }, { status: 1, gasUsed: 300_000n, gasPrice: 10_000_000n, logs: [executed] } as any);
const won = t.results[0];
assert(won.status === 'profit' && Math.abs((won.profitUsd ?? 0) - 42.5) < 1e-9, 'profit read from Executed event ($42.50)');
assert(Math.abs(won.gasUsd - 0.009) < 1e-9, 'gas cost in USD (300k gas x 0.01 gwei x $3000)');
assert(losses.length === 0, 'profitable trade adds no loss');

t.record('0xlose', { expectedProfitUsd: 30, label: 'X/USDG' }, { status: 0, gasUsed: 250_000n, gasPrice: 10_000_000n, logs: [] } as any);
assert(t.results[1].status === 'reverted' && losses.length === 1 && Math.abs(losses[0] - 0.0075) < 1e-9, 'revert: gas charged to the daily loss cap');
assert(gas.length === 2 && gas[0] === 300_000n, 'gas use reported to the gas tuner');
assert(msgs.length === 2 && /WON/.test(msgs[0]) && /REVERTED/.test(msgs[1]), 'one Telegram message per trade');
const s = t.summary();
assert(s.sent === 2 && s.won === 1 && s.reverted === 1, 'summary counts');
