import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabaseForFixture, openDatabaseReadOnly, type DatabaseSync } from "../src/db/open.js";

/** Same DDL as sync/sync_from_nightscout.py SCHEMA_SQL (box schema_version 1). */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sgv (
  date_ms INTEGER PRIMARY KEY, date_string TEXT NOT NULL, sgv INTEGER NOT NULL,
  direction TEXT, device TEXT, type TEXT, raw_json TEXT
);
CREATE TABLE IF NOT EXISTS treatments (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, timestamp_ms INTEGER, event_type TEXT,
  insulin REAL, carbs REAL, duration_min REAL, rate REAL, percent REAL, absolute REAL,
  entered_by TEXT, notes TEXT, raw_json TEXT
);
CREATE TABLE IF NOT EXISTS daily_stats (
  day TEXT PRIMARY KEY, tir_80_180 REAL, under_80 REAL, over_180 REAL, avg_mgdl REAL, cv_pct REAL,
  tdd_u REAL, bolus_u REAL, basal_u REAL, sgv_count INTEGER, source TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS weekly_stats (
  week_ending TEXT PRIMARY KEY, week_start TEXT, tir_80_180 REAL, under_80 REAL, over_180 REAL,
  avg_mgdl REAL, cv_pct REAL, tdd_u REAL, sgv_count INTEGER, source TEXT, trend_note TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sgv_date_string ON sgv(date_string);
CREATE INDEX IF NOT EXISTS idx_tx_created ON treatments(created_at);
CREATE INDEX IF NOT EXISTS idx_tx_type ON treatments(event_type);
`;

/*
 * Three Chicago days around the 2025 fall-back (DST ends 2025-11-02 02:00 CDT = 07:00Z).
 * Local midnights are written out independently of src/time.ts:
 *   2025-11-01 00:00 CDT = 05:00Z, 2025-11-02 00:00 CDT = 05:00Z (25-hour day),
 *   2025-11-03 00:00 CST = 06:00Z, 2025-11-04 00:00 CST = 06:00Z.
 */
export const START_MS = Date.parse("2025-11-01T05:00:00Z");
export const FALLBACK_MS = Date.parse("2025-11-02T07:00:00Z");
export const END_MS = Date.parse("2025-11-04T06:00:00Z");
export const DAY_MIDNIGHTS: Record<string, number> = {
  "2025-11-01": Date.parse("2025-11-01T05:00:00Z"),
  "2025-11-02": Date.parse("2025-11-02T05:00:00Z"),
  "2025-11-03": Date.parse("2025-11-03T06:00:00Z"),
  "2025-11-04": Date.parse("2025-11-04T06:00:00Z")
};
/** No readings 10:00–11:00 local on 2025-11-03 (a 65-minute gap between readings). */
export const GAP_FROM_MS = Date.parse("2025-11-03T16:00:00Z");
export const GAP_TO_MS = Date.parse("2025-11-03T17:00:00Z");

export function localHour(ms: number): number {
  const offsetH = ms < FALLBACK_MS ? 5 : 6;
  return new Date(ms - offsetH * 3_600_000).getUTCHours();
}

/** 00–06 → 200 (high), 06–12 → 120, 12–18 → 70 (low), 18–24 → 150. */
export function valueFor(ms: number): number {
  const h = localHour(ms);
  if (h < 6) return 200;
  if (h < 12) return 120;
  if (h < 18) return 70;
  return 150;
}

export interface SgvPoint {
  ms: number;
  sgv: number;
}

export function fixtureSgv(): SgvPoint[] {
  const out: SgvPoint[] = [];
  for (let ms = START_MS; ms < END_MS; ms += 5 * 60_000) {
    if (ms >= GAP_FROM_MS && ms < GAP_TO_MS) continue;
    out.push({ ms, sgv: valueFor(ms) });
  }
  return out;
}

/** Entirely synthetic people, treatment events and numeric values for arithmetic tests. */
export const FIXTURE_TREATMENTS = [
  // 2025-11-01 02:00 CDT
  { id: "t1", created_at: "2025-11-01T07:00:00.000Z", event_type: "Temp Basal", rate: 0.8, duration_min: 60, entered_by: "tconnectsync" },
  // 2025-11-01 09:00 CDT
  { id: "t2", created_at: "2025-11-01T14:00:00.000Z", event_type: "Site Change", entered_by: "Patient A", notes: "synthetic site change" },
  // 2025-11-01 12:30 CDT
  { id: "t3", created_at: "2025-11-01T17:30:00.000Z", event_type: "Combo Bolus", insulin: 3, carbs: 45, entered_by: "tconnectsync", notes: "split 60/40" },
  // 2025-11-03 09:00 CST, offset-form timestamp
  { id: "t4", created_at: "2025-11-03T09:00:00-06:00", event_type: "Meal Bolus", insulin: 2, carbs: 30, entered_by: "tconnectsync" },
  // 2025-11-03 23:30 CST is already 2025-11-04 in UTC
  { id: "t5", created_at: "2025-11-04T05:30:00Z", event_type: "Correction Bolus", insulin: 1.5, entered_by: "tconnectsync" }
];

export function createFixture(): { path: string; db: DatabaseSync } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diabetes-mcp-"));
  const file = path.join(dir, "diabetes.sqlite");
  const write = openDatabaseForFixture(file);
  write.exec(SCHEMA_SQL);
  const meta = write.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  for (const [k, v] of [
    ["schema_version", "1"],
    ["timezone", "America/Chicago"],
    ["tir_low", "80"],
    ["tir_high", "180"],
    ["last_sync_at", "2025-11-04T11:15:04Z"],
    ["last_sync_mode", "sync"],
    ["nightscout_url", "https://example-ns.invalid"],
    ["path_note", "copied from https://example-ns.invalid/api for test"]
  ]) {
    meta.run(k, v);
  }
  write.exec("BEGIN");
  const sgv = write.prepare(
    "INSERT INTO sgv (date_ms, date_string, sgv, direction, device, type, raw_json) VALUES (?, ?, ?, ?, ?, 'sgv', ?)"
  );
  for (const p of fixtureSgv()) {
    const iso = new Date(p.ms).toISOString();
    sgv.run(p.ms, iso, p.sgv, "Flat", "share2", JSON.stringify({ date: p.ms, sgv: p.sgv }));
  }
  const tx = write.prepare(
    `INSERT INTO treatments (id, created_at, timestamp_ms, event_type, insulin, carbs, duration_min, rate, percent, absolute, entered_by, notes, raw_json)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
  );
  for (const t of FIXTURE_TREATMENTS) {
    const r = t as Record<string, unknown>;
    tx.run(
      t.id,
      t.created_at,
      t.event_type,
      (r.insulin as number) ?? null,
      (r.carbs as number) ?? null,
      (r.duration_min as number) ?? null,
      (r.rate as number) ?? null,
      (r.entered_by as string) ?? null,
      (r.notes as string) ?? null,
      JSON.stringify(t)
    );
  }
  write.exec("COMMIT");
  const daily = write.prepare(
    `INSERT INTO daily_stats VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Nightscout API', '2025-11-04T11:15:04Z')`
  );
  daily.run("2025-11-01", 50, 25, 25, 135, 35.123, 12.5, 3, 0.8, 288);
  daily.run("2025-11-03", 47.826, 26.087, 26.087, 134.2, 35.9, 3.5, 3.5, null, 276);
  const weekly = write.prepare(
    `INSERT INTO weekly_stats VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SQLite', ?, '2025-11-04T11:15:04Z')`
  );
  weekly.run("2025-10-25", "2025-10-19", 61, 9, 30, 150, 33, 40, 2016, null);
  weekly.run("2025-11-01", "2025-10-26", 55.5, 20, 24.5, 140, 34, 41, 2010, "steady");
  write.close();
  return { path: file, db: openDatabaseReadOnly(file) };
}
