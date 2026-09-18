import { openDatabase } from "./connection";
import { migrate } from "./migrate";

/*
 * Flow: entrypoint CLI di `pnpm db:migrate`. Applica le migrazioni pendenti
 * ed esce. Utile in produzione per preparare il DB prima di avviare i
 * processi, e come check manuale dopo aver modificato lo schema.
 */
const handle = openDatabase();
migrate(handle.raw);
const version = handle.raw.pragma("user_version", { simple: true });
console.log(`[stash] Database migrato a versione ${version}.`);
handle.raw.close();
