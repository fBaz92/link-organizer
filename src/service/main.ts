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
  viewerEnabled,
  webPassword,
} from "@/config/env";
import { migrate } from "@/db/migrate";
import { openNodeSqliteDatabase } from "@/db/node-sqlite-driver";
import { createRuntime, type StashRuntime } from "@/core/runtime";
import { backfillThumbnails } from "@/core/thumbnail-backfill";
import { BOT_COMMANDS, createStashBot } from "@/bot/stash-bot";
import { startTelegramInbox } from "@/service/telegram-inbox";
import { logEvent } from "@/service/log";
import { startWebUi, type WebUiHandle } from "@/service/web-ui";
import { startControl } from "@/service/control";

/*
 * Flow: entrypoint del processo "bot" del servizio. Due modalità:
 *
 * - completa (default, runtime node di HomeGate o sviluppo): visualizzatore
 *   web leggero su PORT + bot Telegram;
 * - solo-bot (STASH_VIEWER=0, usata dal container Docker dove la web UI è
 *   la webapp Next completa in un processo separato): nessuna porta pubblica;
 *   un controllo privato su loopback gestisce readiness e job video.
 *
 * Arresto ordinato su SIGINT/SIGTERM entro i 10 secondi richiesti dal
 * contratto Docker (bot → web → checkpoint WAL → chiusura DB → exit 0,
 * con uscita forzata di sicurezza a 7 s).
 */

const FORCE_EXIT_MS = 7_000;

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
  const withViewer = viewerEnabled();
  let port: number | undefined;
  if (withViewer) {
    try {
      port = httpPort();
    } catch (error) {
      logEvent("error", "config_invalid", "Configurazione non valida, arresto", { error });
      process.exit(1);
    }
  }

  const stateDir = dataDir();
  logEvent("info", "service_starting", "Avvio del servizio Stash", {
    version,
    node: process.version,
    pid: process.pid,
    dataDir: stateDir,
    configDir: configDir(),
    viewer: withViewer,
    ...(port !== undefined ? { port } : {}),
  });

  const handle = openNodeSqliteDatabase();
  migrate(handle.raw);
  const userVersion = handle.raw.pragma("user_version", { simple: true });
  logEvent("info", "db_ready", "Database pronto", { file: "stash.db", user_version: userVersion });

  const runtime: StashRuntime = createRuntime(stateDir, handle);

  let web: WebUiHandle | undefined;
  let webAppUrl: string;
  if (withViewer) {
    web = await startWebUi(runtime, {
      port: port!,
      password: webPassword(),
      dataRoot: stateDir,
    });
    webAppUrl = guessWebAppUrl(web.port);
    logEvent("info", "web_listening", "Visualizzatore web in ascolto", {
      port: web.port,
      bind: "0.0.0.0",
      url: webAppUrl,
      auth: webPassword() !== undefined,
    });
  } else {
    // Modalità solo-bot (container): la web UI è la webapp Next esterna.
    // L'URL per i deep link si stima dalla porta della webapp se nota.
    webAppUrl = guessWebAppUrl(Number.parseInt((process.env.WEB_APP_PORT ?? "3000"), 10) || 3000);
    logEvent("info", "viewer_disabled", "Visualizzatore interno disattivato: la web UI è la webapp Next");
  }

  let botState = "starting";
  const control = await startControl(runtime, () => botState);
  const closeable = [web, control].filter((handle): handle is WebUiHandle => handle !== undefined);
  const token = telegramToken();
  const allowed = allowedUserIds();
  if (!token || allowed.length === 0) {
    if (!withViewer && !control) {
      // Senza web di risparmio, un servizio solo-bot senza credenziali non
      // fa nulla: meglio fallire subito e rumorosamente.
      logEvent(
        "error",
        "bot_config_missing",
        "Modalità solo-bot senza BOT_TOKEN e TELEGRAM_ALLOWED_USER_IDS: configurazione incompleta, arresto",
        { has_token: Boolean(token), allowed_count: allowed.length },
      );
      handle.raw.close();
      process.exit(1);
    }
    botState = "disabled";
    logEvent(
      "warn",
      "bot_disabled",
      "Bot Telegram non avviato: servono BOT_TOKEN e TELEGRAM_ALLOWED_USER_IDS; archivio web disponibile",
      { has_token: Boolean(token), allowed_count: allowed.length },
    );
    installShutdown(runtime, closeable, undefined);
    return;
  }

  const bot = createStashBot(token, {
    runtime,
    allowedUserIds: allowed,
    webAppUrl,
    botToken: token,
  });
  const intake: { started?: Promise<Awaited<ReturnType<typeof startTelegramInbox>>> } = {};
  const isStopping = installShutdown(runtime, closeable, async () => {
    const inbox = await intake.started?.catch(() => undefined);
    await inbox?.stop();
  });
  try {
    await bot.api.setMyCommands(BOT_COMMANDS.map((command) => ({ ...command })));
  } catch (error) {
    logEvent("warn", "bot_commands_failed", "Registrazione dei comandi non riuscita (si prosegue)", { error });
  }

  if (isStopping()) return;
  intake.started = startTelegramInbox(bot, handle.raw, {
    onStart: () => {
      botState = "running";
      logEvent("info", "bot_started", "Bot Telegram avviato (coda persistente)", {
        allowed_users: allowed.length,
        upload_chat_configured: process.env.TELEGRAM_UPLOAD_CHAT_ID !== undefined,
      });
    },
    onError: (error) => logEvent("error", "bot_update_retry", "Errore Telegram: aggiornamento conservato e ritentato", { error }),
  });
  void intake.started.catch((error) => {
    if (isStopping()) return;
    botState = "failed";
    logEvent("error", "bot_start_failed", "Avvio del bot non riuscito: verificare BOT_TOKEN e rete", { error });
    process.exit(1);
  });

  startThumbnailBackfill(runtime);
}

/**
 * Il backfill delle thumbnail gira in background: una scansione all'avvio
 * (recupera le thumbnail mancate in passato) e poi una ogni 6 ore (riprende
 * gli item arrivati mentre la rete era giù). I fallimenti si ritentano al
 * run successivo; l'arresto del servizio non lo attende.
 */
function startThumbnailBackfill(runtime: StashRuntime): void {
  const INTERVAL_MS = 6 * 60 * 60 * 1000;

  const run = (trigger: string): void => {
    void backfillThumbnails(runtime, {
      onItem: (result) => {
        if (!result.ok) {
          logEvent("warn", "thumb_backfill_item_failed", "Thumbnail non recuperabile per un item", {
            item_id: result.itemId,
            via: result.via,
            error: result.error,
          });
        }
      },
    })
      .then((summary) => {
        if (summary.scanned > 0) {
          logEvent("info", "thumb_backfill_done", "Backfill delle thumbnail completato", {
            trigger,
            scanned: summary.scanned,
            fetched: summary.fetched,
            failed: summary.failed,
          });
        }
      })
      .catch((error) => {
        logEvent("error", "thumb_backfill_failed", "Backfill delle thumbnail interrotto da un errore", {
          trigger,
          error,
        });
      });
  };

  run("startup");
  const timer = setInterval(() => run("periodic"), INTERVAL_MS);
  timer.unref();
}

function installShutdown(runtime: StashRuntime, web: WebUiHandle[], stopIntake: (() => Promise<void>) | undefined): () => boolean {
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

    const botStopped = stopIntake?.() ?? Promise.resolve();
    const webClosed = Promise.all(web.map(handle => handle.close()));
    void Promise.allSettled([botStopped, webClosed])
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
  return () => stopping;
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
