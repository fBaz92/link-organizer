import { isAuthenticated } from "@/lib/auth";

/*
 * Flow: keepalive SSE del contratto Docker di HomeGate: le connessioni in
 * corso (incluse SSE) impediscono il riposo del container. Finché una
 * scheda della webapp è aperta, il bot Telegram resta attivo. Un commento
 * ogni 15 s (sotto il timeout di lettura di 30 s del proxy). Richiede la
 * sessione come le altre route API.
 */

export const dynamic = "force-dynamic";

const KEEPALIVE_MS = 15_000;

export async function GET(): Promise<Response> {
  if (!(await isAuthenticated())) {
    return new Response("Non autorizzato", { status: 401 });
  }

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const tick = () => controller.enqueue(encoder.encode(": keepalive\n\n"));
      tick();
      timer = setInterval(tick, KEEPALIVE_MS);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
    },
  });
}
