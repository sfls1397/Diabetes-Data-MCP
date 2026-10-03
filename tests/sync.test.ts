import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabaseReadOnly } from "../src/db/open.js";
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
      const bracket = url.searchParams.get("find[created_at][$lt]");
      const lt = bracket != null ? bracket : find ? (JSON.parse(find).created_at.$lt as string) : "￿";
      body = treatments.filter((t) => t.created_at < lt).slice(0, count);
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
