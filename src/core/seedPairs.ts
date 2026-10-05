import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';

// ============================================================================
// START PAIRS -- which pairs to watch the moment the bot starts
//
// Plain English:
//   The chain-wide scan picks the top 20 pairs, but it can take minutes and
//   the free node sometimes blocks it. Until it finishes the bot would only
//   watch WETH/USDG. So:
//     1. after every good scan, the top pairs are saved to a small file
//        (data/robinhood-top-pairs.json on the server);
//     2. on startup the bot watches the pairs in that file straight away;
//     3. if that file is missing (fresh machine, data/ deleted) it uses the
//        backup list committed in the repo (config/robinhoodSeedPairs.ts).
//   The scan still runs as before and replaces the list when it finishes.
// ============================================================================

export interface SeedPair { a: string; b: string; label?: string }

const isAddr = (x: unknown): x is string => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x);

// Keeps only well-formed pairs; anything odd in the file is skipped, never trusted.
export function cleanPairs(raw: unknown): SeedPair[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SeedPair[] = [];
  for (const p of raw) {
    if (!p || !isAddr(p.a) || !isAddr(p.b) || p.a.toLowerCase() === p.b.toLowerCase()) continue;
    const key = [p.a.toLowerCase(), p.b.toLowerCase()].sort().join('/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a: p.a, b: p.b, label: typeof p.label === 'string' ? p.label.slice(0, 40) : undefined });
  }
  return out;
}

// Saved list first, then the committed backup. Never throws.
export function loadStartPairs(savedFile: string, backup: SeedPair[]): { pairs: SeedPair[]; source: 'saved' | 'backup' | 'none' } {
  try {
    const saved = cleanPairs(JSON.parse(readFileSync(savedFile, 'utf8')));
    if (saved.length) return { pairs: saved, source: 'saved' };
  } catch { /* missing or unreadable: use the backup */ }
  const b = cleanPairs(backup);
  return { pairs: b, source: b.length ? 'backup' : 'none' };
}

// Atomic write (temp file + rename) so a crash never leaves half a file.
export function saveStartPairs(file: string, pairs: SeedPair[]): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify(cleanPairs(pairs), null, 1));
    renameSync(file + '.tmp', file);
  } catch (err) { console.warn('[scan] could not save top pairs:', (err as Error).message); }
}
