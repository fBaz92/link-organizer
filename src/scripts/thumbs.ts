#!/usr/bin/env tsx
import { loadDotEnv } from "@/config/dotenv";
import { getRuntime } from "@/core/get-runtime";
import { logger } from "@/core/logger";
import { backfillThumbnails } from "@/core/thumbnail-backfill";

/*
 * Flow: backfill delle thumbnail da CLI (sviluppo locale o manutenzione
 * manuale): recupera le immagini mancanti con le stesse regole del servizio
 * (YouTube diretto, resto via metadati). Idempotente: si può rilanciare.
 *
 *   pnpm thumbs                    # tutto quello che manca (tetto 5000)
 *   pnpm thumbs --limit 100        # solo i 100 più recenti
 *   pnpm thumbs --pausa 100        # più veloce, se i server reggono
 */

function intFlag(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number.parseInt(process.argv[index + 1] ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function main(): Promise<void> {
  loadDotEnv();
  const runtime = getRuntime();

  logger.info("Backfill delle thumbnail: cerco gli item senza immagine…");
  const summary = await backfillThumbnails(runtime, {
    limit: intFlag("limit", 5000),
    pauseMs: intFlag("pausa", 350),
    onItem: (result) => {
      if (!result.ok) {
        logger.warn(`Item #${result.itemId}: non recuperata (${result.error ?? "sconosciuto"})`);
      }
    },
  });

  if (summary.scanned === 0) {
    logger.info("Nessun item senza thumbnail: tutto già in ordine.");
  } else {
    logger.info(`Fatto: ${summary.fetched} scaricate, ${summary.failed} non recuperate su ${summary.scanned}.`);
  }
  process.exit(0);
}

void main();
