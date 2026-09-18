/*
 * Flow: migrazioni come sequenza di statement SQL idempotenti (IF NOT EXISTS),
 * tracciati con PRAGMA user_version. Sicuri da rilanciare in concorrenza dai
 * due processi (web e bot) perché ogni statement protege se stesso.
 *
 * v1: tabelle core + indice full-text FTS5 su (title, description) mantenuto
 *     sincrono da trigger sulla tabella items (content table esterna).
 */
export const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      url TEXT,
      canonical_url TEXT,
      url_hash TEXT UNIQUE,
      title TEXT,
      description TEXT,
      notes TEXT,
      thumbnail_path TEXT,
      file_path TEXT,
      file_name TEXT,
      mime_type TEXT,
      file_hash TEXT UNIQUE,
      source TEXT NOT NULL,
      source_ref TEXT,
      seen INTEGER NOT NULL DEFAULT 0,
      starred INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    )`,
    `CREATE TABLE IF NOT EXISTS items_tags (
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (item_id, tag_id)
    )`,
    `CREATE INDEX IF NOT EXISTS items_created_at_idx ON items (created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS items_type_idx ON items (type)`,
    `CREATE INDEX IF NOT EXISTS items_seen_idx ON items (seen)`,
    `CREATE INDEX IF NOT EXISTS items_tags_tag_id_idx ON items_tags (tag_id)`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
      title, description, content='items', content_rowid='id'
    )`,
    `CREATE TRIGGER IF NOT EXISTS items_fts_ai AFTER INSERT ON items BEGIN
      INSERT INTO items_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
    END`,
    `CREATE TRIGGER IF NOT EXISTS items_fts_ad AFTER DELETE ON items BEGIN
      INSERT INTO items_fts(items_fts, rowid, title, description) VALUES ('delete', old.id, old.title, old.description);
    END`,
    `CREATE TRIGGER IF NOT EXISTS items_fts_au AFTER UPDATE ON items BEGIN
      INSERT INTO items_fts(items_fts, rowid, title, description) VALUES ('delete', old.id, old.title, old.description);
      INSERT INTO items_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
    END`,
  ],
  [
    // v2: canale/autore dell'item (es. canale YouTube), filtrabile.
    `ALTER TABLE items ADD COLUMN author_name TEXT`,
    `ALTER TABLE items ADD COLUMN author_url TEXT`,
    `CREATE INDEX IF NOT EXISTS items_author_url_idx ON items (author_url)`,
  ],
];
