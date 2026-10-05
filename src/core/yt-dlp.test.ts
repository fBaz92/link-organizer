import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createYtDlpMetadataSource, ytdlpJsonToMetadata } from "@/core/yt-dlp";

/*
 * Flow: test del fetcher metadati via yt-dlp senza rete. Il mapper è puro e
 * si prova direttamente su JSON realistici; l'adapter si prova con un
 * binario finto (script sh eseguibile che stampa JSON, registra gli argomenti
 * o fallisce), così ENOENT, exit code, garbage e timeout sono coperti.
 */

const VIDEO_JSON = {
  id: "dQw4w9WgXcQ",
  title: "Grid-forming converters: intro",
  description: "Una descrizione lunga e completa\ncon più righe.",
  uploader: "Power Systems Channel",
  channel_url: "https://www.youtube.com/channel/UC123",
  thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
  tags: ["grid-forming", "Power Systems", "inverter"],
  categories: ["Science & Technology"],
};

describe("ytdlpJsonToMetadata", () => {
  it("mappa titolo, descrizione completa, canale, thumbnail e keyword", () => {
    const metadata = ytdlpJsonToMetadata(VIDEO_JSON);
    expect(metadata).toEqual({
      title: "Grid-forming converters: intro",
      description: "Una descrizione lunga e completa\ncon più righe.",
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
      siteName: "YouTube",
      authorName: "Power Systems Channel",
      authorUrl: "https://www.youtube.com/channel/UC123",
      keywords: ["grid-forming", "power systems", "inverter", "science & technology"],
    });
  });

  it("tollerante ai campi mancanti o vuoti", () => {
    const metadata = ytdlpJsonToMetadata({ title: "Solo titolo", description: "   " });
    expect(metadata.title).toBe("Solo titolo");
    expect(metadata.description).toBeUndefined();
    expect(metadata.authorName).toBeUndefined();
    expect(metadata.authorUrl).toBeUndefined();
    expect(metadata.keywords).toBeUndefined();
  });

  it("keyword ripulite: minuscole, spazi collassati, dedup, filtro lunghezza, tetto a 8", () => {
    const metadata = ytdlpJsonToMetadata({
      tags: ["  AI  ", "ai", "x", "questo-tag-è-deciduramente-troppo-lungo-per-restare-una-keyword-utile", "a".repeat(41)],
      categories: ["Music"],
    });
    expect(metadata.keywords).toEqual(["ai", "music"]);
  });

  it("tetto alle keyword: al massimo 8, in ordine di arrivo", () => {
    const metadata = ytdlpJsonToMetadata({ tags: ["a1", "b2", "c3", "d4", "e5", "f6", "g7", "h8", "i9", "j10"] });
    expect(metadata.keywords).toEqual(["a1", "b2", "c3", "d4", "e5", "f6", "g7", "h8"]);
  });
});

describe("createYtDlpMetadataSource", () => {
  let dir: string;
  const CANONICAL = "https://youtu.be/dQw4w9WgXcQ";

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "stash-ytdlp-"));
  });

  /**
   * Scrive il binario finto fake-ytdlp nella cartella del test: registra gli
   * argomenti in args.txt e poi esegue `script`. I path sono tutti letterali.
   */
  async function writeFakeBin(script: string): Promise<void> {
    await writeFile(
      path.join(dir, "fake-ytdlp"),
      `#!/bin/sh\necho "$@" > "${path.join(dir, "args.txt")}"\n${script}\n`,
      { mode: 0o755 },
    );
    await chmod(path.join(dir, "fake-ytdlp"), 0o755);
  }

  it("ottiene i metadati passando l'URL canonico a yt-dlp", async () => {
    await writeFakeBin(`cat <<'JSON'\n${JSON.stringify(VIDEO_JSON)}\nJSON`);
    const source = createYtDlpMetadataSource(path.join(dir, "fake-ytdlp"));

    const metadata = await source.fetch(CANONICAL);
    expect(metadata?.description).toBe(VIDEO_JSON.description);
    expect(metadata?.keywords).toContain("grid-forming");

    const args = await readFile(path.join(dir, "args.txt"), "utf8");
    expect(args.trim()).toContain(CANONICAL);
    expect(args).toContain("--dump-json");
  });

  it("binario assente (ENOENT): null, senza lanciare", async () => {
    const source = createYtDlpMetadataSource(path.join(dir, "non-esiste"));
    expect(await source.fetch(CANONICAL)).toBeNull();
  });

  it("exit code non zero: null", async () => {
    await writeFakeBin("echo 'ERROR: private video' >&2; exit 1");
    expect(await createYtDlpMetadataSource(path.join(dir, "fake-ytdlp")).fetch(CANONICAL)).toBeNull();
  });

  it("output non JSON: null", async () => {
    await writeFakeBin("echo 'not json at all'");
    expect(await createYtDlpMetadataSource(path.join(dir, "fake-ytdlp")).fetch(CANONICAL)).toBeNull();
  });

  it("timeout del binario: null", async () => {
    await writeFakeBin("sleep 5");
    const started = Date.now();
    expect(await createYtDlpMetadataSource(path.join(dir, "fake-ytdlp"), 200).fetch(CANONICAL)).toBeNull();
    expect(Date.now() - started).toBeLessThan(4000);
  }, 10_000);
});
