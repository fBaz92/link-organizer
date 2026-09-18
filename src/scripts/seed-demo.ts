#!/usr/bin/env tsx
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadDotEnv } from "@/config/dotenv";
import { logger } from "@/core/logger";
import { createRuntime } from "@/core/runtime";

/*
 * Flow: seed di dati DEMO per provare l'app senza rete (classificazione e
 * dedup funzionano offline; niente fetch di metadati). `pnpm seed:demo`
 * aggiunge 8 item di esempio all'archivio corrente — NON usarlo se ci sono
 * dati veri che vuoi tenere puliti.
 */

const DEMO_URLS: {
  url: string;
  title?: string;
  description?: string;
  authorName?: string;
  authorUrl?: string;
}[] = [
  {
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Rick Astley - Never Gonna Give You Up",
    authorName: "Rick Astley",
    authorUrl: "https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw",
  },
  {
    url: "https://github.com/vercel/next.js",
    title: "vercel/next.js — The React Framework",
  },
  {
    url: "https://arxiv.org/abs/1706.03762",
    title: "Attention Is All You Need",
  },
  {
    url: "https://www.ilpost.it/2026/09/10/intelligenza-artificiale-energia/",
    title: "Quanta energia consuma l'IA",
  },
  {
    url: "https://x.com/nasa/status/1830000000000000000",
    title: "NASA su X",
    authorName: "NASA",
    authorUrl: "https://x.com/nasa",
  },
  {
    url: "https://open.spotify.com/episode/3aa2QuAJ8jUUmCAiDQOqfu",
    title: "Un episodio di podcast",
  },
  {
    url: "https://blog.sqlite.org/2026/sqlite-4.html",
    title: "SQLite 4: cosa cambia",
  },
  {
    url: "https://esempio-sconosciuto.net/guida-rust",
    title: "Una grande guida a Rust",
  },
  {
    url: "https://www.youtube.com/watch?v=aircAruvnKk",
    title: "But what is a neural network?",
    authorName: "3Blue1Brown",
    authorUrl: "https://www.youtube.com/channel/UCYO_jab_esuFRV4b17AJtAw",
  },
  {
    url: "https://www.youtube.com/watch?v=9bZkp7q19f0",
    title: "Un altro video popolare",
    authorName: "Rick Astley",
    authorUrl: "https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw",
  },
];

async function main(): Promise<void> {
  loadDotEnv();
  logger.warn("Seed DEMO: aggiungo item di esempio all'archivio corrente.");
  const runtime = createRuntime(process.env.DATA_DIR ?? path.join(process.cwd(), "data"));

  for (const demo of DEMO_URLS) {
    const result = await runtime.ingestion.ingest({ payload: { kind: "url", url: demo.url }, source: "web" });
    if (result.status === "created") {
      runtime.items.update(result.item.id, {
        title: demo.title,
        description: demo.description,
        authorName: demo.authorName,
        authorUrl: demo.authorUrl,
      });
    }
  }

  // Un documento con file vero, per provare flag, note e download.
  const tempDir = await mkdtemp(path.join(tmpdir(), "stash-seed-"));
  const pdfPath = path.join(tempDir, "appunti-stash.pdf");
  await writeFile(pdfPath, "%PDF-1.4 Demo document per Stash. Puoi eliminarlo dall'interfaccia.");
  const fileResult = await runtime.ingestion.ingest({
    payload: { kind: "file", path: pdfPath, name: "appunti-stash.pdf", mimeType: "application/pdf" },
    source: "web",
  });

  const { items } = runtime.items.list({ limit: 100, offset: 0 });
  const video = items.find((item) => item.type === "video");
  const rust = items.find((item) => item.title?.includes("Rust"));
  if (video) {
    runtime.items.update(video.id, { starred: true });
    runtime.items.replaceTags(video.id, [...video.tags, "musica"]);
  }
  if (rust) {
    runtime.items.update(rust.id, { notes: "## Da guardare\n- capitolo su **ownership**\n- confronto con Go" });
  }
  if (fileResult.status === "created") {
    runtime.items.update(fileResult.item.id, { seen: true });
  }

  logger.info(`Seed completato: ${runtime.items.stats().total} item in archivio.`);
  runtime.db.raw.close();
}

main().catch((error) => {
  logger.error("Seed fallito:", error);
  process.exit(1);
});
