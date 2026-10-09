import { ethers } from 'ethers';
import {
  SEL_FABLES_CURRENT_FEE, fablesFeeCalls, parseFablesFees, readFablesFees, decodeFeeWord,
  predictFablesFeePips, FablesFeeBook, FABLES_DEFAULT_FALLBACK_PIPS,
} from '../core/fablesFee';

// ============================================================================
// Fables fee predictor: call encoding, result parsing, and the pure rule
// that picks the fee to assume for a trade.
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const coder = ethers.AbiCoder.defaultAbiCoder();
const word = (n: number) => coder.encode(['uint24'], [n]);

async function main() {
  // --- call encoding --------------------------------------------------------
  assert(SEL_FABLES_CURRENT_FEE === '0x15452022', 'currentFee(bytes32,bool) selector matches the one found in the hook bytecode');
  const idA = '0x' + 'ab'.repeat(32), idB = '0x' + 'cd'.repeat(32);
  const hook = '0x' + '11'.repeat(20);
  const pools = [{ id: idA, hooks: hook }, { id: idB, hooks: hook }];
  const calls = fablesFeeCalls(pools);
  const iface = new ethers.Interface(['function currentFee(bytes32 id, bool zeroForOne) view returns (uint24)']);
  assert(calls.length === 4 && calls.every((c) => c.target === hook), 'two calls per pool, all to the hook');
  assert(calls[0].data === iface.encodeFunctionData('currentFee', [idA, true]) && calls[1].data === iface.encodeFunctionData('currentFee', [idA, false]), 'calldata matches the ABI encoder (true first, then false)');
  assert(calls[3].data === iface.encodeFunctionData('currentFee', [idB, false]), 'second pool encoded the same way');

  // --- decoding --------------------------------------------------------------
  assert(decodeFeeWord(word(2600)) === 2600, 'fee word decoded');
  assert(decodeFeeWord(null) === null && decodeFeeWord('0x') === null, 'failed call -> null');
  assert(decodeFeeWord('0x' + 'ff'.repeat(32)) === null, 'impossible fee (>= 100%) -> null');
  const parsed = parseFablesFees(pools, [word(700), word(845), null, word(3000)]);
  assert(parsed.get(idA)!.zeroForOne === 700 && parsed.get(idA)!.oneForZero === 845, 'pool A both directions');
  assert(parsed.get(idB)!.zeroForOne === null && parsed.get(idB)!.oneForZero === 3000, 'pool B: one failed read kept as null');
  const viaHelper = await readFablesFees(async (c) => c.map(() => word(1200)), pools);
  assert(viaHelper.size === 2 && viaHelper.get(idB)!.oneForZero === 1200, 'readFablesFees does one bundled call and parses it');
  assert((await readFablesFees(async () => { throw new Error('should not be called'); }, [])).size === 0, 'no pools -> no RPC call');

  // --- pure prediction ---------------------------------------------------------
  const now = 1_000_000;
  assert(predictFablesFeePips({ nowMs: now, live: { feePips: 700, readAtMs: now - 3000 } }).feePips === 700, 'fresh hook read is used as is');
  assert(predictFablesFeePips({ nowMs: now, live: { feePips: 700, readAtMs: now - 3000 } }).source === 'hook', 'source = hook');
  const raised = predictFablesFeePips({ nowMs: now, live: { feePips: 700, readAtMs: now - 3000 }, observed: [{ feePips: 1799, atMs: now - 1000 }] });
  assert(raised.feePips === 1799 && raised.source === 'hook', 'a swap paying more AFTER our read raises the prediction');
  const older = predictFablesFeePips({ nowMs: now, live: { feePips: 700, readAtMs: now - 3000 }, observed: [{ feePips: 1799, atMs: now - 4000 }] });
  assert(older.feePips === 700, 'a higher fee paid BEFORE our read does not override it (it has decayed since)');
  const stale = predictFablesFeePips({ nowMs: now, live: { feePips: 700, readAtMs: now - 60_000 }, observed: [{ feePips: 1285, atMs: now - 120_000 }, { feePips: 900, atMs: now - 10_000 }] });
  assert(stale.feePips === 1285 && stale.source === 'observed', 'stale read: highest fee recently paid');
  const nothing = predictFablesFeePips({ nowMs: now });
  assert(nothing.feePips === FABLES_DEFAULT_FALLBACK_PIPS && nothing.source === 'fallback', 'nothing known: conservative default');
  const highStale = predictFablesFeePips({ nowMs: now, live: { feePips: 16000, readAtMs: now - 60 * 60_000 } });
  assert(highStale.feePips === 16000 && highStale.source === 'fallback', 'fallback never goes below an old read (meme pools charge 1.6%)');
  const oldObs = predictFablesFeePips({ nowMs: now + 3_600_000, observed: [{ feePips: 9000, atMs: now }] });
  assert(oldObs.source === 'fallback', 'observed fees older than the window are ignored');

  // --- the book ------------------------------------------------------------------
  const book = new FablesFeeBook();
  book.applyRead(parsed, now);
  assert(book.predict(idA, true, now + 1000).feePips === 700 && book.predict(idA, false, now + 1000).feePips === 845, 'book uses the read per direction');
  assert(book.predict(idB, true, now + 1000).source === 'fallback', 'book: unreadable direction falls back');
  book.observeSwap(idA, true, 1500, now + 2000);
  assert(book.predict(idA, true, now + 2500).feePips === 1500, 'book: swap after the read raises the fee');
  assert(book.predict(idA, true, now + 60_000).feePips === 1500 && book.predict(idA, true, now + 60_000).source === 'observed', 'book: read gone stale -> highest observed');
  assert(book.predict(idA.toUpperCase().replace('0X', '0x'), false, now + 1000).feePips === 845, 'pool id matched case-insensitively');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
