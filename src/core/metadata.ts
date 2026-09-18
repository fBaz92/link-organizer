import type { FileStore } from "@/core/files";
import { UnsafeUrlError, assertSafeRemoteUrl } from "@/core/security/url-guard";
import { youtubeVideoId } from "@/core/url";

/*
 * Flow: il fetcher di metadati arricchisce gli item con titolo, descrizione
 * e thumbnail, senza API key.
 *
 * 1. fetch() sceglie la strategia: oEmbed dedicato per YouTube e Vimeo
 *    (JSON pulito), altrimenti fetch dell'HTML con parsing dei tag
 *    OpenGraph e fallback sul <title>. L'oEmbed di YouTube non include la
 *    descrizione: viene integrata dall'og:description della pagina watch.
 * 2. OGNI richiesta (URL iniziale, redirect, thumbnail) passa da
 *    assertSafeRemoteUrl(): http/https soltanto, niente host privati —
 *    i redirect vengono seguiti a mano proprio per ricontrollare ogni hop.
 * 3. downloadThumbnail() scarica l'immagine nello store (thumbs/, nome = hash
 *    dell'URL immagine) con tetto dimensionale e verifica del content-type.
 *
 * fetchImpl è iniettabile per i test. Ogni errore di rete è recuperabile:
 * fetch ritorna null e l'item resta con il titolo di fallback.
 */

export interface PageMetadata {
  title?: string;
  description?: string;
  thumbnailUrl?: string;
  siteName?: string;
  /** Canale/autore (oEmbed di YouTube/Vimeo): nome + URL canonico. */
  authorName?: string;
  authorUrl?: string;
}

const USER_AGENT = "Mozilla/5.0 (compatible; StashArchiver/1.0; +local-personal-tool)";
const FETCH_TIMEOUT_MS = 10_000;
// Generoso: nelle pagine YouTube l'<head> chiude a ~700KB (script inline prima
// dei meta) e l'og:description serve per la descrizione. I siti normali chiudono
// l'<head> molto prima: il limite è solo una rete di sicurezza.
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export class MetadataFetcher {
  constructor(
    private readonly fileStore: FileStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetch(canonicalUrl: string): Promise<PageMetadata | null> {
    try {
      const url = new URL(canonicalUrl);
      const host = url.hostname.replace(/^www\./, "");

      if (host === "youtu.be" || host.endsWith("youtube.com")) {
        return await this.fetchYouTubeOEmbed(url);
      }
      if (host === "vimeo.com") {
        return await this.fetchOEmbedJson(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(canonicalUrl)}`);
      }
      return await this.fetchOpenGraph(canonicalUrl);
    } catch (error) {
      if (error instanceof UnsafeUrlError) throw error; // segnalare, non nascondere
      return null; // rete giù, 404, HTML strano: l'item resta com'è
    }
  }

  /** Scarica la thumbnail nello store; ritorna il path relativo. */
  async downloadThumbnail(imageUrl: string): Promise<string | undefined> {
    try {
      await assertSafeRemoteUrl(imageUrl);
      const response = await this.guardedFetch(imageUrl);
      if (!response.ok) return undefined;

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) return undefined;

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_THUMBNAIL_BYTES) return undefined;

      const extension = contentType.includes("png")
        ? ".png"
        : contentType.includes("webp")
          ? ".webp"
          : contentType.includes("gif")
            ? ".gif"
            : ".jpg";
      const stored = await this.fileStore.saveBytes(bytes, `thumbnail${extension}`, "thumbs");
      return stored.relativePath;
    } catch {
      return undefined;
    }
  }

  // ── Strategie per sorgente ─────────────────────────────────────────────

  private async fetchYouTubeOEmbed(url: URL): Promise<PageMetadata | null> {
    const videoId = youtubeVideoId(url);
    const canonical = videoId ? `https://youtu.be/${videoId}` : url.toString();
    // L'oEmbed di YouTube non include la descrizione: la si recupera in
    // parallelo dall'og:description della pagina watch (fallisce in silenzio).
    const [metadata, description] = await Promise.all([
      this.fetchOEmbedJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`),
      videoId ? this.fetchYouTubeDescription(videoId) : Promise.resolve(undefined),
    ]);
    if (!metadata && !description) return null;
    return {
      ...metadata,
      description: metadata?.description ?? description,
      thumbnailUrl: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : metadata?.thumbnailUrl,
    };
  }

  /** Descrizione YouTube dal meta og:description della pagina watch: un bonus,
   * mai una ragione per far fallire l'arricchimento (consent page, 404…). */
  private async fetchYouTubeDescription(videoId: string): Promise<string | undefined> {
    try {
      const html = await this.fetchHtmlHead(`https://www.youtube.com/watch?v=${videoId}`);
      if (!html) return undefined;
      return extractMeta(html, ["og:description"]) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private async fetchOEmbedJson(endpoint: string): Promise<PageMetadata | null> {
    await assertSafeRemoteUrl(endpoint);
    const response = await this.guardedFetch(endpoint);
    if (!response.ok) return null;
    try {
      return oembedToMetadata((await response.json()) as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  private async fetchOpenGraph(pageUrl: string): Promise<PageMetadata | null> {
    const html = await this.fetchHtmlHead(pageUrl);
    if (!html) return null;

    const title = extractMeta(html, ["og:title", "twitter:title"]) ?? extractTag(html, "title");
    const description = extractMeta(html, ["og:description", "description", "twitter:description"]);
    const rawImage = extractMeta(html, ["og:image", "twitter:image"]);
    const siteName = extractMeta(html, ["og:site_name"]);

    let thumbnailUrl: string | undefined;
    if (rawImage) {
      try {
        thumbnailUrl = new URL(rawImage, pageUrl).toString();
      } catch {
        thumbnailUrl = undefined;
      }
    }

    if (!title && !description) return null;
    return { title: title ?? undefined, description: description ?? undefined, thumbnailUrl, siteName: siteName ?? undefined };
  }

  /** Fetch manuale dei redirect: ogni hop viene rivalidato contro l'SSRF guard. */
  private async guardedFetch(url: string, redirects = 0): Promise<Response> {
    await assertSafeRemoteUrl(url);
    if (redirects > MAX_REDIRECTS) throw new Error("Troppi redirect");

    const response = await this.fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": USER_AGENT, accept: "*/*" },
    });

    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (location) {
      const next = new URL(location, url).toString();
      return this.guardedFetch(next, redirects + 1);
    }
    return response;
  }

  private async fetchHtmlHead(pageUrl: string): Promise<string | null> {
    const response = await this.guardedFetch(pageUrl);
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("html") && contentType !== "") return null;

    const reader = response.body?.getReader();
    if (!reader) return null;
    const decoder = new TextDecoder();
    let html = "";
    while (html.length < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (html.includes("</head>")) break;
    }
    await reader.cancel().catch(() => undefined);
    return html;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Mappa la risposta oEmbed standard su PageMetadata (autore incluso). */
export function oembedToMetadata(data: Record<string, unknown>): PageMetadata {
  return {
    title: asString(data.title),
    description: asString(data.description),
    thumbnailUrl: asString(data.thumbnail_url),
    siteName: asString(data.provider_name),
    authorName: asString(data.author_name),
    authorUrl: asString(data.author_url),
  };
}

function extractMeta(html: string, names: string[]): string | null {
  for (const name of names) {
    const escaped = name.replace(/[:."]/g, "\\$&");
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"),
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return decodeHtmlEntities(match[1].trim());
    }
  }
  return null;
}

function extractTag(html: string, tag: string): string | null {
  const match = html.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "i"));
  return match?.[1] ? decodeHtmlEntities(match[1].trim()) : null;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&nbsp;", " ");
}
