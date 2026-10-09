import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { openDatabase } from "@/db/connection";
import { migrate } from "@/db/migrate";
import { ItemsRepository } from "@/db/repositories/items";
import { FileStore } from "@/core/files";
import { MetadataFetcher } from "@/core/metadata";
import { IngestionService } from "@/core/ingestion";
import { VideoDownloadService } from "@/core/video-download";
import { createRuntime } from "@/core/runtime";
import { startControl } from "./control";

it("worker owns a download while the web client is replaced, with authenticated access", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stash-control-"));
  const db = openDatabase(":memory:");
  migrate(db.raw);
  const items = new ItemsRepository(db);
  const files = new FileStore(root);
  const metadata = new MetadataFetcher(files, async () => new Response("", { status: 404 }));
  const ingestion = new IngestionService(items, files, metadata);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const uploads: string[] = [];
  const downloads = new VideoDownloadService(items, files, ingestion, {
    downloader: async (_url, dir) => {
      await gate;
      const file = path.join(dir, "fixture.mp4");
      await writeFile(file, "video bytes");
      return file;
    },
    uploader: async input => { uploads.push(input.chatId); },
  });
  vi.stubEnv("STASH_CONTROL_PORT", "0");
  vi.stubEnv("STASH_CONTROL_TOKEN", "test-control-secret");
  const control = await startControl(createRuntime(root, db, downloads), () => "running");
  expect(control).toBeDefined();
  vi.stubEnv("STASH_CONTROL_PORT", String(control!.port));
  try {
    const forbidden = await fetch(`http://127.0.0.1:${control!.port}/video-jobs`, {
      method: "POST", body: "{}",
    });
    expect(forbidden.status).toBe(401);
    const { startWebVideoJob } = await import("@/core/web-video-jobs");
    const started = await startWebVideoJob({ url: "https://youtu.be/dQw4w9WgXcQ", chatId: "1", source: "web" });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    vi.resetModules(); // Replacing the web consumer must not replace the job owner.
    const { getWebVideoJob } = await import("@/core/web-video-jobs");
    expect((await getWebVideoJob(started.job.id))?.phase).toBe("downloading");
    finish();
    await vi.waitFor(async () => expect((await getWebVideoJob(started.job.id))?.phase).toBe("done"));
    expect(uploads).toEqual(["1"]);
    expect(await getWebVideoJob("missing")).toBeUndefined();
  } finally {
    finish();
    await control!.close();
    db.raw.close();
    await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
