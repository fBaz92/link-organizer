import { rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Bot, type Context } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import { isItemType, type Item } from "@/core/domain/item";
import { extractFromEntities, extractUrls } from "@/core/extract-urls";
import type { StashRuntime } from "@/core/runtime";
import type { ItemFilters, PagedItemFilters } from "@/db/repositories/items";
import {
  createdMessage,
  duplicateMessage,
  escapeHtml,
  helpMessage,
  itemList,
  statMessage,
  truncate,
} from "@/bot/render";

/*
 * Flow: il bot Telegram — il punto d'accesso primario di Stash.
 *
 * 1. Allowlist: il middleware in testa ignora silenziosamente chiunque non
 *    sia in TELEGRAM_ALLOWED_USER_IDS.
 * 2. Dump: ogni messaggio con link (entity Telegram o regex fallback) o
 *    documento viene archiviato dalla pipeline condivisa; la risposta è
 *    immediata (dedup + tag), i metadati arrivano in background.
 * 3. Menu: /cerca (con inline keyboard: apri, elimina, paginazione),
 *    /recenti, /lucky, /tag, /stat, /aiuto.
 * 4. Inline mode: @tuobot <query> suggerisce gli item in qualunque chat.
 *
 * La factory è pura rispetto alla rete: riceve runtime e opzioni, così i
 * test possono usare un runtime in-memory (vedi stash-bot.test.ts).
 */

const SEARCH_PAGE_SIZE = 5;
const LUCKY_SIZE = 10;
const MAX_LINKS_PER_MESSAGE = 3;
const MAX_TELEGRAM_DOWNLOAD = 20 * 1024 * 1024; // limite Bot API getFile

export interface StashBotOptions {
  runtime: StashRuntime;
  allowedUserIds: readonly number[];
  webAppUrl: string;
  botToken: string;
}

interface SearchState {
  filters: ItemFilters;
  total: number;
}

export const BOT_COMMANDS = [
  { command: "cerca", description: "Cerca nell'archivio (es. /cerca rust #guide)" },
  { command: "recenti", description: "Ultimi item archiviati" },
  { command: "lucky", description: "10 item a caso tra i non visti" },
  { command: "tag", description: "I tag più usati" },
  { command: "stat", description: "Statistiche dell'archivio" },
  { command: "aiuto", description: "Come funziona Stash" },
] as const;

export function createStashBot(botToken: string, options: StashBotOptions): Bot {
  const bot = new Bot(botToken);
  const { runtime, webAppUrl } = options;
  const searchSessions = new Map<string, SearchState>();

  // ── Middleware: allowlist, sempre per primo ────────────────────────────
  bot.use(async (ctx, next) => {
    if (ctx.from && options.allowedUserIds.includes(ctx.from.id)) {
      return next();
    }
    // Sconosciuto: silenzio totale (nessuna conferma di esistenza).
  });

  // ── Menu: comandi ──────────────────────────────────────────────────────
  bot.command("start", (ctx) => ctx.reply(helpMessage(webAppUrl), { parse_mode: "HTML" }));
  bot.command("aiuto", (ctx) => ctx.reply(helpMessage(webAppUrl), { parse_mode: "HTML" }));

  bot.command("stat", (ctx) => ctx.reply(statMessage(runtime.items.stats()), { parse_mode: "HTML" }));

  bot.command("tag", (ctx) => {
    const tags = runtime.items.tagsWithCounts().slice(0, 20);
    const text =
      tags.length === 0
        ? "Nessun tag: archivia qualcosa!"
        : `🏷 <b>Tag più usati</b>\n\n${tags.map((t) => `#${escapeHtml(t.name)} — ${t.count}`).join("\n")}`;
    return ctx.reply(text, { parse_mode: "HTML" });
  });

  bot.command("recenti", (ctx) => {
    const { items } = runtime.items.list({ limit: LUCKY_SIZE, offset: 0 });
    return ctx.reply(itemList(items, "📥 <b>Ultimi archiviati</b>", "Archivio vuoto."), { parse_mode: "HTML" });
  });

  bot.command("lucky", (ctx) => {
    const tag = parseLuckyTag(ctx.message?.text ?? "");
    // Default: solo non visti. Se il filtro non produce nulla, si estrae da tutto.
    let items = runtime.items.random({ seen: false, tag }, LUCKY_SIZE);
    if (items.length === 0) items = runtime.items.random({ tag }, LUCKY_SIZE);
    return ctx.reply(itemList(items, "🎰 <b>Mi sento fortunato</b>", "Archivio vuoto: niente fortuna da sprecare."), {
      parse_mode: "HTML",
    });
  });

  bot.command("cerca", async (ctx) => {
    const filters = parseSearchQuery(ctx.message?.text ?? "");
    if (!filters.q && !filters.tag && !filters.type) {
      await ctx.reply("Uso: /cerca &lt;testo&gt; [#tag] [tipo:video]", { parse_mode: "HTML" });
      return;
    }
    await sendSearchPage(ctx, filters, 0);
  });

  // ── Dump: documenti e link ─────────────────────────────────────────────
  bot.on("message:document", (ctx) => handleDocument(ctx));

  bot.on(["message:photo", "message:video", "message:audio", "message:voice", "message:animation"], (ctx) => {
    return ctx.reply("📤 I file multimediali non sono ancora supportati: per ora Stash archivia link e documenti.");
  });

  bot.on("message", (ctx) => handleTextDump(ctx));

  // ── Callback: paginazione ricerca ed eliminazione ──────────────────────
  bot.callbackQuery(/^sq:(\w+):(\d+)$/, async (ctx) => {
    const [, sessionId, pageRaw] = ctx.match;
    const state = searchSessions.get(sessionId);
    if (!state) {
      await ctx.answerCallbackQuery("Ricerca scaduta: rifai /cerca.");
      return;
    }
    await ctx.answerCallbackQuery();
    await sendSearchPage(ctx, state.filters, Number.parseInt(pageRaw, 10));
  });

  bot.callbackQuery(/^del:(\d+)$/, async (ctx) => {
    const id = Number.parseInt(ctx.match[1], 10);
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🗑 Conferma eliminazione", callback_data: `dely:${id}` },
            { text: "Annulla", callback_data: "deln" },
          ],
        ],
      },
    });
  });

  bot.callbackQuery(/^dely:(\d+)$/, async (ctx) => {
    const id = Number.parseInt(ctx.match[1], 10);
    runtime.items.delete(id);
    searchSessions.clear(); // i conteggi delle pagine non sono più affidabili
    await ctx.answerCallbackQuery("Eliminato.");
    await ctx.editMessageText(`🗑 Item #${id} eliminato dall'archivio.`);
  });

  bot.callbackQuery("deln", async (ctx) => {
    await ctx.answerCallbackQuery("Annullato.");
  });

  // ── Inline mode: @tuobot <query> ───────────────────────────────────────
  bot.on("inline_query", async (ctx) => {
    const query = ctx.inlineQuery.query.trim();
    const items =
      query !== ""
        ? runtime.items.list({ q: query, limit: 20, offset: 0 }).items
        : runtime.items.list({ limit: 20, offset: 0 }).items;

    await ctx.answerInlineQuery(
      items.map((item) => ({
        type: "article" as const,
        id: String(item.id),
        title: truncate(item.title ?? item.fileName ?? `Item #${item.id}`, 80),
        description: `${item.tags.map((t) => `#${t}`).join(" ") || item.type}`,
        input_message_content: {
          message_text: itemList([item]),
          parse_mode: "HTML" as const,
        },
      })),
      { cache_time: 5 },
    );
  });

  // ── Helper ─────────────────────────────────────────────────────────────

  async function sendSearchPage(ctx: Context, filters: ItemFilters, page: number): Promise<void> {
    const paged: PagedItemFilters = { ...filters, limit: SEARCH_PAGE_SIZE, offset: page * SEARCH_PAGE_SIZE };
    const { items, total } = runtime.items.list(paged);

    let sessionId = findSessionByFilters(filters);
    if (!sessionId) {
      sessionId = randomBytes(4).toString("hex");
      searchSessions.set(sessionId, { filters, total });
    }

    const pages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
    const header = `🔎 <b>Ricerca</b>${total > 0 ? ` — ${total} risultati (pagina ${page + 1}/${pages})` : ""}`;

    const keyboard: InlineKeyboardButton[][] = items.map((item) => [
      { text: truncate(item.title ?? `#${item.id}`, 32), url: itemLink(item) },
      { text: "🗑", callback_data: `del:${item.id}` },
    ]);
    const nav: { text: string; callback_data: string }[] = [];
    if (page > 0) nav.push({ text: "◀︎", callback_data: `sq:${sessionId}:${page - 1}` });
    if (page < pages - 1) nav.push({ text: "▶︎", callback_data: `sq:${sessionId}:${page + 1}` });
    if (nav.length > 0) keyboard.push(nav);

    await ctx.reply(itemList(items, header, "Nessun risultato per questa ricerca."), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  function findSessionByFilters(filters: ItemFilters): string | undefined {
    for (const [id, state] of searchSessions) {
      if (JSON.stringify(state.filters) === JSON.stringify(filters)) return id;
    }
    return undefined;
  }

  function itemLink(item: Item): string {
    return item.url ?? item.canonicalUrl ?? `${webAppUrl}/item/${item.id}`;
  }

  async function handleTextDump(ctx: Context): Promise<void> {
    const message = ctx.message;
    if (!message?.text) return;

    const urls = [
      ...(message.entities ? extractFromEntities(message.text, message.entities) : []),
      ...extractUrls(message.text),
    ];
    const unique = [...new Set(urls)].slice(0, MAX_LINKS_PER_MESSAGE);
    if (unique.length === 0) return; // testo senza link: non è un dump

    for (const url of unique) {
      await ingestAndReply(ctx, { kind: "url", url });
    }
  }

  async function handleDocument(ctx: Context): Promise<void> {
    const document = ctx.message?.document;
    if (!document) return;

    if ((document.file_size ?? 0) > MAX_TELEGRAM_DOWNLOAD) {
      await ctx.reply("📦 File oltre i 20MB: Telegram non permette il download ai bot. Caricalo dalla web UI.");
      return;
    }

    const tempPath = path.join(tmpdir(), `stash-${Date.now()}-${document.file_name ?? "file"}`);
    try {
      const file = await ctx.api.getFile(document.file_id);
      if (!file.file_path) throw new Error("file_path mancante");
      const response = await fetch(`https://api.telegram.org/file/bot${options.botToken}/${file.file_path}`);
      if (!response.ok) throw new Error(`download HTTP ${response.status}`);
      await writeFile(tempPath, new Uint8Array(await response.arrayBuffer()));

      await ingestAndReply(ctx, {
        kind: "file",
        path: tempPath,
        name: document.file_name ?? "file",
        mimeType: document.mime_type,
      });
    } catch (error) {
      await ctx.reply(`⚠️ Download fallito: ${escapeHtml(String(error))}`);
    } finally {
      await rm(tempPath, { force: true });
    }
  }

  /** Pipeline condivisa + risposta immediata + arricchimento in background. */
  async function ingestAndReply(
    ctx: Context,
    payload: { kind: "url"; url: string } | { kind: "file"; path: string; name: string; mimeType?: string },
  ): Promise<void> {
    const sourceRef = ctx.from ? { chatId: String(ctx.chat?.id ?? ctx.from.id), messageId: ctx.message?.message_id } : undefined;
    try {
      const result = await runtime.ingestion.ingest({
        payload,
        source: "telegram",
        sourceRef,
      });
      if (result.status === "created") {
        const item = result.item;
        await ctx.reply(createdMessage(item), { parse_mode: "HTML" });
        // Fire-and-forget: il titolo vero arriva poco dopo, senza bloccare la chat.
        void runtime.ingestion.enrichMetadata(item).catch((error) => {
          console.error("[stash] arricchimento fallito:", error);
        });
      } else {
        await ctx.reply(duplicateMessage(result.existing, webAppUrl), { parse_mode: "HTML" });
      }
    } catch (error) {
      await ctx.reply(`⚠️ Archiviazione fallita: ${escapeHtml(String(error))}`);
    }
  }

  return bot;
}

// ── Parser delle query di ricerca ────────────────────────────────────────

/** /cerca "testo libero" #tag tipo:video → filtri strutturati. */
export function parseSearchQuery(commandText: string): ItemFilters {
  const raw = commandText.replace(/^\/cerca(@\w+)?\s*/i, "");
  const qTokens: string[] = [];
  let tag: string | undefined;
  let type: string | undefined;

  for (const token of raw.split(/\s+/).filter(Boolean)) {
    if (token.startsWith("#") && token.length > 1) {
      tag = token.slice(1).toLowerCase();
    } else if (/^tipo:\w+$/i.test(token) || /^type:\w+$/i.test(token)) {
      type = token.split(":")[1].toLowerCase();
    } else {
      qTokens.push(token);
    }
  }

  return {
    q: qTokens.length > 0 ? qTokens.join(" ") : undefined,
    tag,
    type: type && isItemType(type) ? type : undefined,
  };
}

function parseLuckyTag(commandText: string): string | undefined {
  const match = commandText.match(/#(\w+)/);
  return match ? match[1].toLowerCase() : undefined;
}
