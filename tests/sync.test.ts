import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabaseForFixture, openDatabaseReadOnly } from "../src/db/open.js";
import { callTool } from "../src/mcp/queries.js";
import { FIXTURE_TREATMENTS, fixtureSgv } from "./fixture.js";

/*
 * End-to-end: a fake Nightscout serves the fixture readings/treatments, the
 * real sync script (sync/diabetes-sqlite-sync) writes a temp archive, and the
 * MCP reads it back. Checks that the Python daily_stats and the MCP's
 * get_range_stats agree, so box-era rollups and computed windows match.
 */
const run = promisify(execFile);
const SYNC = path.resolve(__dirname, "../sync/diabetes-sqlite-sync");
const SECRET = "test-api-secret-not-real";
const SECRET_SHA1 = crypto.createHash("sha1").update(SECRET).digest("hex");

const entries = [
  ...fixtureSgv().map((p) => ({
    _id: `e${p.ms}`,
    date: p.ms,
    dateString: new Date(p.ms).toISOString(),
    sgv: p.sgv,
    direction: "Flat",
    device: "share2",
    type: "sgv"
  })),
  // meter reading without sgv: skipped by the sync
  { _id: "mbg1", date: Date.parse("2025-11-02T15:00:00Z"), dateString: "2025-11-02T15:00:00.000Z", mbg: 110, type: "mbg" }
].sort((a, b) => b.date - a.date);

const treatments = FIXTURE_TREATMENTS.map((t) => {
  const r = t as Record<string, unknown>;
  return {
    _id: t.id,
    created_at: t.created_at,
    eventType: t.event_type,
    insulin: r.insulin,
    carbs: r.carbs,
    duration: r.duration_min,
    rate: r.rate,
    enteredBy: r.entered_by,
    notes: r.notes
  };
}).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

let server: http.Server;
let baseUrl: string;
const requests: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push(req.url || "");
    if (req.headers["api-secret"] !== SECRET_SHA1) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: 401, message: "Unauthorized" }));
      return;
    }
    const url = new URL(req.url || "/", "http://localhost");
    const count = Number(url.searchParams.get("count") || 10);
    const find = url.searchParams.get("find");
    let body: unknown[] = [];
    if (url.pathname === "/api/v1/entries.json") {
      const bracket = url.searchParams.get("find[date][$lt]");
      const lt = bracket != null ? Number(bracket) : find ? (JSON.parse(find).date.$lt as number) : Infinity;
      body = entries.filter((e) => e.date < lt).slice(0, count);
    } else if (url.pathname === "/api/v1/treatments.json") {
      const lte = url.searchParams.get("find[created_at][$lte]");
      const bracket = url.searchParams.get("find[created_at][$lt]");
      const lt = bracket != null ? bracket : find ? (JSON.parse(find).created_at.$lt as string) : "￿";
      body = treatments.filter((t) => (lte != null ? t.created_at <= lte : t.created_at < lt)).slice(0, count);
    } else {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function tempDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "diabetes-sync-")), "diabetes.sqlite");
}

function env(dbPath: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: os.tmpdir(),
    TZ: "America/Chicago",
    DIABETES_DB_PATH: dbPath,
    DIABETES_KEYCHAIN_SERVICE: "diabetes-sqlite-test-does-not-exist",
    ...extra
  };
}

describe("sync (fake Nightscout -> SQLite -> MCP)", () => {
  it("fails closed without credentials and never creates the database", async () => {
    const dbPath = tempDb();
    const err = (await run(SYNC, ["sync"], { env: env(dbPath) }).catch((e) => e)) as { code: number; stderr: string };
    expect(err.code).toBe(2);
    expect(err.stderr).toMatch(/credentials missing/);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("does not leak the URL or secret when Nightscout rejects the secret", async () => {
    const dbPath = tempDb();
    const err = (await run(SYNC, ["sync"], {
      env: env(dbPath, { NIGHTSCOUT_URL: baseUrl, NIGHTSCOUT_API_SECRET: "wrong-secret-value" })
    }).catch((e) => e)) as { code: number; stdout: string; stderr: string };
    expect(err.code).toBe(1);
    expect(err.stderr).toMatch(/401/);
    const out = err.stdout + err.stderr;
    expect(out).not.toContain("wrong-secret-value");
    expect(out).not.toContain(baseUrl);
  });

  it("syncs with paging, writes rollups, and the MCP agrees with them", async () => {
    const dbPath = tempDb();
    const opts = { env: env(dbPath, { NIGHTSCOUT_URL: baseUrl, NIGHTSCOUT_API_SECRET: SECRET, DIABETES_SYNC_PAGE: "200" }) };
    const first = await run(SYNC, ["sync"], opts);
    expect(first.stdout).toMatch(/totals: sgv=864 treatments=5/);
    expect(first.stdout + first.stderr).not.toContain(SECRET);
    expect(requests.filter((r) => r.includes("find[date][$lt]") || r.includes("find%5Bdate%5D")).length).toBeGreaterThan(0);

    const second = await run(SYNC, ["sync"], opts);
    expect(second.stdout).toMatch(/totals: sgv=864 treatments=5/);

    const db = openDatabaseReadOnly(dbPath);
    try {
      const call = (name: string, args: Record<string, unknown> = {}) => JSON.parse(callTool(db, name, args, dbPath));
      const status = call("sync_status");
      expect(status.counts).toMatchObject({ sgv: 864, treatments: 5, daily_stats: 3 });
      expect(status.meta).toMatchObject({
        schema_version: "1",
        timezone: "America/Chicago",
        tir_low: "80",
        tir_high: "180",
        last_sync_mode: "sync",
        last_sync_writer: "com.diabetes-sqlite.sync (Mac mini)"
      });
      expect(status.stale).toBe(false);

      const daily = call("get_daily_stats", { date_from: "2025-11-01", date_to: "2025-11-03" }).rows;
      expect(daily.map((d: any) => [d.day, d.sgv_count])).toEqual([
        ["2025-11-01", 288],
        ["2025-11-02", 300],
        ["2025-11-03", 276]
      ]);
      expect(daily[0]).toMatchObject({ tdd_u: 3.8, bolus_u: 3, basal_u: 0.8 });
      expect(daily[2]).toMatchObject({ bolus_u: 3.5 });
      for (const d of daily) {
        const computed = call("get_range_stats", { date_from: d.day });
        for (const k of ["tir_80_180", "under_80", "over_180", "avg_mgdl", "cv_pct", "sgv_count"]) {
          expect(computed[k], `${d.day} ${k}`).toBeCloseTo(d[k], 1);
        }
      }
      const tx = call("list_treatments", { date_from: "2025-11-01", event_type: "Combo Bolus", include_raw: true });
      expect(tx.rows[0]).toMatchObject({ id: "t3", insulin: 3, carbs: 45, entered_by: "tconnectsync" });
      expect(JSON.parse(tx.rows[0].raw_json).notes).toBe("split 60/40");
    } finally {
      db.close();
    }
  }, 60_000);
});

describe("backfill and incremental rollups", () => {
  const opts = (dbPath: string, extra: Record<string, string> = {}) => ({
    env: env(dbPath, { NIGHTSCOUT_URL: baseUrl, NIGHTSCOUT_API_SECRET: SECRET, DIABETES_SYNC_PAGE: "200", ...extra })
  });

  it("backfill restores history a routine sync never revisits, and removes synthetic-id duplicates", async () => {
    const dbPath = tempDb();
    await run(SYNC, ["sync"], opts(dbPath));

    // Simulate the live archive: older history missing, t3 stored under a box-era synthetic id.
    const w = openDatabaseForFixture(dbPath);
    w.exec("DELETE FROM sgv WHERE date_ms < " + Date.parse("2025-11-02T00:00:00Z"));
    w.exec("DELETE FROM treatments WHERE id IN ('t1','t3')");
    w.exec(
      "INSERT INTO treatments(id,created_at,event_type,insulin,carbs,entered_by,raw_json) VALUES " +
        "('2025-11-01T17:30:00.000Z:Combo Bolus:3:45','2025-11-01T17:30:00.000Z','Combo Bolus',3,45,'tconnectsync','{}')," +
        // a real-looking id Nightscout no longer has, same event as t4 (tconnectsync delete + re-post)
        "('aaaaaaaaaaaaaaaaaaaaaaaa','2025-11-03T09:00:00-06:00','Meal Bolus',2,30,'tconnectsync','{}')," +
        // history that only the archive has: no counterpart in Nightscout, must be kept
        "('bbbbbbbbbbbbbbbbbbbbbbbb','2025-10-15T12:00:00.000Z','Combo Bolus',1,NULL,'tconnectsync','{}')"
    );
    const gaps = w.prepare("SELECT COUNT(*) AS n FROM sgv").get() as { n: number };
    w.close();
    expect(gaps.n).toBeLessThan(864);

    // A routine sync stops at the newest stored reading, so the gap stays.
    const routine = await run(SYNC, ["sync"], opts(dbPath));
    const afterRoutine = openDatabaseReadOnly(dbPath);
    expect((afterRoutine.prepare("SELECT COUNT(*) AS n FROM sgv").get() as { n: number }).n).toBeLessThan(864);
    afterRoutine.close();
    expect(routine.stdout).toMatch(/\(recent\)/);

    const full = await run(SYNC, ["backfill"], opts(dbPath));
    expect(full.stdout).toMatch(/stale duplicate treatments removed: 2/);
    expect(full.stdout).toMatch(/totals: sgv=864 treatments=6/);
    expect(full.stdout).toMatch(/daily_stats days: 3 \(full\)/);
    expect(full.stdout + full.stderr).not.toContain(SECRET);

    const db = openDatabaseReadOnly(dbPath);
    try {
      const ids = (db.prepare("SELECT id FROM treatments ORDER BY id").all() as { id: string }[]).map((r) => r.id);
      expect(ids).toEqual(["bbbbbbbbbbbbbbbbbbbbbbbb", "t1", "t2", "t3", "t4", "t5"]);
      const meta = Object.fromEntries((db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
      expect(meta.last_sync_mode).toBe("backfill");
      expect(meta.last_backfill_at).toMatch(/Z$/);
    } finally {
      db.close();
    }
  }, 60_000);

  it("recomputes only the newest days on a routine sync, and everything on recompute", async () => {
    const dbPath = tempDb();
    const o = opts(dbPath, { DIABETES_SYNC_RECOMPUTE_DAYS: "0" });
    await run(SYNC, ["sync"], o); // empty daily_stats: full pass

    const w = openDatabaseForFixture(dbPath);
    w.exec("UPDATE daily_stats SET tir_80_180 = -1 WHERE day = '2025-11-01'");
    w.close();

    await run(SYNC, ["sync"], o); // same local day: recent only
    let db = openDatabaseReadOnly(dbPath);
    expect((db.prepare("SELECT tir_80_180 AS t FROM daily_stats WHERE day='2025-11-01'").get() as { t: number }).t).toBe(-1);
    db.close();

    await run(SYNC, ["recompute"], o);
    db = openDatabaseReadOnly(dbPath);
    expect((db.prepare("SELECT tir_80_180 AS t FROM daily_stats WHERE day='2025-11-01'").get() as { t: number }).t).toBeGreaterThan(0);
    db.close();
  }, 60_000);
});

describe("combo bolus insulin totals", () => {
  it("counts the extended part of a Care Portal combo once: requested when its extended entry is gone, delivered when it exists", async () => {
    const dbPath = tempDb();
    const o = { env: env(dbPath, { NIGHTSCOUT_URL: baseUrl, NIGHTSCOUT_API_SECRET: SECRET, DIABETES_SYNC_PAGE: "200" }) };
    await run(SYNC, ["sync"], o);

    const w = openDatabaseForFixture(dbPath);
    const ins = w.prepare(
      "INSERT INTO treatments(id,created_at,event_type,insulin,entered_by,raw_json) VALUES (?,?,?,?,?,?)"
    );
    // 2025-11-02: combo 3.46 now of 5.64 total, 60/40 over 2 h, extended entry absent -> 3.46 + 2.256
    ins.run("c1", "2025-11-02T18:00:00.000Z", "Combo Bolus", 3.46, "Pump (tconnectsync)",
      JSON.stringify({ enteredinsulin: 5.64, splitNow: 60, splitExt: 40, duration: 120, relative: 1.13, pump_event_id: "10,11,12,13" }));
    // 2025-11-03: combo 2 now of 4 total, 50/50 over 1 h, extension cancelled: its own row delivered 1.2 U
    ins.run("c2", "2025-11-03T20:00:00.000Z", "Combo Bolus", 2, "Pump (tconnectsync)",
      JSON.stringify({ enteredinsulin: 4, splitNow: 50, splitExt: 50, duration: 60, relative: 2, pump_event_id: "20,21,22,23" }));
    ins.run("c2x", "2025-11-03T20:40:00.000Z", "Combo Bolus", 1.2, "Pump (tconnectsync)",
      JSON.stringify({ notes: "Extended Bolus", pump_event_id: "40" }));
    // a combo request the pump never completed (no insulin): counts nothing
    ins.run("c3", "2025-11-02T22:00:00.000Z", "Combo Bolus", null, "Pump (tconnectsync)",
      JSON.stringify({ enteredinsulin: 6, splitNow: 60, splitExt: 40, duration: 120, pump_event_id: "30,31,32,33" }));
    w.close();

    const out = await run(SYNC, ["recompute"], o);
    expect(out.stdout).toMatch(/combo boluses counting their extended part: 1/);

    const db = openDatabaseReadOnly(dbPath);
    try {
      const eff = Object.fromEntries((db.prepare("SELECT id, insulin_effective AS e FROM treatments WHERE id IN ('c1','c2','c2x','c3')").all() as { id: string; e: number }[]).map((r) => [r.id, r.e]));
      expect(eff).toEqual({ c1: 5.716, c2: 2, c2x: 1.2, c3: null });
      const day = (d: string) => db.prepare("SELECT bolus_u FROM daily_stats WHERE day = ?").get(d) as { bolus_u: number };
      // fixture bolus on 11-02 is 0; on 11-03 the Meal Bolus is 2 U (the 11-04 UTC correction is 11-03 local too: 1.5)
      expect(day("2025-11-02").bolus_u).toBeCloseTo(5.716, 3);
      const call = (name: string, args: Record<string, unknown>) => JSON.parse(callTool(db, name, args, dbPath));
      for (const d of ["2025-11-02", "2025-11-03"]) {
        const r = call("get_range_stats", { date_from: d, include_insulin: true });
        expect(r.insulin.bolus_u, d).toBeCloseTo(day(d).bolus_u, 2);
      }
      const rows = call("list_treatments", { date_from: "2025-11-02", event_type: "Combo Bolus" }).rows;
      expect(rows.find((r: any) => r.id === "c1")).toMatchObject({ insulin: 3.46, insulin_counted: 5.716 });
    } finally {
      db.close();
    }
  }, 60_000);
});
