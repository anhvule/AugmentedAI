// Telegram bridge: long-polls getUpdates and answers through the shared chat
// command engine. Dormant until a bot token is saved in workspace settings.
import { db } from './store.js';
import { handleChatMessage, recordExchange } from './chat.js';

let running = false;
let generation = 0;

const api = (token, method, params) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  }).then((r) => r.json());

async function loop(myGeneration) {
  let backoff = 2000;
  while (running && myGeneration === generation) {
    const token = db.get().settings.telegramToken;
    if (!token) return;
    try {
      const res = await api(token, 'getUpdates', {
        offset: db.get().settings.telegramOffset || 0,
        timeout: 25,
        allowed_updates: ['message'],
      });
      if (!res.ok) throw new Error(res.description || 'getUpdates failed');
      backoff = 2000;
      for (const update of res.result || []) {
        db.get().settings.telegramOffset = update.update_id + 1;
        db.save();
        const text = update.message?.text;
        const chatId = update.message?.chat?.id;
        if (!text || !chatId) continue;
        const reply = handleChatMessage(text);
        recordExchange('telegram', text, reply);
        await api(token, 'sendMessage', { chat_id: chatId, text: reply });
      }
    } catch (err) {
      console.error('[telegram]', err.message);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60000);
    }
  }
}

export function syncTelegram() {
  const token = db.get().settings.telegramToken;
  generation += 1; // stop any previous loop
  running = Boolean(token);
  if (running) {
    console.log('[telegram] bridge started');
    loop(generation);
  }
}
