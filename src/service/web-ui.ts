import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import path from "node:path";
import type { StashRuntime } from "@/core/runtime";
import {
  SESSION_COOKIE_NAME,
  createSessionValue,
  passwordMatches,
  verifySessionValue,
} from "@/core/session";
import type { Item } from "@/core/domain/item";
import { ITEM_TYPE_LABELS } from "@/core/domain/item";
import { escapeHtml, truncate } from "@/bot/render";
import { fullDate, relativeDate } from "@/lib/format";
import { logEvent } from "@/service/log";

/*
 * Flow: visualizzatore web incluso nel servizio HomeGate. È volutamente
 * MINIMO e in sola lettura (ricerca, dettaglio, thumbnail, download): il
 * pacchetto HomeGate non può contenere la webapp Next completa (limite di
 * 20 MiB e moduli nativi), quindi il servizio espone questa interfaccia
 * leggera per rileggere l'archivio dalla LAN. Editing, wizard download e
 * note restano sul bot Telegram o sulla webapp completa in sviluppo.
 *
 * Sicurezza: se WEB_PASSWORD è impostata tutte le pagine richiedono il
 * cookie di sessione firmato (stessa logica della webapp Next, vedi
 * core/session.ts). I file/thumbnail vengono serviti solo se il percorso
 * risolto resta dentro la cartella dati.
 */

const PAGE_SIZE = 20;
const MAX_LOGIN_BODY_BYTES = 4096;
const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface WebUiOptions {
  port: number;
  /** Password della web UI; se assente l'accesso è libero (uso locale). */
  password?: string;
  /** Cartella dati: radice per thumbnail e file serviti. */
  dataRoot: string;
  loginFailureDelayMs?: number;
}

export interface WebUiHandle {
  port: number;
  close(): Promise<void>;
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return cookies;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_LOGIN_BODY_BYTES) {
        reject(new Error("Corpo della richiesta troppo grande"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export function startWebUi(runtime: StashRuntime, options: WebUiOptions): Promise<WebUiHandle> {
  const authRequired = options.password !== undefined;
  const failureDelayMs = options.loginFailureDelayMs ?? 400;

  const server = createServer((request, response) => {
    void handle(runtime, options, request, response).catch((error) => {
      logEvent("error", "web_request_failed", "Richiesta non gestita", { error });
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("Errore interno");
    });
  });

  return new Promise((resolve) => {
    server.listen(options.port, "0.0.0.0", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      resolve({ port, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });

  async function handle(
    runtime: StashRuntime,
    options: WebUiOptions,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://stash.local");
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (request.method !== "GET" && request.method !== "POST" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, POST, HEAD" });
      response.end("Metodo non consentito");
      return;
    }

    if (segments[0] === "login") {
      await handleLogin(request, response);
      return;
    }

    if (authRequired) {
      const cookie = parseCookies(request.headers.cookie).get(SESSION_COOKIE_NAME);
      const valid = verifySessionValue(cookie, options.password!);
      if (!valid) {
        response.writeHead(302, { location: "/login", "cache-control": "no-store" });
        response.end();
        return;
      }
    }

    if (segments[0] === "logout") {
      response.setHeader("set-cookie", `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
      response.writeHead(302, { location: "/login", "cache-control": "no-store" });
      response.end();
      return;
    }

    if (segments.length === 0) {
      await handleList(url, response, runtime);
      return;
    }
    if (segments[0] === "item" && segments[1] && /^\d+$/.test(segments[1])) {
      await handleItem(Number.parseInt(segments[1], 10), response, runtime);
      return;
    }
    if (segments[0] === "thumb" && segments[1] && /^\d+$/.test(segments[1])) {
      await handleStoredFile(Number.parseInt(segments[1], 10), response, runtime, "thumb", options);
      return;
    }
    if (segments[0] === "file" && segments[1] && /^\d+$/.test(segments[1])) {
      await handleStoredFile(Number.parseInt(segments[1], 10), response, runtime, "file", options);
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Non trovato");
  }

  async function handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET" || request.method === "HEAD") {
      sendHtml(response, 200, loginPage());
      return;
    }
    const body = new URLSearchParams(await readBody(request));
    const candidate = body.get("password") ?? "";
    if (!authRequired || passwordMatches(candidate, options.password!)) {
      const { value, maxAge } = createSessionValue(options.password ?? "");
      response.setHeader(
        "set-cookie",
        `${SESSION_COOKIE_NAME}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax`,
      );
      response.writeHead(303, { location: "/", "cache-control": "no-store" });
      response.end();
      return;
    }
    // Rallenta i tentativi a forza bruta senza accumulare stato.
    await new Promise((resolve) => setTimeout(resolve, failureDelayMs));
    logEvent("warn", "web_login_failed", "Password errata al login del visualizzatore");
    sendHtml(response, 401, loginPage("Password errata."));
  }

  async function handleList(url: URL, response: ServerResponse, runtime: StashRuntime): Promise<void> {
    const q = url.searchParams.get("q")?.trim() || undefined;
    const tag = url.searchParams.get("tag")?.trim() || undefined;
    const page = Math.max(0, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1) - 1;
    const { items, total } = runtime.items.list({ q, tag, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const topTags = runtime.items.tagsWithCounts().slice(0, 24);

    const cards = items
      .map((item) => {
        const link = item.url ?? item.canonicalUrl;
        const title = escapeHtml(truncate(item.title ?? item.fileName ?? `Item #${item.id}`, 120));
        const tagsHtml = item.tags.map((t) => `<a class="tag" href="/?tag=${encodeURIComponent(t)}">#${escapeHtml(t)}</a>`).join(" ");
        const thumb = item.thumbnailPath
          ? `<a href="/item/${item.id}"><img class="thumb" src="/thumb/${item.id}" alt="" loading="lazy"></a>`
          : `<a class="thumb placeholder" href="/item/${item.id}">${escapeHtml(typeEmoji(item))}</a>`;
        const openLink = link ? ` · <a href="${escapeAttr(link)}" rel="noopener noreferrer">apri ↗</a>` : "";
        return `<article class="card">
  ${thumb}
  <div class="card-body">
    <h3><a href="/item/${item.id}">${title}</a></h3>
    <p class="meta">${escapeHtml(ITEM_TYPE_LABELS[item.type] ?? item.type)} · ${escapeHtml(relativeDate(item.createdAt))}${item.authorName ? ` · ${escapeHtml(truncate(item.authorName, 40))}` : ""}${openLink}</p>
    <p class="tags">${tagsHtml}</p>
  </div>
</article>`;
      })
      .join("\n");

    const tagChips = topTags
      .map((t) => `<a class="chip${t.name === tag ? " active" : ""}" href="/?tag=${encodeURIComponent(t.name)}">${escapeHtml(t.name)} <span>${t.count}</span></a>`)
      .join(" ");

    const navLinks: string[] = [];
    const pageHref = (n: number) => `/?${new URLSearchParams({ ...(q ? { q } : {}), ...(tag ? { tag } : {}), page: String(n) })}`;
    if (page > 0) navLinks.push(`<a href="${escapeAttr(pageHref(page))}">‹ Precedente</a>`);
    navLinks.push(`<span>Pagina ${page + 1} di ${pages}</span>`);
    if (page < pages - 1) navLinks.push(`<a href="${escapeAttr(pageHref(page + 2))}">Successiva ›</a>`);

    sendHtml(
      response,
      200,
      layout("Stash — Archivio", `
<header class="bar">
  <h1>📦 Stash</h1>
  <form class="search" method="get" action="/">
    ${tag ? `<input type="hidden" name="tag" value="${escapeAttr(tag)}">` : ""}
    <input type="search" name="q" value="${q ? escapeAttr(q) : ""}" placeholder="Cerca nell'archivio…">
    <button type="submit">Cerca</button>
  </form>
  ${authRequired ? '<a class="logout" href="/logout">Esci</a>' : ""}
</header>
<p class="stats">${total} item · ${topTags.length > 0 ? "filtra per tag:" : "nessun tag"}</p>
${tag ? `<p class="stats">Filtro attivo: <strong>#${escapeHtml(tag)}</strong> · <a href="/">rimuovi</a></p>` : ""}
<nav class="chips">${tagChips}</nav>
<main class="list">
${items.length === 0 ? `<p class="empty">Nessun item${q ? ` per «${escapeHtml(q)}»` : ""}.</p>` : cards}
</main>
<nav class="pager">${navLinks.join("")}</nav>`),
    );
  }

  async function handleItem(id: number, response: ServerResponse, runtime: StashRuntime): Promise<void> {
    const item = runtime.items.getById(id);
    if (!item) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Item non trovato");
      return;
    }
    const link = item.url ?? item.canonicalUrl;
    const description = item.description
      ? `<section><h2>Descrizione</h2><p class="prose">${escapeHtml(truncate(item.description, 4000))}</p></section>`
      : "";
    const notes = item.notes ? `<section><h2>Note</h2><p class="prose">${escapeHtml(item.notes)}</p></section>` : "";
    const fileLink = item.filePath
      ? `<a class="button" href="/file/${item.id}">⬇︎ Scarica file</a>`
      : "";
    const author = item.authorUrl
      ? `<a href="${escapeAttr(item.authorUrl)}" rel="noopener noreferrer">${escapeHtml(item.authorName ?? "canale")}</a>`
      : item.authorName
        ? escapeHtml(item.authorName)
        : "";
    const thumb = item.thumbnailPath ? `<img class="cover" src="/thumb/${item.id}" alt="">` : "";

    sendHtml(
      response,
      200,
      layout(item.title ?? `Item #${item.id}`, `
<article class="detail">
  <p class="crumbs"><a href="/">‹ Archivio</a></p>
  <h1>${escapeHtml(truncate(item.title ?? item.fileName ?? `Item #${item.id}`, 160))}</h1>
  ${thumb}
  <p class="meta">
    ${escapeHtml(ITEM_TYPE_LABELS[item.type] ?? item.type)} · aggiunto ${escapeHtml(fullDate(item.createdAt))}
    ${author ? ` · ${author}` : ""}
    ${item.seen ? " · visto ✓" : ""}${item.starred ? " · ⭐" : ""}
  </p>
  <p class="tags">${item.tags.map((t) => `<a class="tag" href="/?tag=${encodeURIComponent(t)}">#${escapeHtml(t)}</a>`).join(" ")}</p>
  <p class="actions">
    ${link ? `<a class="button" href="${escapeAttr(link)}" rel="noopener noreferrer">Apri originale ↗</a>` : ""}
    ${fileLink}
  </p>
  ${description}
  ${notes}
</article>`),
    );
  }

  async function handleStoredFile(
    id: number,
    response: ServerResponse,
    runtime: StashRuntime,
    kind: "thumb" | "file",
    options: WebUiOptions,
  ): Promise<void> {
    const item = runtime.items.getById(id);
    const relativePath = kind === "thumb" ? item?.thumbnailPath : item?.filePath;
    if (!item || !relativePath) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Non trovato");
      return;
    }

    // Il path nel DB è relativo alla cartella dati: dopo la risoluzione non
    // deve mai uscire dalla radice (difesa da path traversal).
    const dataRoot = path.resolve(options.dataRoot);
    const absolute = path.resolve(runtime.files.absolutePath(relativePath));
    if (absolute !== dataRoot && !absolute.startsWith(dataRoot + path.sep)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Non trovato");
      return;
    }

    let info;
    try {
      info = await stat(absolute);
      if (!info.isFile()) throw new Error("non è un file ordinario");
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("File non disponibile");
      return;
    }

    const extension = path.extname(absolute).toLowerCase();
    if (kind === "thumb") {
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
        "content-length": info.size,
        "cache-control": "private, max-age=86400",
        "x-content-type-options": "nosniff",
      });
      createReadStream(absolute).pipe(response);
      return;
    }
    response.writeHead(200, {
      "content-type": item.mimeType ?? "application/octet-stream",
      "content-length": info.size,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(item.fileName ?? `item-${item.id}`)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    createReadStream(absolute).pipe(response);
  }
}

function typeEmoji(item: Item): string {
  switch (item.type) {
    case "video":
      return "🎬";
    case "articolo":
      return "📄";
    case "paper":
      return "🎓";
    case "documento":
      return "📦";
    case "repo":
      return "🧩";
    case "podcast":
      return "🎧";
    case "musica":
      return "🎵";
    default:
      return "🔗";
  }
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "content-security-policy": "default-src 'self'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  });
  response.end(body);
}

function loginPage(error?: string): string {
  return layout("Stash — Accesso", `
<form class="login" method="post" action="/login">
  <h1>📦 Stash</h1>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <label for="password">Password</label>
  <input type="password" id="password" name="password" autofocus autocomplete="current-password">
  <button type="submit">Entra</button>
</form>`);
}

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font-family: system-ui, -apple-system, sans-serif; margin: 0; background: #f6f6f8; color: #1c1c22; }
@media (prefers-color-scheme: dark) { body { background: #14141a; color: #e8e8ee; } }
a { color: #4653d0; }
@media (prefers-color-scheme: dark) { a { color: #8f9bff; } }
.bar { display: flex; gap: 1rem; align-items: center; padding: .75rem 1rem; flex-wrap: wrap; }
.bar h1 { font-size: 1.1rem; margin: 0 auto 0 0; }
.search { display: flex; gap: .5rem; flex: 1; min-width: 240px; }
.search input { flex: 1; padding: .45rem .6rem; border: 1px solid #c9c9d4; border-radius: 8px; background: inherit; color: inherit; }
.stats, .chips { padding: 0 1rem; margin: .4rem 0; }
.chips { display: flex; flex-wrap: wrap; gap: .4rem; }
.chip { border: 1px solid #c9c9d4; border-radius: 999px; padding: .15rem .6rem; text-decoration: none; font-size: .85rem; }
.chip.active { background: #4653d0; color: #fff; }
.chip span { opacity: .6; font-size: .8em; }
.list { display: grid; gap: .6rem; padding: 0 1rem 1rem; }
.card { display: flex; gap: .8rem; background: #fff; border: 1px solid #e2e2ea; border-radius: 10px; padding: .6rem; }
@media (prefers-color-scheme: dark) { .card { background: #1d1d26; border-color: #2c2c38; } }
.card h3 { margin: 0 0 .2rem; font-size: .95rem; }
.card .meta { margin: 0; font-size: .8rem; opacity: .75; }
.thumb { width: 72px; height: 54px; object-fit: cover; border-radius: 6px; flex: none; display: flex; align-items: center; justify-content: center; text-decoration: none; font-size: 1.4rem; background: #ececf3; }
@media (prefers-color-scheme: dark) { .thumb.placeholder { background: #262633; } }
.tags { margin: .2rem 0 0; font-size: .8rem; }
.tag { text-decoration: none; margin-right: .35rem; }
.pager { display: flex; gap: 1rem; padding: 0 1rem 2rem; align-items: center; }
.detail { padding: 0 1rem 2rem; max-width: 760px; }
.cover { max-width: 100%; max-height: 360px; border-radius: 10px; display: block; margin: .6rem 0; }
.prose { white-space: pre-wrap; line-height: 1.5; }
.button { display: inline-block; border: 1px solid #c9c9d4; border-radius: 8px; padding: .4rem .8rem; text-decoration: none; margin-right: .5rem; }
.actions { margin: .8rem 0; }
.login { max-width: 320px; margin: 3rem auto; display: grid; gap: .6rem; background: #fff; border: 1px solid #e2e2ea; border-radius: 12px; padding: 1.5rem; }
@media (prefers-color-scheme: dark) { .login { background: #1d1d26; border-color: #2c2c38; } }
.login input { padding: .5rem .6rem; border: 1px solid #c9c9d4; border-radius: 8px; background: inherit; color: inherit; }
.error { color: #b3261e; margin: 0; }
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}
