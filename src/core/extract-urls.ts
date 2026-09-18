/*
 * Flow: estrazione degli URL da testo libero (caption e messaggi Telegram,
 * export JSON dell'import). Priorità alla precisione: nel bot le entity
 * Telegram sono la fonte ufficiale e passano da extractFromEntities();
 * il regex qui sotto è il fallback per testo nudo e copre http(s), www.
 * e domini nudi con TLD plausibile. I duplicati nella stessa frase vengono
 * uniti in insieme.
 */

const HTTP_URL = /https?:\/\/[^\s<>"'`)\]}]+/gi;
const BARE_DOMAIN = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(tld)(?:\/[^\s<>"'`)\]},;]*)?/gi;

const COMMON_TLDS =
  "com|it|net|org|io|dev|app|ai|co|edu|gov|info|me|tv|gg|xyz|to|sh|fr|de|es|uk|us|ch|nl|pt|br|ru|pl|se|no|fi|be|at|ie|cz|gr|eu|biz|one|page|tech|cloud|link|live|media|news|blog|wiki|shop|store|video|tools|today|tips|studio|design|systems|world|zone|online|site|press|ink";

const BARE_DOMAIN_WITH_TLD = new RegExp(BARE_DOMAIN.source.replace("tld", COMMON_TLDS), "gi");

/** Estrae gli URL da un testo libero, già normalizzabili. */
export function extractUrls(text: string): string[] {
  const found = new Set<string>();

  for (const match of text.matchAll(HTTP_URL)) {
    found.add(match[0].replace(/[.,;:!?)]+$/, ""));
  }

  // Domini nudi: evita ciò che segue http(s) già catturato sopra.
  const withoutHttp = text.replaceAll(HTTP_URL, " ");
  for (const match of withoutHttp.matchAll(BARE_DOMAIN_WITH_TLD)) {
    found.add(`https://${match[0].replace(/[.,;:!?)]+$/, "")}`);
  }

  return [...found];
}

/** Estrae gli URL dichiarati dalle entity Telegram (type "url" e "text_link"). */
export function extractFromEntities(
  text: string,
  entities: { type: string; url?: string; offset: number; length: number }[],
): string[] {
  const found = new Set<string>();
  for (const entity of entities) {
    if (entity.type === "text_link" && entity.url) {
      found.add(entity.url);
    } else if (entity.type === "url") {
      found.add(text.slice(entity.offset, entity.offset + entity.length));
    }
  }
  return [...found];
}
