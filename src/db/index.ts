import { openDatabase, type DatabaseHandle } from "./connection";
import { migrate } from "./migrate";

/*
 * Flow: singleton del DB per i processi di lunga vita (web e bot). La handle
 * è messa su globalThis così l'hot reload di Next in dev riusa la connessione
 * invece di aprirne una per modulo. Al primo accesso: apertura + migrazioni.
 */

const globalForDb = globalThis as unknown as { __stashDb?: DatabaseHandle };

export function getDatabase(): DatabaseHandle {
  if (!globalForDb.__stashDb) {
    const handle = openDatabase();
    migrate(handle.raw);
    globalForDb.__stashDb = handle;
  }
  return globalForDb.__stashDb;
}
