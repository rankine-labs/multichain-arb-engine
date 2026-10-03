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

// Telegram rejects messages over 4096 characters.
const MAX_LEN = 4000;

// Plain-text version of an HTML message: tags removed, entities restored.
// Used as a fallback so a formatting mistake never silently drops an alert.
export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Trims an over-long message, closing an open <pre> block so the HTML stays valid.
export function capLength(html: string): string {
  if (html.length <= MAX_LEN) return html;
  let cut = html.slice(0, MAX_LEN);
  cut = cut.slice(0, cut.lastIndexOf('\n') > 0 ? cut.lastIndexOf('\n') : cut.length);
  const opens = (cut.match(/<pre>/g) ?? []).length;
  const closes = (cut.match(/<\/pre>/g) ?? []).length;
  if (opens > closes) cut += '</pre>';
  return cut + '\n<i>(trimmed)</i>';
}

// Messages are HTML (see telegramFormatter.ts). Plain strings without tags
// work too, as long as any '<', '>' or '&' in them is escaped.
export async function sendTelegramMessage(text: string): Promise<void> {
  text = capLength(text);
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
                          const post = (body: Record<string, unknown>) => fetch(url, {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ chat_id: chatId, disable_web_page_preview: true, ...body }),
                          });
                          let res = await post({ text, parse_mode: 'HTML' });
                          // 400 = Telegram couldn't parse the formatting. Resend as
                          // plain text rather than lose the message.
                          if (res.status === 400) {
                                      console.error(`[telegram] HTML rejected for ${chatId}, resending as plain text:`, await res.text());
                                      res = await post({ text: htmlToPlain(text) });
                          }
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
