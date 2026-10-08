import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * Flow: controlli statici del contratto HomeGate: VERSION nel formato del
 * contratto, service.toml con i campi obbligari del profilo Docker
 * (immagine pinata a digest, porte, health) e coerenza dei campi obbligati
 * come HOMEGATE_IDLE_MINUTES. L'esecuzione reale del pacchetto è provata
 * da scripts/package-check.sh (bot) e scripts/docker-check.sh (container).
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUNDLE = path.join(REPO_ROOT, "dist", "main.js");

describe("contratto del pacchetto HomeGate (Docker)", () => {
  it("VERSION è una versione finale X.Y.Z senza prefisso v", () => {
    const version = readFileSync(path.join(REPO_ROOT, "VERSION"), "utf8").trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version.startsWith("v")).toBe(false);
  });

  it("service.toml dichiara il contratto Docker", () => {
    const manifest = readFileSync(path.join(REPO_ROOT, "service.toml"), "utf8");
    expect(manifest).toContain("schema = 1");
    expect(manifest).toContain('id = "link-organizer"');
    expect(manifest).toContain("description = ");
    expect(manifest).toContain('repository = "fBaz92/link-organizer"');
    expect(manifest).toContain('runtime = "docker"');
    expect(manifest).toContain('entrypoint = "service.toml"');
    expect(manifest).toContain('os = "linux"');
    expect(manifest).toContain("[[databases]]");
    expect(manifest).toMatch(/^\[container\]$/m);
    expect(manifest).toMatch(/^port = 3000$/m);
    expect(manifest).toMatch(/^proxy_port = \d{4,5}$/m);
    expect(manifest).toMatch(/^proxy_port = (10[2-9]\d{2}|[1-9]\d{4}|1\d{3}|[2-9]\d{3})$/m);
    expect(manifest).toContain('health_path = "/health"');

    // Il digest deve essere un SHA-256 completo, oppure il segnaposto in
    // attesa della prima release (il workflow docker-release lo pinna).
    const image = manifest.match(/^image = "ghcr\.io\/fbaz92\/link-organizer@(.+)"$/m)?.[1] ?? "";
    expect(image === "sha256:PENDING" || /^sha256:[0-9a-f]{64}$/.test(image)).toBe(true);

    // La descrizione radice: tra 10 e 600 caratteri, almeno tre parole.
    const description = manifest.match(/^description = "(.*)"$/m)?.[1] ?? "";
    expect(description.length).toBeGreaterThanOrEqual(10);
    expect(description.length).toBeLessThanOrEqual(600);
    expect(description.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(3);
  });

  it("HOMEGATE_IDLE_MINUTES ha tipo e vincoli richiesti dal contratto", () => {
    const manifest = readFileSync(path.join(REPO_ROOT, "service.toml"), "utf8");
    const block = manifest.match(
      /\[\[environment\]\]\nkey = "HOMEGATE_IDLE_MINUTES"\n([\s\S]*?)(?=\n\n\[\[|\n\[\[)/,
    )?.[1];
    expect(block).toBeDefined();
    expect(block).toContain('type = "integer"');
    expect(block).toContain("secret = false");
    expect(block).toContain("required = true");
    expect(block).toContain("parameter = true");
    expect(block).toMatch(/^min = 1$/m);
    expect(block).toMatch(/^max = 1440$/m);
    expect(block).toMatch(/^default = "\d+"$/m);
    const defaultValue = Number.parseInt(block!.match(/^default = "(\d+)"$/m)![1], 10);
    expect(defaultValue).toBeGreaterThanOrEqual(1);
    expect(defaultValue).toBeLessThanOrEqual(1440);
  });

  it("il database dichiarato resta lo stesso delle release 1.x (rollback)", () => {
    const manifest = readFileSync(path.join(REPO_ROOT, "service.toml"), "utf8");
    expect(manifest).toContain("[[databases]]");
    expect(manifest).toContain('path = "stash.db"');
    expect(manifest).toContain("user_version = 2");
    expect(manifest).toContain("items_tags = ");
  });

  it.skipIf(!existsSync(BUNDLE))("dist/main.js (bot del container) esiste, nei limiti e senza nativi", () => {
    const size = statSync(BUNDLE).size;
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(20 * 1024 * 1024);
    const bundle = readFileSync(BUNDLE, "utf8");
    // Il modulo nativo better-sqlite3 NON deve entrare nel bundle: il bot
    // usa node:sqlite anche nel container.
    expect(bundle).not.toContain("node_modules/.pnpm/better-sqlite3");
    expect(bundle).toContain("node:sqlite");
  });
});
