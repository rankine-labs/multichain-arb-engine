// ============================================================================
// TELEGRAM SENDER
// Deliberately the ONLY module that makes a network call for reporting.
// Never imported by anything in the hot path (chainManager event handler in
// shadowMain.ts) — messages get queued/formatted there, sent here, on the
// cold path, so a slow Telegram API response can never delay a trade.
// ============================================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';

// TELEGRAM_CHAT_ID supports one or more comma-separated chat/channel IDs
// (matches the format already used by the sonic-liq-bot project's .env) —
// a message goes out to every ID listed.
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_ID ?? '')
  .split(',')
  .map(id => id.trim())
  .filter(id => id.length > 0);

export async function sendTelegramMessage(text: string): Promise<void> {
    if (!TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_IDS.length === 0) {
          console.warn('[telegram] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — message not sent:');
          console.warn(text);
          return;
    }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  // Sent in parallel, each failure logged independently — one bad chat ID
  // (e.g. the bot was removed from a group) should never block delivery
  // to the others.
  await Promise.all(
        TELEGRAM_CHAT_IDS.map(async (chatId) => {
                try {
                          const res = await fetch(url, {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ chat_id: chatId, text }),
                          });
                          if (!res.ok) {
                                      console.error(`[telegram] send to ${chatId} failed:`, res.status, await res.text());
                          }
                } catch (err) {
                          // Never let a Telegram failure crash or block anything else — this is
                  // reporting, not trading logic.
                  console.error(`[telegram] send to ${chatId} error:`, err);
                }
        }),
      );
}
