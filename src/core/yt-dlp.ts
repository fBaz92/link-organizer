import { spawn } from "node:child_process";
import type { PageMetadata } from "@/core/metadata";
import { logger } from "@/core/logger";

/*
 * Flow: l'adapter yt-dlp per i METADATI (niente download). yt-dlp --dump-json
 * ritorna il JSON completo del video — descrizione integrale, canale e i tag
 * messi dall'autore — in pochi secondi e senza scaricare nulla.
 *
 * L'interfaccia VideoMetadataSource è la seam: MetadataFetcher la usa come
 * strategia primaria per YouTube e cade sull'oEmbed/og:description se qui si
 * ritorna null (binario assente, rete giù, video privato, timeout). Ogni
 * errore è recuperabile: null, mai un'eccezione.
 */

/** Tetto alla durata dello spawn yt-dlp --dump-json: oltre, si killa. */
const DUMP_TIMEOUT_MS = 30_000;
/** I tag dell'autore sono un segnale, non un vangelo: tetto prudente. */
const MAX_AUTHOR_TAGS = 8;

/**
 * Sorgente di metadati "ricca" per i video. Ritorna null quando la sorgente
 * non può servire l'URL (indisponibile, non un video, errore): il chiamante
 * deve avere una strategia di fallback.
 */
export interface VideoMetadataSource {
  fetch(canonicalUrl: string): Promise<PageMetadata | null>;
}

/** Segnala che il binario non esiste: inutile riprovare. */
class MissingBinaryError extends Error {}

/**
 * Adapter yt-dlp: spawn `--dump-json --no-playlist` e mappa il JSON.
 * La prima ENOENT disabilita la sorgente per sempre (niente spawn falliti
 * a ogni item dell'archivio).
 */
export function createYtDlpMetadataSource(binPath = "yt-dlp", timeoutMs = DUMP_TIMEOUT_MS): VideoMetadataSource {
  let missing = false;
  return {
    async fetch(canonicalUrl) {
      if (missing) return null;
      try {
        const json = await dumpJson(binPath, timeoutMs, canonicalUrl);
        return json ? ytdlpJsonToMetadata(json) : null;
      } catch (error) {
        if (error instanceof MissingBinaryError) {
          missing = true;
          logger.info(`[yt-dlp] "${binPath}" non trovato: metadati via fallback di rete.`);
          return null;
        }
        logger.warn(`[yt-dlp] dump metadati fallito per ${canonicalUrl}: ${String(error)}`);
        return null;
      }
    },
  };
}

/** Spawn del dump JSON: oggetto parsato, oppure null su errore/garbage. */
function dumpJson(binPath: string, timeoutMs: number, canonicalUrl: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, ["--no-playlist", "--no-warnings", "--dump-json", canonicalUrl], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => resolve(null));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() => {
        if (error.code === "ENOENT") reject(new MissingBinaryError(error.message));
        else reject(new Error(String(error)));
      });
    });
    child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        finish(() => resolve(null));
        return;
      }
      finish(() => {
        try {
          // --no-playlist produce un solo oggetto, ma si difende dalle righe vuote.
          const firstLine = stdout.split("\n").find((line) => line.trim() !== "");
          const parsed = firstLine ? (JSON.parse(firstLine) as unknown) : null;
          resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null);
        } catch {
          resolve(null);
        }
      });
    });
  });
}

/** Il JSON di yt-dlp su PageMetadata; i tag dell'autore diventano keyword. */
export function ytdlpJsonToMetadata(data: Record<string, unknown>): PageMetadata {
  const keywords = sanitizeYtDlpKeywords([...asArray(data.tags), ...asArray(data.categories)]);
  return {
    title: asString(data.title),
    description: asString(data.description),
    thumbnailUrl: asString(data.thumbnail),
    siteName: "YouTube",
    authorName: asString(data.uploader) ?? asString(data.channel),
    authorUrl: asString(data.channel_url) ?? asString(data.uploader_url),
    keywords: keywords.length > 0 ? keywords : undefined,
  };
}

/**
 * I tag dell'autore (yt-dlp "tags" + "categories") ripuliti per l'archivio:
 * minuscoli, spazi collassati, dedup, lunghezza sensata (2..40) e tetto.
 */
export function sanitizeYtDlpKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const tag = item.trim().toLowerCase().replace(/\s+/g, " ");
    if (tag.length < 2 || tag.length > 40) continue;
    seen.add(tag);
    if (seen.size >= MAX_AUTHOR_TAGS) break;
  }
  return [...seen];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
