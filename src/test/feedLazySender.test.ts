// Feed parser: the SENDER of each transaction is now worked out only when
// something reads it (signature checks cost ~1-2 ms each and used to run for
// every transaction in a frame before the bot could act on any trade).
import { Wallet, Transaction, ethers } from 'ethers';
import { parseFeedFrame } from '../chains/nitroFeed';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const ROUTER = '0x' + '12'.repeat(20);
const iface = new ethers.Interface(['function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)']);
function batchEntry(msg: Buffer): Buffer {
  const len = Buffer.alloc(8);
  len.writeBigUInt64BE(BigInt(msg.length));
  return Buffer.concat([len, msg]);
}
const signedTxMsg = (raw: string) => Buffer.concat([Buffer.from([4]), Buffer.from(raw.slice(2), 'hex')]);
const frameFor = (seq: number, l2Msg: Buffer) => ({
  version: 1,
  messages: [{ sequenceNumber: seq, message: { message: { header: { kind: 3 }, l2Msg: l2Msg.toString('base64') }, delayedMessagesRead: 1 } }],
});

async function main() {
  // A realistic frame: 30 signed swaps from different wallets.
  const wallets = Array.from({ length: 30 }, () => Wallet.createRandom());
  const raws: string[] = [];
  for (let i = 0; i < wallets.length; i++) {
    const data = iface.encodeFunctionData('swapExactTokensForTokens', [BigInt(i + 1) * 10n ** 18n, 0n, [ROUTER, ROUTER], wallets[i].address, 9_999_999_999n]);
    raws.push(await wallets[i].signTransaction({ type: 2, chainId: 4663, nonce: i, to: ROUTER, data, gasLimit: 300_000, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 0n }));
  }
  const batch = Buffer.concat([Buffer.from([3]), ...raws.map((r) => batchEntry(signedTxMsg(r)))]);
  const frame = frameFor(500, batch);

  // Warm up (first ethers calls load code).
  parseFeedFrame(frame);

  // Lazy (default): parsing is fast, sender still correct when read.
  delete process.env.FEED_LAZY_SENDER;
  let t = performance.now();
  const lazy = parseFeedFrame(frame);
  const lazyMs = performance.now() - t;
  assert(lazy.length === 30, 'lazy: all 30 swaps parsed');
  assert(lazy[0].to.toLowerCase() === ROUTER && lazy[7].hash === Transaction.from(raws[7]).hash, 'lazy: to and hash right without touching the sender');

  // Eager (old behaviour, FEED_LAZY_SENDER=0).
  process.env.FEED_LAZY_SENDER = '0';
  t = performance.now();
  const eager = parseFeedFrame(frame);
  const eagerMs = performance.now() - t;
  delete process.env.FEED_LAZY_SENDER;
  console.log(`  frame of 30: lazy ${lazyMs.toFixed(1)} ms vs eager ${eagerMs.toFixed(1)} ms`);
  assert(lazyMs < eagerMs, 'lazy parsing is faster than checking every signature up front');
  assert(eager.every((e, i) => e.from === wallets[i].address), 'eager: every sender recovered (old behaviour kept behind the switch)');

  // Reading the sender later gives the same answer, and it is remembered.
  assert(lazy.every((e, i) => e.from === wallets[i].address), 'lazy: sender correct when read');
  t = performance.now();
  for (const e of lazy) void e.from;
  const secondReadMs = performance.now() - t;
  assert(secondReadMs < 5, `lazy: second read is cached (${secondReadMs.toFixed(2)} ms for 30)`);

  // The sender still shows up as a normal field (e.g. when copied).
  const copy = { ...lazy[3] };
  assert(copy.from === wallets[3].address, 'lazy sender survives a copy of the object');

  // A tx with an odd signature: reading the sender never crashes the bot.
  const good = Transaction.from(raws[0]);
  const badSig = Transaction.from({ ...good.toJSON(), signature: { r: '0x' + '00'.repeat(31) + '01', s: '0x' + '00'.repeat(31) + '01', v: 27 } } as any);
  const badFrame = frameFor(501, Buffer.concat([Buffer.from([3]), batchEntry(signedTxMsg(badSig.serialized))]));
  const bad = parseFeedFrame(badFrame);
  let readOk = true;
  try { for (const b of bad) void b.from; } catch { readOk = false; }
  assert(readOk && bad.every((b) => b.from === null || typeof b.from === 'string'), 'odd signature: reading the sender never throws (null or an address)');
}
main();
