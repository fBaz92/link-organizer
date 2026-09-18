import { createHash } from "node:crypto";

/*
 * Flow: normalizzazione "furbo" degli URL, cuore del dedup.
 *
 * normalizeUrl() porta rappresentazioni diverse della stessa risorsa a UNA
 * forma canonica: scheme implicito, host in minuscolo senza www., niente
 * fragment, parametri di tracking rimossi, query ordinata, slash finale
 * tolta. Per i grandi player va oltre: YouTube (watch/shorts/embed/live/
 * youtu.be), Spotify e X/Twitter vengono ridotti alla loro identità minima.
 *
 * urlHash() è lo sha256 della forma canonica: due URL diversi che puntano
 * allo stesso video producono lo stesso hash → il dedup è un lookup, non un
 * confronto fuzzy.
 */

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_eid",
  "igshid",
  "si",
  "ref",
  "ref_src",
  "ref_url",
  "feature",
  "t",
  "ck_subscriber_id",
  "spm",
  "scid",
  "_ga",
  "__twitter_impression",
]);

const YOUTUBE_HOSTS = new Set(["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"]);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Porta l'URL alla forma canonica; ritorna null se non è un URL valido.
 * Accetta anche URL senza schema ("youtube.com/watch?v=x") assumendo https.
 */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname.includes(".")) return null;

  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");

  const special = specialSiteCanonical(url);
  if (special) return special;

  const params = [...url.searchParams.entries()].filter(
    ([key]) => !TRACKING_PARAMS.has(key) && !key.startsWith("utm_"),
  );
  params.sort(([a], [b]) => a.localeCompare(b));

  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : "";
  return `${url.protocol}//${url.hostname}${path}${query}`;
}

/** Hash stabile dell'URL canonico (sha256 troncato: collisioni irragionevoli). */
export function urlHash(canonicalUrl: string): string {
  return createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 32);
}

/** Estrae l'ID di un video YouTube da qualunque forma di URL. */
export function youtubeVideoId(url: URL): string | null {  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "youtu.be") return YOUTUBE_ID.test(url.pathname.slice(1)) ? url.pathname.slice(1) : null;
  if (!YOUTUBE_HOSTS.has(host)) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] === "watch") return YOUTUBE_ID.test(url.searchParams.get("v") ?? "") ? url.searchParams.get("v") : null;
  if (["shorts", "embed", "live", "v"].includes(segments[0] ?? "")) {
    return segments[1] && YOUTUBE_ID.test(segments[1]) ? segments[1] : null;
  }
  return null;
}

/** Riduce i grandi player alla loro identità minima; null = normalizzazione generica. */
function specialSiteCanonical(url: URL): string | null {
  const host = url.hostname;

  // YouTube → https://youtu.be/<id> (o playlist se non c'è un video)
  const videoId = youtubeVideoId(url);
  if (videoId) return `https://youtu.be/${videoId}`;
  if (YOUTUBE_HOSTS.has(host) && url.pathname === "/playlist") {
    const list = url.searchParams.get("list");
    if (list) return `https://www.youtube.com/playlist?list=${list}`;
  }

  // Spotify → https://open.spotify.com/<kind>/<id>
  const spotify = url.pathname.match(/^\/(track|album|playlist|episode|show)\/([A-Za-z0-9]+)/);
  if (host === "open.spotify.com" && spotify) {
    return `https://open.spotify.com/${spotify[1]}/${spotify[2]}`;
  }

  // X/Twitter → https://x.com/<user>/status/<id>
  const status = url.pathname.match(/^\/([^/]+)\/status(?:es)?\/(\d+)/);
  if ((host === "x.com" || host === "twitter.com") && status) {
    return `https://x.com/${status[1]}/status/${status[2]}`;
  }

  return null;
}

/** Thumbnail pubblica di un video YouTube: anteprima subito disponibile,
 * anche prima che i metadati (e la copia locale) arrivino. */
export function youtubeThumbnailUrl(canonicalUrl: string): string | null {
  try {
    const id = youtubeVideoId(new URL(canonicalUrl));
    return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
  } catch {
    return null;
  }
}
