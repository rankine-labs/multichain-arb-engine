// ============================================================================
// ENV DEFAULTS -- fill in settings the owner already gave us in another form.
//
// Plain English:
//   The owner saved the Chainstack links in .env as CHAINSTACK_RPC_ROBINHOOD
//   (and CHAINSTACK_WSS_ROBINHOOD) and tested them (Oct 13: chain id and
//   eth_simulateV1 both work). The bot's any-provider switch (core/checkNodes.ts)
//   reads CHECK_RPC_MAIN / CHECK_RPC_FALLBACK instead. Rather than making the
//   owner edit .env again on the server, this file copies the values across
//   at startup, but ONLY when the CHECK_* settings are not set. Anything the
//   owner sets in .env always wins.
//
//   What it fills in (only if missing):
//     CHECK_RPC_MAIN           <- CHAINSTACK_RPC_ROBINHOOD   (practice checks on Chainstack)
//     CHECK_RPC_MAIN_DAILY     <- 60000                      (free plan: ~100k/day, leave room)
//     CHECK_RPC_FALLBACK       <- QUICKNODE_RPC_ROBINHOOD    (QuickNode as the backup)
//     CHECK_RPC_FALLBACK_DAILY <- 14000                      (QuickNode's daily allowance)
//     LOOP_TRADER              <- 1                          (owner approved Oct 13; practice
//                                                             only, the loop code can't send)
//   Set LOOP_TRADER=0 in .env to turn loops off again.
//
//   NOT filled in: BLOCK_READER_WSS. The WebSocket reader pushes a message for
//   every pool trade on the chain, which could use up the free plan in a day.
//   It waits until the owner upgrades the plan and sets it on purpose.
//
//   Must be imported right after 'dotenv/config' and before anything else
//   reads these settings. Never prints the links (they contain the API key).
// ============================================================================

type Env = Record<string, string | undefined>;

// Fills in missing settings on `env` and returns plain-English notes of what
// it did (no URLs, no keys). Exported for tests.
export function applyEnvDefaults(env: Env): string[] {
  const notes: string[] = [];
  const has = (k: string) => (env[k] ?? '').trim() !== '';

  if (!has('CHECK_RPC_MAIN') && has('CHAINSTACK_RPC_ROBINHOOD')) {
    env.CHECK_RPC_MAIN = env.CHAINSTACK_RPC_ROBINHOOD!.trim();
    notes.push('practice checks: Chainstack (from CHAINSTACK_RPC_ROBINHOOD)');
    if (!has('CHECK_RPC_MAIN_DAILY')) { env.CHECK_RPC_MAIN_DAILY = '60000'; notes.push('Chainstack daily allowance 60000'); }
    if (!has('CHECK_RPC_FALLBACK') && has('QUICKNODE_RPC_ROBINHOOD')) {
      env.CHECK_RPC_FALLBACK = env.QUICKNODE_RPC_ROBINHOOD!.trim();
      notes.push('backup for checks: QuickNode');
      if (!has('CHECK_RPC_FALLBACK_DAILY')) { env.CHECK_RPC_FALLBACK_DAILY = '14000'; notes.push('QuickNode daily allowance 14000'); }
    }
  }

  if (!has('LOOP_TRADER')) {
    env.LOOP_TRADER = '1';
    notes.push('loop trader ON (practice only; set LOOP_TRADER=0 to turn off)');
  }
  return notes;
}

// Runs once when imported.
const applied = applyEnvDefaults(process.env as Env);
if (applied.length) console.log(`[env] defaults filled in: ${applied.join(' · ')}`);
