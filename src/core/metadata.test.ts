import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { FileStore } from "@/core/files";
import { MetadataFetcher, oembedToMetadata } from "@/core/metadata";
import { UnsafeUrlError } from "@/core/security/url-guard";

/*
 * Flow: test del fetcher di metadati con fetch finto. Copre: OpenGraph con
 * risoluzione di URL relativi, fallback <title>, rifiuto dei contenuti non
 * HTML, gestione dei redirect CON rivalidazione SSRF a ogni hop, e rifiuto
 * secco degli URL verso la rete interna.
 */

const HOST = "93.184.216.34"; // IP pubblico letterale: niente DNS reale nei test

describe("oembedToMetadata", () => {
  it("mappa autore e canale dalla risposta oEmbed", () => {
    const metadata = oembedToMetadata({
      title: "Never Gonna Give You Up",
      author_name: "Rick Astley",
      author_url: "https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw",
      thumbnail_url: "https://i.ytimg.com/vi/x/hqdefault.jpg",
      provider_name: "YouTube",
    });
    expect(metadata.authorName).toBe("Rick Astley");
    expect(metadata.authorUrl).toBe("https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw");
    expect(metadata.siteName).toBe("YouTube");
  });

  it("tollerante ai campi mancanti o vuoti", () => {
    expect(oembedToMetadata({ author_name: "  " })).toEqual({
      title: undefined,
      description: undefined,
      thumbnailUrl: undefined,
      siteName: undefined,
      authorName: undefined,
      authorUrl: undefined,
    });
  });
});

describe("MetadataFetcher", () => {
  let files: FileStore;

  beforeAll(async () => {
    files = new FileStore(await mkdtemp(path.join(tmpdir(), "stash-meta-")));
  });

  it("estrae OpenGraph e risolve immagini relative", async () => {
    const fetcher = new MetadataFetcher(
      files,
      fakeFetcher({
        [`https://${HOST}/x`]: `<html><head>
          <title>titolo sbagliato</title>
          <meta property="og:title" content="Titolo OG">
          <meta property="og:description" content="Descrizione OG">
          <meta property="og:image" content="/img/copertina.png">
        </head></html>`,
      }),
    );

    const metadata = await fetcher.fetch(`https://${HOST}/x`);
    expect(metadata).toEqual({
      title: "Titolo OG",
      description: "Descrizione OG",
      thumbnailUrl: `https://${HOST}/img/copertina.png`,
      siteName: undefined,
    });
  });

  it("usa il <title> quando mancano i meta", async () => {
    const fetcher = new MetadataFetcher(
      files,
      fakeFetcher({ [`https://${HOST}/solo`]: "<html><head><title>Solo titolo</title></head></html>" }),
    );
    const metadata = await fetcher.fetch(`https://${HOST}/solo`);
    expect(metadata?.title).toBe("Solo titolo");
    expect(metadata?.description).toBeUndefined();
  });

  it("per YouTube integra la descrizione dall'og:description della pagina watch", async () => {
    const fetcher = new MetadataFetcher(
      files,
      fakeFetcher({
        "https://www.youtube.com/oembed?url=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ&format=json": json({
          title: "Titolo video",
          author_name: "Canale",
        }),
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ": `<html><head>
          <meta property="og:description" content="Grid-forming converters explained">
        </head><body>player</body></html>`,
      }),
    );

    const metadata = await fetcher.fetch("https://youtu.be/dQw4w9WgXcQ");
    expect(metadata?.title).toBe("Titolo video");
    expect(metadata?.authorName).toBe("Canale");
    expect(metadata?.description).toBe("Grid-forming converters explained");
    expect(metadata?.thumbnailUrl).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  });

  it("per YouTube una descrizione non disponibile non blocca il resto", async () => {
    const fetcher = new MetadataFetcher(
      files,
      fakeFetcher({
        "https://www.youtube.com/oembed?url=https%3A%2F%2Fyoutu.be%2Fabcdefghijk&format=json": json({
          title: "Solo titolo",
        }),
        // La pagina watch risponde 404: nessuna descrizione, title resta.
      }),
    );

    const metadata = await fetcher.fetch("https://youtu.be/abcdefghijk");
    expect(metadata?.title).toBe("Solo titolo");
    expect(metadata?.description).toBeUndefined();
  });

  it("ritorna null per contenuti non HTML", async () => {
    const fetcher = new MetadataFetcher(files, fakeFetcher({}));
    expect(await fetcher.fetch(`https://${HOST}/binario`)).toBeNull();
  });

  it("segue i redirect rivalidando la SSRF guard a ogni hop", async () => {
    let hops = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = input.toString();
      if (hops === 0) {
        hops++;
        return new Response(null, { status: 302, headers: { location: `https://${HOST}/finale` } });
      }
      return html(`<html><head><meta property="og:title" content="Dopo il redirect"></head></html>`);
    }) as typeof fetch;

    const fetcher = new MetadataFetcher(files, fetchImpl);
    const metadata = await fetcher.fetch(`https://${HOST}/redirect`);
    expect(metadata?.title).toBe("Dopo il redirect");
  });

  it("rifiuta senza fare richieste gli URL verso la rete interna", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return html("");
    }) as typeof fetch;

    const fetcher = new MetadataFetcher(files, fetchImpl);
    await expect(fetcher.fetch("http://127.0.0.1:8080/segreto")).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(called).toBe(false);
  });
});

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

function json(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Fetch finto: risponde solo agli URL noti (HTML o Response pronta), 404 per il resto. */
function fakeFetcher(routes: Record<string, string | Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = input.toString();
    const body = routes[url];
    if (body === undefined) {
      return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    return typeof body === "string" ? html(body) : body;
  }) as typeof fetch;
}
