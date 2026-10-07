// ============================================================================
// RIVAL FUNDING PROBE -- do the rival arb bots borrow (flash loans) or use
// their own money? Read-only, no keys.
//
// Reads every receipt in recent blocks (eth_getBlockReceipts), keeps trades
// that swap through 2+ pools and send coins back to the same contract (an
// arbitrage), then for each bot contract:
//   - flash loan used?  (a Flash / FlashLoan event in the same trade)
//   - how much it starts with: the bot's WETH and USDG balance right now
//   - pools per trade, and how often it trades
// ============================================================================
import { ethers } from 'ethers';

const URL_ = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const BLOCKS = Number(process.env.PROBE_BLOCKS ?? 400);

let id = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rpc(method: string, params: unknown[]): Promise<any> {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const j = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
    if (j.error && /429|Too Many|rate/i.test(JSON.stringify(j.error))) { await sleep(1500 * (i + 1)); continue; }
    return j;
  }
  return { error: { message: 'rate limited' } };
}

const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const SWAPS = new Set([
  ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)'),
  ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)'),
  ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)'),
  ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'),
]);
const FLASH = new Set([
  ethers.id('Flash(address,address,uint256,uint256,uint256,uint256)'),            // Uniswap/Pancake V3
  ethers.id('FlashLoan(address,address,address,uint256,uint8,uint256,uint16)'),   // Aave V3
  ethers.id('FlashLoan(address,address,uint256,uint256)'),                        // Balancer
]);
const topicAddr = (t: string) => '0x' + t.slice(26).toLowerCase();

(async () => {
  const latest = Number((await rpc('eth_blockNumber', [])).result);
  const bots = new Map<string, { trades: number; flash: number; pools: number[]; froms: Set<string> }>();
  let blocksRead = 0, receiptsRead = 0;
  for (let n = latest - 2; n > latest - 2 - BLOCKS; n--) {
    const r = await rpc('eth_getBlockReceipts', ['0x' + n.toString(16)]);
    if (r.error) { console.log(`block receipts not available: ${JSON.stringify(r.error).slice(0, 120)}`); break; }
    blocksRead++;
    for (const rc of r.result ?? []) {
      receiptsRead++;
      if (rc.status !== '0x1' || !rc.to) continue;
      const to = rc.to.toLowerCase();
      const pools = new Set<string>();
      let flash = false, backToBot = false, outOfBot = false;
      for (const l of rc.logs ?? []) {
        const t0 = l.topics?.[0];
        if (SWAPS.has(t0)) pools.add(l.topics.length > 1 && t0 === ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)') ? l.topics[1] : l.address.toLowerCase());
        if (FLASH.has(t0)) flash = true;
        if (t0 === TRANSFER && l.topics.length >= 3) {
          if (topicAddr(l.topics[2]) === to) backToBot = true;
          if (topicAddr(l.topics[1]) === to) outOfBot = true;
        }
      }
      // Arbitrage shape: 2+ pools, coins leave AND return to the called contract.
      if (pools.size < 2 || !backToBot || !outOfBot) continue;
      const b = bots.get(to) ?? { trades: 0, flash: 0, pools: [], froms: new Set<string>() };
      b.trades++; if (flash) b.flash++; b.pools.push(pools.size); b.froms.add(rc.from.toLowerCase());
      bots.set(to, b);
    }
    if (n % 25 === 0) await sleep(300);
  }
  console.log(`read ${blocksRead} blocks, ${receiptsRead} trades; arbitrage contracts found: ${bots.size}`);
  const top = [...bots.entries()].sort((a, b) => b[1].trades - a[1].trades).slice(0, 8);
  for (const [bot, b] of top) {
    const bal = async (tok: string) => { const r = await rpc('eth_call', [{ to: tok, data: '0x70a08231' + bot.slice(2).padStart(64, '0') }, 'latest']); try { return BigInt(r.result); } catch { return 0n; } };
    const w = await bal(WETH), u = await bal(USDG);
    const eth = BigInt((await rpc('eth_getBalance', [bot, 'latest'])).result ?? '0x0');
    const avgPools = (b.pools.reduce((x, y) => x + y, 0) / b.pools.length).toFixed(1);
    console.log(`bot ${bot}: ${b.trades} arb trades, flash loan in ${b.flash}, avg ${avgPools} pools/trade, senders ${b.froms.size}, holds ${Number(w) / 1e18} WETH + ${Number(u) / 1e6} USDG + ${Number(eth) / 1e18} ETH`);
    await sleep(500);
  }
})();
