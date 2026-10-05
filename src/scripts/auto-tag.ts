#!/usr/bin/env tsx
import path from "node:path";
import {
  semanticTagsEnabled,
  semanticTagsModel,
  semanticTagsThreshold,
  semanticTagsTopK,
} from "@/config/env";
import { loadDotEnv } from "@/config/dotenv";
import { keywordTags } from "@/core/classify";
import { isFallbackTitle } from "@/core/ingestion";
import { logger } from "@/core/logger";
import { createRuntime } from "@/core/runtime";
import { TAG_RULES } from "@/core/rules/tag-rules";
import { createSemanticTagger, SEMANTIC_CACHE_FILE_NAME } from "@/core/semantic-tags";

/*
 * Flow: backfill dei tag automatici su tutto l'archivio esistente, in due
 * livelli che si SOMMANO (mai sostituiscono) ai tag già presenti:
 *
 * 1. regole keyword (temi tecnici, talk, guide… in tag-rules.ts) su titolo
 *    + descrizione — deterministiche, sempre disponibili;
 * 2. tag semantici (modello di embedding locale, multilingue): la descrizione
 *    viene confrontata col VOCABOLARIO dell'archivio (regole + tag già usati)
 *    e i tag semanticamente vicini vengono suggeriti. Il modello si scarica
 *    da solo al primo uso (~120 MB) e gli embedding dei tag restano in cache
 *    nel data dir: il costo per item è una sola inferenza. Disattivabile con
 *    SEMANTIC_TAGS=0, tarabile con SEMANTIC_TAGS_THRESHOLD/TOP_K/MODEL.
 *
 * Ciò che esiste o è stato messo a mano non si tocca: idempotente,
 * rilanciarlo non produce cambiamenti.
 *
 * Uso: pnpm auto-tag
 * Utile dopo l'import, dopo «pnpm enrich», o quando cresce il vocabolario.
 */

const PAGE_SIZE = 200;

async function main(): Promise<void> {
  loadDotEnv();
  const rootDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  const runtime = createRuntime(rootDir);

  // Vocabolario semantico: i tag delle regole + quelli realmente usati
  // nell'archivio — i suggerimenti restano nella lingua dell'archivio.
  const vocabulary = [
    ...new Set([...TAG_RULES.map((rule) => rule.tag), ...runtime.items.tagsWithCounts().map((t) => t.name)]),
  ];
  const semantic = semanticTagsEnabled()
    ? createSemanticTagger({
        modelId: semanticTagsModel(),
        threshold: semanticTagsThreshold(),
        topK: semanticTagsTopK(),
        cachePath: path.join(rootDir, SEMANTIC_CACHE_FILE_NAME),
      })
    : null;
  if (!semantic) logger.info("Tag semantici disattivati (SEMANTIC_TAGS=0): solo regole keyword.");

  let scanned = 0;
  let tagged = 0;
  let keywordOnly = 0;
  const applied = new Map<string, number>();
  let offset = 0;

  for (;;) {
    const page = runtime.items.list({ limit: PAGE_SIZE, offset });
    for (const item of page.items) {
      scanned += 1;
      const text = [item.title, item.description].filter(Boolean).join(" ").trim();
      if (!text) continue;

      const keywordMissing = keywordTags(text).filter((tag) => !item.tags.includes(tag));
      // Semantico solo su testo vero: un titolo-hostname di fallback non
      // significa nulla e produrrebbe solo riempitivi generici.
      const semanticMissing =
        semantic && !isFallbackTitle(item)
          ? (await semantic.suggestTags(text, vocabulary)).filter(
              (tag) => !item.tags.includes(tag) && !keywordMissing.includes(tag),
            )
          : [];
      const missing = [...keywordMissing, ...semanticMissing];
      if (missing.length === 0) continue;

      runtime.items.replaceTags(item.id, [...item.tags, ...missing]);
      tagged += 1;
      if (semanticMissing.length === 0) keywordOnly += 1;
      for (const tag of missing) applied.set(tag, (applied.get(tag) ?? 0) + 1);
      const sources = [
        keywordMissing.length > 0 ? `+kw:${keywordMissing.join(", +kw:")}` : null,
        semanticMissing.length > 0 ? `+sem:${semanticMissing.join(", +sem:")}` : null,
      ];
      logger.info(`Item #${item.id} «${item.title ?? "senza titolo"}» → ${sources.filter(Boolean).join(" ")}`);
    }
    if (page.items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const summary = [...applied.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tag, n]) => `#${tag}×${n}`)
    .join(" ");
  logger.info(
    `Backfill auto-tag concluso: ${scanned} item analizzati, ${tagged} aggiornati ` +
      `(${tagged - keywordOnly} anche coi tag semantici). ${summary || "Nessun nuovo tag."}`,
  );
  runtime.db.raw.close();
}

main().catch((error) => {
  logger.error("Backfill interrotto:", error);
  process.exit(1);
});
