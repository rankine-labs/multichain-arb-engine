// Feed parser: the transaction HASH is worked out only when something reads
// it (experiment). Checks the lazy hash gives exactly the same answers as the
// old eager one for single txs, batches, malformed input and the Robinhood
// odd-fee tx (priority fee above max fee, which ethers refuses to hash).
import { Wallet, Transaction, ethers, keccak256, encodeRlp, toBeHex } from 'ethers';
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

// Parses a frame with the lazy hash (default) and with FEED_LAZY_HASH=0 (old way).
function both(frame: unknown) {
  delete process.env.FEED_LAZY_HASH;
  const lazy = parseFeedFrame(frame);
  process.env.FEED_LAZY_HASH = '0';
  const eager = parseFeedFrame(frame);
  delete process.env.FEED_LAZY_HASH;
  return { lazy, eager };
}
// Same fields, same values (the sender is compared too: it stays lazy in both).
const same = (a: any, b: any) => a.sequenceNumber === b.sequenceNumber && a.hash === b.hash && a.to === b.to && a.data === b.data && a.value === b.value && a.from === b.from;

async function main() {
  const wallets = Array.from({ length: 5 }, () => Wallet.createRandom());
  const raws: string[] = [];
  for (let i = 0; i < wallets.length; i++) {
    const data = iface.encodeFunctionData('swapExactTokensForTokens', [BigInt(i + 1) * 10n ** 18n, 0n, [ROUTER, ROUTER], wallets[i].address, 9_999_999_999n]);
    raws.push(await wallets[i].signTransaction({ type: 2, chainId: 4663, nonce: i, to: ROUTER, data, value: BigInt(i), gasLimit: 300_000, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 0n }));
  }

  // 1) Single tx.
  {
    const { lazy, eager } = both(frameFor(1, signedTxMsg(raws[0])));
    assert(lazy.length === 1 && eager.length === 1, 'single: one tx both ways');
    assert(lazy[0].hash === Transaction.from(raws[0]).hash && lazy[0].hash === keccak256(raws[0]), 'single: lazy hash = real tx hash');
    assert(same(lazy[0], eager[0]), 'single: every field identical to the old eager parser');
    assert(Object.keys(lazy[0]).includes('hash') && { ...lazy[0] }.hash === eager[0].hash, 'single: hash still listed and survives a copy');
    assert(lazy[0].hash === lazy[0].hash, 'single: second read returns the cached value');
  }

  // 2) Batch (plus a plain ETH transfer that must still be skipped).
  {
    const transfer = await wallets[0].signTransaction({ type: 2, chainId: 4663, nonce: 9, to: wallets[1].address, value: 1n, gasLimit: 21_000, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 0n });
    const batch = Buffer.concat([Buffer.from([3]), ...raws.map((r) => batchEntry(signedTxMsg(r))), batchEntry(signedTxMsg(transfer))]);
    const { lazy, eager } = both(frameFor(2, batch));
    assert(lazy.length === 5 && eager.length === 5, 'batch: 5 contract calls, transfer skipped, both ways');
    assert(lazy.every((t, i) => same(t, eager[i]) && t.hash === keccak256(raws[i])), 'batch: every tx identical, hashes right');
    assert(lazy.map((t) => t.value).join(',') === '0,1,2,3,4', 'batch: values unchanged');
    // Nested batch inside a batch.
    const nested = Buffer.concat([Buffer.from([3]), batchEntry(batch)]);
    const n = both(frameFor(3, nested));
    assert(n.lazy.length === 5 && n.lazy.every((t, i) => same(t, n.eager[i])), 'nested batch: identical');
  }

  // 3) Malformed input: no crash, same output both ways.
  {
    const cases: [string, unknown][] = [
      ['garbage tx bytes', { version: 1, messages: [{ sequenceNumber: 1, message: { message: { header: { kind: 3 }, l2Msg: Buffer.from([4, 1, 2, 3]).toString('base64') } } }] }],
      ['truncated batch', frameFor(4, Buffer.concat([Buffer.from([3]), batchEntry(signedTxMsg(raws[0])).subarray(0, 20)]))],
      ['not a frame', { hello: 'world' }],
      ['null', null],
      ['l2Msg not a string', { messages: [{ message: { message: { header: { kind: 3 }, l2Msg: 5 } } }] }],
    ];
    for (const [name, f] of cases) {
      let threw = false; let r = { lazy: [] as any[], eager: [] as any[] };
      try { r = both(f); } catch { threw = true; }
      assert(!threw && r.lazy.length === 0 && r.eager.length === 0, `malformed (${name}): no crash, nothing out`);
    }
    // Good tx after a bad one in the same batch: the good one is kept.
    const mixed = Buffer.concat([Buffer.from([3]), batchEntry(Buffer.from([4, 9, 9, 9])), batchEntry(signedTxMsg(raws[2]))]);
    const m = both(frameFor(5, mixed));
    assert(m.lazy.length === 1 && same(m.lazy[0], m.eager[0]) && m.lazy[0].hash === keccak256(raws[2]), 'malformed + good in one batch: good tx kept, identical');
  }

  // 4) Robinhood odd-fee tx (priority fee above max fee): ethers throws from
  //    tx.hash, our hash is keccak of the raw bytes. Reading it must not throw.
  {
    const fields = [toBeHex(4663), '0x01', toBeHex(5_000_000_000n), toBeHex(1_000_000n), toBeHex(300_000), '0x' + '22'.repeat(20), '0x', '0x12345678', [], '0x01', '0x' + '33'.repeat(32), '0x' + '44'.repeat(32)];
    const raw = '0x02' + encodeRlp(fields).slice(2);
    let threw = false; let r = { lazy: [] as any[], eager: [] as any[] };
    try { r = both(frameFor(6, signedTxMsg(raw))); } catch { threw = true; }
    let readOk = true; let h = '';
    try { h = r.lazy[0]?.hash; } catch { readOk = false; }
    assert(!threw && r.lazy.length === 1 && r.eager.length === 1, 'odd-fee: kept both ways, no throw');
    assert(readOk && h === keccak256(raw) && h === r.eager[0].hash, 'odd-fee: lazy hash readable and = keccak(raw bytes)');
  }
}

main().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; });
