import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "@/db/connection";
import { migrate } from "@/db/migrate";
import { ItemsRepository } from "@/db/repositories/items";
import { FileStore } from "@/core/files";
import { IngestionService } from "@/core/ingestion";
import { MetadataFetcher } from "@/core/metadata";
import type { IngestionService as Service } from "@/core/ingestion";

/*
 * Flow: test di integrazione della pipeline di ingestione su SQLite
 * in-memory (stesse migrazioni del produttivo) e FileStore in cartella
 * temporanea. La rete è simulata con un fetchImpl finto: nessun test parla
 * con internet. Contratti verificati: dedup per URL-forme diverse, dedup
 * file per contenuto, tag automatici, arricchimento metadati solo dove
 * manca (con auto-tag additivo da titolo/descrizione), ricerca FTS, random
 * con filtri, statistiche.
 */

// IP pubblico letterale: la guardia SSRF lo accetta senza fare DNS reale.
const HOST = "93.184.216.34";

describe("IngestionService", () => {
  let handle: DatabaseHandle;
  let items: ItemsRepository;
  let files: FileStore;
  let ingestion: Service;
  let dataRoot: string;
  let fetchCalls: string[];

  beforeAll(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "stash-test-"));
    handle = openDatabase(":memory:");
    migrate(handle.raw);
    items = new ItemsRepository(handle);
    files = new FileStore(dataRoot);
    fetchCalls = [];

    const fetchImpl = (async (input: string | URL | Request) => {
      const url = input.toString();
      fetchCalls.push(url);
      if (url.includes("/thumb.jpg")) {
        return htmlResponse(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg");
      }
      if (url.includes("/power")) {
        return htmlResponse(
          `<html><head>
            <meta property="og:title" content="Introduction to power systems">
            <meta property="og:description" content="Transformers, transmission lines and load flow">
          </head><body>contenuto</body></html>`,
        );
      }
      if (url.includes("/elettronica")) {
        return htmlResponse(
          `<html><head>
            <meta property="og:title" content="Convertitori buck e boost">
            <meta property="og:description" content="Lezioni di elettronica di potenza">
          </head><body>contenuto</body></html>`,
        );
      }
      return htmlResponse(
        `<html><head>
          <meta property="og:title" content="Il titolo vero">
          <meta property="og:description" content="Una descrizione utile">
          <meta property="og:image" content="/thumb.jpg">
        </head><body>contenuto</body></html>`,
      );
    }) as typeof fetch;

    ingestion = new IngestionService(items, files, new MetadataFetcher(files, fetchImpl));
  });

  afterAll(() => {
    handle.raw.close();
  });

  it("crea un item da URL con tipo e tag automatici", async () => {
    const result = await ingestion.ingest({
      payload: { kind: "url", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
      source: "telegram",
    });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.item.type).toBe("video");
    expect(result.item.tags).toContain("video");
    expect(result.item.canonicalUrl).toBe("https://youtu.be/dQw4w9WgXcQ");
  });

  it("rifiuta come duplicato una forma diversa dello stesso URL", async () => {
    const result = await ingestion.ingest({
      payload: { kind: "url", url: "https://youtu.be/dQw4w9WgXcQ?si=abc123" },
      source: "web",
    });
    expect(result.status).toBe("duplicate");
  });

  it("rifiuta URL non validi con errore dedicato", async () => {
    await expect(
      ingestion.ingest({ payload: { kind: "url", url: "non-un-url" }, source: "web" }),
    ).rejects.toMatchObject({ name: "IngestionError", reason: "invalid-url" });
  });

  it("arricchisce con metadati senza sovrascrivere ciò che esiste", async () => {
    const created = await ingestion.ingest({
      payload: { kind: "url", url: `https://${HOST}/articolo` },
      source: "telegram",
    });
    if (created.status !== "created") throw new Error("atteso created");

    const enriched = await ingestion.enrichMetadata(created.item);
    expect(enriched.title).toBe("Il titolo vero");
    expect(enriched.description).toBe("Una descrizione utile");
    expect(enriched.thumbnailPath).toMatch(/^thumbs\//);

    // Secondo arricchimento: nessun sovrascrivere, nessun nuovo download thumbnail.
    fetchCalls.length = 0;
    const again = await ingestion.enrichMetadata(enriched);
    expect(again.title).toBe("Il titolo vero");
    expect(fetchCalls.filter((url) => url.includes("thumb"))).toEqual([]);
  });

  it("l'arricchimento metadati applica l'auto-tag da titolo e descrizione", async () => {
    const created = await ingestion.ingest({
      payload: { kind: "url", url: `https://${HOST}/power` },
      source: "web",
    });
    if (created.status !== "created") throw new Error("atteso created");
    expect(created.item.tags).not.toContain("power-systems"); // all'ingest non c'è ancora testo

    const enriched = await ingestion.enrichMetadata(created.item);
    expect(enriched.tags).toContain("power-systems");
    expect(enriched.type).toBe("link"); // le keyword arricchiscono, il tipo no
  });

  it("l'auto-tag si somma ai tag scritti a mano senza cancellarli", async () => {
    const created = await ingestion.ingest({
      payload: { kind: "url", url: `https://${HOST}/elettronica` },
      source: "web",
    });
    if (created.status !== "created") throw new Error("atteso created");
    items.replaceTags(created.item.id, ["da-vedere"]);

    const enriched = await ingestion.enrichMetadata(created.item);
    expect(enriched.tags).toEqual(expect.arrayContaining(["da-vedere", "power-electronics"]));
  });

  it("deduplica i file per contenuto (hash), non per nome", async () => {
    const filePath = path.join(dataRoot, "primo.pdf");
    await writeFile(filePath, "%PDF-1.4 contenuto di prova");

    const first = await ingestion.ingest({
      payload: { kind: "file", path: filePath, name: "primo.pdf", mimeType: "application/pdf" },
      source: "telegram",
    });
    expect(first.status).toBe("created");
    if (first.status !== "created") return;
    expect(first.item.type).toBe("documento");
    expect(first.item.tags).toContain("pdf");

    const secondPath = path.join(dataRoot, "copia-rinominata.pdf");
    await writeFile(secondPath, "%PDF-1.4 contenuto di prova");
    const second = await ingestion.ingest({
      payload: { kind: "file", path: secondPath, name: "copia-rinominata.pdf" },
      source: "telegram",
    });
    expect(second.status).toBe("duplicate");
  });
});

describe("ItemsRepository", () => {
  let handle: DatabaseHandle;
  let items: ItemsRepository;

  beforeAll(() => {
    handle = openDatabase(":memory:");
    migrate(handle.raw);
    items = new ItemsRepository(handle);
  });

  afterAll(() => handle.raw.close());

  it("lista con paginazione, totale e tag in batch", () => {
    for (let i = 1; i <= 25; i++) {
      items.insert({ type: "link", url: `https://${HOST}/${i}`, canonicalUrl: `https://${HOST}/${i}`, urlHash: `h${i}`, source: "web", tags: i % 2 ? ["notizie"] : [] });
    }
    const page1 = items.list({ limit: 10, offset: 0 });
    expect(page1.total).toBe(25);
    expect(page1.items).toHaveLength(10);
    expect(page1.items[0].id).toBe(25); // stesso createdAt → ordina per id discendente

    const filtered = items.list({ limit: 10, offset: 0, tag: "notizie" });
    expect(filtered.total).toBe(13);
    expect(filtered.items.every((i) => i.tags.includes("notizie"))).toBe(true);
  });

  it("aggiorna titolo e ricerca full-text trova", () => {
    const created = items.insert({ type: "video", url: `https://${HOST}/talk`, canonicalUrl: `https://${HOST}/talk`, urlHash: "talk", source: "web", title: "Rust per principianti" });
    items.update(created.id, { title: "Rust avanzato: ownership spiegata" });

    expect(items.list({ q: "ownership", limit: 5, offset: 0 }).total).toBe(1);
    expect(items.list({ q: "python", limit: 5, offset: 0 }).total).toBe(0);
  });

  it("random rispetta i filtri e la quantità", () => {
    items.insert({ type: "documento", title: "documento unico", urlHash: "doc", source: "web", tags: ["pdf"] });
    const seen = items.list({ limit: 1, offset: 0 }).items[0];
    items.update(seen.id, { seen: true });

    const lucky = items.random({ seen: false, tag: "notizie" }, 5);
    expect(lucky.length).toBeLessThanOrEqual(5);
    expect(lucky.every((i) => !i.seen && i.tags.includes("notizie"))).toBe(true);
  });

  it("replaceTags sostituisce e tagsWithCounts conta", () => {
    const created = items.insert({ type: "link", urlHash: "tags1", source: "web", tags: ["vecchio"] });
    items.replaceTags(created.id, ["nuovo", "altro"]);
    const item = items.getById(created.id);
    expect(item?.tags.sort()).toEqual(["altro", "nuovo"]);
    expect(items.tagsWithCounts().find((t) => t.name === "nuovo")?.count).toBe(1);
  });

  it("filtra per canale (author_url) e conta i canali", () => {
    items.insert({
      type: "video",
      urlHash: "ch1",
      source: "web",
      title: "Video del canale A",
      authorName: "Canale A",
      authorUrl: "https://example.com/channel/a",
    });
    items.insert({
      type: "video",
      urlHash: "ch2",
      source: "web",
      title: "Altro video del canale A",
      authorName: "Canale A",
      authorUrl: "https://example.com/channel/a",
    });
    items.insert({
      type: "video",
      urlHash: "ch3",
      source: "web",
      title: "Video del canale B",
      authorName: "Canale B",
      authorUrl: "https://example.com/channel/b",
    });

    const byAuthor = items.list({
      author: "https://example.com/channel/a",
      limit: 10,
      offset: 0,
    });
    expect(byAuthor.total).toBe(2);
    expect(byAuthor.items.every((i) => i.authorName === "Canale A")).toBe(true);

    const authors = items.authorsWithCounts();
    expect(authors.find((a) => a.url === "https://example.com/channel/a")).toMatchObject({
      name: "Canale A",
      count: 2,
    });
  });

  it("la ricerca full-text trova anche nell'autore", () => {
    const created = items.insert({
      type: "video",
      urlHash: "auth1",
      source: "web",
      title: "Un tutorial",
      authorName: "Ferrari",
      authorUrl: "https://example.com/channel/ferrari",
    });
    expect(items.list({ q: "ferrari", limit: 5, offset: 0 }).total).toBe(1);
    items.delete(created.id);
  });

  it("facets: ogni dimensione rispetta gli altri filtri", () => {
    const FA = "https://example.com/channel/facet-a";
    const FB = "https://example.com/channel/facet-b";
    const v1 = items.insert({ type: "video", urlHash: "f1", source: "web", tags: ["t1f"], authorName: "Canale FA", authorUrl: FA });
    items.insert({ type: "video", urlHash: "f2", source: "web", tags: ["t1f"], authorName: "Canale FB", authorUrl: FB });
    items.insert({ type: "post", urlHash: "f3", source: "web", tags: ["t2f"], authorName: "Canale FA", authorUrl: FA });
    items.update(v1.id, { seen: true });

    // Con tipo=video: solo tag/canali dei video; la dimensione tipo è esclusa.
    const byType = items.facets({ type: "video" });
    expect(byType.tags.map((t) => t.name)).toContain("t1f");
    expect(byType.tags.find((t) => t.name === "t2f")).toBeUndefined();
    expect(byType.tags.find((t) => t.name === "t1f")?.count).toBe(2);
    expect(byType.authors.find((a) => a.url === FA)?.count).toBe(1);
    expect(byType.types.find((t) => t.type === "post")?.count).toBe(1);

    // Con tag=t2f (il post): il canale FA conta solo il post.
    const byTag = items.facets({ tag: "t2f" });
    expect(byTag.authors.find((a) => a.url === FA)?.count).toBe(1);
    expect(byTag.tags.find((t) => t.name === "t2f")?.count).toBe(1);

    // Con autore=FA: gli stati tengono conto dei soli item di FA.
    const byAuthor = items.facets({ author: FA });
    expect(byAuthor.states).toEqual({ unseen: 1, seen: 1, starred: 0 });
    expect(byAuthor.tags.map((t) => t.name).sort()).toEqual(["t1f", "t2f"]);
  });

  it("delete rimuove item e associazioni", () => {
    const created = items.insert({ type: "link", urlHash: "del1", source: "web", tags: ["x"] });
    items.delete(created.id);
    expect(items.getById(created.id)).toBeUndefined();
    expect(items.tagsWithCounts().find((t) => t.name === "x")).toBeUndefined();
  });

  it("stats aggrega per tipo", () => {
    const stats = items.stats();
    expect(stats.total).toBeGreaterThan(0);
    expect(stats.byType["video"]).toBeGreaterThan(0);
    expect(stats.unseen).toBeGreaterThan(0);
  });
});

function htmlResponse(body: string | Uint8Array, contentType = "text/html; charset=utf-8"): Response {
  return new Response(body as BodyInit, { status: 200, headers: { "content-type": contentType } });
}
