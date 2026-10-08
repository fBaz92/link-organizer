import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/db/connection";
import { migrate } from "@/db/migrate";
import { FileStore } from "@/core/files";
import { IngestionService } from "@/core/ingestion";
import { MetadataFetcher } from "@/core/metadata";
import { createRuntime, type StashRuntime } from "@/core/runtime";
import { backfillThumbnails, youtubeThumbnailUrl } from "@/core/thumbnail-backfill";

/*
 * Flow: test del backfill automatico delle thumbnail con fetch iniettata:
 * YouTube usa l'URL deterministico i.ytimg.com (SENZA passare da oEmbed o
 * yt-dlp), gli altri siti passano da enrichMetadata (che come bonus
 * completa titolo/descrizione mancanti); i fallimenti sono per-item e un
 * item già provvisto non viene toccato.
 */

const YT_VIDEO_ID = "dQw4w9WgXcQ";
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

let dir: string;
let runtime: StashRuntime;
const fetchedUrls: string[] = [];

function imageResponse(): Response {
  return new Response(JPEG_BYTES.slice(), {
    status: 200,
    headers: { "content-type": "image/jpeg", "content-length": String(JPEG_BYTES.byteLength) },
  });
}

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = input.toString();
  fetchedUrls.push(url);
  if (url.includes("i.ytimg.com") || url.includes("esempio.it/copertina")) {
    return imageResponse();
  }
  if (url.includes("rotta.it")) {
    return new Response("not found", { status: 404 });
  }
  if (url.includes("esempio.it/articolo")) {
    return htmlResponse(`<!doctype html><html><head>
      <meta property="og:title" content="Titolo vero dell'articolo">
      <meta property="og:image" content="https://esempio.it/copertina.jpg">
    </head><body></body></html>`);
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "stash-thumb-backfill-"));
  const handle = openDatabase(":memory:");
  migrate(handle.raw);
  runtime = createRuntime(dir, handle, {} as StashRuntime["videoDownload"]);
  // Runtime con fetch di rete finta (nessuna chiamata reale nei test).
  (runtime as unknown as { metadata: MetadataFetcher }).metadata = new MetadataFetcher(
    new FileStore(dir),
    fakeFetch,
  );
  runtime.ingestion = new IngestionService(runtime.items, runtime.files, runtime.metadata);
  fetchedUrls.length = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("youtubeThumbnailUrl", () => {
  it("deriva l'URL pubblico dal canonical youtu.be", () => {
    expect(youtubeThumbnailUrl(`https://youtu.be/${YT_VIDEO_ID}`)).toBe(
      `https://i.ytimg.com/vi/${YT_VIDEO_ID}/hqdefault.jpg`,
    );
  });

  it("undefined per URL non YouTube", () => {
    expect(youtubeThumbnailUrl("https://esempio.it/articolo")).toBeUndefined();
  });
});

describe("backfillThumbnails", () => {
  it("YouTube: scarica la thumbnail deterministica senza fetch di metadati", async () => {
    runtime.items.insert({
      type: "video",
      url: `https://www.youtube.com/watch?v=${YT_VIDEO_ID}`,
      canonicalUrl: `https://youtu.be/${YT_VIDEO_ID}`,
      title: "Video senza thumb",
      source: "telegram",
    });

    const summary = await backfillThumbnails(runtime, { pauseMs: 0 });
    expect(summary).toEqual({ scanned: 1, fetched: 1, failed: 0 });

    // Solo l'immagine: niente oEmbed, niente pagina watch, niente yt-dlp.
    expect(fetchedUrls).toEqual([`https://i.ytimg.com/vi/${YT_VIDEO_ID}/hqdefault.jpg`]);

    const [item] = runtime.items.list({ limit: 10, offset: 0 }).items;
    expect(item.thumbnailPath).toMatch(/^thumbs\//);
    expect(existsSync(runtime.files.absolutePath(item.thumbnailPath!))).toBe(true);

    // Idempotente: il secondo run non trova più nulla.
    const second = await backfillThumbnails(runtime, { pauseMs: 0 });
    expect(second.scanned).toBe(0);
  });

  it("altri siti: passa dai metadati e completa anche titolo e descrizione mancanti", async () => {
    runtime.items.insert({
      type: "articolo",
      url: "https://esempio.it/articolo",
      canonicalUrl: "https://esempio.it/articolo",
      source: "telegram",
    });

    const summary = await backfillThumbnails(runtime, { pauseMs: 0 });
    expect(summary.fetched).toBe(1);

    const [item] = runtime.items.list({ limit: 10, offset: 0 }).items;
    expect(item.thumbnailPath).toMatch(/^thumbs\//);
    expect(item.title).toBe("Titolo vero dell'articolo");
    expect(item.description).toBeUndefined(); // l'HTML fake non ha og:description
  });

  it("un fallimento non blocca il run: gli altri item vengono comunque trattati", async () => {
    runtime.items.insert({
      type: "video",
      url: `https://youtu.be/${YT_VIDEO_ID}`,
      canonicalUrl: `https://youtu.be/${YT_VIDEO_ID}`,
      title: "ok",
      source: "telegram",
    });
    runtime.items.insert({
      type: "articolo",
      url: "https://rotta.it/pagina",
      canonicalUrl: "https://rotta.it/pagina",
      title: "rotta",
      source: "telegram",
    });

    const summary = await backfillThumbnails(runtime, { pauseMs: 0 });
    expect(summary).toEqual({ scanned: 2, fetched: 1, failed: 1 });

    const items = runtime.items.list({ limit: 10, offset: 0 }).items;
    const rotta = items.find((i) => i.url?.includes("rotta.it"));
    expect(rotta?.thumbnailPath).toBeUndefined();
  });

  it("limit e item già provvisti: non si rifà il lavoro", async () => {
    runtime.items.insert({
      type: "video",
      url: `https://youtu.be/${YT_VIDEO_ID}`,
      canonicalUrl: `https://youtu.be/${YT_VIDEO_ID}`,
      title: "prima",
      thumbnailPath: "thumbs/già-scaricata.jpg",
      source: "telegram",
    });
    for (let i = 0; i < 3; i += 1) {
      const videoId = `vid${String(i).padStart(8, "0")}`; // 11 caratteri
      runtime.items.insert({
        type: "video",
        url: `https://youtu.be/${videoId}`,
        canonicalUrl: `https://youtu.be/${videoId}`,
        title: `senza thumb ${i}`,
        source: "telegram",
      });
    }

    const summary = await backfillThumbnails(runtime, { pauseMs: 0, limit: 2 });
    expect(summary.scanned).toBe(2);

    // I più recenti prima: con limit 2 si prendono i due con id più alto
    // e resta in coda solo il più vecchio.
    const remaining = runtime.items.listMissingThumbnails(10);
    expect(remaining.map((i) => i.title)).toEqual(["senza thumb 0"]);
    expect(remaining.every((i) => i.title !== "prima")).toBe(true);
  });

  it("listMissingThumbnails ignora item senza URL (documenti)", () => {
    runtime.items.insert({
      type: "documento",
      title: "doc.pdf",
      filePath: "files/doc.pdf",
      fileName: "doc.pdf",
      source: "telegram",
    });
    expect(runtime.items.listMissingThumbnails(10)).toEqual([]);
  });
});
