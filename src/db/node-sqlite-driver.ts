import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { createTableRelationsHelpers, extractTablesRelationalConfig } from "drizzle-orm/relations";
import { BetterSQLiteSession } from "drizzle-orm/better-sqlite3/session";
import { BaseSQLiteDatabase, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { dataDir } from "@/config/env";
import * as schema from "./schema";
import type {
  DatabaseHandle,
  SqliteClient,
  SqliteRunResult,
  SqliteStatement,
  SqliteTransactionFn,
} from "./connection";

/*
 * Flow: driver SQLite per il servizio HomeGate, basato sul modulo integrato
 * node:sqlite (Node ≥ 22.13) invece di better-sqlite3: così il bundle di
 * produzione non contiene moduli nativi e gira senza installazioni su
 * Raspberry (arm64/amd64). L'interfaccia è la stessa di connection.ts
 * (SqliteClient): migratore, repository e drizzle funzionano identici e il
 * file di database resta intercambiabile fra i due driver.
 *
 * Da qui in giù NON importare nulla a runtime da connection.ts, db/index o
 * drizzle-orm/better-sqlite3 (il driver, non la session): porterebbero
 * better-sqlite3 dentro il bundle. Il database drizzle si costruisce dai
 * componenti core, replicando construct() del driver ufficiale.
 */

function rowToValues(row: Record<string, unknown> | undefined): unknown[] | undefined {
  return row === undefined ? undefined : Object.values(row);
}

/** Statement node:sqlite con la superficie attesa da drizzle/repositories. */
class NodeSqliteStatement implements SqliteStatement {
  constructor(private readonly statement: StatementSync) {}

  private args(params: unknown[]): SQLInputValue[] {
    return params as SQLInputValue[];
  }

  run(...params: unknown[]): SqliteRunResult {
    return this.statement.run(...this.args(params)) as SqliteRunResult;
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    return this.statement.get(...this.args(params)) as Record<string, unknown> | undefined;
  }

  all(...params: unknown[]): Record<string, unknown>[] {
    return this.statement.all(...this.args(params)) as Record<string, unknown>[];
  }

  /** Vista posizionale (righe come array): node:sqlite restituisce oggetti
   * con le colonne in ordine di SELECT, quindi Object.values è equivalente
   * alla "raw mode" di better-sqlite3 che drizzle si aspetta. */
  raw() {
    return {
      get: (...params: unknown[]) => rowToValues(this.get(...params)),
      all: (...params: unknown[]) => this.all(...params).map((row) => Object.values(row)),
    };
  }
}

export class NodeSqliteClient implements SqliteClient {
  private depth = 0;

  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new NodeSqliteStatement(this.database.prepare(sql));
  }

  /**
   * PRAGMA letti con { simple: true } (user_version) o applicati come
   * istruzioni di scrittura. `source` arriva solo da costanti interne
   * (migratore e setup del driver), mai da input esterno.
   */
  pragma(source: string, options?: { simple?: boolean }): unknown {
    const statement = this.database.prepare(`PRAGMA ${source}`);
    if (options?.simple) {
      return rowToValues(statement.get() as Record<string, unknown> | undefined)?.[0];
    }
    statement.run();
    return undefined;
  }

  transaction<T>(fn: (...args: unknown[]) => T): SqliteTransactionFn<T> {
    const wrapped = (...args: unknown[]): T => {
      this.depth += 1;
      const nested = this.depth > 1;
      const savepointName = `stash_sp${this.depth}`;
      const command = (sql: string) => this.database.prepare(sql).run();
      if (nested) command(`SAVEPOINT ${savepointName}`);
      else command("BEGIN");
      try {
        const result = fn(...args);
        if (nested) command(`RELEASE SAVEPOINT ${savepointName}`);
        else command("COMMIT");
        return result;
      } catch (error) {
        if (nested) {
          command(`ROLLBACK TO SAVEPOINT ${savepointName}`);
          command(`RELEASE SAVEPOINT ${savepointName}`);
        } else {
          command("ROLLBACK");
        }
        throw error;
      } finally {
        this.depth -= 1;
      }
    };
    const tx = wrapped as SqliteTransactionFn<T>;
    tx.deferred = wrapped;
    tx.immediate = wrapped;
    tx.exclusive = wrapped;
    return tx;
  }

  close(): void {
    this.database.close();
  }
}

export function openNodeSqliteDatabase(file?: string): DatabaseHandle {
  if (!file) mkdirSync(dataDir(), { recursive: true });
  const target = file ?? path.join(dataDir(), "stash.db");
  const native = new DatabaseSync(target);
  const raw = new NodeSqliteClient(native);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.pragma("busy_timeout = 5000");
  return { raw, db: buildDrizzleDatabase(raw) };
}

/** Replicate di BetterSQLite3Database: stessa base, nessun import nativo. */
class NodeSqliteDatabase extends BaseSQLiteDatabase<"sync", SqliteRunResult, typeof schema> {}

function buildDrizzleDatabase(client: SqliteClient): DatabaseHandle["db"] {
  const dialect = new SQLiteSyncDialect();
  const tablesConfig = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
  const relationalSchema = {
    fullSchema: schema,
    schema: tablesConfig.tables,
    tableNamesMap: tablesConfig.tableNamesMap,
  };
  const session = new BetterSQLiteSession(client as never, dialect, relationalSchema, {});
  // I cast rispecchiano construct() del driver ufficiale: sessione e oggetto
  // relazionale costruiti sopra hanno la forma attesa dal costruttore, ma la
  // varianza dei generics di drizzle non la dimostra staticamente.
  const db = new NodeSqliteDatabase("sync", dialect, session as never, relationalSchema as never);
  return db as unknown as DatabaseHandle["db"];
}
