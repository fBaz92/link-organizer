import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { webPassword } from "@/config/env";

/*
 * Flow: auth minima della web UI. La password vive SOLO in WEB_PASSWORD.
 * Il cookie di sessione è `${expiry}.${hmac(expiry, password)}`: verificabile
 * senza stato, scadenza 30 giorni, confronto a tempo costante. Se la password
 * non è configurata l'auth è disabilitata (installazione locale senza LAN).
 *
 * requireAuth() → pagine (redirect a /login)
 * isAuthenticated() → route handlers e server actions (boolean)
 */

const COOKIE_NAME = "stash_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function authEnabled(): boolean {
  return webPassword() !== undefined;
}

function sign(expiry: number, password: string): string {
  return createHmac("sha256", password).update(`stash:${expiry}`).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

export function createSessionValue(password: string): { value: string; maxAge: number } {
  const expiry = Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS;
  return { value: `${expiry}.${sign(expiry, password)}`, maxAge: MAX_AGE_SECONDS };
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

export async function isAuthenticated(): Promise<boolean> {
  if (!authEnabled()) return true;
  const store = await cookies();
  return verifySessionValue(store.get(COOKIE_NAME)?.value, webPassword()!);
}

/** Guard per le pagine: senza sessione si viene rimandati al login. */
export async function requireAuth(): Promise<void> {
  if (!(await isAuthenticated())) redirect("/login");
}

/** Guard per le server actions e le route API. */
export async function assertAuthenticated(): Promise<boolean> {
  return isAuthenticated();
}

export async function setSessionCookie(): Promise<void> {
  const { value, maxAge } = createSessionValue(webPassword()!);
  const store = await cookies();
  store.set(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "lax",
    maxAge,
    path: "/",
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}
