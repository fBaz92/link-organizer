import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { parseDefaultGateway, startHomeGateLease } from "../docker/homegate-lease.mjs";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

describe("HomeGate proxy lease", () => {
  it("decodes only a valid default gateway route", () => {
    expect(parseDefaultGateway("Iface Destination Gateway Flags\neth0 00000000 010011AC 0003 0 0 0 00000000")).toBe("172.17.0.1");
    expect(parseDefaultGateway("eth0 00000000 00000000 0001")).toBeNull();
    expect(parseDefaultGateway("eth0 000011AC 010011AC 0003")).toBeNull();
  });

  it("is disabled outside HomeGate", () => {
    const lease = startHomeGateLease({ token: "secret", env: { NODE_ENV: "test" } });
    expect(lease.status()).toBe("disabled");
    lease.close();
  });

  it("holds the SSE request, reconnects, and releases it on close", async () => {
    let connections = 0;
    let current: http.ServerResponse;
    let active = 0;
    const server = http.createServer((req, res) => {
      expect(req.url).toBe("/_stash/lease");
      expect(req.headers.authorization).toBe("Bearer test-secret");
      connections++;
      active++;
      current = res;
      res.on("close", () => active--);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": alive\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const address = server.address() as { port: number };
    const lease = startHomeGateLease({ token: "test-secret", env: { NODE_ENV: "test", HOMEGATE_SERVICE_ID: "stash", STASH_HOMEGATE_PROXY_URL: `http://127.0.0.1:${address.port}` } });
    cleanup.unshift(() => lease.close());
    await waitFor(() => lease.status() === "active");
    expect(active).toBe(1);
    current!.end();
    await waitFor(() => connections === 2 && lease.status() === "active");
    lease.close();
    await waitFor(() => active === 0);
    expect(connections).toBe(2);
  });
});

async function waitFor(predicate: () => boolean) {
  const until = Date.now() + 3500;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("Condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
