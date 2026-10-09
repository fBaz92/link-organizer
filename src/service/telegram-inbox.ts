import type { Bot } from "grammy";
import type { Update } from "grammy/types";
import type { RawSqlite } from "@/db/connection";

interface InboxOptions {
  onStart?: () => void;
  onError?: (error: unknown) => void;
}

/** Persist before confirming Telegram offsets. Processing failures stay in SQLite.
 * Delivery is at least once: handlers must tolerate replay after a process crash.
 */
export async function startTelegramInbox(bot: Bot, raw: RawSqlite, options: InboxOptions = {}) {
  const abort = new AbortController();
  // grammY types its Node signal with an older polyfill; native Node signals
  // implement the abort listener contract used by its HTTP client.
  const signal = abort.signal as unknown as NonNullable<Parameters<Bot["init"]>[0]>;
  let stopping = false;
  const report = (error: unknown) => {
    try { options.onError?.(error); } catch { /* Diagnostics must not interrupt intake. */ }
  };
  const pause = (ms: number) => new Promise<void>(resolve => {
    if (stopping) return resolve();
    const done = () => { clearTimeout(timer); abort.signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    abort.signal.addEventListener("abort", done, { once: true });
  });
  const getOffset = raw.prepare("SELECT next_offset FROM telegram_inbox_offset WHERE id = 1");
  const count = raw.prepare("SELECT COUNT(*) AS count FROM telegram_inbox");
  const insert = raw.prepare("INSERT OR IGNORE INTO telegram_inbox (update_id, update_json) VALUES (?, ?)");
  const setOffset = raw.prepare("UPDATE telegram_inbox_offset SET next_offset = ? WHERE id = 1");
  const next = raw.prepare("SELECT update_id, update_json, attempts FROM telegram_inbox WHERE next_attempt <= ? ORDER BY update_id LIMIT 1");
  const remove = raw.prepare("DELETE FROM telegram_inbox WHERE update_id = ?");
  const retry = raw.prepare("UPDATE telegram_inbox SET attempts = ?, next_attempt = ? WHERE update_id = ?");

  await bot.init(signal);
  await bot.api.deleteWebhook({ drop_pending_updates: false }, signal);
  options.onStart?.();

  async function poll() {
    while (!stopping) {
      try {
        const remaining = 1000 - Number(count.get()!.count);
        if (remaining <= 0) { await pause(100); continue; }
        const offset = Number(getOffset.get()!.next_offset);
        const updates = await bot.api.getUpdates({ offset, limit: Math.min(100, remaining), timeout: 25, allowed_updates: [] }, signal);
        if (updates.length) {
          raw.transaction(() => {
            let nextOffset = offset;
            for (const update of updates) {
              insert.run(update.update_id, JSON.stringify(update));
              nextOffset = Math.max(nextOffset, update.update_id + 1);
            }
            setOffset.run(nextOffset);
          })();
        } else await pause(25);
      } catch (error) {
        if (!stopping) { report(error); await pause(1000); }
      }
    }
  }
  async function processPending() {
    while (!stopping) {
      try {
        const row = next.get(Date.now());
        if (!row) { await pause(50); continue; }
        try {
          await bot.handleUpdate(JSON.parse(String(row.update_json)) as Update);
          remove.run(row.update_id);
        } catch (error) {
          const attempts = Number(row.attempts) + 1;
          retry.run(attempts, Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempts - 1, 6)), row.update_id);
          report(error);
        }
      } catch (error) {
        if (!stopping) { report(error); await pause(1000); }
      }
    }
  }
  const polling = poll();
  const processing = processPending();
  return {
    async stop() {
      stopping = true;
      abort.abort();
      await Promise.all([polling, processing]);
    },
  };
}
