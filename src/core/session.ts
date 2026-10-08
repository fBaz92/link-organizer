import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * Flow: sessione cookie senza stato, condivisa dalla web UI Next e dal
 * visualizzatore incluso nel servizio. Il valore è `${expiry}.${hmac}`:
 * verificabile senza archivi, scadenza 30 giorni, confronto a tempo costante.
 * La password vive SOLO nella variabile WEB_PASSWORD.
 */

export const SESSION_COOKIE_NAME = "stash_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function sign(expiry: number, password: string): string {
  return createHmac("sha256", password).update(`stash:${expiry}`).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

export function createSessionValue(password: string): { value: string; maxAge: number } {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
  return { value: `${expiry}.${sign(expiry, password)}`, maxAge: SESSION_MAX_AGE_SECONDS };
}

export function verifySessionValue(value: string | undefined, password: string): boolean {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;

  const expiry = Number.parseInt(value.slice(0, dot), 10);
  const signature = value.slice(dot + 1);
  if (!Number.isInteger(expiry) || expiry < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(signature, sign(expiry, password));
}

/** Confronto password a tempo costante (hash intermedio: lunghezza costante). */
export function passwordMatches(candidate: string, expected: string): boolean {
  return safeEqual(createHmac("sha256", "stash-pw").update(candidate).digest("hex"),
    createHmac("sha256", "stash-pw").update(expected).digest("hex"));
}
