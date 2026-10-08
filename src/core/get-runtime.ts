import { dataDir } from "@/config/env";
import { getDatabase } from "@/db";
import { createRuntime, type StashRuntime } from "@/core/runtime";

/*
 * Flow: singleton del runtime per i processi "host" con better-sqlite3 —
 * la webapp Next e gli script CLI di sviluppo. Memoizza su globalThis per
 * sopravvivere all'hot reload di Next. Il servizio HomeGate NON passa di
 * qui: costruisce il proprio runtime col driver node:sqlite (vedi
 * service/main.ts), per non trascinare moduli nativi nel bundle.
 */

const globalForRuntime = globalThis as unknown as { __stashRuntime?: StashRuntime };

export function getRuntime(): StashRuntime {
  if (!globalForRuntime.__stashRuntime) {
    globalForRuntime.__stashRuntime = createRuntime(dataDir(), getDatabase());
  }
  return globalForRuntime.__stashRuntime;
}
