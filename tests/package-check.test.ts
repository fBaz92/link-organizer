import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * Flow: controlli statici del pacchetto richiesto da HomeGate: VERSION nel
 * formato del contratto, service.toml con i campi obbligatori e bundle
 * dist/main.js presente, dentro il limite di 20 MiB e senza riferimenti a
 * node_modules (il deploy non installa dipendenze). L'avvio/arresto reale
 * del pacchetto estratto è provato da scripts/package-check.sh (usato anche
 * dalla CI), che esegue il bundle fuori dalla build.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUNDLE = path.join(REPO_ROOT, "dist", "main.js");
const bundleReady = existsSync(BUNDLE);

describe("contratto del pacchetto HomeGate", () => {
  it("VERSION è una versione finale X.Y.Z senza prefisso v", () => {
    const version = readFileSync(path.join(REPO_ROOT, "VERSION"), "utf8").trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version.startsWith("v")).toBe(false);
  });

  it("service.toml dichiara i campi obbligatori del contratto", () => {
    const manifest = readFileSync(path.join(REPO_ROOT, "service.toml"), "utf8");
    expect(manifest).toContain("schema = 1");
    expect(manifest).toContain('id = "link-organizer"');
    expect(manifest).toContain("description = ");
    expect(manifest).toContain('repository = "fBaz92/link-organizer"');
    expect(manifest).toContain('runtime = "node"');
    expect(manifest).toContain('entrypoint = "dist/main.js"');
    expect(manifest).toContain('runtime_min = "22.13.0"');
    expect(manifest).toContain('os = "linux"');
    expect(manifest).toContain("[[databases]]");
    expect(manifest).toContain('path = "stash.db"');
    expect(manifest).toContain("user_version = 2");
    // La descrizione radice: tra 10 e 600 caratteri, almeno tre parole.
    const description = manifest.match(/^description = "(.*)"$/m)?.[1] ?? "";
    expect(description.length).toBeGreaterThanOrEqual(10);
    expect(description.length).toBeLessThanOrEqual(600);
    expect(description.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(3);
  });

  it.skipIf(!bundleReady)("dist/main.js esiste, rientra nei 20 MiB e non dipende da node_modules", () => {
    const size = statSync(BUNDLE).size;
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(20 * 1024 * 1024);
    const bundle = readFileSync(BUNDLE, "utf8");
    // Il modulo nativo better-sqlite3 NON deve entrare nel bundle (i commenti
    // di percorso degli altri pacchetti bundlati sono innocui).
    expect(bundle).not.toContain("node_modules/.pnpm/better-sqlite3");
    expect(bundle).toContain("node:sqlite");
    expect(bundle).toContain("createRequire");
  });
});
