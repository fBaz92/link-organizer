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
    const runtime = getRuntime();
    const userVersion = runtime.db.raw.pragma("user_version", { simple: true });
    return Response.json({ status: "ok", user_version: userVersion, busy: runtime.ingestion.activeOperations > 0 });
  } catch (error) {
    return Response.json({ status: "error", error: String(error) }, { status: 503 });
  }
}
