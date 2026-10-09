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
  if (typeof value === "string") {
    let redacted = value.replace(/\/bot\d+:[A-Za-z0-9_-]+/g, "/bot[redatto]");
    for (const key of ["BOT_TOKEN", "WEB_PASSWORD"]) {
      const secret = process.env[key]?.trim();
      if (secret) redacted = redacted.split(secret).join("[redatto]");
    }
    return redacted;
  }
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) {
    const output: Record<string, unknown> = {
      name: scrub(value.name, depth + 1), message: scrub(value.message, depth + 1),
    };
    // HttpError di grammY conserva la causa in `error`, fetch in `cause`.
    // Selezione esplicita: non serializzare payload, header, stack o richieste.
    for (const key of ["error", "cause", "code", "errno", "syscall", "hostname", "address", "port", "type", "error_code"]) {
      if (key in value) {
        output[key] = scrub((value as unknown as Record<string, unknown>)[key], depth + 1);
      }
    }
    return output;
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
