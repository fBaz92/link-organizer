import type { Item } from "@/core/domain/item";
import { ITEM_TYPE_LABELS } from "@/core/domain/item";

/*
 * Flow: formattazione dei messaggi Telegram (HTML). Tutto ciò che tocca
 * testo utente/esterno passa da escapeHtml, così titoli e note non rompono
 * il parse mode. Le funzioni sono pure → facili da testare.
 */

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function itemLine(item: Item, index?: number): string {
  const prefix = index !== undefined ? `${index}. ` : "";
  const title = item.title ?? item.canonicalUrl ?? item.fileName ?? `Item #${item.id}`;
  const label = ITEM_TYPE_LABELS[item.type];
  const channel = item.authorName ? ` · ${escapeHtml(item.authorName)}` : "";
  const tags = item.tags.length > 0 ? `  ·  ${item.tags.map((t) => `#${t}`).join(" ")}` : "";
  const link = item.url ?? item.canonicalUrl;
  const titleHtml = link
    ? `<a href="${escapeHtml(link)}">${escapeHtml(truncate(title, 80))}</a>`
    : `<b>${escapeHtml(truncate(title, 80))}</b>`;
  const flags = item.starred ? " ⭐" : "";
  return `${prefix}${titleHtml}\n     <i>${label}${flags}</i>${channel}${tags}`;
}

export function itemList(items: Item[], header?: string, emptyMessage = "Nessun risultato."): string {
  if (items.length === 0) return emptyMessage;
  const body = items.map((item, i) => itemLine(item, i + 1)).join("\n\n");
  return header ? `${header}\n\n${body}` : body;
}

export function createdMessage(item: Item): string {
  const label = ITEM_TYPE_LABELS[item.type];
  const tags = item.tags.length > 0 ? `\n🏷 tag: ${item.tags.map((t) => `#${t}`).join(" ")}` : "";
  const title = item.title ?? item.fileName ?? "";
  return `✅ <b>Archiviato</b> · ${label}\n${escapeHtml(truncate(title, 120))}${tags}\n<i>Recupero dettagli in corso…</i>`;
}

export function duplicateMessage(item: Item, webAppUrl: string): string {
  const when = item.createdAt.toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" });
  return `♻️ <b>Già in archivio</b> (dal ${when})\n→ <a href="${escapeHtml(`${webAppUrl}/item/${item.id}`)}">apri nella web UI</a>`;
}

export function helpMessage(webAppUrl: string): string {
  return [
    "📥 <b>Stash</b> — il tuo archivio personale",
    "",
    "Manda qui un <b>link</b> o un <b>file</b>: viene archiviato, classificato con i tag e deduplicato.",
    "",
    "<b>Comandi</b>",
    "/cerca &lt;testo&gt; — cerca nell'archivio (filtri: #tag, tipo:video)",
    "/scarica [link] — scarica un video YouTube e te lo manda qui (senza link apre il wizard: ultimi 20 o parola chiave)",
    "/recenti — ultime aggiunte",
    "/lucky [#tag] — 10 estrazioni a caso tra i non visti",
    "/tag — i tuoi tag più usati",
    "/stat — statistiche dell'archivio",
    "/aiuto — questo messaggio",
    "",
    `🌐 Web UI: ${escapeHtml(webAppUrl)}`,
  ].join("\n");
}

export function statMessage(stats: { total: number; unseen: number; byType: Record<string, number> }): string {
  const byType = Object.entries(stats.byType)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${ITEM_TYPE_LABELS[type as keyof typeof ITEM_TYPE_LABELS] ?? type}: ${count}`)
    .join(" · ");
  return [
    "📊 <b>Statistiche archivio</b>",
    `Totale: <b>${stats.total}</b> item (${stats.unseen} da vedere)`,
    byType !== "" ? byType : "Archivio vuoto.",
  ].join("\n");
}
