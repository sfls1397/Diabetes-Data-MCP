import fs from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};
export type DatabaseSync = DatabaseSyncType;

const BUSY_TIMEOUT_MS = 30_000;

export function openDatabaseReadOnly(dbPath: string): DatabaseSync {
  if (!dbPath || dbPath === ":memory:") {
    throw new Error("Refusing to open an in-memory database. This MCP only reads the diabetes archive file.");
  }
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `Diabetes database not found at ${dbPath}. This MCP does not create or write it; com.diabetes-sqlite.sync is the sole writer.`
    );
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA query_only = ON");
  return db;
}

export function openDatabaseForFixture(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

export function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

export function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { ok: number } | undefined;
  return row?.ok === 1;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
