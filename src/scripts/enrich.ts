#!/usr/bin/env tsx
import { loadDotEnv } from "@/config/dotenv";
import type { Item } from "@/core/domain/item";
import { isFallbackTitle } from "@/core/ingestion";
import { logger } from "@/core/logger";
import { getRuntime } from "@/core/get-runtime";

/*
 * Flow: arricchimento metadati di MASSA sull'archivio esistente — il pezzo
 * che manca quando l'import è stato fatto senza --meta. Per ogni item con
 * URL e metadati incompleti chiama la solita IngestionService.enrichMetadata
 * (stessa pipeline di bot e web: titolo, descrizione, thumbnail, autore e
 * ora anche auto-tag da titolo/descrizione).
 *
 * Uso: pnpm enrich [--limit N] [--pausa MS]   (oppure --limit=N / --pausa=MS)
 *   --limit N   ferma il giro dopo N item arricchiti (per provare)
 *   --pausa MS  attesa fra un item e l'altro (default 350; gentile con YouTube)
 *
 * Salta gli item già completi (titolo vero + descrizione + autore), quindi
 * è riprendibile: rilanciarlo dopo un'interruzione riprende dove era. Alcuni
 * domini (Instagram, LinkedIn…) non espongono OpenGraph pubblico: quegli
 * item resteranno col titolo di fallback, non è un errore.
 */

const PAGE_SIZE = 100;

function intFlag(name: string, fallback: number): number {
  const argv = process.argv.slice(2);
  const withEquals = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (withEquals) {
    const value = Number(withEquals.split("=")[1]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }
  const index = argv.indexOf(`--${name}`);
  if (index >= 0) {
    const value = Number(argv[index + 1]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }
  return fallback;
}

function needsEnrichment(item: Item): boolean {
  if (!item.url) return false; // i documenti non hanno metadati di rete
  return isFallbackTitle(item) || !item.description || !item.authorName;
}

async function main(): Promise<void> {
  loadDotEnv();
  const limit = intFlag("limit", Number.POSITIVE_INFINITY);
  const pauseMs = intFlag("pausa", 350);
  const runtime = getRuntime();

  let scanned = 0;
  let enriched = 0;
  let unchanged = 0;
  let errors = 0;
  let offset = 0;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  for (;;) {
    const page = runtime.items.list({ limit: PAGE_SIZE, offset });
    for (const item of page.items) {
      scanned += 1;
      if (!needsEnrichment(item)) continue;
      if (enriched >= limit) {
        logger.info(`Raggiunto il limite di ${limit} item arricchiti: fermo qui. Rilancia per continuare.`);
        logSummary(scanned, enriched, unchanged, errors);
        runtime.db.raw.close();
        return;
      }

      try {
        const after = await runtime.ingestion.enrichMetadata(item);
        const arrived: string[] = [];
        if (after.title && after.title !== item.title) arrived.push("titolo");
        if (after.description && !item.description) arrived.push("descrizione");
        if (after.authorName && !item.authorName) arrived.push("autore");
        if (after.thumbnailPath && !item.thumbnailPath) arrived.push("thumbnail");

        if (arrived.length > 0) {
          enriched += 1;
          logger.info(`#${item.id} «${after.title ?? "?"}» ← ${arrived.join(", ")}`);
        } else {
          unchanged += 1;
        }
      } catch (error) {
        errors += 1;
        logger.warn(`#${item.id} fallito: ${String(error)}`);
      }
      await sleep(pauseMs);
    }
    if (page.items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  logSummary(scanned, enriched, unchanged, errors);
  runtime.db.raw.close();
}

function logSummary(scanned: number, enriched: number, unchanged: number, errors: number): void {
  logger.info(
    `Enrich concluso: ${scanned} item analizzati, ${enriched} arricchiti, ${unchanged} senza novità, ${errors} errori.` +
      " Titoli ancora di fallback? Sono domini senza metadati pubblici (o rete assente): riprova più tardi.",
  );
  if (enriched > 0) logger.info("Ora gira «pnpm auto-tag» per assegnare i tag tematici su tutto l'archivio.");
}

main().catch((error) => {
  logger.error("Enrich interrotto:", error);
  process.exit(1);
});
