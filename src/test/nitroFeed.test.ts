import { Wallet, Transaction, ethers } from 'ethers';
import { parseFeedFrame, parseL2Message, maxSequenceNumber } from '../chains/nitroFeed';
import { TransactionDecoder, RouterRegistry } from '../core/decoder';

// Builds real signed transactions, packs them exactly the way the Nitro
// sequencer feed does (single SignedTx and Batch messages, base64 in JSON
// frames), and checks they come back out with the right to/data -- then
// runs one all the way through the decoder as a swap.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const ROUTER = '0x89e5db8b5aa49aa85ac63f691524311aeb649eba';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const iface = new ethers.Interface(['function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)']);

// One length-prefixed entry inside a Batch: [8-byte BE length][message].
function batchEntry(msg: Buffer): Buffer {
  const len = Buffer.alloc(8);
  len.writeBigUInt64BE(BigInt(msg.length));
  return Buffer.concat([len, msg]);
}
const signedTxMsg = (raw: string) => Buffer.concat([Buffer.from([4]), Buffer.from(raw.slice(2), 'hex')]);
const frameFor = (seq: number, l2Msg: Buffer, headerKind = 3) => ({
  version: 1,
  messages: [{ sequenceNumber: seq, message: { message: { header: { kind: headerKind }, l2Msg: l2Msg.toString('base64') }, delayedMessagesRead: 1 } }],
});

async function main() {
  const wallet = Wallet.createRandom();
  const swapData = iface.encodeFunctionData('swapExactTokensForTokens', [10n ** 18n, 0n, [WETH, USDG], wallet.address, 9_999_999_999n]);

  // EIP-1559 swap tx and a legacy tx, both signed.
  const swapRaw = await wallet.signTransaction({ type: 2, chainId: 4663, nonce: 0, to: ROUTER, data: swapData, gasLimit: 300_000, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 0n });
  const legacyRaw = await wallet.signTransaction({ type: 0, chainId: 4663, nonce: 1, to: USDG, data: '0xa9059cbb' + '00'.repeat(64), gasLimit: 60_000, gasPrice: 10n ** 9n });
  const transferRaw = await wallet.signTransaction({ type: 2, chainId: 4663, nonce: 2, to: wallet.address, value: 1n, gasLimit: 21_000, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 0n });

  // 1. Single SignedTx message.
  const single = parseFeedFrame(frameFor(100, signedTxMsg(swapRaw)));
  assert(single.length === 1 && single[0].to.toLowerCase() === ROUTER && single[0].data === swapData, 'single SignedTx: to/data recovered');
  assert(single[0].sequenceNumber === 100 && single[0].hash === Transaction.from(swapRaw).hash, 'single SignedTx: sequence number and hash');
  assert(single[0].from === wallet.address, 'single SignedTx: sender recovered from signature');

  // 2. Batch of three (swap, legacy call, plain ETH transfer), with a nested batch.
  const nested = Buffer.concat([Buffer.from([3]), batchEntry(signedTxMsg(legacyRaw))]);
  const batch = Buffer.concat([Buffer.from([3]), batchEntry(signedTxMsg(swapRaw)), batchEntry(nested), batchEntry(signedTxMsg(transferRaw))]);
  const fromBatch = parseFeedFrame(frameFor(101, batch));
  assert(fromBatch.length === 2, `batch: 2 contract calls extracted, plain transfer skipped (got ${fromBatch.length})`);
  assert(parseL2Message(batch).length === 3, 'batch: all 3 txs parsed incl. nested batch');

  // 3. Ignored safely.
  assert(parseFeedFrame(frameFor(102, signedTxMsg(swapRaw), 12)).length === 0, 'non-L2 header kind ignored');
  assert(parseFeedFrame({ version: 1, messages: [{ sequenceNumber: 1, message: { message: { header: { kind: 3 }, l2Msg: Buffer.from([4, 1, 2, 3]).toString('base64') } } }] }).length === 0, 'garbage tx bytes ignored, no crash');
  const truncated = Buffer.concat([Buffer.from([3]), Buffer.from([0, 0, 0, 0, 0, 0, 0, 99, 4, 1])]);
  assert(parseFeedFrame(frameFor(103, truncated)).length === 0, 'truncated batch ignored, no crash');
  assert(parseFeedFrame({ hello: 'world' }).length === 0 && parseFeedFrame(null).length === 0, 'unrelated frames ignored');
  assert(maxSequenceNumber({ messages: [{ sequenceNumber: 5 }, { sequenceNumber: 9 }] }) === 9, 'max sequence number for liveness');

  // 4. End to end: feed tx -> decoder -> swap.
  const registry: RouterRegistry = { avalanche: {}, monad: {}, robinhood: { [ROUTER]: { dex: 'uniswap-v2', style: 'v2' } } };
  const decoder = new TransactionDecoder(registry);
  const tx = single[0];
  const swap = await decoder.decode({ chain: 'robinhood', stateType: 'SEQUENCED', blockOrSeq: 100, receivedAtMs: 1, raw: { to: tx.to, data: tx.data } });
  assert(swap?.tokenIn === WETH && swap?.tokenOut === USDG && swap?.amountIn === 10n ** 18n, 'sequencer tx decodes as a WETH -> USDG swap');
}

main().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; });
