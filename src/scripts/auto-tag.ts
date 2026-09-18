#!/usr/bin/env tsx
import path from "node:path";
import { keywordTags } from "@/core/classify";
import { loadDotEnv } from "@/config/dotenv";
import { logger } from "@/core/logger";
import { createRuntime } from "@/core/runtime";

/*
 * Flow: backfill dei tag automatici su tutto l'archivio esistente. Le regole
 * keyword (temi tecnici, talk, guide…) vivono in src/core/rules/tag-rules.ts
 * e valgono per titolo + descrizione: qui si ricalcolano per ogni item e si
 * AGGIUNGONO solo i tag mancanti — ciò che esiste o è stato messo a mano non
 * si tocca. Idempotente: rilanciarlo non produce cambiamenti.
 *
 * Uso: pnpm auto-tag
 * Utile dopo aver esteso le regole, o per item arricchiti prima che
 * l'auto-tag esistesse. Titoli di fallback (hostname)? Rilancia prima
 * l'import con --meta o il comando Ricarica metadati nella web UI.
 */

const PAGE_SIZE = 200;

async function main(): Promise<void> {
  loadDotEnv();
  const runtime = createRuntime(process.env.DATA_DIR ?? path.join(process.cwd(), "data"));

  let scanned = 0;
  let tagged = 0;
  const applied = new Map<string, number>();
  let offset = 0;

  for (;;) {
    const page = runtime.items.list({ limit: PAGE_SIZE, offset });
    for (const item of page.items) {
      scanned += 1;
      const text = [item.title, item.description].filter(Boolean).join(" ").trim();
      if (!text) continue;

      const missing = keywordTags(text).filter((tag) => !item.tags.includes(tag));
      if (missing.length === 0) continue;

      runtime.items.replaceTags(item.id, [...item.tags, ...missing]);
      tagged += 1;
      for (const tag of missing) applied.set(tag, (applied.get(tag) ?? 0) + 1);
      logger.info(`Item #${item.id} «${item.title ?? "senza titolo"}» → +${missing.join(", +")}`);
    }
    if (page.items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const summary = [...applied.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tag, n]) => `#${tag}×${n}`)
    .join(" ");
  logger.info(
    `Backfill auto-tag concluso: ${scanned} item analizzati, ${tagged} aggiornati. ${summary || "Nessun nuovo tag."}`,
  );
  runtime.db.raw.close();
}

main().catch((error) => {
  logger.error("Backfill interrotto:", error);
  process.exit(1);
});
