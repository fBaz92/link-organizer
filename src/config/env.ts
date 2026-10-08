import { networkInterfaces } from "node:os";
import path from "node:path";

/*
 * Flow: accesso centralizzato alla configurazione. TUTTI i valori sensibili
 * (token bot, password, user id) vengono letti SOLO da variabili d'ambiente,
 * mai scritti nel codice. Le funzioni leggono process.env alla chiamata così
 * i test possono iniettare valori senza mutazioni globali fragili.
 */

/*
 * Cartella dati di Stash: db SQLite, file scaricati, thumbnail. In un
 * deploy HomeGate vince HOMEGATE_STATE_DIR (dati persistenti fuori dalla
 * release); in sviluppo si usa DATA_DIR o ./data.
 */
export function dataDir(): string {
  return (
    process.env.HOMEGATE_STATE_DIR?.trim() ||
    process.env.DATA_DIR?.trim() ||
    path.join(process.cwd(), "data")
  );
}

/**
 * Cartella della configurazione gestita: HomeGate espone il .env in
 * HOMEGATE_CONFIG_DIR; senza HomeGate si torna alla cwd del processo.
 */
export function configDir(): string {
  return process.env.HOMEGATE_CONFIG_DIR?.trim() || process.cwd();
}

/** Porta HTTP del visualizzatore incluso nel servizio. */
export const DEFAULT_SERVICE_PORT = 8787;

/**
 * Visualizzatore incluso nel servizio: attivo di default, disattivato con
 * STASH_VIEWER=0/off/false (nel container Docker la web UI è la webapp Next
 * completa e il processo gira in modalità solo-bot).
 */
export function viewerEnabled(): boolean {
  const value = (process.env.STASH_VIEWER ?? "").trim().toLowerCase();
  return !["0", "off", "false", "no"].includes(value);
}

/** PORT valida: intero 1024-65535, altrimenti il default del servizio. */
export function httpPort(): number {
  const raw = (process.env.PORT ?? "").trim();
  if (raw === "") return DEFAULT_SERVICE_PORT;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`PORT non valida: "${raw}" (atteso un intero tra 1024 e 65535)`);
  }
  return port;
}

/**
 * URL pubblico della web UI per i deep link del bot. Se non configurato si
 * stima dall'indirizzo LAN della macchina (primo IPv4 non interno), così i
 * link aprono il visualizzatore incluso nel servizio.
 */
export function guessWebAppUrl(port: number): string {
  const configured = process.env.WEB_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const lan = primaryLanIPv4();
  return `http://${lan ?? "localhost"}:${port}`;
}

function primaryLanIPv4(): string | undefined {
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const info of interfaces ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  return undefined;
}

export function telegramToken(): string | undefined {
  const token = process.env.BOT_TOKEN?.trim();
  return token ? token : undefined;
}

/** User ID Telegram autorizzati a interagire col bot (allowlist). */
export function allowedUserIds(): readonly number[] {
  return (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((id) => Number.parseInt(id.trim(), 10))
    .filter((id) => Number.isInteger(id) && id > 0);
}

/** Password della web UI; se assente l'auth va considerata disabilitata. */
export function webPassword(): string | undefined {
  const password = process.env.WEB_PASSWORD?.trim();
  return password ? password : undefined;
}

/** Base URL della web UI, usato dal bot per costruire i deep link. */
export function webAppUrl(): string {
  return (process.env.WEB_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** Eseguibile yt-dlp per il download dei video (default: cerca nel PATH). */
export function ytDlpPath(): string {
  return process.env.YTDLP_PATH?.trim() || "yt-dlp";
}

// ── Tag semantici (modello locale di embedding) ──────────────────────────

/** False solo con SEMANTIC_TAGS=0|off|false|no: per default è attivo. */
export function semanticTagsEnabled(): boolean {
  const value = (process.env.SEMANTIC_TAGS ?? "").trim().toLowerCase();
  return !["0", "off", "false", "no"].includes(value);
}

/** Override del modello di embedding (default dentro semantic-tags.ts). */
export function semanticTagsModel(): string | undefined {
  return process.env.SEMANTIC_TAGS_MODEL?.trim() || undefined;
}

/** Similarità coseno minima per suggerire un tag (default dentro il modulo). */
export function semanticTagsThreshold(): number | undefined {
  const value = Number.parseFloat((process.env.SEMANTIC_TAGS_THRESHOLD ?? "").trim());
  return Number.isFinite(value) && value > 0 && value < 1 ? value : undefined;
}

/** Massimo tag semantici per item (default dentro il modulo). */
export function semanticTagsTopK(): number | undefined {
  const value = Number.parseInt((process.env.SEMANTIC_TAGS_TOP_K ?? "").trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Chat Telegram che riceve i video scaricati dalla web UI. Default: il
 * primo user ID autorizzato (il proprietario, in un tool personale).
 */
export function telegramUploadChatId(): string | undefined {
  const explicit = process.env.TELEGRAM_UPLOAD_CHAT_ID?.trim();
  if (explicit) return explicit;
  return allowedUserIds()[0] !== undefined ? String(allowedUserIds()[0]) : undefined;
}
