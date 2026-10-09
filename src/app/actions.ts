"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertAuthenticated, setSessionCookie, clearSessionCookie, authEnabled } from "@/lib/auth";
import { telegramUploadChatId } from "@/config/env";
import { getRuntime } from "@/core/get-runtime";
import { startWebVideoJob } from "@/core/web-video-jobs";
import { logger } from "@/core/logger";
import { normalizeUrl, youtubeThumbnailUrl } from "@/core/url";
import { rankBySimilarity, similarityFieldsOfItem } from "@/core/similarity";
import type { Item, ItemType } from "@/core/domain/item";

/*
 * Flow: le server action sono l'unica porta di scrittura della web UI.
 * Tutte (tranne login) verificano la sessione PRIMA di toccare dati, poi
 * delegano al dominio condiviso (stessa IngestionService del bot) e
 * invalidano le pagine RSC interessate. I risultati sono oggetti
 * serializzabili per useActionState.
 */

export interface ActionResult {
  ok: boolean;
  message: string;
}

function refreshItemPaths(itemId?: number): void {
  revalidatePath("/");
  revalidatePath("/tags");
  revalidatePath("/lucky");
  if (itemId !== undefined) revalidatePath(`/item/${itemId}`);
}

// ── Autenticazione ───────────────────────────────────────────────────────

export async function loginAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const password = String(formData.get("password") ?? "");
  if (!authEnabled()) redirect("/");
  if (password === process.env.WEB_PASSWORD?.trim()) {
    await setSessionCookie();
    redirect("/");
  }
  return { ok: false, message: "Password errata." };
}

export async function logoutAction(): Promise<void> {
  await clearSessionCookie();
  redirect("/login");
}

// ── Ingestione (web) ─────────────────────────────────────────────────────

export async function addLinkAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  if (!(await assertAuthenticated())) return { ok: false, message: "Sessione scaduta." };

  const url = String(formData.get("url") ?? "").trim();
  const canonical = normalizeUrl(url);
  if (!canonical) return { ok: false, message: "URL non valido." };

  const { ingestion } = getRuntime();
  try {
    const result = await ingestion.ingest({ payload: { kind: "url", url }, source: "web" });
    if (result.status === "duplicate") {
      refreshItemPaths(result.existing.id);
      return { ok: true, message: `Già in archivio: «${result.existing.title ?? result.existing.id}»` };
    }
    // Qui l'utente aspetta: i metadati arrivano subito (timeout interno 10s).
    const enriched = await ingestion.enrichMetadata(result.item);
    refreshItemPaths(enriched.id);
    return { ok: true, message: `Archiviato: «${enriched.title ?? canonical}»` };
  } catch (error) {
    logger.error("addLinkAction fallita:", error);
    return { ok: false, message: "Archiviazione fallita." };
  }
}

export async function addFileAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  if (!(await assertAuthenticated())) return { ok: false, message: "Sessione scaduta." };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Nessun file selezionato." };

  const tempPath = path.join(tmpdir(), `stash-web-${Date.now()}-${file.name.replace(/[/\\]/g, "_")}`);
  try {
    await writeFile(tempPath, Buffer.from(await file.arrayBuffer()));
    const { ingestion } = getRuntime();
    const result = await ingestion.ingest({
      payload: { kind: "file", path: tempPath, name: file.name, mimeType: file.type || undefined },
      source: "web",
    });
    if (result.status === "duplicate") {
      refreshItemPaths(result.existing.id);
      return { ok: true, message: `Già in archivio: «${result.existing.fileName ?? result.existing.id}»` };
    }
    refreshItemPaths(result.item.id);
    return { ok: true, message: `Archiviato: «${result.item.fileName}»` };
  } catch (error) {
    logger.error("addFileAction fallita:", error);
    return { ok: false, message: "Archiviazione fallita." };
  } finally {
    await rm(tempPath, { force: true });
  }
}

// ── Modifica item ────────────────────────────────────────────────────────

export async function toggleSeenAction(itemId: number): Promise<void> {
  if (!(await assertAuthenticated())) return;
  const { items } = getRuntime();
  const item = items.getById(itemId);
  if (!item) return;
  items.update(itemId, { seen: !item.seen });
  refreshItemPaths(itemId);
}

export async function toggleStarredAction(itemId: number): Promise<void> {
  if (!(await assertAuthenticated())) return;
  const { items } = getRuntime();
  const item = items.getById(itemId);
  if (!item) return;
  items.update(itemId, { starred: !item.starred });
  refreshItemPaths(itemId);
}

export async function saveNotesAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  if (!(await assertAuthenticated())) return { ok: false, message: "Sessione scaduta." };

  const itemId = Number(formData.get("itemId"));
  const notes = String(formData.get("notes") ?? "");
  if (!Number.isInteger(itemId)) return { ok: false, message: "Item non valido." };

  getRuntime().items.update(itemId, { notes });
  refreshItemPaths(itemId);
  return { ok: true, message: "Note salvate." };
}

export async function setTagsAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  if (!(await assertAuthenticated())) return { ok: false, message: "Sessione scaduta." };

  const itemId = Number(formData.get("itemId"));
  const tags = String(formData.get("tags") ?? "")
    .split(/[,\n]/)
    .map((tag) => tag.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-"))
    .filter(Boolean);
  if (!Number.isInteger(itemId)) return { ok: false, message: "Item non valido." };

  getRuntime().items.replaceTags(itemId, [...new Set(tags)]);
  refreshItemPaths(itemId);
  return { ok: true, message: `Tag aggiornati (${tags.length}).` };
}

export async function reclassifyAction(itemId: number): Promise<void> {
  if (!(await assertAuthenticated())) return;
  const { items, ingestion } = getRuntime();
  const item = items.getById(itemId);
  if (!item?.url) return;
  const enriched = await ingestion.enrichMetadata(item);
  refreshItemPaths(enriched.id);
}

export async function deleteItemAction(itemId: number): Promise<void> {
  if (!(await assertAuthenticated())) return;
  const { items, files } = getRuntime();
  const item = items.getById(itemId);
  if (!item) return;

  items.delete(itemId);
  if (item.filePath) {
    await files.deleteStoredFile(item.filePath).catch(() => undefined);
  }
  refreshItemPaths();
  redirect("/");
}

// ── Download video YouTube ───────────────────────────────────────────────

/** Riga risultato del wizard di download (ultimo 20 / parola chiave). */
export interface VideoSearchHit {
  id: number;
  title: string;
  channel: string | null;
  /** Punteggio di somiglianza 0..1: presente solo nella ricerca per keyword. */
  score?: number;
  /** true se il file video è già nello store (basterà l'invio su Telegram). */
  downloaded: boolean;
  /** Anteprima 16:9: copia locale se c'è, altrimenti la thumbnail YouTube. */
  thumbUrl: string | null;
}

/** Base del wizard: i video YouTube dell'archivio, dai più recenti. */
export async function latestArchiveVideosAction(): Promise<VideoSearchHit[]> {
  if (!(await assertAuthenticated())) return [];
  const { items } = getRuntime();
  return items
    .list({ youtube: true, limit: 20, offset: 0 })
    .items.map(videoSearchHit);
}

/**
 * Ricerca "simile" tra i video YouTube archiviati: ranking fuzzy su titolo,
 * canale e tag (vedi core/similarity.ts), limitata ai primi 30 risultati.
 */
export async function searchArchiveVideosAction(query: string): Promise<VideoSearchHit[]> {
  if (!(await assertAuthenticated())) return [];
  const q = query.trim();
  if (q.length < 2) return [];

  const { items } = getRuntime();
  // Base ampia: l'archivio è personale, qualche migliaio di righe è ok.
  const videos = items.list({ youtube: true, limit: 2000, offset: 0 }).items;
  return rankBySimilarity(videos, q, similarityFieldsOfItem, 30).map(({ item, score }) => ({
    ...videoSearchHit(item),
    score: Math.round(score * 100) / 100,
  }));
}

export async function startVideoDownloadByItemAction(itemId: number): Promise<ActionResult & { jobId?: string }> {
  if (!(await assertAuthenticated())) return { ok: false, message: "Sessione scaduta." };

  const chatId = telegramUploadChatId();
  if (!chatId) {
    return {
      ok: false,
      message: "Configura TELEGRAM_UPLOAD_CHAT_ID (o TELEGRAM_ALLOWED_USER_IDS) per ricevere i video.",
    };
  }

  const result = await startWebVideoJob({ itemId, chatId, source: "web" });
  if (!result.ok) return { ok: false, message: result.error };
  return { ok: true, message: "Download avviato.", jobId: result.job.id };
}

export async function startVideoDownloadByUrlAction(url: string): Promise<ActionResult & { jobId?: string }> {
  if (!(await assertAuthenticated())) return { ok: false, message: "Sessione scaduta." };

  const trimmed = url.trim();
  const canonical = normalizeUrl(trimmed);
  if (!canonical || !/^https:\/\/youtu\.be\//.test(canonical)) {
    return { ok: false, message: "Serve un link YouTube valido (per ora si scarica solo da YouTube)." };
  }

  const chatId = telegramUploadChatId();
  if (!chatId) {
    return {
      ok: false,
      message: "Configura TELEGRAM_UPLOAD_CHAT_ID (o TELEGRAM_ALLOWED_USER_IDS) per ricevere i video.",
    };
  }

  const result = await startWebVideoJob({ url: trimmed, chatId, source: "web" });
  if (!result.ok) return { ok: false, message: result.error };
  refreshItemPaths(result.job.itemId ?? undefined);
  return { ok: true, message: "Download avviato.", jobId: result.job.id };
}

function videoSearchHit(item: Item): VideoSearchHit {
  return {
    id: item.id,
    title: item.title ?? item.fileName ?? `Item #${item.id}`,
    channel: item.authorName ?? null,
    downloaded: Boolean(item.filePath),
    thumbUrl: item.thumbnailPath
      ? `/api/thumbs/${item.id}`
      : (youtubeThumbnailUrl(item.canonicalUrl ?? item.url ?? "") ?? null),
  };
}

export type { ItemType };
