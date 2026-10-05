import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createSemanticTagger } from "@/core/semantic-tags";

/*
 * Flow: test del tagger semantico senza ONNX. La seam di embedding è finta:
 * ogni stringa nota mappa su un vettore a scelta del test, così similarità,
 * soglia, tetto, cache e degradazione sono deterministici. I vettori NON
 * sono normalizzati di proposito: la normalizzazione è compito del tagger.
 */

/** Passaggio: cos → typescript 0.6, css 0.8, rust 1.0 (vedi vettori sotto). */
const TEXT = "un video sui linguaggi di programmazione";
const VECTORS: Record<string, number[]> = {
  typescript: [2, 0, 0],
  css: [0, 5, 0],
  rust: [3, 4, 0],
  [TEXT]: [3, 4, 0],
};

interface FakeEmbed {
  api: { queries: (texts: string[]) => Promise<number[][]>; passage: (text: string) => Promise<number[]> };
  queryCalls: string[][];
  passageCalls: string[];
}

function fakeEmbed(vectors: Record<string, number[]> = VECTORS, fail = false): FakeEmbed {
  const queryCalls: string[][] = [];
  const passageCalls: string[] = [];
  return {
    api: {
      queries: async (texts) => {
        queryCalls.push(texts);
        if (fail) throw new Error("modello non disponibile");
        return texts.map((t) => vectors[t] ?? [0, 0, 0]);
      },
      passage: async (text) => {
        passageCalls.push(text);
        if (fail) throw new Error("modello non disponibile");
        return vectors[text] ?? [0, 0, 0];
      },
    },
    queryCalls,
    passageCalls,
  };
}

describe("createSemanticTagger", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "stash-sem-"));
  });

  it("ordina i tag del vocabolario per similarità coseno, sopra soglia", async () => {
    const embed = fakeEmbed();
    const tagger = createSemanticTagger({ embed: embed.api, threshold: 0.7 });

    const tags = await tagger.suggestTags(TEXT, ["typescript", "css", "rust"]);
    expect(tags).toEqual(["rust", "css"]); // 1.0 e 0.8; typescript (0.6) è sotto soglia
  });

  it("rispetta il tetto topK sui tag suggeriti", async () => {
    const embed = fakeEmbed();
    const tagger = createSemanticTagger({ embed: embed.api, threshold: 0.5, topK: 1 });
    expect(await tagger.suggestTags(TEXT, ["typescript", "css", "rust"])).toEqual(["rust"]);
  });

  it("la soglia di default è calibrata su e5: le similarità basse non passano", async () => {
    const embed = fakeEmbed();
    const tagger = createSemanticTagger({ embed: embed.api }); // default: 0.83
    // rust cos 1.0 passa; css 0.8 e typescript 0.6 no (banda rumorosa di e5).
    expect(await tagger.suggestTags(TEXT, ["typescript", "css", "rust"])).toEqual(["rust"]);
  });

  it("vocabolario normalizzato: minuscolo, dedup, vuoti scartati", async () => {
    const embed = fakeEmbed();
    const tagger = createSemanticTagger({ embed: embed.api, threshold: 0.5, topK: 5 });

    const tags = await tagger.suggestTags(TEXT, ["Typescript ", "typescript", "", "  "]);
    expect(tags).toEqual(["typescript"]); // cos 0.6 ≥ soglia 0.5
    expect(embed.queryCalls[0]).toEqual(["typescript"]); // una sola query, già normalizzata
  });

  it("testo vuoto o vocabolario vuoto: nessun tag, nessuna inferenza", async () => {
    const embed = fakeEmbed();
    const tagger = createSemanticTagger({ embed: embed.api });

    expect(await tagger.suggestTags("", ["typescript"])).toEqual([]);
    expect(await tagger.suggestTags(TEXT, [])).toEqual([]);
    expect(await tagger.suggestTags("   ", ["typescript"])).toEqual([]);
    expect(embed.queryCalls).toHaveLength(0);
    expect(embed.passageCalls).toHaveLength(0);
  });

  it("embedding del vocabolario in cache fra chiamate: solo i tag nuovi passano dal modello", async () => {
    const embed = fakeEmbed();
    const tagger = createSemanticTagger({ embed: embed.api, threshold: 0.5 });

    await tagger.suggestTags(TEXT, ["typescript", "css"]);
    await tagger.suggestTags(TEXT, ["typescript", "css", "rust"]);

    expect(embed.queryCalls).toEqual([["typescript", "css"], ["rust"]]);
    expect(embed.passageCalls).toHaveLength(2); // il testo si incorpora ogni volta
  });

  it("guasto del modello: [], e non si riprova (warn una volta sola)", async () => {
    const embed = fakeEmbed(VECTORS, true);
    const tagger = createSemanticTagger({ embed: embed.api });

    expect(await tagger.suggestTags(TEXT, ["typescript", "css"])).toEqual([]);
    expect(await tagger.suggestTags(TEXT, ["typescript", "css"])).toEqual([]);
    expect(embed.queryCalls).toHaveLength(1);
    expect(embed.passageCalls).toHaveLength(0);
  });

  it("la cache persiste su file e una nuova istanza non re-incorpora i tag noti", async () => {
    const cachePath = path.join(dir, "cache-semantica.json");
    const first = fakeEmbed();
    await createSemanticTagger({ embed: first.api, cachePath, threshold: 0.5 }).suggestTags(TEXT, [
      "typescript",
      "css",
    ]);
    expect(first.queryCalls).toHaveLength(1);

    const second = fakeEmbed();
    const tags = await createSemanticTagger({ embed: second.api, cachePath, threshold: 0.5 }).suggestTags(TEXT, [
      "typescript",
      "css",
      "rust",
    ]);
    expect(tags).toEqual(["rust", "css", "typescript"]);
    expect(second.queryCalls).toEqual([["rust"]]); // i primi due arrivano dal file

    const onDisk = JSON.parse(await readFile(cachePath, "utf8")) as { embeddings: Record<string, number[]> };
    // "rust" è arrivato dopo e la cache lo assorbe: sul file ci sono tutti.
    expect(Object.keys(onDisk.embeddings).sort()).toEqual(["css", "rust", "typescript"]);
  });

  it("cache di un modello diverso: si riparte da zero", async () => {
    const cachePath = path.join(dir, "cache-modello-diverso.json");
    await writeFile(
      cachePath,
      JSON.stringify({ version: 1, model: "altro/modello", embeddings: { css: [0, 1, 0] } }),
      "utf8",
    );

    const embed = fakeEmbed();
    const tagger = createSemanticTagger({ embed: embed.api, cachePath, modelId: "x/y", threshold: 0.5 });
    await tagger.suggestTags(TEXT, ["css"]);
    expect(embed.queryCalls).toEqual([["css"]]); // l'embedding nel file non è fidato
  });
});
