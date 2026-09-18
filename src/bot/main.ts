import { logger } from "@/core/logger";
import { getRuntime } from "@/core/runtime";
import { allowedUserIds, telegramToken, webAppUrl } from "@/config/env";
import { loadDotEnv } from "@/config/dotenv";
import { BOT_COMMANDS, createStashBot } from "@/bot/stash-bot";

/*
 * Flow: entrypoint del worker bot (processo separato dalla web app).
 * 1. carica .env (Next.js non c'è qui), legge token e allowlist;
 * 2. rifiuta di partire senza token o senza allowlist: il bot è privato;
 * 3. registra il menu dei comandi e avvia il long polling;
 * 4. shutdown graceful su SIGINT/SIGTERM.
 */
async function main(): Promise<void> {
  loadDotEnv();

  const token = telegramToken();
  if (!token) {
    logger.error("BOT_TOKEN mancante: crea un bot con @BotFather e mettilo in .env (vedi .env.example).");
    process.exit(1);
  }
  const allowed = allowedUserIds();
  if (allowed.length === 0) {
    logger.error("TELEGRAM_ALLOWED_USER_IDS vuoto: il bot è privato, serve almeno il tuo user ID.");
    process.exit(1);
  }

  const runtime = getRuntime();
  const bot = createStashBot(token, {
    runtime,
    allowedUserIds: allowed,
    webAppUrl: webAppUrl(),
    botToken: token,
  });

  bot.catch((error) => {
    logger.error("Errore non gestito nel bot:", error.error);
  });

  await bot.api.setMyCommands(BOT_COMMANDS.map((command) => ({ ...command })));
  logger.info("Comandi registrati. Long polling avviato.");

  void bot.start();

  const stop = (): void => {
    logger.info("Arresto del bot…");
    void bot.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

void main();
