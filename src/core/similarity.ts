import type { Item } from "@/core/domain/item";

/*
 * Flow: la ricerca "simile" del wizard di download (bot e web).
 *
 * È volutamente più di una parità di stringa, ma resta locale e
 * spiegabile: niente embedding, solo segnali lessicali combinati.
 *
 * normalizeForSearch() porta tutto a una base confrontabile (minuscolo,
 * diacritici rimossi, punteggiatura → spazio). similarity() giudica un
 * token di query contro un token di campo su una scala 0..1:
 *   1.00  parità esatta
 *   ~0.9  il campo inizia con il token (prefisso: "ing" → "ingegneria")
 *   ~0.7  il token è contenuto nel campo (infix)
 *   scala distanza di Levenshtein ≥ 0.6 (refusi: "rustt" → "rust")
 *
 * scoreItem() valuta OGNI token della query contro titolo, canale e tag
 * (con pesi diversi) e combina i risultati con semantica AND: se un token
 * non trova nulla di decente da nessuna parte, l'item è scartato. Il
 * punteggio finale premia chi matcha bene su TUTTI i token (min) e in
 * media (media), più un bonus se la frase intera appare nel titolo.
 */

/** Sotto questa soglia un token si considera non trovato → item scartato. */
const TOKEN_MIN_SCORE = 0.4;
/** Punteggio minimo dell'item per entrare nei risultati. */
const ITEM_MIN_SCORE = 0.5;
/** Peso dei campi: il titolo dice più del canale, il canale più dei tag. */
const FIELD_WEIGHTS = { title: 1, channel: 0.85, tags: 0.7 } as const;

export interface SimilarityFields {
  title: string;
  channel?: string;
  tags?: string[];
}

export interface ScoredItem<T> {
  item: T;
  score: number;
}

/** Minuscolo, senza diacritici, solo lettere/cifre separati da spazi. */
export function normalizeForSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Combining_Mark}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function tokenizeForSearch(text: string): string[] {
  return normalizeForSearch(text).split(" ").filter(Boolean);
}

/** Distanza di Levenshtein classica (due righe), per token brevi. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Quanto un token di query assomiglia a un token candidato (0..1).
 * I token corti (≤2 caratteri) accettano solo parità/prefisso: le altre
 * vie producono troppo rumore.
 */
export function tokenSimilarity(queryToken: string, candidateToken: string): number {
  if (queryToken === candidateToken) return 1;
  if (queryToken.length <= 2 || candidateToken.length <= 2) {
    return candidateToken.startsWith(queryToken) ? 0.9 : 0;
  }
  if (candidateToken.startsWith(queryToken)) {
    return 0.85 + 0.1 * (queryToken.length / candidateToken.length);
  }
  if (candidateToken.includes(queryToken)) {
    return 0.6 + 0.2 * (queryToken.length / candidateToken.length);
  }
  // Refusi: solo se le lunghezze sono compatibili e la similarità è ≥ 0.6.
  if (Math.abs(queryToken.length - candidateToken.length) > 2) return 0;
  const ratio = 1 - levenshtein(queryToken, candidateToken) / Math.max(queryToken.length, candidateToken.length);
  return ratio >= 0.6 ? 0.45 + 0.55 * ratio : 0;
}

/** Miglior punteggio di un token di query contro un campo testuale. */
function bestInField(queryToken: string, field: string): number {
  let best = 0;
  for (const token of tokenizeForSearch(field)) {
    const score = tokenSimilarity(queryToken, token);
    if (score > best) best = score;
    if (best === 1) break;
  }
  return best;
}

/** Punteggio dell'item (0..1); 0 = non simile, va scartato. */
export function scoreItem(query: string, fields: SimilarityFields): number {
  const queryTokens = tokenizeForSearch(query);
  if (queryTokens.length === 0) return 0;

  const tokenScores: number[] = [];
  for (const token of queryTokens) {
    const best = Math.max(
      bestInField(token, fields.title) * FIELD_WEIGHTS.title,
      fields.channel ? bestInField(token, fields.channel) * FIELD_WEIGHTS.channel : 0,
      fields.tags ? bestInField(token, fields.tags.join(" ")) * FIELD_WEIGHTS.tags : 0,
    );
    if (best < TOKEN_MIN_SCORE) return 0; // semantica AND: un token perso basta
    tokenScores.push(best);
  }

  const min = Math.min(...tokenScores);
  const mean = tokenScores.reduce((sum, score) => sum + score, 0) / tokenScores.length;
  let score = 0.35 * min + 0.65 * mean;

  // Bonus frase: la query intera (già normalizzata) dentro titolo o canale.
  const phrase = queryTokens.join(" ");
  if (phrase && normalizeForSearch(fields.title).includes(phrase)) score += 0.1;
  if (phrase && fields.channel && normalizeForSearch(fields.channel).includes(phrase)) score += 0.05;

  return Math.min(score, 1);
}

/**
 * Ranking degli item per somiglianza con la query: filtra sotto soglia,
 * ordina per punteggio (a parità vince il più recente), taglia al limite.
 * I campi vengono estratti con fieldsOf così il chiamante passa i suoi
 * oggetti (Item del dominio, righe di test, …) senza wrapper intermedi.
 */
export function rankBySimilarity<T>(
  items: T[],
  query: string,
  fieldsOf: (item: T) => SimilarityFields,
  limit = 30,
): ScoredItem<T>[] {
  return items
    .map((item) => ({ item, score: scoreItem(query, fieldsOf(item)) }))
    .filter((entry) => entry.score >= ITEM_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Estrae i campi che partecipano al ranking da un item dell'archivio. */
export function similarityFieldsOfItem(item: Item): SimilarityFields {
  return {
    title: item.title ?? item.fileName ?? item.canonicalUrl ?? "",
    channel: item.authorName,
    tags: item.tags,
  };
}
