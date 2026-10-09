import { Bot } from "grammy";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Update } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "@/db/connection";
import { migrate } from "@/db/migrate";
import { startTelegramInbox } from "./telegram-inbox";

function update(id: number): Update {
  return { update_id: id, message: { message_id: id, date: 1, from: { id: 1, is_bot: false, first_name: "Test" }, chat: { id: 1, type: "private", first_name: "Test" }, text: String(id) } };
}

function fixture(updates: Update[], onPoll: (offset: number) => void = () => {}) {
  const bot = new Bot("123:fixture");
  vi.spyOn(bot.api, "getMe").mockResolvedValue({ id: 123, is_bot: true, first_name: "Fixture", username: "fixture_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false });
  vi.spyOn(bot.api, "deleteWebhook").mockImplementation(async payload => {
    expect(payload).toEqual({ drop_pending_updates: false });
    return true;
  });
  vi.spyOn(bot.api, "getUpdates").mockImplementation(async (payload, signal) => {
      const { offset = 0, limit = 100 } = payload ?? {};
      onPoll(offset);
      const batch = updates.filter(update => update.update_id >= offset).slice(0, limit);
      if (batch.length) return batch;
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) return reject(new Error("Aborted"));
        signal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
      });
      return [];
  });
  return bot;
}

describe("durable Telegram intake", () => {
  it("persists every batch before acknowledgment and drains more than 100 messages", async () => {
    const db = openDatabase(":memory:");
    migrate(db.raw);
    const updates = Array.from({ length: 205 }, (_, index) => update(index + 1));
    const processed = new Set<number>();
    const offsets: number[] = [];
    const bot = fixture(updates, offset => {
      offsets.push(offset);
      const stored = new Set(db.raw.prepare("SELECT update_id FROM telegram_inbox").all().map(row => Number(row.update_id)));
      for (const item of updates.filter(item => item.update_id < offset)) {
        expect(stored.has(item.update_id) || processed.has(item.update_id)).toBe(true);
      }
    });
    bot.use(ctx => { processed.add(ctx.update.update_id); });
    const inbox = await startTelegramInbox(bot, db.raw);
    try {
      await vi.waitFor(() => expect(processed.size).toBe(205));
      expect(offsets).toEqual([0, 101, 201, 206]);
      expect(db.raw.prepare("SELECT next_offset FROM telegram_inbox_offset").get()?.next_offset).toBe(206);
    } finally { await inbox.stop(); db.raw.close(); }
  });

  it("retains failed work across restart and processes later due messages", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "telegram-inbox-"));
    const file = path.join(root, "stash.db");
    let db = openDatabase(file);
    migrate(db.raw);
    const bot = fixture([update(1), update(2)]);
    const processed: number[] = [];
    bot.use(ctx => {
      if (ctx.update.update_id === 1) throw new Error("Temporary failure");
      processed.push(ctx.update.update_id);
    });
    const inbox = await startTelegramInbox(bot, db.raw);
    await vi.waitFor(() => expect(processed).toEqual([2]));
    await inbox.stop();
    expect(db.raw.prepare("SELECT attempts FROM telegram_inbox WHERE update_id = 1").get()?.attempts).toBe(1);
    expect(db.raw.prepare("SELECT next_offset FROM telegram_inbox_offset").get()?.next_offset).toBe(3);
    db.raw.close();
    db = openDatabase(file);
    // Advance the persisted retry time, without losing the original update.
    db.raw.prepare("UPDATE telegram_inbox SET next_attempt = 0").run();
    const replacement = fixture([]);
    replacement.use(ctx => { processed.push(ctx.update.update_id); });
    const restarted = await startTelegramInbox(replacement, db.raw);
    try {
      await vi.waitFor(() => expect(processed).toEqual([2, 1]));
      await vi.waitFor(() => expect(db.raw.prepare("SELECT COUNT(*) AS count FROM telegram_inbox").get()?.count).toBe(0));
    } finally { await restarted.stop(); db.raw.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("stop waits for an in-flight handler and keeps its update until completion", async () => {
    const db = openDatabase(":memory:");
    migrate(db.raw);
    const bot = fixture([update(1)]);
    let entered = false;
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    bot.use(async () => { entered = true; await gate; });
    const inbox = await startTelegramInbox(bot, db.raw);
    await vi.waitFor(() => expect(entered).toBe(true));
    let stopped = false;
    const stopping = inbox.stop().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    expect(db.raw.prepare("SELECT update_id FROM telegram_inbox").get()?.update_id).toBe(1);
    finish();
    await stopping;
    expect(db.raw.prepare("SELECT update_id FROM telegram_inbox").get()).toBeUndefined();
    db.raw.close();
  });
});
