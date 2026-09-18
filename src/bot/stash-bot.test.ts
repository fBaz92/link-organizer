import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Update, UserFromGetMe } from "grammy/types";
import { createStashBot, parseSearchQuery } from "@/bot/stash-bot";
import { openDatabase, type DatabaseHandle } from "@/db/connection";
import { migrate } from "@/db/migrate";
import { ItemsRepository } from "@/db/repositories/items";
import { FileStore } from "@/core/files";
import { IngestionService } from "@/core/ingestion";
import { MetadataFetcher } from "@/core/metadata";
import type { StashRuntime } from "@/core/runtime";

/*
 * Flow: test del bot senza rete né token veri. Le chiamate all'API Telegram
 * vengono intercettate con un transformer grammY (getMe risponde con un utente
 * finto); gli update sono costruiti a mano. Copre: dump link con risposta di
 * conferma, dedup con messaggio dedicato, allowlist silenziosa, /cerca con
 * paginazione, /lucky, e il parser dei filtri di ricerca.
 */

const OWNER_ID = 42;
const STRANGER_ID = 99;
// IP pubblico letterale: l'arricchimento in background resta offline (404).
const HOST = "93.184.216.34";

describe("parseSearchQuery", () => {
  it("separa testo, #tag e tipo:", () => {
    const filters = parseSearchQuery("/cerca rust ownership #guide tipo:video");
    expect(filters.q).toBe("rust ownership");
    expect(filters.tag).toBe("guide");
    expect(filters.type).toBe("video");
  });

  it("tollerante a comandi vuoti o con username", () => {
    expect(parseSearchQuery("/cerca@stash_bot #repo").tag).toBe("repo");
    expect(parseSearchQuery("/cerca tipo:pippo").type).toBeUndefined();
  });
});

describe("StashBot", () => {
  let handle: DatabaseHandle;
  let sentMessages: { text: string; chatId: number }[];
  let bot: ReturnType<typeof createStashBot>;
  let updateId = 100;

  beforeAll(async () => {
    handle = openDatabase(":memory:");
    migrate(handle.raw);
    const items = new ItemsRepository(handle);
    const files = new FileStore(await mkdtemp(path.join(tmpdir(), "stash-bot-")));
    const metadata = new MetadataFetcher(files, (async () =>
      new Response("nope", { status: 404, headers: { "content-type": "text/plain" } })) as typeof fetch);
    const runtime: StashRuntime = {
      db: handle,
      items,
      files,
      metadata,
      ingestion: new IngestionService(items, files, metadata),
    };

    sentMessages = [];
    const fakeMe = {
      id: 1,
      is_bot: true,
      first_name: "Stash",
      username: "stash_test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: true,
    } as UserFromGetMe;

    bot = createStashBot("123:test-token", {
      runtime,
      allowedUserIds: [OWNER_ID],
      webAppUrl: "http://localhost:3000",
      botToken: "123:test-token",
    });
    bot.api.config.use(((_prev: unknown, method: string, payload: Record<string, unknown>) => {
      console.log(`[api] ${method}`, JSON.stringify(payload).slice(0, 140));
      if (method === "sendMessage") {
        sentMessages.push({
          text: String(payload.text ?? ""),
          chatId: (payload.chat_id as number) ?? 0,
        });
      }
      if (method === "getMe") return { ok: true, result: fakeMe };
      return { ok: true, result: true };
    }) as never);
    await bot.init();
  });

  function updateWith(text: string, fromId = OWNER_ID): Update {
    updateId += 1;
    // Come Telegram: i comandi portano l'entity bot_command a offset 0.
    const entities =
      text.startsWith("/")
        ? [{ offset: 0, length: text.split(/\s+/)[0]!.length, type: "bot_command" as const }]
        : undefined;
    return {
      update_id: updateId,
      message: {
        message_id: updateId,
        text,
        entities,
        date: Math.floor(Date.now() / 1000),
        chat: { id: fromId, type: "private", first_name: "Test" },
        from: { id: fromId, is_bot: false, first_name: "Test" },
      },
    } as Update;
  }

  it("archivia un link con conferma e tag", async () => {
    await bot.handleUpdate(updateWith(`guarda https://www.youtube.com/watch?v=dQw4w9WgXcQ`));
    const last = sentMessages.at(-1);
    expect(last).toBeDefined();
    expect(last!.text).toContain("Archiviato");
    expect(last!.text).toContain("#video");
  });

  it("risponde con già-in-archivio sullo stesso URL", async () => {
    const before = sentMessages.length;
    await bot.handleUpdate(updateWith("https://youtu.be/dQw4w9WgXcQ?si=xyz"));
    expect(sentMessages.length).toBe(before + 1);
    expect(sentMessages.at(-1)!.text).toContain("Già in archivio");
  });

  it("ignora silenziosamente gli utenti fuori allowlist", async () => {
    const before = sentMessages.length;
    await bot.handleUpdate(updateWith("https://esempio-sconosciuto.it/x", STRANGER_ID));
    expect(sentMessages.length).toBe(before);
  });

  it("/cerca trova con paginazione e /lucky risponde", async () => {
    await bot.handleUpdate(updateWith("/cerca video"));
    expect(sentMessages.at(-1)!.text).toContain("Ricerca");

    await bot.handleUpdate(updateWith("/lucky"));
    expect(sentMessages.at(-1)!.text).toContain("Mi sento fortunato");
  });

  it("i messaggi senza link restano silenziosi", async () => {
    const before = sentMessages.length;
    await bot.handleUpdate(updateWith("solo una nota personale, nessun link"));
    expect(sentMessages.length).toBe(before);
  });
});
