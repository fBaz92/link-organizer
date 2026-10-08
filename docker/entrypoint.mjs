import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

/*
 * Flow: supervisor PID-1 del container (contratto Docker di HomeGate).
 * Avvia e supervisiona i due processi del servizio:
 *
 *   web: la webapp Next completa (server.js standalone) su 0.0.0.0:$PORT —
 *        processo primario: la readiness HTTP (/health) è la sua;
 *   bot: il worker Telegram (bundle node:sqlite, visualizzatore off) —
 *        secondario: se esce per config errata o token invalido il
 *        container resta su e il problema è visibile nei log.
 *
 * Regole del contratto rispettate qui:
 * - SIGTERM/SIGINT → arresto ordinato di entrambi entro ~7 s, poi SIGKILL,
 *   exit 0 (il gestore concede 10 secondi);
 * - la morte del processo primario ferma il container e propaga il codice:
 *   HomeGate ritenta l'avvio con backoff ≥ 30 s;
 * - UID/GID non root assegnati da HomeGate: nessuno USER nominato; le
 *   scritture runtime vanno solo su /tmp e /data (rootfs in sola lettura);
 * - log su stdout/stderr, eventi del supervisor come JSON su una riga.
 */

const KILL_GRACE_MS = 7_000;

function logEvent(level, event, summary, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, summary, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// Cache di Next su spazio scrivibile (symlink creato a build time verso
// /tmp/next-cache): la directory esiste sempre, anche dopo un reset di /tmp.
mkdirSync("/tmp/next-cache", { recursive: true });

const children = new Map();
let shuttingDown = false;
let webExitCode = 0;

function startProcess(name, command, args, options, critical) {
  const child = spawn(command, args, {
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
    ...options,
  });
  children.set(name, child);
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (shuttingDown) return;
    if (critical) {
      logEvent("error", "child_exited", `Processo primario "${name}" terminato inaspettatamente`, {
        process: name,
        code,
        signal,
      });
      webExitCode = code ?? 1;
      shutdown("child-exited");
    } else {
      logEvent(
        "warn",
        "worker_exited",
        `Processo secondario "${name}" terminato: la webapp resta attiva, controllare i log e riavviare il servizio dopo aver corretto la configurazione`,
        { process: name, code, signal },
      );
    }
  });
  return child;
}

function forwardSignal(child, signal) {
  if (child && child.exitCode === null && !child.killed) {
    try {
      child.kill(signal);
    } catch {
      // già morto: ignora
    }
  }
}

let shutdownPromise;
function shutdown(reason) {
  if (shuttingDown) return shutdownPromise;
  shuttingDown = true;
  logEvent("info", "container_stopping", "Arresto del container richiesto", { reason });

  shutdownPromise = (async () => {
    for (const child of children.values()) forwardSignal(child, "SIGTERM");
    const deadline = Date.now() + KILL_GRACE_MS;
    while (children.size > 0 && Date.now() < deadline) {
      await delay(100);
    }
    for (const child of children.values()) {
      forwardSignal(child, "SIGKILL");
    }
    logEvent("info", "container_stopped", "Container arrestato", { reason });
    // Su segnale (docker stop) uscita pulita; se è morto il processo
    // primario si propaga il suo codice per il retry di HomeGate.
    process.exit(reason === "shutdown-signal" ? 0 : webExitCode || 1);
  })();
  return shutdownPromise;
}

process.on("SIGTERM", () => shutdown("shutdown-signal"));
process.on("SIGINT", () => shutdown("shutdown-signal"));

logEvent("info", "container_starting", "Avvio del container Stash", {
  node: process.version,
  pid: process.pid,
  uid: process.getuid?.(),
});

startProcess("web", process.execPath, ["server.js"], { cwd: "/app/web" }, true);
startProcess("bot", process.execPath, ["/app/service/main.js"], { cwd: "/app" }, false);
