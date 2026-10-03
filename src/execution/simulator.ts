import { ethers } from 'ethers';
import { ARB_EXECUTOR_RUNTIME_CODE, EXECUTOR_STORAGE_SLOT } from './arbExecutorBytecode';
import { ExecutorHop, encodeExecuteRaw } from './executorCalldata';

// ============================================================================
// FREE PRE-TRADE SIMULATION
//
// Plain English:
//   Asks the real chain "if our contract held X tokens and ran this exact
//   round trip right now, how much would it make?" -- without deploying
//   anything or spending anything.
//
// How:
//   eth_call with STATE OVERRIDES: for this one call only, the RPC pretends
//     - our ArbExecutor code lives at SIM_EXECUTOR_ADDRESS (no deploy)
//     - SIM_CALLER is its executor (storage slot 0)
//     - the contract holds `amountIn` of the start token (we find which
//       storage slot holds token balances by probing once per token)
//   We set minProfit impossibly high, so the contract ALWAYS refuses at the
//   end -- and its refusal, InsufficientProfit(got, wanted), carries the
//   exact profit it would have made. Any other refusal means the trade
//   itself would have failed (and we report which error).
//
// Notes:
//   - Simulates own-capital mode (no flash loan); the flash fee is a known,
//     fixed cost the caller can subtract.
//   - Runs against the chain's latest state, so call it shortly AFTER the
//     big trade you're backrunning has landed.
//   - Never throws: returns a status instead.
// ============================================================================

// Arbitrary empty addresses, only ever used inside eth_call overrides.
export const SIM_EXECUTOR_ADDRESS = '0x00000000000000000000000000000000a7b51e00';
export const SIM_CALLER = '0x00000000000000000000000000000000000b0751';

const MAX_UINT = (1n << 256n) - 1n;
const abi = ethers.AbiCoder.defaultAbiCoder();
const errIface = new ethers.Interface([
  'error InsufficientProfit(uint256 got, uint256 wanted)',
  'error TokenBalanceDropped(address token)',
  'error UnsupportedKind(uint8 kind)',
  'error BadRoute()',
  'error ZeroAmount()',
  'error Expired()',
  'error UnauthorizedCallback()',
  'error TransferFailed()',
  'error NotExecutor()',
  'error Error(string)',
  'error Panic(uint256)',
]);
const BALANCE_OF = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);

export type SimResult =
  | { status: 'profit'; profit: bigint }               // would make `profit` (start-token units, before gas)
  | { status: 'loss' }                                  // would end with less than it started
  | { status: 'fail'; reason: string }                  // trade itself would revert
  | { status: 'unsupported'; reason: string };          // couldn't simulate on this chain/token

// ----------------------------------------------------------------------------
// Minimal JSON-RPC client: returns the RPC error instead of throwing on it,
// because the revert data inside the error IS the answer we want.
// ----------------------------------------------------------------------------
export type Rpc = (method: string, params: unknown[]) => Promise<{ result?: any; error?: { code?: number; message?: string; data?: any } }>;

export function makeRpc(url: string, timeoutMs = 8_000): Rpc {
  let id = 0;
  return async (method, params) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: ctrl.signal,
      });
      return await res.json();
    } catch (err) {
      return { error: { message: `network: ${(err as Error).message}` } };
    } finally {
      clearTimeout(t);
    }
  };
}

const pad32 = (v: bigint | string): string =>
  ethers.zeroPadValue(typeof v === 'bigint' ? ethers.toBeHex(v) : v, 32);

// Revert data can sit in error.data as a string or nested (provider-specific).
function revertData(err: { data?: any } | undefined): string | null {
  const d = err?.data;
  if (typeof d === 'string' && d.startsWith('0x')) return d;
  if (typeof d?.data === 'string' && d.data.startsWith('0x')) return d.data;
  return null;
}

// Does this RPC error mean "state overrides aren't supported here"?
function overridesUnsupported(err: { code?: number; message?: string } | undefined): boolean {
  const m = (err?.message ?? '').toLowerCase();
  return err?.code === -32602 || m.includes('override') || m.includes('too many arguments') || m.includes('invalid params');
}

// ----------------------------------------------------------------------------
// Finding where a token keeps balances (one-time per token, then cached)
// ----------------------------------------------------------------------------
type SlotInfo = { key: (holder: string) => string } | { unsupported: string } | null;
const slotCache = new Map<string, SlotInfo>();
const MAX_SLOT = 60;

// Storage key for balances[holder] at mapping slot `slot`.
function solidityKey(holder: string, slot: number) { return ethers.keccak256(abi.encode(['address', 'uint256'], [holder, slot])); }
function vyperKey(holder: string, slot: number) { return ethers.keccak256(abi.encode(['uint256', 'address'], [slot, holder])); }

export async function findBalanceSlot(rpc: Rpc, cacheKey: string, token: string): Promise<SlotInfo> {
  if (slotCache.has(cacheKey)) return slotCache.get(cacheKey)!;
  const magic = 0x1234567890abcdefn;
  const data = BALANCE_OF.encodeFunctionData('balanceOf', [SIM_EXECUTOR_ADDRESS]);

  const tryKey = async (keyFn: (h: string) => string): Promise<boolean | 'unsupported'> => {
    const r = await rpc('eth_call', [
      { to: token, data }, 'latest',
      { [token]: { stateDiff: { [keyFn(SIM_EXECUTOR_ADDRESS)]: pad32(magic) } } },
    ]);
    if (r.error) return overridesUnsupported(r.error) ? 'unsupported' : false;
    try { return BigInt(r.result) === magic; } catch { return false; }
  };

  let found: SlotInfo = null;
  outer:
  for (let slot = 0; slot <= MAX_SLOT; slot++) {
    for (const keyFn of [(h: string) => solidityKey(h, slot), (h: string) => vyperKey(h, slot)]) {
      const ok = await tryKey(keyFn);
      if (ok === 'unsupported') { found = { unsupported: 'RPC does not support eth_call state overrides' }; break outer; }
      if (ok) { found = { key: keyFn }; break outer; }
    }
  }
  slotCache.set(cacheKey, found);
  return found;
}

// ----------------------------------------------------------------------------
// The simulation
// ----------------------------------------------------------------------------
export async function simulateRoundTrip(
  rpc: Rpc,
  chain: string,
  trade: { token: string; amountIn: bigint; hops: ExecutorHop[] },
): Promise<SimResult> {
  const slot = await findBalanceSlot(rpc, `${chain}:${trade.token.toLowerCase()}`, trade.token);
  if (slot === null) return { status: 'unsupported', reason: 'could not find token balance storage' };
  if ('unsupported' in slot) return { status: 'unsupported', reason: slot.unsupported };

  const data = encodeExecuteRaw({
    token: trade.token,
    amountIn: trade.amountIn,
    minProfit: MAX_UINT,          // force the "report profit and refuse" path
    maxBlock: MAX_UINT,
    hops: trade.hops,
  });

  const r = await rpc('eth_call', [
    { from: SIM_CALLER, to: SIM_EXECUTOR_ADDRESS, data, gas: '0x' + (8_000_000).toString(16) },
    'latest',
    {
      [SIM_EXECUTOR_ADDRESS]: {
        code: ARB_EXECUTOR_RUNTIME_CODE,
        stateDiff: { [pad32(ethers.toBeHex(EXECUTOR_STORAGE_SLOT))]: pad32(SIM_CALLER) },
      },
      [trade.token]: { stateDiff: { [slot.key(SIM_EXECUTOR_ADDRESS)]: pad32(trade.amountIn) } },
    },
  ]);

  if (!r.error) return { status: 'fail', reason: 'call unexpectedly succeeded' };
  if (overridesUnsupported(r.error)) return { status: 'unsupported', reason: r.error.message ?? 'overrides unsupported' };

  const rd = revertData(r.error);
  if (!rd || rd === '0x') return { status: 'fail', reason: r.error.message ?? 'reverted without data' };

  try {
    const parsed = errIface.parseError(rd);
    if (parsed?.name === 'InsufficientProfit') {
      const got = parsed.args[0] as bigint;
      return got > 0n ? { status: 'profit', profit: got } : { status: 'loss' };
    }
    if (parsed?.name === 'Error') return { status: 'fail', reason: String(parsed.args[0]) };
    if (parsed) return { status: 'fail', reason: `${parsed.name}(${parsed.args.join(', ')})` };
  } catch { /* unknown error shape */ }
  return { status: 'fail', reason: `revert ${rd.slice(0, 10)}` };
}
