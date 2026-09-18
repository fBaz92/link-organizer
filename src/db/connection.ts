import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { dataDir } from "@/config/env";
import * as schema from "./schema";

/*
 * Flow: apertura del database. SQLite gira in modalità WAL per permettere al
 * web server e al bot worker di accedere allo stesso file in concorrenza;
 * busy_timeout evita errori di lock momentanei. La funzione accetta un path
 * (i test passano ":memory:") così resta l'unica porta d'ingresso al DB.
 * La cartella dati viene creata al bisogno.
 */

export type Db = BetterSQLite3Database<typeof schema>;
export type RawSqlite = Database.Database;

export interface DatabaseHandle {
  raw: RawSqlite;
  db: Db;
}

export function openDatabase(file?: string): DatabaseHandle {
  if (!file) mkdirSync(dataDir(), { recursive: true });
  const raw = new Database(file ?? `${dataDir()}/stash.db`);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.pragma("busy_timeout = 5000");
  return { raw, db: drizzle(raw, { schema }) };
}
