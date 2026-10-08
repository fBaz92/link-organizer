import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { webPassword } from "@/config/env";
import {
  SESSION_COOKIE_NAME,
  createSessionValue,
  verifySessionValue,
} from "@/core/session";

/*
 * Flow: auth minima della web UI Next. La logica di firma/verifica della
 * sessione vive in core/session.ts (pura, senza Next) così è condivisa col
 * visualizzatore del servizio HomeGate; qui restano solo i binding a
 * next/headers. Se WEB_PASSWORD non è configurata l'auth è disabilitata.
 *
 * requireAuth() → pagine (redirect a /login)
 * isAuthenticated() → route handlers e server actions (boolean)
 */

export { createSessionValue, verifySessionValue } from "@/core/session";

export function authEnabled(): boolean {
  return webPassword() !== undefined;
}

export async function isAuthenticated(): Promise<boolean> {
  if (!authEnabled()) return true;
  const store = await cookies();
  return verifySessionValue(store.get(SESSION_COOKIE_NAME)?.value, webPassword()!);
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
  store.set(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "lax",
    maxAge,
    path: "/",
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE_NAME);
}
