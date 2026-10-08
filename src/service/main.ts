import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadDotEnv } from "@/config/dotenv";
import {
  allowedUserIds,
  configDir,
  dataDir,
  guessWebAppUrl,
  httpPort,
  telegramToken,
  webPassword,
} from "@/config/env";
import { migrate } from "@/db/migrate";
import { openNodeSqliteDatabase } from "@/db/node-sqlite-driver";
import { createRuntime, type StashRuntime } from "@/core/runtime";
import { BOT_COMMANDS, createStashBot } from "@/bot/stash-bot";
import type { Bot } from "grammy";
import { logEvent } from "@/service/log";
import { startWebUi, type WebUiHandle } from "@/service/web-ui";

/*
 * Flow: entrypoint unico del servizio HomeGate (dist/main.js). Nessuna
 * dipendenza nativa e nessun node_modules: tutto il necessario è nel bundle
 * (SQLite arriva da node:sqlite, integrato in Node ≥ 22.13).
 *
 * 1. carica il .env dalla configurazione gestita (HOMEGATE_CONFIG_DIR) o cwd;
 * 2. apre/migra il database nella cartella dati (HOMEGATE_STATE_DIR);
 * 3. avvia il visualizzatore web sulla PORT configurata;
 * 4. avvia il bot Telegram se token e allowlist ci sono (altrimenti resta
 *    solo la web, con un avviso nei log);
 * 5. arresto ordinato su SIGTERM/SIGTERM: chiude bot e web, checkpoint del
 *    WAL e chiusura del database, exit 0 (exit 1 di sicurezza dopo 20 s).
 */

const FORCE_EXIT_MS = 20_000;

async function serviceVersion(): Promise<string> {
  // Nel bundle il riferimento è dist/main.js → ../VERSION (radice release);
  // sotto tsx import.meta.url può non essere risolvibile, quindi si ripiega
  // sul percorso dello script in argv (src/service/main.ts → ../VERSION).
  const candidates = [
    fileURLToPath(new URL("../VERSION", import.meta.url)),
    path.resolve(path.dirname(process.argv[1] ?? ""), "../VERSION"),
    // Con tsx argv[1] è il runner: gli script npm partono dalla radice del repo.
    path.join(process.cwd(), "VERSION"),
  ];
  for (const candidate of candidates) {
    try {
      const version = (await readFile(candidate, "utf8")).trim();
      if (version) return version;
    } catch {
      // prova il candidato successivo
    }
  }
  return "sconosciuta";
}

async function main(): Promise<void> {
  loadDotEnv(path.join(configDir(), ".env"));
  loadDotEnv(path.join(process.cwd(), ".env"));

  const version = await serviceVersion();
  let port: number;
  try {
    port = httpPort();
  } catch (error) {
    logEvent("error", "config_invalid", "Configurazione non valida, arresto", { error });
    process.exit(1);
  }

  const stateDir = dataDir();
  logEvent("info", "service_starting", "Avvio del servizio Stash", {
    version,
    node: process.version,
    pid: process.pid,
    dataDir: stateDir,
    configDir: configDir(),
    port,
  });

  const handle = openNodeSqliteDatabase();
  migrate(handle.raw);
  const userVersion = handle.raw.pragma("user_version", { simple: true });
  logEvent("info", "db_ready", "Database pronto", { file: "stash.db", user_version: userVersion });

  const runtime: StashRuntime = createRuntime(stateDir, handle);

  const web = await startWebUi(runtime, {
    port,
    password: webPassword(),
    dataRoot: stateDir,
  });
  const webAppUrl = guessWebAppUrl(web.port);
  logEvent("info", "web_listening", "Visualizzatore web in ascolto", {
    port: web.port,
    bind: "0.0.0.0",
    url: webAppUrl,
    auth: webPassword() !== undefined,
  });

  const token = telegramToken();
  const allowed = allowedUserIds();
  if (!token || allowed.length === 0) {
    logEvent(
      "warn",
      "bot_disabled",
      "Bot Telegram non avviato: servono BOT_TOKEN e TELEGRAM_ALLOWED_USER_IDS nel .env; resta attivo solo il visualizzatore web",
      { has_token: Boolean(token), allowed_count: allowed.length },
    );
    installShutdown(runtime, web, undefined);
    return;
  }

  const bot = createStashBot(token, {
    runtime,
    allowedUserIds: allowed,
    webAppUrl,
    botToken: token,
  });
  bot.catch((error) => {
    logEvent("error", "bot_update_failed", "Errore nella gestione di un aggiornamento Telegram", {
      error: error.error,
    });
  });

  try {
    await bot.api.setMyCommands(BOT_COMMANDS.map((command) => ({ ...command })));
  } catch (error) {
    logEvent("warn", "bot_commands_failed", "Registrazione dei comandi non riuscita (si prosegue)", { error });
  }

  bot
    .start()
    .then(() => logEvent("info", "bot_stopped", "Polling del bot terminato"))
    .catch((error) => {
      logEvent("error", "bot_start_failed", "Avvio del bot non riuscito: verificare BOT_TOKEN e rete", { error });
      process.exit(1);
    });
  logEvent("info", "bot_started", "Bot Telegram avviato (long polling)", {
    allowed_users: allowed.length,
    upload_chat_configured: process.env.TELEGRAM_UPLOAD_CHAT_ID !== undefined,
  });

  installShutdown(runtime, web, bot);
}

function installShutdown(runtime: StashRuntime, web: WebUiHandle, bot: Bot | undefined): void {
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logEvent("info", "service_stopping", `Arresto richiesto (${signal})`);

    const force = setTimeout(() => {
      logEvent("error", "service_stop_forced", "Arresto ordinato troppo lento, uscita forzata");
      process.exit(1);
    }, FORCE_EXIT_MS);
    force.unref();

    const botStopped = bot ? bot.stop() : Promise.resolve();
    void Promise.allSettled([botStopped, web.close()])
      .then(async () => {
        try {
          // Checkpoint del WAL: file principale coerente anche per un backup a
          // caldo fatto poco prima dell'arresto.
          runtime.db.raw.pragma("wal_checkpoint(TRUNCATE)");
        } catch {
          // non fatale: close() fa comunque il checkpoint
        }
        runtime.db.raw.close();
        logEvent("info", "service_stopped", "Servizio arrestato in modo ordinato");
        clearTimeout(force);
        process.exit(0);
      })
      .catch(() => process.exit(1));
  };

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}

process.on("uncaughtException", (error) => {
  logEvent("error", "uncaught_exception", "Eccezione non gestita, arresto del processo", { error });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logEvent("error", "unhandled_rejection", "Promise rifiutata non gestita, arresto del processo", {
    error: reason,
  });
  process.exit(1);
});

void main();
