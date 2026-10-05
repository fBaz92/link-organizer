import { dataDir } from "@/config/env";
import { telegramToken, ytDlpPath } from "@/config/env";
import type { DatabaseHandle } from "@/db/connection";
import { getDatabase } from "@/db";
import { ItemsRepository } from "@/db/repositories/items";
import { FileStore } from "@/core/files";
import { IngestionService } from "@/core/ingestion";
import { MetadataFetcher } from "@/core/metadata";
import { createYtDlpMetadataSource } from "@/core/yt-dlp";
import { VideoDownloadService } from "@/core/video-download";

/*
 * Flow: il "composition root" del dominio. Bot, web e import costruiscono i
 * servizi dalla stessa factory così l'object graph è definito in UN punto.
 * getRuntime() memoizza su globalThis (come il DB) per sopravvivere all'hot
 * reload; createRuntime() è la versione esplicita per i test, che iniettano
 * i propri double.
 */

export interface StashRuntime {
  db: DatabaseHandle;
  items: ItemsRepository;
  files: FileStore;
  metadata: MetadataFetcher;
  ingestion: IngestionService;
  videoDownload: VideoDownloadService;
}

export function createRuntime(
  rootDir: string,
  db?: DatabaseHandle,
  videoDownload?: VideoDownloadService,
): StashRuntime {
  const handle = db ?? getDatabase();
  const files = new FileStore(rootDir);
  const items = new ItemsRepository(handle);
  // Per YouTube la strategia primaria è yt-dlp (descrizione completa + tag
  // dell'autore); senza binario cade in automatico sull'oEmbed online.
  const metadata = new MetadataFetcher(files, fetch, createYtDlpMetadataSource(ytDlpPath()));
  const ingestion = new IngestionService(items, files, metadata);
  const downloads =
    videoDownload ??
    new VideoDownloadService(items, files, ingestion, {
      ytDlpPath: ytDlpPath(),
      botToken: telegramToken(),
    });
  return { db: handle, items, files, metadata, ingestion, videoDownload: downloads };
}

const globalForRuntime = globalThis as unknown as { __stashRuntime?: StashRuntime };

export function getRuntime(): StashRuntime {
  if (!globalForRuntime.__stashRuntime) {
    globalForRuntime.__stashRuntime = createRuntime(dataDir());
  }
  return globalForRuntime.__stashRuntime;
}
