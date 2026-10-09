import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "./connection";
import { MIGRATIONS } from "@/db/schema.sql";
import { migrate } from "./migrate";
import { openNodeSqliteDatabase } from "./node-sqlite-driver";
import { ItemsRepository } from "./repositories/items";

/*
 * Flow: test del driver node:sqlite usato dal servizio HomeGate. Dimostrano
 * che migratore e repository funzionano identici sui due driver e — punto
 * chiave per rollback e coesistenza con la webapp — che il FILE di database
 * è intercambiabile: si scrive con better-sqlite3 e si legge con node:sqlite,
 * e viceversa, senza cambi di schema né perdite.
 */

describe("driver node:sqlite", () => {
  it("applica le migrazioni come better-sqlite3: user_version e tabelle", () => {
    const handle = openNodeSqliteDatabase(":memory:");
    try {
      migrate(handle.raw);
      expect(handle.raw.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
      const tables = handle.raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name);
      expect(tables).toContain("items");
      expect(tables).toContain("tags");
      expect(tables).toContain("items_tags");
      expect(tables).toContain("items_fts"); // FTS5 disponibile anche in node:sqlite
    } finally {
      handle.raw.close();
    }
  });

  it("repository: insert con tag, ricerca FTS, filtri e statistiche", () => {
    const handle = openNodeSqliteDatabase(":memory:");
    try {
      migrate(handle.raw);
      const items = new ItemsRepository(handle);

      const created = items.insert({
        type: "video",
        url: "https://www.youtube.com/watch?v=abc123",
        canonicalUrl: "https://youtu.be/abc123",
        title: "Rust in pratica",
        description: "Una guida completa al borrow checker",
        source: "telegram",
        tags: ["rust", "guide"],
      });
      expect(created.id).toBeGreaterThan(0);

      const byFTS = items.list({ q: "borrow", limit: 10, offset: 0 });
      expect(byFTS.total).toBe(1);
      expect(byFTS.items[0]?.title).toBe("Rust in pratica");
      expect([...(byFTS.items[0]?.tags ?? [])].sort()).toEqual(["guide", "rust"]);

      const byTag = items.list({ tag: "rust", limit: 10, offset: 0 });
      expect(byTag.total).toBe(1);

      const stats = items.stats();
      expect(stats.total).toBe(1);
      expect(stats.unseen).toBe(1);

      items.replaceTags(created.id, ["sistemi"]);
      expect(items.list({ tag: "rust", limit: 10, offset: 0 }).total).toBe(0);
      expect(items.tagsWithCounts().map((t) => t.name)).toEqual(["sistemi"]);

      items.delete(created.id);
      expect(items.stats().total).toBe(0);
    } finally {
      handle.raw.close();
    }
  });

  it("transazioni: il rollback lascia il database invariato", () => {
    const handle = openNodeSqliteDatabase(":memory:");
    try {
      migrate(handle.raw);
      const items = new ItemsRepository(handle);
      expect(() =>
        handle.raw.transaction(() => {
          items.insert({ type: "link", url: "https://esempio.it", source: "telegram" });
          throw new Error("boom");
        })(),
      ).toThrow("boom");
      expect(items.stats().total).toBe(0);
    } finally {
      handle.raw.close();
    }
  });
});

describe("retrocompatibilità del file di database fra driver", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "stash-node-sqlite-"));
    file = path.join(dir, "stash.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeWithBetterSqlite3(): void {
    const handle = openDatabase(file);
    try {
      migrate(handle.raw);
      new ItemsRepository(handle).insert({
        type: "articolo",
        url: "https://esempio.it/post",
        title: "Scritto dalla webapp",
        source: "web",
        tags: ["webapp"],
      });
    } finally {
      handle.raw.close();
    }
  }

  it("il file scritto da better-sqlite3 (webapp) è leggibile e aggiornabile dal servizio", () => {
    writeWithBetterSqlite3();

    const service: DatabaseHandle = openNodeSqliteDatabase(file);
    try {
      expect(service.raw.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
      const items = new ItemsRepository(service);
      const found = items.list({ q: "webapp", limit: 10, offset: 0 });
      expect(found.total).toBe(1);
      expect(found.items[0]?.title).toBe("Scritto dalla webapp");

      // Il servizio scrive: update + nuovo item con tag (trigger FTS inclusi).
      items.update(found.items[0]!.id, { seen: true, notes: "visto dal servizio" });
      items.insert({ type: "video", url: "https://youtu.be/xyz", source: "telegram", tags: ["bot"] });
      expect(items.list({ q: "servizio", limit: 10, offset: 0 }).total).toBe(0);
      expect(items.list({ tag: "bot", limit: 10, offset: 0 }).total).toBe(1);
    } finally {
      service.raw.close();
    }

    // …e la webapp (rollback su better-sqlite3) rilegge tutto ciò che il servizio ha scritto.
    const webapp = openDatabase(file);
    try {
      const items = new ItemsRepository(webapp);
      expect(items.stats().total).toBe(2);
      const updated = items.list({ q: "webapp", limit: 10, offset: 0 }).items[0]!;
      expect(updated.seen).toBe(true);
      expect(updated.notes).toBe("visto dal servizio");
    } finally {
      webapp.raw.close();
    }
  });

  it("il file creato dal servizio è leggibile dalla webapp (persistenza HOMEGATE_STATE_DIR)", () => {
    const service = openNodeSqliteDatabase(file);
    try {
      migrate(service.raw);
      new ItemsRepository(service).insert({
        type: "repo",
        url: "https://github.com/x/y",
        title: "Repo dal servizio",
        source: "telegram",
        tags: ["ci"],
      });
    } finally {
      service.raw.close();
    }

    const webapp = openDatabase(file);
    try {
      const items = new ItemsRepository(webapp);
      const found = items.list({ q: "repo", limit: 10, offset: 0 });
      expect(found.total).toBe(1);
      expect(found.items[0]?.tags).toEqual(["ci"]);
    } finally {
      webapp.raw.close();
    }
  });
});
