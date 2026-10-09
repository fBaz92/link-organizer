import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { openDatabase } from "@/db/connection";
import { migrate } from "@/db/migrate";
import { ItemsRepository } from "@/db/repositories/items";
import { FileStore } from "./files";
import { MetadataFetcher } from "./metadata";
import { IngestionService } from "./ingestion";

it("reports unfinished enrichment after its caller stops waiting, and releases failed work", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stash-busy-"));
  const db = openDatabase(":memory:");
  migrate(db.raw);
  const files = new FileStore(root);
  const metadata = new MetadataFetcher(files);
  let release!: () => void;
  const waiting = new Promise<null>(resolve => { release = () => resolve(null); });
  vi.spyOn(metadata, "fetch").mockReturnValue(waiting);
  const ingestion = new IngestionService(new ItemsRepository(db), files, metadata);
  try {
    const result = await ingestion.ingest({ payload: { kind: "url", url: "https://example.org/busy" }, source: "web" });
    if (result.status !== "created") throw new Error("Missing test item");
    const enrichment = ingestion.enrichMetadata(result.item);
    expect(ingestion.activeOperations).toBe(1);
    release();
    await enrichment;
    expect(ingestion.activeOperations).toBe(0);
    await expect(ingestion.ingest({ payload: { kind: "url", url: "invalid" }, source: "web" })).rejects.toThrow();
    expect(ingestion.activeOperations).toBe(0);
  } finally {
    release(); db.raw.close();
    await rm(root, { recursive: true, force: true });
  }
});
