import type { ItemType } from "@/core/domain/item";
import { TAG_RULES, type TagRule } from "@/core/rules/tag-rules";
import { youtubeVideoId } from "@/core/url";

/*
 * Flow: il classificatore. Tutto regex/config, zero ML, zero rete.
 *
 * 1. classifyUrl() valuta le regole di dominio/path sull'URL canonico:
 *    la PRIMA regola che combacia e ha un `type` decide il tipo; ogni regola
 *    che combacia aggiunge il suo tag. Gli ID YouTube sono riconosciuti
 *    direttamente dal modulo url (canonical form già dedicata).
 * 2. Il testo noto (titolo + descrizione, quando arrivano dai metadati) può
 *    solo ARRICCHIRE con tag keyword — mai cambiare tipo: la classificazione
 *    resta deterministica. keywordTags() è la parte riusabile dall'esterno:
 *    la usa anche l'auto-tag di ingestione e il backfill.
 * 3. classifyFile() gestisce i file Telegram/import: sono documenti, con
 *    tag extra per i formati più comuni (pdf, epub, immagini…).
 * 4. Fallback onesto: tipo "link", nessun tag inventato.
 */

export interface Classification {
  type: ItemType;
  tags: string[];
}

const FILE_EXTENSION_TAGS: [RegExp, string][] = [
  [/\.pdf$/i, "pdf"],
  [/\.epub$/i, "ebook"],
  [/\.(png|jpe?g|gif|webp|avif|heic)$/i, "immagine"],
  [/\.(zip|rar|7z|tar|gz)$/i, "archivio"],
  [/\.(csv|xlsx?|numbers)$/i, "dati"],
];

export function classifyUrl(canonicalUrl: string, textContent?: string): Classification {
  let url: URL;
  try {
    url = new URL(canonicalUrl);
  } catch {
    return { type: "link", tags: [] };
  }

  const host = url.hostname.replace(/^www\./, "");
  const pathWithQuery = `${url.pathname}${url.search}`;

  let type: ItemType | undefined;
  const tagSet = new Set<string>();

  // ID YouTube: la canonical form è già youtu.be, ma copriamo anche forme strane.
  if (youtubeVideoId(url)) {
    type ??= "video";
    tagSet.add("video");
  }

  for (const rule of TAG_RULES) {
    if (!ruleMatches(rule, host, pathWithQuery)) continue;
    type ??= rule.type;
    tagSet.add(rule.tag);
  }

  // Titolo/descrizione arricchiscono: keyword → tag extra (mai il tipo).
  if (textContent) {
    for (const tag of keywordTags(textContent)) tagSet.add(tag);
  }

  return { type: type ?? "link", tags: [...tagSet] };
}

/**
 * Tag deducibili dal solo testo (titolo + descrizione): le regole keyword
 * sono pure arricchimento, qui non c'è alcun tipo in gioco. Case-insensitive
 * e idempotente — stesso testo, stessi tag.
 */
export function keywordTags(text: string): string[] {
  const tagSet = new Set<string>();
  for (const rule of TAG_RULES) {
    if (!rule.textKeywords) continue;
    if (rule.textKeywords.some((pattern) => pattern.test(text))) tagSet.add(rule.tag);
  }
  return [...tagSet];
}

export function classifyFile(fileName?: string, mimeType?: string): Classification {
  const tags = new Set<string>(["documento"]);
  if (mimeType === "application/pdf" || (fileName && /\.pdf$/i.test(fileName))) tags.add("pdf");
  for (const [pattern, tag] of FILE_EXTENSION_TAGS) {
    if (fileName && pattern.test(fileName)) tags.add(tag);
  }
  return { type: "documento", tags: [...tags] };
}

function ruleMatches(rule: TagRule, host: string, pathWithQuery: string): boolean {
  const domainMatch = rule.domains?.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
  if (!domainMatch) return false;
  if (!rule.pathPatterns || rule.pathPatterns.length === 0) return true;
  return rule.pathPatterns.some((pattern) => pattern.test(pathWithQuery));
}
