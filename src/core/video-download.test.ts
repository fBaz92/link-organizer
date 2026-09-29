import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "@/db/connection";
import { migrate } from "@/db/migrate";
import { ItemsRepository } from "@/db/repositories/items";
import { FileStore } from "@/core/files";
import { IngestionService } from "@/core/ingestion";
import { MetadataFetcher } from "@/core/metadata";
import { VideoDownloadService, type VideoUploadInput } from "@/core/video-download";

/*
 * Flow: test del servizio di download video senza rete. yt-dlp è sostituito
 * da un downloader finto che "scarica" un file di test in destDir; l'uploader
 * Bot API registra le chiamhe in memoria. Il DB è SQLite in-memory con la
 * stessa pipeline reale di ingestione.
 */

const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const CANONICAL = "https://youtu.be/dQw4w9WgXcQ";

describe("VideoDownloadService", () => {
  let handle: DatabaseHandle;
  let items: ItemsRepository;
  let files: FileStore;
  let metadata: MetadataFetcher;
  let service: VideoDownloadService;
  let downloads: { url: string; dir: string }[];
  let uploads: VideoUploadInput[];
  let downloadImpl: (url: string, dir: string) => Promise<void>;

  beforeEach(async () => {
    handle = openDatabase(":memory:");
    migrate(handle.raw);
    items = new ItemsRepository(handle);
    files = new FileStore(await mkdtemp(path.join(tmpdir(), "stash-vdl-")));
    metadata = new MetadataFetcher(files, (async () =>
      new Response("nope", { status: 404, headers: { "content-type": "text/plain" } })) as typeof fetch);
    const ingestion = new IngestionService(items, files, metadata);

    downloads = [];
    uploads = [];
    downloadImpl = async (url, dir) => {
      downloads.push({ url, dir });
      await writeFile(path.join(dir, "dQw4w9WgXcQ.mp4"), "fake video bytes");
    };
    const downloader = async (url: string, dir: string, onProgress: (pct: number) => void) => {
      onProgress(42.5);
      await downloadImpl(url, dir);
      return path.join(dir, "dQw4w9WgXcQ.mp4");
    };
    const uploader = async (input: VideoUploadInput) => {
      uploads.push(input);
    };

    service = new VideoDownloadService(items, files, ingestion, { downloader, uploader });
  });

  async function waitForJob(
    jobId: string,
    svc: VideoDownloadService = service,
    timeoutMs = 5000,
  ): Promise<ReturnType<VideoDownloadService["get"]>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = svc.get(jobId);
      if (job && (job.phase === "done" || job.phase === "error")) return job;
      if (Date.now() > deadline) throw new Error(`job ${jobId} non termina (fase: ${job?.phase ?? "?"})`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("da URL nuovo: archivia, scarica, aggancia il file e carica su Telegram", async () => {
    const started = service.start({ url: VIDEO_URL, chatId: "100", source: "telegram" });
    expect(started.ok).toBe(true);
    const job = await waitForJob(started.ok ? started.job.id : "");

    expect(job!.phase).toBe("done");
    expect(job!.itemId).toBe(1);
    expect(downloads[0]!.url).toBe(CANONICAL);

    const item = items.getById(1)!;
    expect(item.type).toBe("video");
    expect(item.filePath).toMatch(/^files\/[0-9a-f]{64}\.mp4$/);
    expect(item.fileName).toBe("youtu.be.mp4"); // titolo di fallback offline
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.chatId).toBe("100");
    expect(uploads[0]!.caption).toContain("https://youtu.be/dQw4w9WgXcQ");
    expect(uploads[0]!.caption).toContain("Stash #1");
    // Il file caricato è quello nello store, non la copia temporanea.
    expect(uploads[0]!.filePath).toBe(files.absolutePath(item.filePath!));
  });

  it("da itemId esistente: riusa l'item dell'archivio senza crearne un altro", async () => {
    const created = items.insert({
      type: "video",
      url: VIDEO_URL,
      canonicalUrl: CANONICAL,
      title: "Never Gonna Give You Up",
      authorName: "Rick Astley",
      source: "web",
      tags: ["video"],
    });
    const before = items.stats().total;

    const started = service.start({ itemId: created.id, chatId: "100", source: "web" });
    expect(started.ok).toBe(true);
    const job = await waitForJob(started.ok ? started.job.id : "");

    expect(job!.phase).toBe("done");
    expect(items.stats().total).toBe(before);
    expect(downloads[0]!.url).toBe(CANONICAL);
    expect(uploads[0]!.caption).toContain("Never Gonna Give You Up");
    expect(uploads[0]!.caption).toContain("Rick Astley");
    // Il titolo vero diventa il nome del file salvato.
    expect(items.getById(created.id)!.fileName).toContain("Never_Gonna_Give_You_Up");
  });

  it("item non YouTube viene rifiutato subito", async () => {
    const created = items.insert({ type: "video", url: "https://vimeo.com/12345", canonicalUrl: "https://vimeo.com/12345", title: "Vimeo", source: "web" });
    const result = service.start({ itemId: created.id, chatId: "100", source: "web" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("solo per YouTube");
  });

  it("URL non valido viene rifiutato subito", async () => {
    const result = service.start({ url: "https://esempio.it/video", chatId: "100", source: "web" });
    expect(result.ok).toBe(false);
  });

  it("file già scaricato: salta il download e ricarica soltanto", async () => {
    const created = items.insert({
      type: "video",
      url: VIDEO_URL,
      canonicalUrl: CANONICAL,
      title: "Già presente",
      source: "web",
      tags: [],
    });
    const stored = await files.saveBytes(new TextEncoder().encode("video già in store"), "già presente.mp4", "files");
    items.update(created.id, { filePath: stored.relativePath, fileName: stored.fileName, fileHash: stored.hash });

    const started = service.start({ itemId: created.id, chatId: "200", source: "web" });
    const job = await waitForJob(started.ok ? started.job.id : "");

    expect(job!.phase).toBe("done");
    expect(downloads).toHaveLength(0);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.filePath).toBe(files.absolutePath(stored.relativePath));
    expect(uploads[0]!.chatId).toBe("200");
  });

  it("downloader che fallisce: job in errore con messaggio leggibile", async () => {
    downloadImpl = async () => {
      throw new Error("boom di rete");
    };
    const started = service.start({ url: VIDEO_URL, chatId: "100", source: "telegram" });
    const job = await waitForJob(started.ok ? started.job.id : "");

    expect(job!.phase).toBe("error");
    expect(job!.error).toContain("boom di rete");
    expect(uploads).toHaveLength(0);
    // L'item resta archiviato, ma senza file agganciato.
    expect(items.getById(1)!.filePath).toBeUndefined();
  });

  it("video oltre il limite: viene spezzettato e inviato in parti", async () => {
    const downloadsBefore = downloads.length;
    const uploadsBefore = uploads.length;
    const splitCalls: { path: string; target: number }[] = [];
    const limited = new VideoDownloadService(items, files, new IngestionService(items, files, metadata), {
      downloader: async (url, dir, onProgress) => {
        onProgress(50);
        await downloadImpl(url, dir);
        return path.join(dir, "dQw4w9WgXcQ.mp4");
      },
      uploader: async (input) => {
        uploads.push(input);
      },
      splitter: async (filePath, target, destDir) => {
        splitCalls.push({ path: filePath, target });
        const parts = [path.join(destDir, "part0000.mp4"), path.join(destDir, "part0001.mp4")];
        for (const part of parts) await writeFile(part, "0123"); // 4 byte: sotto il limite di 8
        return parts;
      },
      maxUploadBytes: 8,
    });
    const started = limited.start({ url: VIDEO_URL, chatId: "100", source: "web" });
    const job = await waitForJob(started.ok ? started.job.id : "", limited);

    expect(job!.phase).toBe("done");
    // Lo scaricamento non è stato limitato: il file intero finisce nello store.
    expect(downloads.length).toBe(downloadsBefore + 1);
    // L'upload è arrivato come due parti ordinate, con caption e nome file dedicati.
    expect(uploads.length).toBe(uploadsBefore + 2);
    expect(uploads.at(-2)!.part).toEqual({ index: 1, total: 2 });
    expect(uploads.at(-1)!.part).toEqual({ index: 2, total: 2 });
    expect(uploads.at(-2)!.caption).toContain("parte 1/2");
    expect(uploads.at(-1)!.caption).toContain("parte 2/2");
    expect(uploads.at(-1)!.fileName).toContain(".parte2di2.mp4");
    // Lo splitter ha ricevuto il file dello store (16 byte > limite 8).
    expect(splitCalls).toHaveLength(1);
    expect(splitCalls[0]!.path).toContain("files/");
    expect(splitCalls[0]!.target).toBeGreaterThan(0);
  });

  it("se una parte sfora comunque il limite, il job fallisce con messaggio chiaro", async () => {
    const limited = new VideoDownloadService(items, files, new IngestionService(items, files, metadata), {
      downloader: async (url, dir) => {
        await downloadImpl(url, dir);
        return path.join(dir, "dQw4w9WgXcQ.mp4");
      },
      uploader: async (input) => {
        uploads.push(input);
      },
      splitter: async (_filePath, _target, destDir) => {
        // Keyframe radi: una parte resta oltre il limite per-parti.
        const part = path.join(destDir, "part0000.mp4");
        await writeFile(part, "0123456789abcdefghij"); // 20 byte > 8
        return [part];
      },
      maxUploadBytes: 8,
    });
    const started = limited.start({ url: VIDEO_URL, chatId: "100", source: "web" });
    const job = await waitForJob(started.ok ? started.job.id : "", limited);

    expect(job!.phase).toBe("error");
    expect(job!.error).toContain("Una parte supera comunque");
    expect(uploads.length).toBe(0);
  });
});
