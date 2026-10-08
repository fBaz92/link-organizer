import { getRuntime } from "@/core/get-runtime";

/*
 * Flow: health check pubblico richiesto dal contratto Docker di HomeGate:
 * restituisce 2xx soltanto quando l'app è pronta (database raggiungibile e
 * schema noto). Non richiede sessione: è l'endpoint che il gestore usa per
 * la readiness, prima dell'autenticazione.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const userVersion = getRuntime().db.raw.pragma("user_version", { simple: true });
    return Response.json({ status: "ok", user_version: userVersion });
  } catch (error) {
    return Response.json({ status: "error", error: String(error) }, { status: 503 });
  }
}
