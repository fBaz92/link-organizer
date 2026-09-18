import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/*
 * Flow: definizione Drizzle delle tabelle. È lo spec tipizzato usato dalle
 * query; l'SDL reale applicato al DB vive in schema.sql.ts (migratore).
 * `items` è la tabella centrale: un item è un link e/o un file archiviato.
 * url_hash / file_hash sono UNIQUE e nullable → dedup a colpo sicuro anche
 * con processi concorrenti (web + bot).
 */

export const items = sqliteTable("items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  url: text("url"),
  canonicalUrl: text("canonical_url"),
  urlHash: text("url_hash"),
  title: text("title"),
  description: text("description"),
  notes: text("notes"),
  thumbnailPath: text("thumbnail_path"),
  filePath: text("file_path"),
  fileName: text("file_name"),
  mimeType: text("mime_type"),
  fileHash: text("file_hash"),
  authorName: text("author_name"),
  authorUrl: text("author_url"),
  source: text("source").notNull(),
  sourceRef: text("source_ref"),
  seen: integer("seen").notNull().default(0),
  starred: integer("starred").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const tags = sqliteTable("tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
});

export const itemsTags = sqliteTable(
  "items_tags",
  {
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.tagId] }),
    index("items_tags_tag_id_idx").on(t.tagId),
  ],
);

export type ItemRow = typeof items.$inferSelect;
export type ItemInsert = typeof items.$inferInsert;
