// ============================================================================
// TELEGRAM SENDER
// Deliberately the ONLY module that makes a network call for reporting.
// Never imported by anything in the hot path (chainManager event handler in
// shadowMain.ts) — messages get queued/formatted there, sent here, on the
// cold path, so a slow Telegram API response can never delay a trade.
// ============================================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';

export async function sendTelegramMessage(text: string): Promise<void> {
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
console.warn('[telegram] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — message not sent:');
console.warn(text);
return;
}

const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

try {
const res = await fetch(url, {
method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
if (!res.ok) {
console.error('[telegram] send failed:', res.status, await res.text());
}
} catch (err) {
// Never let a Telegram failure crash or block anything else — this is
// reporting, not trading logic.
console.error('[telegram] send error:', err);
}
}
