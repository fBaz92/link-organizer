"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertAuthenticated, setSessionCookie, clearSessionCookie, authEnabled, verifySessionValue } from "@/lib/auth";
import { getRuntime } from "@/core/runtime";
import { logger } from "@/core/logger";
import { normalizeUrl } from "@/core/url";
import type { ItemType } from "@/core/domain/item";

/*
 * Flow: le server actions sono l'unica porta di scrittura della web UI.
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

export type { ItemType };
