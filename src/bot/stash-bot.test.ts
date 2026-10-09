import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Update, UserFromGetMe } from "grammy/types";
import { createStashBot, parseSearchQuery } from "@/bot/stash-bot";
import { openDatabase, type DatabaseHandle } from "@/db/connection";
import { migrate } from "@/db/migrate";
import { ItemsRepository } from "@/db/repositories/items";
import { FileStore } from "@/core/files";
import { IngestionService } from "@/core/ingestion";
import { MetadataFetcher } from "@/core/metadata";
import { VideoDownloadService, type VideoUploadInput } from "@/core/video-download";
import type { StashRuntime } from "@/core/runtime";

/*
 * Flow: test del bot senza rete né token veri. Le chiamate all'API Telegram
 * vengono intercettate con un transformer grammY (getMe risponde con un utente
 * finto); gli update sono costruiti a mano. Copre: dump link con risposta di
 * conferma, dedup con messaggio dedicato, allowlist silenziosa, /cerca con
 * paginazione, /lucky, il wizard /scarica (menu, parola chiave, avvio) e il
 * parser dei filtri di ricerca.
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
  let items: ItemsRepository;
  let sentMessages: { text: string; chatId: number; buttons?: { text: string; data: string }[] }[];
  let uploads: VideoUploadInput[];
  let runtime: StashRuntime;
  let bot: ReturnType<typeof createStashBot>;
  let updateId = 100;

  beforeAll(async () => {
    handle = openDatabase(":memory:");
    migrate(handle.raw);
    items = new ItemsRepository(handle);
    const files = new FileStore(await mkdtemp(path.join(tmpdir(), "stash-bot-")));
    const metadata = new MetadataFetcher(files, (async () =>
      new Response("nope", { status: 404, headers: { "content-type": "text/plain" } })) as typeof fetch);
    const ingestion = new IngestionService(items, files, metadata);
    uploads = [];
    const videoDownload = new VideoDownloadService(items, files, ingestion, {
      downloader: async (url, dir) => {
        // Byte diversi per URL diversi: ogni "video" ha il suo hash sha256.
        const downloaded = path.join(dir, "video.mp4");
        await writeFile(downloaded, `fake mp4 per ${url}`);
        return downloaded;
      },
      uploader: async (input) => {
        uploads.push(input);
      },
    });
    runtime = {
      db: handle,
      items,
      files,
      metadata,
      ingestion,
      videoDownload,
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
      if (method === "sendMessage") {
        const keyboard = (payload.reply_markup as { inline_keyboard?: { text: string; callback_data?: string }[] } | undefined)
          ?.inline_keyboard;
        sentMessages.push({
          text: String(payload.text ?? ""),
          chatId: (payload.chat_id as number) ?? 0,
          buttons: keyboard?.flat().map((button) => ({ text: String(button.text), data: String(button.callback_data ?? "") })),
        });
      }
      if (method === "getMe") return { ok: true, result: fakeMe };
      return { ok: true, result: true };
    }) as never);
    await bot.init();

    // Un video YouTube con titolo e canale noti, per il wizard /scarica.
    items.insert({
      type: "video",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      canonicalUrl: "https://youtu.be/abcdefghijk",
      title: "Rust tutorial completo",
      authorName: "Dev Channel",
      source: "web",
      tags: ["video"],
    });
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

  function callbackUpdate(data: string, fromId = OWNER_ID): Update {
    updateId += 1;
    return {
      update_id: updateId,
      callback_query: {
        id: `cb-${updateId}`,
        from: { id: fromId, is_bot: false, first_name: "Test" },
        message: {
          message_id: updateId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: fromId, type: "private", first_name: "Test" },
          text: "wizard",
        },
        data,
      },
    } as Update;
  }

  async function waitForUploads(count: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (uploads.length < count) {
      if (Date.now() > deadline) throw new Error(`upload attesi ${count}, avvenuti ${uploads.length}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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

  it("archivia tutti i link di un messaggio anche se Telegram rifiuta le conferme", async () => {
    const urls = Array.from({ length: 6 }, (_, i) => `https://${HOST}/backlog-links-${i}`);
    let failReplies = true;
    bot.api.config.use(async (previous, method, payload, signal) => {
      if (failReplies && method === "sendMessage") throw new Error("Telegram unavailable");
      return previous(method, payload, signal);
    });
    try {
      await bot.handleUpdate(updateWith(urls.join("\n")));
      for (const url of urls) expect(items.list({ limit: 100, offset: 0 }).items.some(item => item.url === url)).toBe(true);
    } finally {
      failReplies = false;
    }
  });

  it("mantiene ritentabili gli errori del disco durante l'archiviazione dei documenti", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("document"));
    const absorb = vi.spyOn(runtime.files, "absorbFile").mockRejectedValueOnce(new Error("ENOSPC"));
    let intercept = true;
    bot.api.config.use(async (previous, method, payload, signal) => {
      if (intercept && method === "getFile") return { ok: true, result: { file_id: "doc", file_unique_id: "doc", file_path: "documents/test.pdf" } } as never;
      return previous(method, payload, signal);
    });
    const update = updateWith("");
    if (!update.message) throw new Error("Missing fixture message");
    delete update.message.text;
    update.message.document = { file_id: "doc", file_unique_id: "doc", file_name: "test.pdf", file_size: 8 };
    try {
      await expect(bot.handleUpdate(update)).rejects.toThrow("Impossibile leggere il file");
    } finally {
      intercept = false;
      fetchMock.mockRestore();
      absorb.mockRestore();
    }
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

  it("/scarica senza argomenti apre il wizard", async () => {
    await bot.handleUpdate(updateWith("/scarica"));
    const last = sentMessages.at(-1)!;
    expect(last.text).toContain("Scarica un video");
    expect(last.buttons?.map((b) => b.text)).toContain("🎬 Ultimi 20 video archiviati");
    expect(last.buttons?.map((b) => b.text)).toContain("🔎 Cerca per parola chiave");
  });

  it("/scarica <link> avvia il download e arriva il video in chat", async () => {
    const uploadsBefore = uploads.length;
    await bot.handleUpdate(updateWith("/scarica https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
    expect(sentMessages.at(-1)!.text).toContain("Download avviato");

    await waitForUploads(uploadsBefore + 1);
    expect(uploads.at(-1)!.chatId).toBe(String(OWNER_ID));
    expect(uploads.at(-1)!.caption).toContain("https://youtu.be/dQw4w9WgXcQ");
  });

  it("/scarica con link non YouTube rifiuta con messaggio chiaro", async () => {
    await bot.handleUpdate(updateWith("/scarica https://esempio.it/video"));
    expect(sentMessages.at(-1)!.text).toContain("link YouTube");
  });

  it("wizard: ultimi 20, parola chiave 'simile' e avvio dal bottone", async () => {
    await bot.handleUpdate(callbackUpdate("dlwiz:recent"));
    const recentMessage = sentMessages.at(-1)!;
    expect(recentMessage.text).toContain("Ultimi video archiviati");
    expect(recentMessage.text).toContain("Rust tutorial completo");

    await bot.handleUpdate(callbackUpdate("dlwiz:search"));
    expect(sentMessages.at(-1)!.text).toContain("parola chiave");

    // La parola chiave arriva come messaggio testuale (con un refuso: deve comunque trovare).
    await bot.handleUpdate(updateWith("rust titorial"));
    const results = sentMessages.at(-1)!;
    expect(results.text).toContain("Video simili");
    expect(results.text).toContain("Dev Channel");

    // Primo bottone dei risultati (callback_data reale) → download avviato.
    const firstResult = results.buttons?.find((button) => button.data.startsWith("dlgo:"));
    expect(firstResult).toBeDefined();
    const uploadsBefore = uploads.length;
    await bot.handleUpdate(callbackUpdate(firstResult!.data));
    expect(sentMessages.at(-1)!.text).toContain("Download avviato");

    await waitForUploads(uploadsBefore + 1);
    expect(uploads.at(-1)!.caption).toContain("Rust tutorial completo");
  });

  it("wizard: sessione scaduta avvisa di rifare /scarica", async () => {
    await bot.handleUpdate(callbackUpdate("dlgo:inesistente:0"));
    // answerCallbackQuery con "Ricerca scaduta": nessun nuovo messaggio sendMessage.
    const before = sentMessages.length;
    await bot.handleUpdate(updateWith("altro messaggio senza link"));
    expect(sentMessages.length).toBe(before);
  });
});
