import fs from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

// A static `import { DatabaseSync } from "node:sqlite"` breaks under
// vite/vitest today: node:sqlite is new enough that vite's own builtin-module
// list doesn't recognize it yet, and it tries (and fails) to resolve it as a
// package. Routing through Node's own require sidesteps that entirely and
// behaves identically under plain Node. Same approach as ResMed-Data-MCP.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};
export type DatabaseSync = DatabaseSyncType;

// Wait out the sync writer's short transaction instead of failing immediately
// with "database is locked". This MCP never writes.
const BUSY_TIMEOUT_MS = 30_000;

/**
 * Open the diabetes archive read-only.
 *
 * `com.diabetes-sqlite.sync` is the sole writer. Its LaunchAgent uses
 * StartCalendarInterval Hour=5 Minute=15 (daily 5:15 AM America/Chicago).
 * This process must never CREATE, migrate, or UPDATE the archive, and must
 * never call Nightscout.
 *
 * Node's built-in `node:sqlite` (22.x) does not accept SQLite URI filenames
 * (`file:…?mode=ro` fails with "unable to open database file"), so the
 * read-only guarantee is the `readOnly: true` flag (SQLITE_OPEN_READONLY)
 * plus `PRAGMA query_only = ON`. Writes fail with "attempt to write a
 * readonly database".
 */
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

/** Writable handle used only by tests to build a fixture file. Never point this at the live archive. */
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
