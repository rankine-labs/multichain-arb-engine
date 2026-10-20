// ============================================================================
// SIM-COMPARE: shared shapes (plain English notes on each field)
//
// The harness works in three steps, each writing to its own file so a run can
// be stopped and resumed at any time:
//   1. collect  -> cases.jsonl     the checks the bot WOULD have run
//   2. check    -> node.jsonl      the node's answer to each check (the truth)
//                  fast-<engine>.jsonl  the fast engine's answer
//   3. report   -> report.json + report.txt
// ============================================================================
import type { ExecutorHop } from '../../src/execution/executorCalldata';

// One contract call, as sent to a node (hex strings).
export interface CallObj { from: string; to: string; data: string; gas?: string; value?: string }

// 'trigger'  = follow-a-trade: replay the block up to and including someone's
//              swap on a watched pool, then run our trade (eth_simulateV1).
// 'standing' = a gap that was simply there at the start of a block: plain
//              eth_call on the state at the end of the previous block.
export type CaseMode = 'trigger' | 'standing';

export interface CaseRoute {
  pair: string;          // "WETH/USDG" style label (symbols when known)
  token: string;         // the coin the round trip starts and ends with
  amountIn: string;      // whole number, token base units (decimal text)
  sizeLabel: string;     // e.g. "2000 USDG"
  hops: ExecutorHop[];   // exactly as buildExecuteCall made them
  kinds: string;         // route type, e.g. "V3>V2", "Algebra>V4-hooked"
  buyPool: string; sellPool: string;
  buyDex: string; sellDex: string;
}

export interface Case {
  v: 1;
  id: string;                 // short fingerprint of everything below (same check = same id)
  mode: CaseMode;
  block: number;              // trigger: block the trade landed in; standing: block whose START we test
  parent: number;             // state the check runs on = block - 1
  time: string | null;        // trigger only: real block timestamp (hex), used as the simulated block's time
  txIndex: number | null;     // trigger only: position of the trade we follow in its block
  triggerHash: string | null;
  triggerPool: string | null; // which watched pool the trade touched
  decodedByBot: boolean | null; // would the bot's feed decoder have recognised this trade? (info only)
  prefixLen: number;          // trigger: how many replayed calls run before ours (from blocks/<block>.json)
  route: CaseRoute;
  funding: 'own' | 'flash';
  v3Lender: string | null;
  // EXACTLY what the bot's simulateRoundTrip sent, captured, not rebuilt.
  // The executor's code inside `overrides` is stored as "@executor" (it is
  // 20 KB) and put back before use; executorCodeHash guards against the
  // bot's contract code changing between collect and check.
  call: CallObj;
  tag: string;                // block tag simulateRoundTrip used ('latest' for trigger: the replay ignores it)
  overrides: Record<string, any>;
  executorCodeHash: string;
}

// The replayed transactions of one trigger block (blocks/<block>.json).
export interface BlockPrefix {
  block: number;
  parent: number;
  time: string;
  // User transactions only (system txs skipped exactly like the bot does),
  // with their real position in the block.
  calls: Array<{ i: number; hash: string; from: string; to: string; data: string; value?: string; gas?: string }>;
}

// A contract's answer, the same shape for node and fast engine.
export interface RawAnswer {
  success: boolean;
  output: string;            // return data or revert data ("0x" = none)
  gasUsed: string | null;    // decimal text; null when the side doesn't report it (plain eth_call)
  message?: string;          // node's error text (for "no reason" failures)
}

export interface NodeRecord {
  id: string;
  status: 'answer' | 'node_error';
  raw?: RawAnswer;
  reason?: string;           // node_error: why (e.g. "replay unavailable (state gone)")
  via: 'eth_simulateV1' | 'eth_call';
  prefixStatuses?: string;   // trigger: "1" ok / "0" failed per replayed call, from the node
  ms: number;
}

export type FastResult =
  | { status: 'answer'; success: boolean; output: string; gasUsed: string | null; prefixStatuses?: string; us?: number; note?: string }
  | { status: 'unknown'; why: string; us?: number };

export interface FastRecord {
  id: string;
  engine: string;            // engine name + version, e.g. "arbsim-socket@0.1.0"
  result: FastResult;
  ms: number;                // wall time seen by the harness
}
