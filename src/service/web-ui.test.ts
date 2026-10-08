import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNodeSqliteDatabase, type NodeSqliteClient } from "@/db/node-sqlite-driver";
import { migrate } from "@/db/migrate";
import { createRuntime, type StashRuntime } from "@/core/runtime";
import { startWebUi, type WebUiHandle } from "@/service/web-ui";

/*
 * Flow: test HTTP del visualizzatore incluso nel servizio. Si avvia su una
 * porta effimera con il driver node:sqlite e copre: auth con cookie firmato,
 * lista con ricerca/tag, dettaglio, thumbnail/file con guardia anti
 * path-traversal e logout. La password è generata a caso: nessuna
 * credenziale (né di test) nel sorgente.
 */

const PASSWORD = randomBytes(16).toString("hex");

let dir: string;
let client: NodeSqliteClient;
let runtime: StashRuntime;
let web: WebUiHandle;

async function start(withAuth: boolean): Promise<void> {
  web = await startWebUi(runtime, {
    port: 0,
    password: withAuth ? PASSWORD : undefined,
    dataRoot: dir,
    loginFailureDelayMs: 0,
  });
}

function url(pathname: string): string {
  return `http://127.0.0.1:${web.port}${pathname}`;
}

function seed(): number {
  mkdirSync(path.join(dir, "thumbs"), { recursive: true });
  writeFileSync(path.join(dir, "thumbs", "testhash.jpg"), Buffer.from("immagine-finta"));

  return runtime.items
    .insert({
      type: "video",
      url: "https://youtu.be/abc",
      canonicalUrl: "https://youtu.be/abc",
      title: "Video di prova",
      description: "Descrizione del video di prova",
      thumbnailPath: "thumbs/testhash.jpg",
      source: "telegram",
      tags: ["test", "video"],
    })
    .id;
}

async function login(): Promise<string> {
  const response = await fetch(url("/login"), {
    method: "POST",
    body: new URLSearchParams({ password: PASSWORD }),
    redirect: "manual",
  });
  expect(response.status).toBe(303);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  expect(cookie).toContain("stash_session=");
  return cookie!;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "stash-web-ui-"));
  const handle = openNodeSqliteDatabase(path.join(dir, "stash.db"));
  migrate(handle.raw);
  client = handle.raw as NodeSqliteClient;
  runtime = createRuntime(dir, handle);
});

afterEach(async () => {
  await web?.close();
  client?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("visualizzatore web senza password (uso locale)", () => {
  beforeEach(async () => {
    await start(false);
  });

  it("la lista mostra gli item con titolo e tag", async () => {
    seed();
    const response = await fetch(url("/"));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Video di prova");
    expect(html).toContain("#test");
    expect(html).toContain('href="/?tag=test"');
  });

  it("la ricerca FTS filtra la lista", async () => {
    seed();
    const hit = await fetch(url("/?q=descrizione"));
    expect(await hit.text()).toContain("Video di prova");
    const miss = await fetch(url("/?q=innesistente"));
    expect(await miss.text()).toContain("Nessun item");
  });

  it("il dettaglio contiene descrizione e link all'originale", async () => {
    const id = seed();
    const response = await fetch(url(`/item/${id}`));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Descrizione del video di prova");
    expect(html).toContain('href="https://youtu.be/abc"');
    expect(html).toContain("aggiunto");
  });

  it("item inesistente → 404", async () => {
    const response = await fetch(url("/item/9999"));
    expect(response.status).toBe(404);
  });

  it("la thumbnail è servita con il content type giusto", async () => {
    const id = seed();
    const response = await fetch(url(`/thumb/${id}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("immagine-finta");
  });

  it("percorsi che escono dalla cartella dati → 404 (anti path traversal)", async () => {
    const id = runtime.items
      .insert({ type: "link", url: "https://esempio.it", thumbnailPath: "../../etc/passwd", source: "telegram" })
      .id;
    const response = await fetch(url(`/thumb/${id}`));
    expect(response.status).toBe(404);
  });

  it("metodi non supportati → 405", async () => {
    const response = await fetch(url("/"), { method: "DELETE" });
    expect(response.status).toBe(405);
  });
});

describe("visualizzatore web con password (LAN)", () => {
  beforeEach(async () => {
    await start(true);
  });

  it("senza sessione si viene rediretti al login", async () => {
    seed();
    const response = await fetch(url("/"), { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
  });

  it("password errata → 401, password giusta → sessione e accesso", async () => {
    seed();
    const bad = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ password: "sbagliata" }),
    });
    expect(bad.status).toBe(401);

    const cookie = await login();
    const response = await fetch(url("/"), { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Video di prova");
  });

  it("logout invalida il cookie", async () => {
    seed();
    const cookie = await login();
    const out = await fetch(url("/logout"), { headers: { cookie }, redirect: "manual" });
    expect(out.status).toBe(302);
    const cleared = out.headers.get("set-cookie") ?? "";
    expect(cleared).toContain("Max-Age=0");

    const after = await fetch(url("/"), { headers: { cookie: cleared.split(";")[0] }, redirect: "manual" });
    expect(after.status).toBe(302);
    expect(after.headers.get("location")).toBe("/login");
  });

  it("il download del file richiede la sessione e forza il salvataggio", async () => {
    mkdirSync(path.join(dir, "files"), { recursive: true });
    writeFileSync(path.join(dir, "files", "doc.pdf"), Buffer.from("%PDF-finto"));
    runtime.items.insert({
      type: "documento",
      url: "https://esempio.it/doc.pdf",
      filePath: "files/doc.pdf",
      fileName: "relazione.pdf",
      mimeType: "application/pdf",
      source: "web",
    });

    const denied = await fetch(url("/file/1"), { redirect: "manual" });
    expect(denied.status).toBe(302);

    const cookie = await login();
    const response = await fetch(url("/file/1"), { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-disposition")).toContain("relazione.pdf");
  });
});
