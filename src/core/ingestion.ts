import type { Item } from "@/core/domain/item";
import type { ItemSource, SourceRef } from "@/core/domain/item";
import { classifyFile, classifyUrl, keywordTags } from "@/core/classify";
import type { FileStore, StoredFile } from "@/core/files";
import { logger } from "@/core/logger";
import type { MetadataFetcher } from "@/core/metadata";
import { normalizeUrl, urlHash } from "@/core/url";
import type { ItemsRepository } from "@/db/repositories/items";

/*
 * Flow: LA pipeline di ingestione, usata identica da bot, web e import.
 *
 * ingest():
 *   1. l'input viene portato a una forma canonica (URL normalizzato + hash,
 *      oppure file assorbito nello store + hash dei byte);
 *   2. dedup: se l'esiste già un item con lo stesso url_hash o file_hash non
 *      si crea nulla — si ritorna l'originale (il bot risponde "già in
 *      archivio"), e se l'originale è ancora "spoglio" viene arricchito;
 *   3. classificazione locale (regole regex) → tipo + tag;
 *   4. insert con titolo di fallback (per non mostrare URL nudi in UI).
 *
 * enrichMetadata(): seconda fase, separata e richiamabile da sola. Per il
 * bot è fire-and-forget (risposta immediata, metadati che arrivano dopo);
 * la web la attende (timeout interno del fetcher). Aggiorna titolo,
 * descrizione e thumbnail SOLO se mancano: mai soprahe le modifiche umane.
 *   5. auto-tag: col testo appena arrivato (titolo + descrizione) le regole
 *      keyword aggiungono i tag tematici mancanti — solo aggiunte, i tag
 *      umani e quelli esistenti non si toccano.
 */

export type IngestPayload =
  | { kind: "url"; url: string }
  | { kind: "file"; path: string; name: string; mimeType?: string };

export interface IngestInput {
  payload: IngestPayload;
  source: ItemSource;
  sourceRef?: SourceRef;
  createdAt?: Date;
}

export type IngestResult =
  | { status: "created"; item: Item }
  | { status: "duplicate"; existing: Item };

export class IngestionError extends Error {
  constructor(
    message: string,
    readonly reason: "invalid-url" | "unreadable-file",
  ) {
    super(message);
    this.name = "IngestionError";
  }
}

export class IngestionService {
  constructor(
    private readonly items: ItemsRepository,
    private readonly files: FileStore,
    private readonly metadata: MetadataFetcher,
  ) {}

  async ingest(input: IngestInput): Promise<IngestResult> {
    if (input.payload.kind === "url") {
      return this.ingestUrl(input, input.payload);
    }
    return this.ingestFile(input, input.payload);
  }

  /** Arricchisce un item con metadati di rete. Idempotente e sicuro da richiamare. */
  async enrichMetadata(item: Item): Promise<Item> {
    if (!item.url || item.type === "documento") return item;

    const metadata = await this.metadata.fetch(item.canonicalUrl ?? item.url);
    if (!metadata) return item;

    // Il titolo di fallback (hostname) non è contenuto umano: si sostituisce.
    const titleUpgradable = !item.title || item.title === fallbackTitle(item.canonicalUrl ?? item.url);
    const needsUpdate =
      (metadata.title && titleUpgradable) ||
      (metadata.description && !item.description) ||
      (metadata.thumbnailUrl && !item.thumbnailPath) ||
      (metadata.authorName && !item.authorName);
    if (!needsUpdate) return item;

    const thumbnailPath =
      !item.thumbnailPath && metadata.thumbnailUrl
        ? await this.metadata.downloadThumbnail(metadata.thumbnailUrl)
        : undefined;

    this.items.update(item.id, {
      title: titleUpgradable ? metadata.title : undefined,
      description: !item.description ? metadata.description : undefined,
      thumbnailPath,
      authorName: !item.authorName ? metadata.authorName : undefined,
      authorUrl: !item.authorUrl ? metadata.authorUrl : undefined,
    });

    const updated = this.items.getById(item.id) ?? item;
    this.applyAutoTags(updated, metadata.keywords);
    return this.items.getById(item.id) ?? updated;
  }

  /**
   * Unisce i tag dedotti dal testo noto (titolo + descrizione) e quelli
   * dichiarati dall'autore (keywords di yt-dlp) a quelli esistenti: solo
   * aggiunte, mai rimosse — ciò che è stato messo a mano resta. Chiamata
   * dopo l'arricchimento, quando il testo è nuovo.
   */
  private applyAutoTags(item: Item, authorKeywords: string[] = []): void {
    const text = [item.title, item.description].filter(Boolean).join(" ").trim();
    const candidates = [
      ...keywordTags(text),
      ...authorKeywords.map((tag) => tag.trim().toLowerCase()).filter(Boolean),
    ];
    const missing = [...new Set(candidates)].filter((tag) => !item.tags.includes(tag));
    if (missing.length === 0) return;
    logger.info(`Auto-tag item #${item.id}: +${missing.join(", +")}`);
    this.items.replaceTags(item.id, [...item.tags, ...missing]);
  }

  // ── Pipeline interne ───────────────────────────────────────────────────

  private async ingestUrl(input: IngestInput, payload: Extract<IngestPayload, { kind: "url" }>): Promise<IngestResult> {
    const canonical = normalizeUrl(payload.url);
    if (!canonical) {
      throw new IngestionError(`URL non valido: "${payload.url}"`, "invalid-url");
    }

    const hash = urlHash(canonical);
    const existing = this.items.findByUrlHash(hash);
    if (existing) {
      logger.info(`Duplicato URL → item #${existing.id}`);
      return { status: "duplicate", existing };
    }

    const classification = classifyUrl(canonical);
    const item = this.items.insert({
      type: classification.type,
      url: payload.url.trim(),
      canonicalUrl: canonical,
      urlHash: hash,
      title: fallbackTitle(canonical),
      source: input.source,
      sourceRef: input.sourceRef,
      tags: classification.tags,
      createdAt: input.createdAt,
    });
    logger.info(`Creato item #${item.id} (${item.type}) da ${item.source}`);
    return { status: "created", item };
  }

  private async ingestFile(
    input: IngestInput,
    payload: Extract<IngestPayload, { kind: "file" }>,
  ): Promise<IngestResult> {
    const { path, name, mimeType } = payload;
    let stored: StoredFile;
    try {
      stored = await this.files.absorbFile(path, name);
    } catch (error) {
      throw new IngestionError(
        `Impossibile leggere il file "${name}": ${String(error)}`,
        "unreadable-file",
      );
    }

    const existing = this.items.findByFileHash(stored.hash);
    if (existing) {
      logger.info(`Duplicato file → item #${existing.id}`);
      return { status: "duplicate", existing };
    }

    const classification = classifyFile(name, mimeType);
    const item = this.items.insert({
      type: classification.type,
      title: stored.fileName,
      filePath: stored.relativePath,
      fileName: stored.fileName,
      mimeType,
      fileHash: stored.hash,
      source: input.source,
      sourceRef: input.sourceRef,
      tags: classification.tags,
      createdAt: input.createdAt,
    });
    logger.info(`Creato item #${item.id} (documento) da ${item.source}`);
    return { status: "created", item };
  }
}

/** Titolo di fallback leggibile finché i metadati non arrivano. */
function fallbackTitle(canonicalUrl: string): string {
  try {
    return new URL(canonicalUrl).hostname.replace(/^www\./, "");
  } catch {
    return canonicalUrl;
  }
}

/**
 * True se il titolo dell'item è quello di fallback (hostname o assente):
 * non è contenuto umano, e chi arricchisce/classifica non deve trattarlo
 * come testo significativo (es. niente tag semantici sopra un hostname).
 */
export function isFallbackTitle(item: Pick<Item, "title" | "canonicalUrl" | "url">): boolean {
  if (!item.title) return true;
  return item.title === fallbackTitle(item.canonicalUrl ?? item.url ?? "");
}
