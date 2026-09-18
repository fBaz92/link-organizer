import { readFileSync } from "node:fs";
import path from "node:path";

/*
 * Flow: caricatore .env minimale (zero dipendenze) per i processi che non
 * passano da Next.js — il worker del bot e gli script CLI. Next.js legge già
 * .env da solo. Regole: KEY=VALUE, commenti #, quoting opzionale; NON
 * sovrascrive variabili già presenti nell'ambiente.
 */
export function loadDotEnv(file = path.join(process.cwd(), ".env")): void {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return; // nessun .env: si va solo di variabili d'ambiente reali
  }

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const withoutExport = line.replace(/^export\s+/, "");
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
