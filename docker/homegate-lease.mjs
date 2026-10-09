import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

/** Linux stores the IPv4 gateway in little-endian hexadecimal. */
export function parseDefaultGateway(text) {
  for (const line of text.trim().split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields[1] !== "00000000" || !/^[0-9a-f]{8}$/i.test(fields[2] ?? "")) continue;
    if (!(parseInt(fields[3], 16) & 2) || fields[2] === "00000000") continue;
    return fields[2].match(/../g).reverse().map((byte) => parseInt(byte, 16)).join(".");
  }
  return null;
}

/** Hold one in-flight public proxy request while the guardian serves Telegram.
 * @param {{token: string, port?: number, path?: string, env?: Record<string, string | undefined>, log?: (level: string, event: string, summary: string) => void, signal?: AbortSignal}} options
 */
export function startHomeGateLease({ token, port = 8790, path = "/_stash/lease", env = process.env, log = () => {}, signal }) {
  let state = "disabled";
  let closed = false;
  let request;
  let response;
  let retry;
  let headerTimeout;
  let attempt = 0;
  const close = () => {
    closed = true;
    state = "disabled";
    clearTimeout(retry);
    clearTimeout(headerTimeout);
    response?.destroy();
    request?.destroy();
    signal?.removeEventListener("abort", close);
  };
  const handle = { close, status: () => state };
  if (!env.HOMEGATE_SERVICE_ID || signal?.aborted) return handle;
  signal?.addEventListener("abort", close, { once: true });

  let base = env.STASH_HOMEGATE_PROXY_URL;
  if (!base) {
    try {
      const gateway = parseDefaultGateway(readFileSync("/proc/net/route", "utf8"));
      if (gateway) base = `http://${gateway}:${port}`;
    } catch { /* Standalone/non-Linux discovery can use WEB_APP_URL. */ }
    base ||= env.WEB_APP_URL;
  }
  let url;
  try {
    url = new URL(path, base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !token) throw new Error("invalid configuration");
  } catch {
    state = "failed";
    log("warn", "homegate_lease_failed", "Impossibile individuare il proxy HomeGate");
    return handle;
  }

  function connect() {
    if (closed) return;
    state = "connecting";
    let settled = false;
    const fail = () => {
      if (settled || closed) return;
      settled = true;
      clearTimeout(headerTimeout);
      response?.destroy();
      request?.destroy();
      state = "failed";
      log("warn", "homegate_lease_failed", "Connessione al proxy HomeGate interrotta; nuovo tentativo automatico");
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5));
      retry = setTimeout(connect, wait);
      retry.unref?.();
    };
    request = (url.protocol === "https:" ? https : http).get(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
    }, (incoming) => {
      response = incoming;
      clearTimeout(headerTimeout);
      if (incoming.statusCode !== 200 || !incoming.headers["content-type"]?.startsWith("text/event-stream")) return fail();
      state = "active";
      attempt = 0;
      log("info", "homegate_lease_active", "Ricezione Telegram mantenuta attiva tramite il proxy HomeGate");
      incoming.on("error", fail);
      incoming.on("end", fail);
      incoming.on("close", fail);
      incoming.resume();
    });
    request.on("error", fail);
    headerTimeout = setTimeout(fail, 5000);
    headerTimeout.unref?.();
  }
  connect();
  return handle;
}
