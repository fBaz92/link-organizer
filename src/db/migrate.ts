import type { RawSqlite } from "./connection";
import { MIGRATIONS } from "./schema.sql";

/*
 * Flow: migratore minimale. Confronta PRAGMA user_version col numero di
 * migrazioni note e applica in transazione solo le mancanti. Gli statement
 * sono idempotenti (IF NOT EXISTS) quindi anche una gara tra i due processi
 * è innocua: lo statement duplicato non ha effetto. Ogni elemento è uno
 * statement singolo (i trigger sono un unico statement BEGIN…END) e passa
 * da prepare(), valido sia per better-sqlite3 sia per node:sqlite.
 */
export function migrate(raw: RawSqlite): void {
  const current = raw.pragma("user_version", { simple: true }) as number;
  if (current >= MIGRATIONS.length) return;

  for (let v = current; v < MIGRATIONS.length; v++) {
    raw.transaction(() => {
      for (const statement of MIGRATIONS[v]) {
        raw.prepare(statement).run();
      }
      raw.pragma(`user_version = ${v + 1}`);
    })();
  }
}
