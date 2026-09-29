import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Item, ItemSource, SourceRef } from "@/core/domain/item";
import type { FileStore } from "@/core/files";
import type { IngestionService } from "@/core/ingestion";
import { logger } from "@/core/logger";
import { assertSafeRemoteUrl } from "@/core/security/url-guard";
import { normalizeUrl, youtubeVideoId } from "@/core/url";
import type { ItemsRepository } from "@/db/repositories/items";

/*
 * Flow: il servizio di download video (per ora solo YouTube), condiviso da
 * bot e web. Ogni richiesta diventa un JOB asincrono: chi lo avvia riceve
 * subito l'id e mostra l'avanzamento (polling della snapshot), mentre il
 * lavoro vero procede in background.
 *
 * start() → 1. risolve l'item: per URL passa dalla pipeline di ingestione
 *              (dedup + classificazione + arricchimento best-effort, così
 *              filename e caption hanno titolo e canale veri); per itemId
 *              carica l'item dell'archivio;
 *           2. se il file è già nello store lo riusa (niente doppioni);
 *           3. altrimenti scarica in una cartella temporanea con yt-dlp
 *              (720p max, --max-filesize: Telegram accetta al più 50MB);
 *           4. assorbe il file nel FileStore (hash sha256) e lo aggancia
 *              all'item (filePath/fileName/fileHash);
 *           5. carica il video nella chat Telegram via Bot API (sendVideo).
 *
 * downloader e uploader sono iniettabili: i test simulano yt-dlp e
 * l'API di Telegram senza rete. Ogni URL che esce dal servizio è costruito
 * qui (canonical youtu.be / api.telegram.org, valido contro la SSRF guard).
 */

/** Limite Bot API per l'invio dei bot: 50 MB, con margine. */
export const MAX_TELEGRAM_VIDEO_BYTES = 49 * 1024 * 1024;
/** Dimensione bersaglio di ogni parte quando serve spezzettare (margine GOP). */
const PART_TARGET_BYTES = 40 * 1024 * 1024;
/** Tetto difensivo al video intero (allineato al FileStore). */
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
/** Tetto alla durata dello spawn yt-dlp: oltre, si killa. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
/** I job terminati restano consultabili, ma non all'infinito. */
const MAX_TRACKED_JOBS = 100;

export type VideoJobPhase = "downloading" | "saving" | "splitting" | "uploading" | "done" | "error";

export interface VideoJobSnapshot {
  id: string;
  itemId: number | null;
  url: string;
  title: string | null;
  phase: VideoJobPhase;
  /** Percentuale download 0..100 (le altre fasi non sono percentuali). */
  progress: number;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface VideoDownloadInput {
  /** URL YouTube da archiviare e scaricare (mutuamente esclusivo con itemId). */
  url?: string;
  /** Item dell'archivio da scaricare. */
  itemId?: number;
  /** Chat Telegram che riceverà il video. */
  chatId: string;
  source: ItemSource;
  sourceRef?: SourceRef;
}

export type StartJobResult =
  | { ok: true; job: VideoJobSnapshot }
  | { ok: false; error: string };

export type VideoDownloader = (
  canonicalUrl: string,
  destDir: string,
  onProgress: (percent: number) => void,
) => Promise<string>;

export interface VideoUploadInput {
  chatId: string;
  filePath: string;
  fileName: string;
  caption: string;
  /** Presente solo quando il video arriva spezzettato in più parti. */
  part?: { index: number; total: number };
}

export type VideoUploader = (input: VideoUploadInput) => Promise<void>;

/**
 * Spezza un video in parti giuste per Telegram (senza ricodifica: segment
 * muxer ffmpeg sui keyframe). Ritorna i path assoluti delle parti, in ordine.
 */
export type VideoSplitter = (filePath: string, targetPartBytes: number, destDir: string) => Promise<string[]>;

export class VideoDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoDownloadError";
  }
}

interface VideoJob {
  id: string;
  url: string;
  videoId: string;
  chatId: string;
  itemId: number | null;
  source: ItemSource;
  sourceRef?: SourceRef;
  phase: VideoJobPhase;
  progress: number;
  error: string | null;
  title: string | null;
  startedAt: number;
  finishedAt: number | null;
  snapshot(): VideoJobSnapshot;
}

export interface VideoDownloadOptions {
  ytDlpPath?: string;
  botToken?: string;
  /** Iniettabili per i test (default: spawn yt-dlp/ffmpeg e Bot API via fetch). */
  downloader?: VideoDownloader;
  uploader?: VideoUploader;
  splitter?: VideoSplitter;
  fetchImpl?: typeof fetch;
  maxUploadBytes?: number;
  downloadTimeoutMs?: number;
}

export class VideoDownloadService {
  private readonly jobs = new Map<string, VideoJob>();
  private readonly downloader: VideoDownloader;
  private readonly uploader: VideoUploader;
  private readonly splitter: VideoSplitter;
  private readonly maxUploadBytes: number;

  constructor(
    private readonly items: ItemsRepository,
    private readonly files: FileStore,
    private readonly ingestion: IngestionService,
    private readonly options: VideoDownloadOptions = {},
  ) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const ytDlpPath = options.ytDlpPath ?? "yt-dlp";
    this.downloader = options.downloader ?? createYtDlpDownloader(ytDlpPath, options.downloadTimeoutMs);
    this.uploader = options.uploader ?? createBotApiUploader(options.botToken, fetchImpl);
    this.splitter = options.splitter ?? createFfmpegSplitter();
    this.maxUploadBytes = options.maxUploadBytes ?? MAX_TELEGRAM_VIDEO_BYTES;
  }

  /** Valida l'input, crea il job e parte in background; risposta immediata. */
  start(input: VideoDownloadInput): StartJobResult {
    if (!input.chatId) return { ok: false, error: "Chat Telegram di destinazione mancante." };

    let videoId: string | null = null;
    if (input.itemId !== undefined) {
      if (!Number.isInteger(input.itemId)) return { ok: false, error: "Item non valido." };
      const item = this.items.getById(input.itemId);
      if (!item) return { ok: false, error: "Item non trovato." };
      videoId = extractCanonicalVideoId(item.canonicalUrl ?? item.url);
      if (!videoId) return { ok: false, error: "L'item non è un video YouTube: il download è supportato solo per YouTube." };
    } else if (input.url) {
      videoId = extractCanonicalVideoId(input.url);
      if (!videoId) return { ok: false, error: "Non è un link YouTube valido." };
    } else {
      return { ok: false, error: "Serve un URL o un itemId." };
    }

    const job: VideoJob = {
      id: randomBytes(6).toString("hex"),
      url: `https://youtu.be/${videoId}`,
      videoId,
      chatId: input.chatId,
      itemId: input.itemId ?? null,
      source: input.source,
      sourceRef: input.sourceRef,
      phase: "downloading",
      progress: 0,
      error: null,
      title: null,
      startedAt: Date.now(),
      finishedAt: null,
      snapshot() {
        return {
          id: this.id,
          itemId: this.itemId,
          url: this.url,
          title: this.title,
          phase: this.phase,
          progress: this.progress,
          error: this.error,
          startedAt: this.startedAt,
          finishedAt: this.finishedAt,
        };
      },
    };

    this.track(job);
    void this.run(job, input).catch((error) => {
      // run() non dovrebbe mai rigettare: rete di sicurezza sul logging.
      logger.error(`[video-download] errore inatteso nel job ${job.id}:`, error);
    });
    return { ok: true, job: job.snapshot() };
  }

  get(jobId: string): VideoJobSnapshot | undefined {
    return this.jobs.get(jobId)?.snapshot();
  }

  // ── Pipeline del job ────────────────────────────────────────────────────

  private async run(job: VideoJob, input: VideoDownloadInput): Promise<void> {
    let tempDir: string | undefined;
    let splitDir: string | undefined;
    try {
      // 1. Risoluzione item (per URL: pipeline completa con arricchimento).
      let item = await this.resolveItem(job, input);
      job.title = item.title ?? null;

      // 2. File già nello store? Si salta il download.
      let uploadPath: string | undefined;
      let uploadName = item.fileName ?? `${job.videoId}.mp4`;
      if (item.filePath) {
        const absolute = this.files.absolutePath(item.filePath);
        try {
          await stat(absolute);
          uploadPath = absolute;
        } catch {
          logger.info(`[video-download] file mancante per item #${item.id}: si riscarica.`);
        }
      }

      // 3-4. Download + assorbimento nello store.
      if (!uploadPath) {
        tempDir = await mkdtemp(path.join(tmpdir(), "stash-video-"));
        job.phase = "downloading";
        const downloaded = await this.downloader(job.url, tempDir, (percent) => {
          job.progress = Math.max(job.progress, Math.min(100, Math.round(percent)));
        });

        const size = (await stat(downloaded)).size;
        if (size > MAX_VIDEO_BYTES) {
          throw new VideoDownloadError(
            `Video troppo grande (${(size / 1024 / 1024 / 1024).toFixed(1)} GB, limite 2 GB).`,
          );
        }

        job.phase = "saving";
        job.progress = 100;
        const extension = path.extname(downloaded) || ".mp4";
        const stored = await this.files.absorbFile(downloaded, `${safeFileTitle(item.title, job.videoId)}${extension}`);
        // File identico già agganciato a un ALTRO item (es. doppione di fatto):
        // si condivide il file dello store senza violare l'UNIQUE su file_hash.
        const holder = this.items.findByFileHash(stored.hash);
        const shared = holder && holder.id !== item.id && holder.filePath ? holder : undefined;
        this.items.update(item.id, {
          filePath: shared?.filePath ?? stored.relativePath,
          fileName: stored.fileName,
          ...(shared ? {} : { fileHash: stored.hash }),
          mimeType: mimeTypeOf(extension),
        });
        item = this.items.getById(item.id) ?? item;
        uploadPath = this.files.absolutePath(shared?.filePath ?? stored.relativePath);
        uploadName = stored.fileName;
      }

      // 5. Invio in chat: oltre il limite Bot API (~50 MB) il video viene
      //    spezzettato in parti con ffmpeg e inviato in sequenza.
      const uploadSize = (await stat(uploadPath)).size;
      const parts: { path: string; index: number; total: number }[] = [];
      if (uploadSize > this.maxUploadBytes) {
        job.phase = "splitting";
        splitDir = await mkdtemp(path.join(tmpdir(), "stash-split-"));
        const files = await this.splitter(uploadPath, PART_TARGET_BYTES, splitDir);
        for (const partPath of files) {
          const partSize = (await stat(partPath)).size;
          if (partSize > this.maxUploadBytes) {
            throw new VideoDownloadError(
              `Una parte supera comunque i 50 MB (${Math.round(partSize / 1024 / 1024)} MB): video con keyframe troppo radi.`,
            );
          }
        }
        files.forEach((partPath, index) => parts.push({ path: partPath, index: index + 1, total: files.length }));
      } else {
        parts.push({ path: uploadPath, index: 1, total: 1 });
      }

      job.phase = "uploading";
      for (const part of parts) {
        const multipart = part.total > 1;
        await this.uploader({
          chatId: job.chatId,
          filePath: part.path,
          fileName: multipart ? partFileName(uploadName, part.index, part.total) : uploadName,
          caption: buildCaption(item, job.videoId, multipart ? { index: part.index, total: part.total } : undefined),
          part: multipart ? { index: part.index, total: part.total } : undefined,
        });
      }

      job.phase = "done";
      job.finishedAt = Date.now();
      logger.info(
        `[video-download] job ${job.id} completato: item #${item.id} → chat ${job.chatId}` +
          (parts.length > 1 ? ` (${parts.length} parti)` : ""),
      );
    } catch (error) {
      job.phase = "error";
      job.error = errorMessage(error);
      job.finishedAt = Date.now();
      logger.error(`[video-download] job ${job.id} fallito:`, error);
      await this.notifyError(job);
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      if (splitDir) await rm(splitDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async resolveItem(job: VideoJob, input: VideoDownloadInput): Promise<Item> {
    if (input.itemId !== undefined) {
      const item = this.items.getById(input.itemId);
      if (!item) throw new VideoDownloadError("Item non trovato.");
      job.itemId = item.id;
      job.title = item.title ?? null;
      return item;
    }

    const result = await this.ingestion.ingest({
      payload: { kind: "url", url: input.url ?? job.url },
      source: input.source,
      sourceRef: input.sourceRef,
    });
    const item = result.status === "created" ? result.item : result.existing;
    job.itemId = item.id;
    // Arricchimento best-effort: titolo e canale servono a filename e caption.
    // Offline o lento non è un problema: si prosegue col titolo di fallback.
    try {
      return await this.ingestion.enrichMetadata(item);
    } catch {
      return item;
    }
  }

  /** Segnala l'errore in chat (se il token c'è): il job era in background. */
  private async notifyError(job: VideoJob): Promise<void> {
    if (!this.options.botToken) return;
    try {
      await sendBotApiMessage(this.options.botToken, this.options.fetchImpl ?? fetch, job.chatId, {
        text: `⚠️ Download di ${job.url} fallito:\n${job.error ?? "errore sconosciuto"}`,
      });
    } catch (error) {
      logger.warn(`[video-download] notifica errore fallita per il job ${job.id}:`, error);
    }
  }

  private track(job: VideoJob): void {
    this.jobs.set(job.id, job);
    if (this.jobs.size <= MAX_TRACKED_JOBS) return;
    // Passa il tetto: elimina i job terminati più vecchi.
    const finished = [...this.jobs.values()]
      .filter((j) => j.phase === "done" || j.phase === "error")
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const j of finished.slice(0, this.jobs.size - MAX_TRACKED_JOBS)) this.jobs.delete(j.id);
  }
}

// ── Downloader yt-dlp (default) ──────────────────────────────────────────

/** True se ffmpeg è raggiungibile (serve a yt-dlp per unire video+audio). */
let ffmpegProbe: Promise<boolean> | undefined;

function hasFfmpeg(): Promise<boolean> {
  ffmpegProbe ??= new Promise((resolve) => {
    const child = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
  return ffmpegProbe;
}

export function createYtDlpDownloader(binPath: string, timeoutMs = DOWNLOAD_TIMEOUT_MS): VideoDownloader {
  return (canonicalUrl, destDir, onProgress) =>
    new Promise<string>((resolve, reject) => {
      void (async () => {
        const merge = await hasFfmpeg();
        // Nessun tetto dimensionale qui: i video grandi sono legittimi, la
        // dimensione si governa a valle (spezzettamento all'invio).
        const format = merge
          ? "bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/b"
          : "b[height<=720][ext=mp4]/b[height<=720]/b";
        const args = [
          "--no-playlist",
          "--newline",
          "--no-warnings",
          "--retries",
          "3",
          "-f",
          format,
          "-o",
          path.join(destDir, "%(id)s.%(ext)s"),
          canonicalUrl,
        ];
        if (merge) args.push("--merge-output-format", "mp4");

        const child = spawn(binPath, args, { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let remainder = "";
        let settled = false;

        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };

        const consume = (chunk: string): void => {
          output += chunk;
          remainder += chunk;
          const lines = remainder.split("\n");
          remainder = lines.pop() ?? "";
          for (const line of lines) {
            const match = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
            if (match) onProgress(Number.parseFloat(match[1]!));
          }
        };

        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(() => reject(new VideoDownloadError("Download interrotto: tempo scaduto.")));
        }, timeoutMs);

        child.stdout.on("data", (chunk: Buffer) => consume(chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => consume(chunk.toString()));
        child.on("error", (error: NodeJS.ErrnoException) => {
          finish(() =>
            reject(
              error.code === "ENOENT"
                ? new VideoDownloadError(
                    `"${binPath}" non trovato: installa yt-dlp (es. brew install yt-dlp) o imposta YTDLP_PATH.`,
                  )
                : error,
            ),
          );
        });
        child.on("close", async (code) => {
          if (code !== 0 && code !== null) {
            finish(() => reject(new VideoDownloadError(ytDlpFailure(output))));
            return;
          }
          try {
            const file = await pickDownloadedFile(destDir);
            finish(() => resolve(file));
          } catch (error) {
            finish(() => reject(error instanceof Error ? error : new Error(String(error))));
          }
        });
      })().catch((error) => reject(error instanceof Error ? error : new Error(String(error))));
    });
}

/** Messaggio d'errore leggibile dallo stdout/stderr di yt-dlp. */
function ytDlpFailure(output: string): string {
  if (/Private video|members-only|Sign in/i.test(output)) {
    return "Video privato o riservato ai membri: non scaricabile.";
  }
  if (/Video unavailable/i.test(output)) {
    return "Video non più disponibile.";
  }
  const tail = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" · ");
  return `yt-dlp è fallito${tail ? `: ${tail.slice(0, 300)}` : "."}`;
}

/** Il file prodotto da yt-dlp: l'ultimo arrivato nella cartella temporanea. */
async function pickDownloadedFile(destDir: string): Promise<string> {
  const entries = await readdir(destDir);
  const candidates = entries.filter((name) => !name.endsWith(".part") && !name.endsWith(".ytdl"));
  if (candidates.length === 0) throw new VideoDownloadError("Nessun file scaricato (video troppo grande o formato indisponibile).");

  let best: { name: string; size: number } | undefined;
  for (const name of candidates) {
    const info = await stat(path.join(destDir, name));
    if (!best || info.size > best.size) best = { name, size: info.size };
  }
  return path.join(destDir, best!.name);
}

// ── Splitter ffmpeg (default) ────────────────────────────────────────────

/**
 * Spezza in parti ≤ targetPartBytes con il segment muxer (-c copy: split
 * sui keyframe, niente ricodifica, secondi anche su video lunghi). La
 * granularità dei keyframe può far sforare una parte oltre il bersaglio:
 * per questo il bersaglio (40 MB) sta sotto il limite Bot API (49 MB).
 */
export function createFfmpegSplitter(ffmpegPath = "ffmpeg", ffprobePath = "ffprobe"): VideoSplitter {
  return async (filePath, targetPartBytes, destDir) => {
    const size = (await stat(filePath)).size;
    const durationSeconds = await probeDurationSeconds(ffprobePath, filePath);
    if (durationSeconds <= 0) throw new VideoDownloadError("Impossibile leggere la durata del video per spezzettarlo.");

    const bytesPerSecond = size / durationSeconds;
    const segmentSeconds = Math.max(1, Math.floor(targetPartBytes / bytesPerSecond));

    await runProcess(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      filePath,
      "-c",
      "copy",
      "-f",
      "segment",
      "-segment_time",
      String(segmentSeconds),
      "-reset_timestamps",
      "1",
      path.join(destDir, "part%04d.mp4"),
    ]);

    const parts = (await readdir(destDir))
      .filter((name) => name.endsWith(".mp4"))
      .sort()
      .map((name) => path.join(destDir, name));
    if (parts.length === 0) {
      throw new VideoDownloadError("Suddivisione fallita: ffmpeg non ha prodotto parti (serve ffmpeg installato).");
    }
    return parts;
  };
}

/** Durata in secondi via ffprobe (fa parte dell'installazione ffmpeg). */
async function probeDurationSeconds(ffprobePath: string, filePath: string): Promise<number> {
  const { stdout } = await runProcess(ffprobePath, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const duration = Number.parseFloat(stdout.trim());
  return Number.isFinite(duration) ? duration : 0;
}

/** Spawn senza shell con cattura dell'output; rigetta con l'ultima riga utile. */
function runProcess(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT" ? new VideoDownloadError(`"${bin}" non trovato: serve ffmpeg installato.`) : error);
    });
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = [stderr, stdout].join("\n").split("\n").filter(Boolean).slice(-2).join(" · ");
        reject(new VideoDownloadError(`${bin} è fallito${tail ? `: ${tail.slice(0, 300)}` : "."}`));
      }
    });
  });
}

// ── Uploader Bot API (default) ───────────────────────────────────────────

export function createBotApiUploader(botToken: string | undefined, fetchImpl: typeof fetch): VideoUploader {
  return async ({ chatId, filePath, fileName, caption }) => {
    if (!botToken) throw new VideoDownloadError("BOT_TOKEN mancante: impossibile inviare il video su Telegram.");

    const bytes = await readFile(filePath);
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set("caption", caption.slice(0, 1000));
    form.set("parse_mode", "HTML");
    form.set("supports_streaming", "true");
    form.set("video", new Blob([bytes], { type: "video/mp4" }), fileName);

    const endpoint = `https://api.telegram.org/bot${botToken}/sendVideo`;
    await assertSafeRemoteUrl(endpoint);
    const response = await fetchImpl(endpoint, { method: "POST", body: form });
    const data = (await response.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (!response.ok || !data?.ok) {
      throw new VideoDownloadError(`Invio su Telegram fallito: ${data?.description ?? `HTTP ${response.status}`}`);
    }
  };
}

async function sendBotApiMessage(
  botToken: string,
  fetchImpl: typeof fetch,
  chatId: string,
  message: { text: string },
): Promise<void> {
  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await assertSafeRemoteUrl(endpoint);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message.text }),
  });
  const data = (await response.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  if (!response.ok || !data?.ok) {
    throw new Error(`sendMessage fallito: ${data?.description ?? `HTTP ${response.status}`}`);
  }
}

// ── Helper ────────────────────────────────────────────────────────────────

/** ID video YouTube da qualunque forma, via normalizzazione canonica. */
function extractCanonicalVideoId(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  const canonical = normalizeUrl(rawUrl);
  if (!canonical) return null;
  try {
    return youtubeVideoId(new URL(canonical));
  } catch {
    return null;
  }
}

function safeFileTitle(title: string | undefined, videoId: string): string {
  const cleaned = (title ?? "")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N} _.-]+/gu, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 60);
  return cleaned || videoId;
}

function mimeTypeOf(extension: string): string {
  if (extension === ".webm") return "video/webm";
  if (extension === ".mkv") return "video/x-matroska";
  return "video/mp4";
}

function buildCaption(item: Item, videoId: string, part?: { index: number; total: number }): string {
  const lines = [
    `🎬 <b>${escapeHtml(clip(item.title ?? `Video YouTube ${videoId}`, 200))}</b>`,
    item.authorName ? `📺 ${escapeHtml(clip(item.authorName, 100))}` : undefined,
    `🔗 https://youtu.be/${videoId}`,
    part ? `✂️ parte ${part.index}/${part.total}` : undefined,
    `📦 Stash #${item.id}`,
  ];
  return lines.filter(Boolean).join("\n");
}

/** titolo.mp4 → titolo.parte2di3.mp4 (le parti viaggiano con un nome proprio). */
function partFileName(fileName: string, index: number, total: number): string {
  const extension = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length);
  return `${stem}.parte${index}di${total}${extension}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function errorMessage(error: unknown): string {
  const text = error instanceof VideoDownloadError ? error.message : String(error);
  return clip(text, 500);
}
