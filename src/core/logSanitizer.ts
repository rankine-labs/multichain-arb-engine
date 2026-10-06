import { formatWithOptions } from 'util';

// ============================================================================
// LOG SANITIZER -- no API key, token or private key ever reaches a log.
//
// Why: ethers puts the FULL request URL (Alchemy key included) into the text
// of its server errors, and many log lines print err.message or whole error
// objects. Redacting each call site is whack-a-mole, so this wraps
// console.log/info/warn/error once at startup and scrubs every line.
//
// What gets scrubbed:
//   1. The exact values of secret-looking env vars (names containing KEY,
//      TOKEN, SECRET, PRIVATE, PASSWORD, RPC, URL, WSS), plus any long path
//      segment or query value inside those URLs. Exact matching catches keys
//      that no pattern would recognise.
//   2. Generic patterns: /v2/<key> or /v3/<key> style paths, long random
//      path segments in URLs, ?apikey=/key=/token= query values, and
//      Telegram bot tokens.
// Plain 0x hashes and addresses are left alone (tx hashes, pool ids).
// ============================================================================

const SECRET_NAME = /KEY|TOKEN|SECRET|PRIVATE|PASSWORD|PASS|RPC|URL|WSS|AUTH/i;

// Pieces of a URL that could be credentials: long path segments, query
// values, and user:pass.
export function urlSecretParts(value: string): string[] {
  const out: string[] = [];
  try {
    const u = new URL(value);
    if (u.username) out.push(u.username);
    if (u.password) out.push(u.password);
    for (const seg of u.pathname.split('/')) if (seg.length >= 16) out.push(seg);
    for (const [, v] of u.searchParams) if (v.length >= 12) out.push(v);
  } catch { /* not a URL */ }
  return out;
}

// Exact strings to hide, longest first (so a key inside a URL is caught even
// if only part of the URL is printed).
export function collectSecrets(env: Record<string, string | undefined> = process.env): string[] {
  const set = new Set<string>();
  for (const [name, raw] of Object.entries(env)) {
    if (!raw || !SECRET_NAME.test(name)) continue;
    const v = raw.trim();
    const parts = urlSecretParts(v);
    if (parts.length) parts.forEach((p) => set.add(p));
    // Non-URL secrets (tokens, private keys) are hidden whole. Public URLs
    // with no credential parts are left alone so logs stay readable.
    else if (!/^(https?|wss?):\/\//i.test(v) && v.length >= 16) set.add(v);
  }
  return [...set].sort((a, b) => b.length - a.length);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PATTERNS: [RegExp, string][] = [
  [/\/(v2|v3)\/[A-Za-z0-9_-]{8,}/g, '/$1/***'],                                       // Alchemy/Infura style
  [/((?:https?|wss?):\/\/[^\s"'/]+(?:\/[^\s"'/?]*)*?)\/[A-Za-z0-9_-]{24,}(?=[/?\s"']|$)/g, '$1/***'], // QuickNode style long segment
  [/([?&](?:api[-_]?key|key|token|access[-_]?token|auth)=)[^&\s"']+/gi, '$1***'],      // query-string keys
  [/bot\d{6,}:[A-Za-z0-9_-]{30,}/g, 'bot***'],                                          // Telegram bot token
];

export function scrub(text: string, secrets: string[]): string {
  let s = text;
  for (const sec of secrets) if (s.includes(sec)) s = s.replace(new RegExp(escapeRe(sec), 'g'), '***');
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

let installed = false;

// Wrap the console once. Safe to call more than once.
export function installLogSanitizer(env: Record<string, string | undefined> = process.env) {
  if (installed) return;
  installed = true;
  const secrets = collectSecrets(env);
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        orig(scrub(formatWithOptions({ depth: 4 }, ...args), secrets));
      } catch {
        orig('[log] (line dropped: could not sanitise)');
      }
    };
  }
}
