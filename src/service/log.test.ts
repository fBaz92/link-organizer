import { describe, expect, it, vi } from "vitest";
import { logEvent, structuredLine } from "./log";

/*
 * Flow: test del logger strutturato richiesto da HomeGate: UNA riga JSON
 * completa per evento, campi `event` e `summary` stabili, nessun segreto.
 */

describe("logger strutturato", () => {
  it("produce una sola riga JSON con ts, level, event e summary", () => {
    const line = structuredLine("info", "service_starting", "Avvio del servizio Stash", {
      version: "1.0.0",
      port: 8787,
    });
    expect(line).not.toContain("\n");

    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.level).toBe("info");
    expect(parsed.event).toBe("service_starting");
    expect(parsed.summary).toBe("Avvio del servizio Stash");
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.port).toBe(8787);
    expect(typeof parsed.ts).toBe("string");
  });

  it("i valori multilinea restano su una riga (escape JSON)", () => {
    const line = structuredLine("error", "x", "a\nb\n", { detail: "prima\nseconda" });
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line).detail).toBe("prima\nseconda");
  });

  it("oscura le chiavi che sembrano segreti", () => {
    const line = structuredLine("info", "e", "s", {
      BOT_TOKEN: "123:segreto",
      password: "ciao",
      apiAuthorization: "xyz",
      port: 8787,
      has_token: false,
      allowed_count: 0,
    });
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.BOT_TOKEN).toBe("[redatto]");
    expect(parsed.password).toBe("[redatto]");
    expect(parsed.apiAuthorization).toBe("[redatto]");
    expect(parsed.port).toBe(8787);
    // I non-stringa sotto chiavi sospette restano leggibili: sono contatori.
    expect(parsed.has_token).toBe(false);
    expect(parsed.allowed_count).toBe(0);
  });

  it("serializza gli Error senza stack rumorosi e scrive su console per livello", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoLog = vi.spyOn(console, "log").mockImplementation(() => {});

    logEvent("error", "boom", "fallito", { error: new Error("andato male") });
    logEvent("warn", "attenzione", "occhio");
    logEvent("info", "ok", "tutto bene");

    const errorLine = JSON.parse(errorLog.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(errorLine.error).toEqual({ name: "Error", message: "andato male" });
    expect(warnLog).toHaveBeenCalledOnce();
    expect(infoLog).toHaveBeenCalledOnce();

    errorLog.mockRestore();
    warnLog.mockRestore();
    infoLog.mockRestore();
  });
});
