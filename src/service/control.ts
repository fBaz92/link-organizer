import { createServer } from "node:http";
import type { StashRuntime } from "@/core/runtime";
import type { VideoDownloadInput } from "@/core/video-download";

/** Private loopback interface. The always-on worker owns video jobs across web sleeps. */
export async function startControl(runtime: StashRuntime, botState: () => string) {
  const port = Number(process.env.STASH_CONTROL_PORT);
  const token = process.env.STASH_CONTROL_TOKEN;
  if (!process.env.STASH_CONTROL_PORT || !Number.isInteger(port) || port < 0 || port > 65535 || !token) return undefined;
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401); response.end(); return;
    }
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      let result: unknown;
      if (url.pathname === "/health" && request.method === "GET") {
        runtime.db.raw.pragma("user_version", { simple: true });
        result = { status: "ok", bot: { state: botState() } };
      } else if (url.pathname === "/video-jobs" && request.method === "POST") {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 16_384) throw new Error("Request too large");
        }
        result = runtime.videoDownload.start(JSON.parse(body) as VideoDownloadInput);
      } else if (url.pathname.startsWith("/video-jobs/") && request.method === "GET") {
        result = runtime.videoDownload.get(url.pathname.slice("/video-jobs/".length)) ?? null;
      } else { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(result));
    } catch {
      response.writeHead(400); response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address() as { port: number };
  return { port: address.port, close: async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
