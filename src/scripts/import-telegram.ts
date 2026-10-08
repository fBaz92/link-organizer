#!/usr/bin/env tsx
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { loadDotEnv } from "@/config/dotenv";
import { logger } from "@/core/logger";
import { getRuntime } from "@/core/get-runtime";
import type { StashRuntime } from "@/core/runtime";
import { extractFromEntities, extractUrls } from "@/core/extract-urls";

/*
 * Flow: import dello storico "Saved Messages" da un export di Telegram
 * Desktop (Impostazioni → Avanzate → Esporta dati → export solo chat).
 *
 * Uso: pnpm import:telegram <cartella-export> [--meta]
 *   - legge result.json nella cartella;
 *   - per ogni messaggio estrae i link (entity "link"/"url" del formato
 *     export, con fallback regex) e i file della cartella files/;
 *   - passa TUTTO dalla pipeline condivisa: normalizzazione, dedup, tag.
 *     I duplicati con l'archivio esistente vengono riconosciuti e saltati.
 *   - --meta: arricchisce anche i metadati (titolo/descrizione/thumbnail).
 *     Off di default: anni di link = migliaia di richieste; attivalo quando
 *     vuoi completare l'archivio e tieni d'occhio la rate.
 *
 * I metadati NON fetchati lasciano il titolo di fallback (hostname): la web
 * UI e i comandi restano comunque usabili.
 */

interface ExportTextEntry {
  type?: string;
  text?: string;
}

interface ExportMessage {
  id: number;
  type?: string;
  date?: string;
  text?: string | ExportTextEntry[];
  photo?: string;
  file?: string;
  file_name?: string;
  mime_type?: string;
  media_type?: string;
}

interface ImportSummary {
  messages: number;
  created: number;
  duplicates: number;
  errors: number;
}

const HELP = "Uso: pnpm import:telegram <cartella-export> [--meta]";

async function main(): Promise<void> {
  loadDotEnv();

  const [exportDir, ...flags] = process.argv.slice(2);
  if (!exportDir) {
    logger.error(HELP);
    process.exit(1);
  }
  const withMetadata = flags.includes("--meta");

  const resultPath = path.join(exportDir, "result.json");
  let raw: string;
  try {
    raw = await readFile(resultPath, "utf8");
  } catch {
    logger.error(`result.json non trovato in "${exportDir}". ${HELP}`);
    process.exit(1);
  }

  let messages: ExportMessage[];
  try {
    const parsed = JSON.parse(raw) as { messages?: ExportMessage[] };
    messages = parsed.messages ?? [];
  } catch {
    logger.error("result.json non è un JSON valido.");
    process.exit(1);
  }

  const runtime = getRuntime();
  const summary: ImportSummary = { messages: 0, created: 0, duplicates: 0, errors: 0 };
  const dateOf = (message: ExportMessage): Date | undefined =>
    message.date ? new Date(message.date) : undefined;

  for (const message of messages) {
    if (message.type !== "message") continue;
    summary.messages += 1;

    const urls = collectUrls(message);
    for (const url of urls) {
      await ingest(summary, () =>
        runtime.ingestion.ingest({ payload: { kind: "url", url }, source: "import", createdAt: dateOf(message) }),
      );
      if (withMetadata) await enrichNewest(runtime.ingestion, runtime.items);
    }

    const filePath = message.file;
    if (filePath && message.media_type === "file") {
      const absolute = path.join(exportDir, filePath);
      if (await exists(absolute)) {
        await ingest(summary, () =>
          runtime.ingestion.ingest({
            payload: { kind: "file", path: absolute, name: message.file_name ?? path.basename(filePath), mimeType: message.mime_type },
            source: "import",
            createdAt: dateOf(message),
          }),
        );
      }
    }

    if (summary.messages % 100 === 0) {
      logger.info(`Elaborati ${summary.messages} messaggi… (creati ${summary.created}, duplicati ${summary.duplicates})`);
    }
  }

  logger.info(
    `Import concluso: ${summary.messages} messaggi → ${summary.created} nuovi, ${summary.duplicates} duplicati, ${summary.errors} errori.` +
      (withMetadata ? "" : " Titoli di fallback? Rilancia con --meta per arricchire i metadati."),
  );
  runtime.db.raw.close();
}

/** URL dal testo (entity "link" del formato export + regex di dominio). */
function collectUrls(message: ExportMessage): string[] {
  if (typeof message.text === "string") return extractUrls(message.text);
  if (!Array.isArray(message.text)) return [];

  const linked: string[] = [];
  let plain = "";
  for (const entry of message.text) {
    if (typeof entry === "string") {
      plain += entry;
    } else {
      if (entry.type === "link" && entry.text) linked.push(entry.text);
      plain += entry.text ?? "";
    }
  }
  return [...linked, ...extractFromEntities(plain, entitiesOf(message.text)), ...extractUrls(plain)];
}

function entitiesOf(entries: ExportTextEntry[]): { type: string; url?: string; offset: number; length: number }[] {
  const entities: { type: string; url?: string; offset: number; length: number }[] = [];
  let offset = 0;
  for (const entry of entries) {
    const text = typeof entry === "string" ? entry : (entry.text ?? "");
    if (typeof entry !== "string" && entry.type === "link" && text) {
      entities.push({ type: "url", offset, length: text.length });
    }
    offset += text.length;
  }
  return entities;
}

async function ingest(summary: ImportSummary, run: () => Promise<{ status: string }>): Promise<void> {
  try {
    const result = await run();
    if (result.status === "created") summary.created += 1;
    else summary.duplicates += 1;
  } catch (error) {
    summary.errors += 1;
    logger.warn(`Ingrest fallito: ${String(error)}`);
  }
}

/** Arricchisce l'item più recente ancora privo di descrizione (per --meta). */
async function enrichNewest(
  ingestion: StashRuntime["ingestion"],
  items: StashRuntime["items"],
): Promise<void> {
  const [newest] = items.list({ limit: 1, offset: 0 }).items;
  if (newest && !newest.description) {
    await ingestion.enrichMetadata(newest);
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  logger.error("Import interrotto:", error);
  process.exit(1);
});
