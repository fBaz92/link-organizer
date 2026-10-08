import type { Item } from "@/core/domain/item";
import type { StashRuntime } from "@/core/runtime";
import { youtubeVideoId } from "@/core/url";

/*
 * Flow: backfill automatico delle thumbnail. Gli item archiviati senza
 * thumbnail locale (import senza --meta, arricchimento fallito al momento,
 * rete assente) restavano così per sempre: questo modulo li scansiona e
 * recupera l'immagine.
 *
 * - YouTube: URL deterministico i.ytimg.com/vi/<id>/hqdefault.jpg — niente
 *   yt-dlp né oEmbed per item, il download è un'immagine sola.
 * - Gli altri: enrichMetadata(), che è idempotente e tocca solo i campi
 *   mancanti (thumbnail e, come bonus, titolo/descrizione/canale se
 *   ancora assenti); mai sopra le modifiche umane.
 *
 * Puro rispetto alla rete (fetch dentro il runtime): i test iniettano un
 * fetch finto. Ogni fallimento è per-item: il backfill prosegue.
 */

export interface BackfillItemResult {
  itemId: number;
  ok: boolean;
  via: "youtube-direct" | "metadata";
  error?: string;
}

export interface BackfillSummary {
  /** Item trovati senza thumbnail (entro il limite del run). */
  scanned: number;
  fetched: number;
  failed: number;
}

export interface BackfillOptions {
  /** Tetto di item per run: il resto si prende il run successivo. */
  limit?: number;
  /** Pausa fra un item e l'altro, per non martellare i server. */
  pauseMs?: number;
  onItem?: (result: BackfillItemResult) => void;
}

/** URL della thumbnail pubblica di YouTube per un canonical_url noto. */
export function youtubeThumbnailUrl(canonicalUrl: string): string | undefined {
  try {
    const videoId = youtubeVideoId(new URL(canonicalUrl));
    return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : undefined;
  } catch {
    return undefined;
  }
}

export async function backfillThumbnails(
  runtime: StashRuntime,
  options: BackfillOptions = {},
): Promise<BackfillSummary> {
  const limit = options.limit ?? 500;
  const pauseMs = options.pauseMs ?? 300;
  const targets = runtime.items.listMissingThumbnails(limit);
  const summary: BackfillSummary = { scanned: targets.length, fetched: 0, failed: 0 };

  for (const item of targets) {
    let result: BackfillItemResult;
    const direct = item.canonicalUrl ? youtubeThumbnailUrl(item.canonicalUrl) : undefined;
    if (direct && item.type !== "documento") {
      result = await backfillYoutube(runtime, item.id, direct);
    } else if (item.url) {
      result = await backfillViaMetadata(runtime, item);
    } else {
      result = { itemId: item.id, ok: false, via: "metadata", error: "nessun URL da cui recuperare" };
    }

    if (result.ok) summary.fetched += 1;
    else summary.failed += 1;
    options.onItem?.(result);

    if (pauseMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }

  return summary;
}

async function backfillYoutube(
  runtime: StashRuntime,
  itemId: number,
  thumbnailUrl: string,
): Promise<BackfillItemResult> {
  const path = await runtime.metadata.downloadThumbnail(thumbnailUrl);
  if (!path) {
    return { itemId, ok: false, via: "youtube-direct", error: "download della thumbnail non riuscito" };
  }
  runtime.items.update(itemId, { thumbnailPath: path });
  return { itemId, ok: true, via: "youtube-direct" };
}

async function backfillViaMetadata(runtime: StashRuntime, item: Item): Promise<BackfillItemResult> {
  const target = runtime.items.getById(item.id);
  if (!target) {
    return { itemId: item.id, ok: false, via: "metadata", error: "item non trovato" };
  }
  try {
    const enriched = await runtime.ingestion.enrichMetadata(target);
    return {
      itemId: item.id,
      ok: Boolean(enriched.thumbnailPath),
      via: "metadata",
      ...(enriched.thumbnailPath ? {} : { error: "metadati senza thumbnail utilizzabile" }),
    };
  } catch (error) {
    return { itemId: item.id, ok: false, via: "metadata", error: String(error) };
  }
}
