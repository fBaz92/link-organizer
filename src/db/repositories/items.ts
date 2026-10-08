import { and, count, desc, eq, inArray, isNotNull, isNull, like, sql } from "drizzle-orm";
import type { Item, ItemSource, ItemType, SourceRef } from "@/core/domain/item";
import { isItemType } from "@/core/domain/item";
import type { DatabaseHandle, Db, RawSqlite } from "../connection";
import { items, itemsTags, tags, type ItemRow } from "../schema";

/*
 * Flow: repository degli item — l'unico modulo che parla SQL.
 *
 * Lettura:  buildConditions() traduce i filtri (tipo, tag, visto, preferito,
 *           ricerca full-text) in condizioni Drizzle riusate da list() e
 *           random(); i tag vengono poi caricati in batch per la pagina
 *           corrente (una sola query, niente N+1).
 * Scrittura: insert/update/delete + replaceTags() in transazione, con
 *            getOrCreateTagId() idempotente (ON CONFLICT DO NOTHING).
 * Dedup:    findByUrlHash / findByFileHash sono i lookup usati dal dominio.
 *
 * La ricerca usa FTS5: la query utente viene trasformata in frasi quotate
 * ("parola1" "parola2") per essere sicura e implicitamente in AND.
 */

export interface ItemFilters {
  q?: string;
  type?: ItemType;
  tag?: string;
  /** true = solo visti, false = solo da vedere, undefined = tutti. */
  seen?: boolean;
  starred?: boolean;
  /** Canale/autore (per author_url, identità canonica). */
  author?: string;
  /** true = solo i video YouTube (canonical_url "https://youtu.be/<id>"). */
  youtube?: boolean;
}

export interface PagedItemFilters extends ItemFilters {
  limit: number;
  offset: number;
}

export interface PagedItems {
  items: Item[];
  total: number;
}

/**
 * Conteggi "a faccette": ogni dimensione è calcolata applicando TUTTI gli
 * altri filtri tranne il proprio, così le select mostrano le opzioni che
 * producono davvero risultati (comportamento tipo raffinamento e-commerce).
 */
export interface ItemFacets {
  types: { type: ItemType; count: number }[];
  states: { unseen: number; seen: number; starred: number };
  tags: { name: string; count: number }[];
  authors: { name: string; url: string; count: number }[];
}

type FacetDimension = "type" | "tag" | "author" | "stato";

/** Input di creazione: i campi gestiti dal DB (id, timestamp) sono esclusi. */
export interface NewItem {
  type: ItemType;
  url?: string;
  canonicalUrl?: string;
  urlHash?: string;
  title?: string;
  description?: string;
  notes?: string;
  thumbnailPath?: string;
  filePath?: string;
  fileName?: string;
  mimeType?: string;
  fileHash?: string;
  authorName?: string;
  authorUrl?: string;
  source: ItemSource;
  sourceRef?: SourceRef;
  tags?: string[];
  createdAt?: Date;
}

export interface ItemPatch {
  type?: ItemType;
  title?: string;
  description?: string;
  notes?: string;
  thumbnailPath?: string;
  filePath?: string;
  fileName?: string;
  mimeType?: string;
  fileHash?: string;
  authorName?: string;
  authorUrl?: string;
  seen?: boolean;
  starred?: boolean;
}

export class ItemsRepository {
  constructor(private readonly handle: DatabaseHandle) {}

  // ── Lettura ────────────────────────────────────────────────────────────

  list(filters: PagedItemFilters): PagedItems {
    const conditions = this.buildConditions(filters);
    const rows = this.db
      .select()
      .from(items)
      .where(and(...conditions))
      .orderBy(desc(items.createdAt), desc(items.id))
      .limit(filters.limit)
      .offset(filters.offset)
      .all();

    const total = this.countWhere(conditions);
    const result = rows.map((row) => this.toDomain(row, []));
    this.attachTags(result);
    return { items: result, total };
  }

  random(filters: ItemFilters, limit: number): Item[] {
    const conditions = this.buildConditions(filters);
    const rows = this.db
      .select()
      .from(items)
      .where(and(...conditions))
      .orderBy(sql`RANDOM()`)
      .limit(limit)
      .all();
    const result = rows.map((row) => this.toDomain(row, []));
    this.attachTags(result);
    return result;
  }

  getById(id: number): Item | undefined {
    const row = this.db.select().from(items).where(eq(items.id, id)).get();
    if (!row) return undefined;
    const item = this.toDomain(row, []);
    this.attachTags([item]);
    return item;
  }

  findByUrlHash(urlHash: string): Item | undefined {
    const row = this.db.select().from(items).where(eq(items.urlHash, urlHash)).get();
    return row ? this.toDomain(row, []) : undefined;
  }

  findByFileHash(fileHash: string): Item | undefined {
    const row = this.db.select().from(items).where(eq(items.fileHash, fileHash)).get();
    return row ? this.toDomain(row, []) : undefined;
  }

  // ── Scrittura ──────────────────────────────────────────────────────────

  insert(newItem: NewItem): Item {
    const now = new Date();
    const created = newItem.createdAt ?? now;

    const row = this.raw.transaction((): ItemRow => {
      const inserted = this.db.insert(items).values(this.toRow(newItem, created, now)).returning().get();
      for (const tagName of newItem.tags ?? []) {
        const tagId = this.getOrCreateTagId(tagName);
        this.db.insert(itemsTags).values({ itemId: inserted.id, tagId }).onConflictDoNothing().run();
      }
      return inserted;
    })();

    return this.toDomain(row, newItem.tags ?? []);
  }

  update(id: number, patch: ItemPatch): void {
    const set: Partial<ItemRow> = { updatedAt: new Date().toISOString() };
    if (patch.type !== undefined) set.type = patch.type;
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.notes !== undefined) set.notes = patch.notes;
    if (patch.thumbnailPath !== undefined) set.thumbnailPath = patch.thumbnailPath;
    if (patch.filePath !== undefined) set.filePath = patch.filePath;
    if (patch.fileName !== undefined) set.fileName = patch.fileName;
    if (patch.mimeType !== undefined) set.mimeType = patch.mimeType;
    if (patch.fileHash !== undefined) set.fileHash = patch.fileHash;
    if (patch.authorName !== undefined) set.authorName = patch.authorName;
    if (patch.authorUrl !== undefined) set.authorUrl = patch.authorUrl;
    if (patch.seen !== undefined) set.seen = patch.seen ? 1 : 0;
    if (patch.starred !== undefined) set.starred = patch.starred ? 1 : 0;
    this.db.update(items).set(set).where(eq(items.id, id)).run();
  }

  replaceTags(id: number, tagNames: string[]): void {
    this.raw.transaction(() => {
      this.db.delete(itemsTags).where(eq(itemsTags.itemId, id)).run();
      for (const name of tagNames) {
        const tagId = this.getOrCreateTagId(name);
        this.db.insert(itemsTags).values({ itemId: id, tagId }).onConflictDoNothing().run();
      }
      this.deleteOrphanTags();
    })();
  }

  delete(id: number): void {
    this.db.delete(items).where(eq(items.id, id)).run();
    this.deleteOrphanTags();
  }

  /** Statistiche aggregate per il comando /stat e la UI. */
  stats(): { total: number; unseen: number; byType: Record<string, number> } {
    const byType = this.db
      .select({ type: items.type, total: count() })
      .from(items)
      .groupBy(items.type)
      .all();
    const total = byType.reduce((sum, row) => sum + row.total, 0);
    const unseen = this.countWhere([eq(items.seen, 0)]);
    return {
      total,
      unseen,
      byType: Object.fromEntries(byType.map((row) => [row.type, row.total])),
    };
  }

  /**
   * Item senza thumbnail locale ma con un URL da cui recuperarla: la coda
   * del backfill automatico (i più recenti prima). Senza URL non c'è
   * nulla da scaricare e non compaiono.
   */
  listMissingThumbnails(limit: number): Item[] {
    const rows = this.db
      .select()
      .from(items)
      .where(and(isNull(items.thumbnailPath), isNotNull(items.url)))
      .orderBy(desc(items.id))
      .limit(limit)
      .all();
    const result = rows.map((row) => this.toDomain(row, []));
    this.attachTags(result);
    return result;
  }

  /** Canali noti con conteggio, per il filtro dell'archivio. */
  authorsWithCounts(): { name: string; url: string; count: number }[] {    const rows = this.db
      .select({
        name: items.authorName,
        url: items.authorUrl,
        total: count(),
      })
      .from(items)
      .where(sql`${items.authorUrl} IS NOT NULL`)
      .groupBy(items.authorUrl, items.authorName)
      .orderBy(desc(count()))
      .all();
    return rows
      .filter((row): row is { name: string; url: string; total: number } => Boolean(row.url))
      .map((row) => ({ name: row.name ?? row.url, url: row.url, count: row.total }));
  }

  /**
   * Facette dinamiche per la barra filtri: per ogni dimensione il conteggio
   * delle opzioni tiene conto di tutti gli ALTRI filtri attivi. Così, ad
   * esempio, con tipo=video la select Canale elenca solo canali con video.
   */
  facets(filters: ItemFilters): ItemFacets {
    const typeRows = this.db
      .select({ type: items.type, total: count() })
      .from(items)
      .where(and(...this.buildConditions(filters, "type")))
      .groupBy(items.type)
      .all();

    const stateRows = this.db
      .select({ seen: items.seen, starred: items.starred, total: count() })
      .from(items)
      .where(and(...this.buildConditions(filters, "stato")))
      .groupBy(items.seen, items.starred)
      .all();
    const states = stateRows.reduce(
      (acc, row) => {
        if (row.starred === 1) acc.starred += row.total;
        if (row.seen === 1) acc.seen += row.total;
        else acc.unseen += row.total;
        return acc;
      },
      { unseen: 0, seen: 0, starred: 0 },
    );

    const tagRows = this.db
      .select({ name: tags.name, total: count(itemsTags.itemId) })
      .from(itemsTags)
      .innerJoin(tags, eq(tags.id, itemsTags.tagId))
      .where(inArray(itemsTags.itemId, this.idsMatching(filters, "tag")))
      .groupBy(tags.name)
      .orderBy(desc(count(itemsTags.itemId)), tags.name)
      .all();

    const authorRows = this.db
      .select({ name: items.authorName, url: items.authorUrl, total: count() })
      .from(items)
      .where(and(inArray(items.id, this.idsMatching(filters, "author")), isNotNull(items.authorUrl)))
      .groupBy(items.authorUrl, items.authorName)
      .orderBy(desc(count()), items.authorName)
      .all();

    return {
      types: typeRows.map((row) => ({ type: isItemType(row.type) ? row.type : "link", count: row.total })),
      states,
      tags: tagRows.map((row) => ({ name: row.name, count: row.total })),
      authors: authorRows
        .filter((row): row is { name: string | null; url: string; total: number } => Boolean(row.url))
        .map((row) => ({ name: row.name ?? row.url, url: row.url, count: row.total })),
    };
  }

  // ── Tag (delegato, stesso DB) ──────────────────────────────────────────

  tagsWithCounts(): { name: string; count: number }[] {
    const rows = this.db
      .select({ name: tags.name, total: count(itemsTags.itemId) })
      .from(tags)
      .leftJoin(itemsTags, eq(itemsTags.tagId, tags.id))
      .groupBy(tags.id)
      .orderBy(desc(count(itemsTags.itemId)), tags.name)
      .all();
    return rows.map((r) => ({ name: r.name, count: r.total }));
  }

  // ── Privati ────────────────────────────────────────────────────────────

  private get db(): Db {
    return this.handle.db;
  }

  private get raw(): RawSqlite {
    return this.handle.raw;
  }

  private buildConditions(filters: ItemFilters, skip?: FacetDimension) {
    const conditions = [];
    if (filters.type && skip !== "type") conditions.push(eq(items.type, filters.type));
    if (filters.seen !== undefined && skip !== "stato") conditions.push(eq(items.seen, filters.seen ? 1 : 0));
    if (filters.starred && skip !== "stato") conditions.push(eq(items.starred, 1));
    if (filters.author && skip !== "author") conditions.push(eq(items.authorUrl, filters.author));
    if (filters.youtube) conditions.push(like(items.canonicalUrl, "https://youtu.be/%"));
    if (filters.tag) {
      conditions.push(
        sql`items.id IN (
          SELECT it.item_id FROM items_tags it JOIN tags t ON t.id = it.tag_id
          WHERE t.name = ${filters.tag.toLowerCase()}
        )`,
      );
    }
    if (filters.q) {
      const lowerQ = filters.q.toLowerCase();
      const typeMatch = isItemType(lowerQ) ? lowerQ : null;
      conditions.push(
        sql`items.id IN (
          SELECT rowid FROM items_fts WHERE items_fts MATCH ${ftsPhrase(filters.q)}
          UNION
          SELECT it.item_id FROM items_tags it JOIN tags t ON t.id = it.tag_id
            WHERE instr(t.name, ${lowerQ}) > 0
          UNION
          SELECT id FROM items WHERE type = ${typeMatch}
          UNION
          SELECT id FROM items WHERE author_name LIKE ${`%${filters.q}%`}
        )`,
      );
    }
    return conditions;
  }

  private countWhere(conditions: ReturnType<ItemsRepository["buildConditions"]>): number {
    const [row] = this.db
      .select({ value: count() })
      .from(items)
      .where(and(...conditions))
      .all();
    return row?.value ?? 0;
  }

  /** Sottoquery degli id che rispettano i filtri, ignorando una dimensione. */
  private idsMatching(filters: ItemFilters, skip?: FacetDimension) {
    return this.db
      .select({ id: items.id })
      .from(items)
      .where(and(...this.buildConditions(filters, skip)));
  }

  private getOrCreateTagId(name: string): number {
    const normalized = name.trim().toLowerCase();
    this.db.insert(tags).values({ name: normalized }).onConflictDoNothing().run();
    const row = this.db.select({ id: tags.id }).from(tags).where(eq(tags.name, normalized)).get();
    if (!row) throw new Error(`Impossibile creare il tag "${name}"`);
    return row.id;
  }

  /** I tag senza item non interessano a nessuno: li si rimuove al volo. */
  private deleteOrphanTags(): void {
    this.raw.prepare("DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM items_tags)").run();
  }

  /** Carica i tag per tutti gli item della lista in una sola query. */
  private attachTags(list: Item[]): void {
    if (list.length === 0) return;
    const ids = list.map((i) => i.id);
    const rows = this.db
      .select({ itemId: itemsTags.itemId, name: tags.name })
      .from(itemsTags)
      .innerJoin(tags, eq(tags.id, itemsTags.tagId))
      .where(inArray(itemsTags.itemId, ids))
      .all();
    const byItem = new Map<number, string[]>();
    for (const row of rows) {
      const bucket = byItem.get(row.itemId) ?? [];
      bucket.push(row.name);
      byItem.set(row.itemId, bucket);
    }
    for (const item of list) item.tags = byItem.get(item.id) ?? [];
  }

  private toRow(newItem: NewItem, createdAt: Date, updatedAt: Date): Omit<ItemRow, "id"> {
    const text = (value: string | undefined): string | null => value ?? null;
    return {
      type: newItem.type,
      url: text(newItem.url),
      canonicalUrl: text(newItem.canonicalUrl),
      urlHash: text(newItem.urlHash),
      title: text(newItem.title),
      description: text(newItem.description),
      notes: text(newItem.notes),
      thumbnailPath: text(newItem.thumbnailPath),
      filePath: text(newItem.filePath),
      fileName: text(newItem.fileName),
      mimeType: text(newItem.mimeType),
      fileHash: text(newItem.fileHash),
      authorName: text(newItem.authorName),
      authorUrl: text(newItem.authorUrl),
      source: newItem.source,
      sourceRef: newItem.sourceRef ? JSON.stringify(newItem.sourceRef) : null,
      seen: 0,
      starred: 0,
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    };
  }

  private toDomain(row: ItemRow, tagsForRow: string[]): Item {
    return {
      id: row.id,
      type: isItemType(row.type) ? row.type : "link",
      url: row.url ?? undefined,
      canonicalUrl: row.canonicalUrl ?? undefined,
      title: row.title ?? undefined,
      description: row.description ?? undefined,
      notes: row.notes ?? undefined,
      thumbnailPath: row.thumbnailPath ?? undefined,
      filePath: row.filePath ?? undefined,
      fileName: row.fileName ?? undefined,
      mimeType: row.mimeType ?? undefined,
      source: row.source as ItemSource,
      sourceRef: parseSourceRef(row.sourceRef),
      authorName: row.authorName ?? undefined,
      authorUrl: row.authorUrl ?? undefined,
      seen: row.seen === 1,
      starred: row.starred === 1,
      tags: tagsForRow,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }
}

/**
 * Trasforma la query utente in frasi quotate per FTS5: sicura (niente errori
 * di sintassi) e con significato di AND tra parole.
 */
export function ftsPhrase(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" ");
}

function parseSourceRef(json: string | null): SourceRef | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as SourceRef;
  } catch {
    return undefined;
  }
}
