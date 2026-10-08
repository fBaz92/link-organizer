import { mkdirSync } from "node:fs";
import path from "node:path";
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

/** Risultato di una scrittura preparata (compatibile better-sqlite3). */
export interface SqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

/**
 * Statement preparato in "object mode" (righe come oggetti chiave→valore,
 * come il default di better-sqlite3 e node:sqlite). raw() restituisce la
 * vista posizionale (righe come array) usata da drizzle per mappare i campi.
 */
export interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  raw(): {
    get(...params: unknown[]): unknown[] | undefined;
    all(...params: unknown[]): unknown[][];
  };
}

/** Funzione transazione alla better-sqlite3: invocabile e con varianti. */
export interface SqliteTransactionFn<T> {
  (...args: unknown[]): T;
  deferred(...args: unknown[]): T;
  immediate(...args: unknown[]): T;
  exclusive(...args: unknown[]): T;
}

/**
 * Superficie di SQLite usata davvero da migratore, repository e drizzle.
 * Nota: niente metodo "esecuzione script multi-statement": ogni statement
 * passa da prepare(), anche DDL e trigger (sono statement singoli).
 */
export interface SqliteClient {
  prepare(sql: string): SqliteStatement;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  transaction<T>(fn: (...args: unknown[]) => T): SqliteTransactionFn<T>;
  close(): void;
}

export type RawSqlite = SqliteClient;
export type Db = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  raw: RawSqlite;
  db: Db;
}

export function sqliteFilePath(): string {
  return path.join(dataDir(), "stash.db");
}

export function openDatabase(file?: string): DatabaseHandle {
  if (!file) mkdirSync(dataDir(), { recursive: true });
  const target = file ?? sqliteFilePath();
  const native = new Database(target);
  native.pragma("journal_mode = WAL");
  native.pragma("foreign_keys = ON");
  native.pragma("busy_timeout = 5000");
  const raw = native as unknown as SqliteClient;
  return { raw, db: drizzle(native, { schema }) };
}
