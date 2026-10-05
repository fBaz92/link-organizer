import { readFile, rename, writeFile } from "node:fs/promises";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { logger } from "@/core/logger";

/*
 * Flow: il tagger semantico. Dietro una interfaccia minima — "dammi un testo
 * e un vocabolario, ti dico quali tag gli appartengono" — vive il modello
 * di embedding locale (transformers.js/ONNX, nessuna API key, nessun server):
 *
 * 1. ogni tag del vocabolario viene incorporato UNA volta e messo in cache
 *    (in memoria + file JSON, chiave = modello): il costo ricorrente è la
 *    sola inferenza sul testo dell'item;
 * 2. il testo (titolo + descrizione) viene incorporato e confrontato con
 *    ogni tag via similarità coseno: sopra soglia, in ordine, al più topK;
 * 3. i tag suggeriti restano nel vocabolario dell'archivio: niente tag
 *    inventati, l'archivio resta coerente;
 * 4. qualunque guasto (modello non installato, rete giù al primo download,
 *    runtime rotto) è recuperabile: suggestTags risolve [] e si disabilita
 *    per sempre — chi chiama degrada alle regole keyword senza accorgersene.
 *
 * embed è la seam interna (usata dai test): senza di essa il modello ONNX
 * si carica pigramente al primo uso, così l'avvio non paga mai il costo.
 */

/** Modello di default: multilingue (IT+EN), quantizzato ~118 MB. */
export const DEFAULT_SEMANTIC_MODEL = "Xenova/multilingual-e5-small";
/**
 * Soglia calibrata sui dati: le similarità e5 vivono compresse in ~0.75-0.89,
 * quindi soglie basse (0.5-0.7) non filtrano nulla e riempiono gli item di
 * tag generici. A 0.83 sopravvivono solo gli accoppiamenti forti.
 */
const DEFAULT_THRESHOLD = 0.83;
const DEFAULT_TOP_K = 5;
const CACHE_VERSION = 1;

export interface SemanticTagger {
  /**
   * Tag del vocabolario semanticamente vicini al testo, ordinati per
   * similarità descrescente. Mai eccezioni: [] quando il tagger non è
   * disponibile o non c'è nulla da suggerire.
   */
  suggestTags(text: string, vocabulary: string[]): Promise<string[]>;
}

/**
 * Seam interna di embedding: incorpora testi brevi (i tag, "query") e un
 * testo lungo (il passaggio da classificare). I vettori NON devono essere
 * normalizzati: ci pensa il ranking.
 */
interface EmbedApi {
  queries(texts: string[]): Promise<number[][]>;
  passage(text: string): Promise<number[]>;
}

/** Quantizzazioni ONNX accettate da transformers.js (subset utile). */
export type SemanticDType = "auto" | "fp32" | "fp16" | "int8" | "uint8" | "q8" | "q4" | "q4f16" | "q2" | "q2f16";

export interface SemanticTaggerOptions {
  /** Modello di embedding sul Hub (default: multilingual-e5-small). */
  modelId?: string;
  /** Quantizzazione ONNX (default "q8": il più leggero). */
  dtype?: SemanticDType;
  /** Similarità coseno minima perché un tag venga suggerito (default 0.83). */
  threshold?: number;
  /** Massimo numero di tag suggeriti per item (default 5). */
  topK?: number;
  /** File JSON dove persistere gli embedding dei tag (default: solo memoria). */
  cachePath?: string;
  /** Iniettabile per i test; default: pipeline ONNX caricata al primo uso. */
  embed?: EmbedApi;
}

interface CacheFile {
  version: number;
  model: string;
  embeddings: Record<string, number[]>;
}

export function createSemanticTagger(options: SemanticTaggerOptions = {}): SemanticTagger {
  const modelId = options.modelId ?? DEFAULT_SEMANTIC_MODEL;
  const dtype = options.dtype ?? "q8";
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const topK = options.topK ?? DEFAULT_TOP_K;

  let unavailable = false;
  let embedApi: EmbedApi | undefined;
  let cache: Map<string, number[]> | undefined;
  // Serializza gli accessi: cache su file e inizializzazione del modello
  // non devono sovrapporsi (lo script lavora già in sequenza, qui si difende).
  let gate: Promise<unknown> = Promise.resolve();

  const tagger: SemanticTagger = {
    async suggestTags(text, vocabulary) {
      if (unavailable) return [];
      const cleanText = text.trim();
      const tags = [...new Set(vocabulary.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
      if (!cleanText || tags.length === 0) return [];

      const run = async (): Promise<string[]> => {
        try {
          return await rank(cleanText, tags);
        } catch (error) {
          unavailable = true;
          logger.warn(`[semantic-tags] tagger disabilitato (da qui solo regole keyword): ${String(error)}`);
          return [];
        }
      };
      const result = (gate = gate.then(run, run)) as Promise<string[]>;
      return result;
    },
  };

  async function rank(text: string, tags: string[]): Promise<string[]> {
    embedApi ??= options.embed ?? (await createOnnxEmbed(modelId, dtype));
    await loadCache();

    const missing = tags.filter((tag) => !cache?.has(tag));
    if (missing.length > 0) {
      const vectors = await embedApi.queries(missing);
      missing.forEach((tag, index) => cache?.set(tag, vectors[index] ?? []));
      await saveCache().catch((error) =>
        logger.warn(`[semantic-tags] cache non salvata (si prosegue in memoria): ${String(error)}`),
      );
    }

    const passage = await embedApi.passage(text);
    return tags
      .map((tag) => ({ tag, score: cosine(passage, cache?.get(tag) ?? []) }))
      .filter((entry) => entry.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((entry) => entry.tag);
  }

  async function loadCache(): Promise<void> {
    if (cache) return;
    cache = new Map();
    if (!options.cachePath) return;
    try {
      const raw = JSON.parse(await readFile(options.cachePath, "utf8")) as Partial<CacheFile>;
      if (raw.version === CACHE_VERSION && raw.model === modelId && raw.embeddings) {
        for (const [tag, vector] of Object.entries(raw.embeddings)) {
          if (Array.isArray(vector)) cache.set(tag, vector);
        }
      }
    } catch {
      // File assente o corrotto: si riparte con la cache vuota.
    }
  }

  async function saveCache(): Promise<void> {
    if (!options.cachePath || !cache) return;
    const file: CacheFile = { version: CACHE_VERSION, model: modelId, embeddings: Object.fromEntries(cache) };
    const tmp = `${options.cachePath}.tmp`;
    await writeFile(tmp, JSON.stringify(file), "utf8");
    await rename(tmp, options.cachePath);
  }

  return tagger;
}

// ── Embedding ONNX (default) ──────────────────────────────────────────────

/** Pipeline feature-extraction con le convenzioni e5 (query/passage). */
async function createOnnxEmbed(modelId: string, dtype: SemanticDType): Promise<EmbedApi> {
  const { pipeline } = await import("@huggingface/transformers");
  const extractor = (await pipeline("feature-extraction", modelId, { dtype })) as FeatureExtractionPipeline;
  return {
    queries: async (texts) => embedBatch(extractor, texts.map((t) => `query: ${t}`)),
    passage: async (text) => (await embedBatch(extractor, [`passage: ${text}`]))[0] ?? [],
  };
}

async function embedBatch(extractor: FeatureExtractionPipeline, texts: string[]): Promise<number[][]> {
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  return output.tolist() as number[][];
}

// ── Matematica ────────────────────────────────────────────────────────────

/** Similarità coseno, difensiva su vettori non normalizzati o vuoti. */
function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Nome conveniente per il file cache, quando il chiamante lo vuole nel data dir. */
export const SEMANTIC_CACHE_FILE_NAME = "semantic-tags-cache.json";
