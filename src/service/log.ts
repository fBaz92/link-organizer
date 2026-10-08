/*
 * Flow: log strutturati del servizio HomeGate. Ogni evento è UN oggetto JSON
 * completo su UNA riga (niente pretty printing), con `event` come
 * identificatore stabile e `summary` leggibile: la dashboard di HomeGate
 * mostra ogni campo nei dettagli. Le chiavi che profumano di segreto
 * (token, password, secret…) vengono oscurate prima della serializzazione.
 * Un traceback può restare testo libero.
 */

export type LogLevel = "info" | "warn" | "error";

const SECRET_KEY_PATTERN = /token|password|secret|authorization|cookie/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[…]";
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    // Oscura solo i VALORI testuale sotto chiavi che sembrano segreti:
    // booleani e numeri (has_token: false, allowed_count: 0) restano leggibili.
    output[key] =
      SECRET_KEY_PATTERN.test(key) && typeof item === "string" ? "[redatto]" : scrub(item, depth + 1);
  }
  return output;
}

export function structuredLine(
  level: LogLevel,
  event: string,
  summary: string,
  fields?: Record<string, unknown>,
): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    summary,
    ...(fields ? (scrub(fields) as Record<string, unknown>) : {}),
  });
}

export function logEvent(
  level: LogLevel,
  event: string,
  summary: string,
  fields?: Record<string, unknown>,
): void {
  const line = structuredLine(level, event, summary, fields);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
