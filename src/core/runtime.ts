import { telegramToken, ytDlpPath } from "@/config/env";
import type { DatabaseHandle } from "@/db/connection";
import { ItemsRepository } from "@/db/repositories/items";
import { FileStore } from "@/core/files";
import { IngestionService } from "@/core/ingestion";
import { MetadataFetcher } from "@/core/metadata";
import { createYtDlpMetadataSource } from "@/core/yt-dlp";
import { VideoDownloadService } from "@/core/video-download";

/*
 * Flow: il "composition root" del dominio. Bot, web e import costruiscono i
 * servizi dalla stessa factory così l'object graph è definito in UN punto.
 * Questo modulo resta PURO (nessun driver SQLite importato): il chiamante
 * decide il driver — better-sqlite3 per la webapp Next, node:sqlite per il
 * servizio HomeGate — e passa la handle. Il singleton per la webapp vive in
 * get-runtime.ts, così il bundle del servizio non trascina better-sqlite3.
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
  db: DatabaseHandle,
  videoDownload?: VideoDownloadService,
): StashRuntime {
  const files = new FileStore(rootDir);
  const items = new ItemsRepository(db);
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
  return { db, items, files, metadata, ingestion, videoDownload: downloads };
}
