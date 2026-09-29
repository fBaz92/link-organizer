import path from "node:path";

/*
 * Flow: accesso centralizzato alla configurazione. TUTTI i valori sensibili
 * (token bot, password, user id) vengono letti SOLO da variabili d'ambiente,
 * mai scritti nel codice. Le funzioni leggono process.env alla chiamata così
 * i test possono iniettare valori senza mutazioni globali fragili.
 */

/** Cartella dati di Stash: db SQLite, file scaricati, thumbnail. */
export function dataDir(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), "data");
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

/**
 * Chat Telegram che riceve i video scaricati dalla web UI. Default: il
 * primo user ID autorizzato (il proprietario, in un tool personale).
 */
export function telegramUploadChatId(): string | undefined {
  const explicit = process.env.TELEGRAM_UPLOAD_CHAT_ID?.trim();
  if (explicit) return explicit;
  return allowedUserIds()[0] !== undefined ? String(allowedUserIds()[0]) : undefined;
}
