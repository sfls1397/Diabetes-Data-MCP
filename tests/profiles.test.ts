import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabaseForFixture, openDatabaseReadOnly, type DatabaseSync } from "../src/db/open.js";
import { callTool } from "../src/mcp/queries.js";
import { wallInstants } from "../src/mcp/profiles.js";

/*
 * Pump profile history end to end: a fake Nightscout serves synthetic profile
 * documents, the real sync mirrors them into a temp archive, and the MCP tools
 * read them back. Every number here is synthetic.
 *
 * Profiles (local America/Chicago schedules):
 *   Standard v1: basal 00:00 1.0, 06:00 2.0 U/h; carb ratio 00:00 10, 12:00 5 g/U
 *   Exercise:    basal 00:00 0.5, 01:30 1.0 U/h; carb ratio 00:00 20 g/U
 *   Standard v3: basal 00:00 1.0, 06:00 3.0 U/h (edited); carb ratio unchanged
 * Versions:
 *   p1 2025-10-01T00:00Z            Standard active
 *   p2 2025-11-01 12:30 CDT (17:30Z) switch to Exercise (mid-segment, mid-day)
 *   p3 2025-11-03 12:00 CST (18:00Z) switch back to Standard with the basal edit
 * 2025-11-02 is the 25-hour fall-back day: 01:00–02:00 happens twice, so the
 * Exercise 01:30 boundary is crossed twice that night.
 */
const run = promisify(execFile);
const SYNC = path.resolve(__dirname, "../sync/diabetes-sqlite-sync");
const SECRET = "profile-test-secret-not-real";
/** The exact SHA-1 header is checked in sync.test.ts; here it only has to be a hashed (never plaintext) secret. */
const HASHED_HEADER = /^[0-9a-f]{40}$/;

const seg = (time: string, value: number) => {
  const [h, m] = time.split(":").map(Number);
  return { time, timeAsSeconds: h * 3600 + m * 60, value };
};
const named = (basal: [string, number][], carbratio: [string, number][]) => ({
  dia: "4.0",
  carbratio: carbratio.map(([t, v]) => seg(t, v)),
  carbs_hr: "20",
  delay: "20",
  sens: [seg("00:00", 50)],
  basal: basal.map(([t, v]) => seg(t, v)),
  target_low: [seg("00:00", 100)],
  target_high: [seg("00:00", 120)],
  timezone: "America/Chicago",
  startDate: "1970-01-01T00:00:00.000Z",
  units: "mg/dl"
});
const STANDARD_V1 = named([["00:00", 1.0], ["06:00", 2.0]], [["00:00", 10], ["12:00", 5]]);
const EXERCISE = named([["00:00", 0.5], ["01:30", 1.0]], [["00:00", 20]]);
const STANDARD_V3 = named([["00:00", 1.0], ["06:00", 3.0]], [["00:00", 10], ["12:00", 5]]);

const ALL_PROFILE_DOCS = [
  { _id: "p1", startDate: "2025-10-01T00:00:00.000Z", created_at: "2025-10-01T00:00:00.000Z", defaultProfile: "Standard", enteredBy: "Pump (tconnectsync)", store: { Standard: STANDARD_V1, Exercise: EXERCISE } },
  // Python-style timestamp with microseconds and +00:00, as tconnectsync writes it
  { _id: "p2", startDate: "2025-11-01T17:30:00.000000+00:00", created_at: "2025-11-01T17:30:00.000000+00:00", defaultProfile: "Exercise", enteredBy: "Pump (tconnectsync)", store: { Standard: STANDARD_V1, Exercise: EXERCISE } },
  { _id: "p3", startDate: "2025-11-03T18:00:00.000Z", created_at: "2025-11-03T18:00:00.000Z", defaultProfile: "Standard", enteredBy: "Pump (tconnectsync)", store: { Standard: STANDARD_V3, Exercise: EXERCISE } }
];

/** Delivered basal rows that tile 2025-11-01 00:00 CDT .. 2025-11-04 00:00 CST (UTC instants, U/h). */
const BASAL_SPANS: [string, string, number, string][] = [
  ["2025-11-01T05:00:00Z", "2025-11-01T11:00:00Z", 1.0, "Profile"],
  ["2025-11-01T11:00:00Z", "2025-11-01T17:30:00Z", 2.0, "Profile"],
  ["2025-11-01T17:30:00Z", "2025-11-02T05:00:00Z", 1.0, "Profile"],
  ["2025-11-02T05:00:00Z", "2025-11-02T06:30:00Z", 0.5, "Profile"],
  ["2025-11-02T06:30:00Z", "2025-11-02T07:00:00Z", 1.0, "Profile"],
  ["2025-11-02T07:00:00Z", "2025-11-02T07:30:00Z", 0.5, "Profile"],
  ["2025-11-02T07:30:00Z", "2025-11-02T15:00:00Z", 1.0, "Profile"],
  ["2025-11-02T15:00:00Z", "2025-11-02T16:00:00Z", 3.0, "Algorithm"], // +2.0 U over programmed
  ["2025-11-02T16:00:00Z", "2025-11-03T06:00:00Z", 1.0, "Profile"],
  ["2025-11-03T06:00:00Z", "2025-11-03T07:30:00Z", 0.5, "Profile"],
  ["2025-11-03T07:30:00Z", "2025-11-03T18:00:00Z", 1.0, "Profile"],
  ["2025-11-03T18:00:00Z", "2025-11-03T20:00:00Z", 3.0, "Profile"],
  ["2025-11-03T20:00:00Z", "2025-11-03T20:30:00Z", 0, "Suspended"], // -1.5 U
  ["2025-11-03T20:30:00Z", "2025-11-04T06:00:00Z", 3.0, "Profile"]
];
const PROGRAMMED_BASAL = { "2025-11-01": 30.5, "2025-11-02": 24, "2025-11-03": 47.25 };

const TREATMENTS = [
  ...BASAL_SPANS.map(([s, e, rate, reason], i) => ({
    _id: `tb${i}`,
    created_at: s.replace("Z", ".000Z"),
    eventType: "Temp Basal",
    reason,
    rate,
    absolute: rate,
    duration: (Date.parse(e) - Date.parse(s)) / 60_000,
    enteredBy: "Pump (tconnectsync)"
  })),
  // 11:00 CDT, Standard v1, ratio 10 -> 3 U programmed
  { _id: "c1", created_at: "2025-11-01T16:00:00.000Z", eventType: "Combo Bolus", carbs: 30, insulin: 3, enteredBy: "Pump (tconnectsync)" },
  // exactly when p2 starts: Exercise, ratio 20 -> 2 U programmed
  { _id: "c2", created_at: "2025-11-01T17:30:00.000Z", eventType: "Combo Bolus", carbs: 40, insulin: 2, enteredBy: "Pump (tconnectsync)" },
  // 13:00 CST, Standard v3, ratio 5 -> 5 U programmed
  { _id: "c3", created_at: "2025-11-03T19:00:00.000Z", eventType: "Combo Bolus", carbs: 25, insulin: 6, enteredBy: "Pump (tconnectsync)" },
  { _id: "x1", created_at: "2025-11-02T18:00:00.000Z", eventType: "Correction Bolus", insulin: 1, enteredBy: "Pump (tconnectsync)" }
].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

let profileDocs = [...ALL_PROFILE_DOCS];
let profileStatus = 200;
let server: http.Server;
let baseUrl: string;
const profileCounts: number[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const header = req.headers["api-secret"];
    if (typeof header !== "string" || !HASHED_HEADER.test(header) || header.includes(SECRET)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: 401 }));
      return;
    }
    const url = new URL(req.url || "/", "http://localhost");
    const count = Number(url.searchParams.get("count") || 10);
    let body: unknown;
    if (url.pathname === "/api/v1/entries.json") body = [];
    else if (url.pathname === "/api/v1/treatments.json") {
      const lte = url.searchParams.get("find[created_at][$lte]");
      body = TREATMENTS.filter((t) => lte == null || t.created_at <= lte).slice(0, count);
    } else if (url.pathname === "/api/v1/profile.json") {
      profileCounts.push(count);
      if (profileStatus !== 200) {
        res.writeHead(profileStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: profileStatus, message: `failed at ${baseUrl}` }));
        return;
      }
      // Nightscout sorts {startDate: -1, _id: -1}
      body = [...profileDocs]
        .sort((a, b) => (a.startDate === b.startDate ? (a._id < b._id ? 1 : -1) : Date.parse(b.startDate) - Date.parse(a.startDate)))
        .slice(0, count);
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
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "diabetes-profile-")), "diabetes.sqlite");
}

function opts(dbPath: string, extra: Record<string, string> = {}) {
  return {
    env: {
      PATH: process.env.PATH,
      HOME: os.tmpdir(),
      TZ: "America/Chicago",
      DIABETES_DB_PATH: dbPath,
      DIABETES_KEYCHAIN_SERVICE: "diabetes-sqlite-test-does-not-exist",
      NIGHTSCOUT_URL: baseUrl,
      NIGHTSCOUT_API_SECRET: SECRET,
      ...extra
    }
  };
}

function dump(dbPath: string): string {
  const db = openDatabaseReadOnly(dbPath);
  try {
    return JSON.stringify(
      ["profile_versions", "profile_settings", "profile_segments"].map((t) =>
        db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3, 4`).all()
      )
    );
  } finally {
    db.close();
  }
}

function tool(db: DatabaseSync, dbPath: string, name: string, args: Record<string, unknown> = {}): any {
  return JSON.parse(callTool(db, name, args, dbPath));
}

describe("profile sync (fake Nightscout -> SQLite)", () => {
  it("mirrors every profile document with its named profiles and segments, idempotently", async () => {
    profileDocs = [...ALL_PROFILE_DOCS];
    profileStatus = 200;
    const dbPath = tempDb();
    const first = await run(SYNC, ["sync"], opts(dbPath));
    expect(first.stdout).toMatch(/profile versions: 3 read \(full\), 3 changed, 0 marked deleted upstream, 0 skipped; total=3/);
    expect(first.stdout + first.stderr).not.toContain(SECRET);

    const db = openDatabaseReadOnly(dbPath);
    try {
      const versions = db.prepare("SELECT id, start_ms, active_profile, profile_names FROM profile_versions ORDER BY start_ms").all();
      expect(versions).toEqual([
        { id: "p1", start_ms: Date.parse("2025-10-01T00:00:00Z"), active_profile: "Standard", profile_names: '["Standard","Exercise"]' },
        { id: "p2", start_ms: Date.parse("2025-11-01T17:30:00Z"), active_profile: "Exercise", profile_names: '["Standard","Exercise"]' },
        { id: "p3", start_ms: Date.parse("2025-11-03T18:00:00Z"), active_profile: "Standard", profile_names: '["Standard","Exercise"]' }
      ]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM profile_settings").get()).toEqual({ n: 6 });
      expect(
        db.prepare("SELECT is_active, units, timezone, dia_hours, carbs_hr, delay_min FROM profile_settings WHERE version_id='p2' AND profile_name='Exercise'").get()
      ).toEqual({ is_active: 1, units: "mg/dl", timezone: "America/Chicago", dia_hours: 4, carbs_hr: 20, delay_min: 20 });
      expect(
        db.prepare("SELECT start_sec, end_sec, time, value FROM profile_segments WHERE version_id='p3' AND profile_name='Standard' AND kind='basal' ORDER BY seq").all()
      ).toEqual([
        { start_sec: 0, end_sec: 21600, time: "00:00", value: 1 },
        { start_sec: 21600, end_sec: 86400, time: "06:00", value: 3 }
      ]);
      expect(db.prepare("SELECT id, end_ms FROM profile_timeline ORDER BY start_ms").all()).toEqual([
        { id: "p1", end_ms: Date.parse("2025-11-01T17:30:00Z") },
        { id: "p2", end_ms: Date.parse("2025-11-03T18:00:00Z") },
        { id: "p3", end_ms: null }
      ]);
    } finally {
      db.close();
    }

    const before = dump(dbPath);
    const second = await run(SYNC, ["sync"], opts(dbPath));
    expect(second.stdout).toMatch(/profile versions: 3 read \(recent\), 0 changed/);
    const backfill = await run(SYNC, ["backfill"], opts(dbPath));
    expect(backfill.stdout).toMatch(/profile versions: 3 read \(full\), 0 changed, 0 marked deleted upstream/);
    // Same rows, same first_seen_at / updated_at: unchanged documents are never rewritten.
    expect(dump(dbPath)).toBe(before);
  }, 60_000);

  it("reads only the newest documents on a routine run; backfill restores history and flags upstream deletions", async () => {
    profileDocs = [...ALL_PROFILE_DOCS];
    profileStatus = 200;
    const dbPath = tempDb();
    const recent = { DIABETES_SYNC_PROFILE_RECENT: "1" };
    await run(SYNC, ["sync"], opts(dbPath, recent));

    const w = openDatabaseForFixture(dbPath);
    w.exec("DELETE FROM profile_segments WHERE version_id='p1'; DELETE FROM profile_settings WHERE version_id='p1'; DELETE FROM profile_versions WHERE id='p1'");
    w.close();
    profileCounts.length = 0;
    const routine = await run(SYNC, ["sync"], opts(dbPath, recent));
    expect(routine.stdout).toMatch(/profile versions: 1 read \(recent\)/);
    expect(profileCounts).toEqual([1]);

    const full = await run(SYNC, ["backfill"], opts(dbPath, recent));
    expect(full.stdout).toMatch(/profile versions: 3 read \(full\), 1 changed, 0 marked deleted upstream, 0 skipped; total=3/);

    // p2 deleted in Nightscout: kept in the archive, flagged, and ignored by the tools.
    profileDocs = ALL_PROFILE_DOCS.filter((d) => d._id !== "p2");
    const gone = await run(SYNC, ["profiles"], opts(dbPath));
    expect(gone.stdout).toMatch(/2 read \(full\), 0 changed, 1 marked deleted upstream, 0 skipped; total=2/);
    let db = openDatabaseReadOnly(dbPath);
    try {
      expect(db.prepare("SELECT source_deleted_at IS NOT NULL AS gone FROM profile_versions WHERE id='p2'").get()).toEqual({ gone: 1 });
      const asOf = tool(db, dbPath, "get_profile_as_of", { at: "2025-11-02 12:00" });
      expect(asOf.version.id).toBe("p1");
      expect(asOf.version.end.ts).toBe("2025-11-03T18:00:00.000Z");
      const changes = tool(db, dbPath, "list_profile_changes");
      expect(changes.versions.map((v: any) => v.id)).toEqual(["p1", "p3"]);
      expect(changes.versions[1]).toMatchObject({ change: "settings_edit", active_profile_changed_fields: ["basal"] });
      const withDeleted = tool(db, dbPath, "list_profile_changes", { include_deleted: true });
      expect(withDeleted.versions.map((v: any) => [v.id, !!v.deleted_upstream_at])).toEqual([
        ["p1", false],
        ["p2", true],
        ["p3", false]
      ]);
      expect(tool(db, dbPath, "get_active_profile").profile_sync).toMatchObject({ versions: 2, deleted_upstream_versions: 1 });
    } finally {
      db.close();
    }

    profileDocs = [...ALL_PROFILE_DOCS];
    const back = await run(SYNC, ["profiles"], opts(dbPath));
    expect(back.stdout).toMatch(/3 read \(full\), 1 changed, 0 marked deleted upstream, 0 skipped; total=3/);
    db = openDatabaseReadOnly(dbPath);
    expect(db.prepare("SELECT COUNT(*) AS n FROM profile_versions WHERE source_deleted_at IS NULL").get()).toEqual({ n: 3 });
    db.close();
  }, 60_000);

  it("a profile endpoint failure is recorded without blocking the treatment sync or leaking the URL/secret", async () => {
    profileDocs = [...ALL_PROFILE_DOCS];
    profileStatus = 500;
    const dbPath = tempDb();
    try {
      const out = await run(SYNC, ["sync"], opts(dbPath));
      expect(out.stdout).toMatch(/totals: sgv=0 treatments=18/);
      expect(out.stderr).toMatch(/WARNING: profile sync failed \(HTTPError: HTTP Error 500/);
      expect(out.stdout + out.stderr).not.toContain(SECRET);
      expect(out.stdout + out.stderr).not.toContain(baseUrl);
      const db = openDatabaseReadOnly(dbPath);
      const status = tool(db, dbPath, "get_active_profile");
      expect(status.found).toBe(false);
      expect(status.profile_sync.last_profile_error).toMatch(/HTTP Error 500/);
      expect(tool(db, dbPath, "sync_status").stale).toBe(false);
      db.close();

      const only = (await run(SYNC, ["profiles"], opts(dbPath)).catch((e) => e)) as { code: number };
      expect(only.code).toBe(1);
    } finally {
      profileStatus = 200;
    }
    const ok = await run(SYNC, ["profiles"], opts(dbPath));
    expect(ok.stdout).toMatch(/total=3/);
    const db = openDatabaseReadOnly(dbPath);
    expect(tool(db, dbPath, "get_active_profile").profile_sync.last_profile_error).toBeNull();
    db.close();
  }, 60_000);
});

describe("profile tools", () => {
  let dbPath: string;
  let db: DatabaseSync;
  const call = (name: string, args: Record<string, unknown> = {}) => tool(db, dbPath, name, args);

  beforeAll(async () => {
    profileDocs = [...ALL_PROFILE_DOCS];
    profileStatus = 200;
    dbPath = tempDb();
    await run(SYNC, ["sync"], opts(dbPath));
    db = openDatabaseReadOnly(dbPath);
  }, 60_000);

  afterAll(() => db.close());

  it("get_active_profile returns the newest version's active schedules", () => {
    const r = call("get_active_profile");
    expect(r.found).toBe(true);
    expect(r.version).toMatchObject({ id: "p3", active_profile: "Standard", end: null, start: { ts: "2025-11-03T18:00:00.000Z", local: "2025-11-03T12:00:00-06:00" } });
    expect(r.active_profile).toMatchObject({
      name: "Standard",
      units: "mg/dl",
      dia_hours: 4,
      basal: [
        { time: "00:00", until: "06:00", value: 1 },
        { time: "06:00", until: "24:00", value: 3 }
      ],
      carb_ratio: [
        { time: "00:00", until: "12:00", value: 10 },
        { time: "12:00", until: "24:00", value: 5 }
      ],
      sensitivity: [{ time: "00:00", until: "24:00", value: 50 }],
      target_low: [{ time: "00:00", until: "24:00", value: 100 }],
      target_high: [{ time: "00:00", until: "24:00", value: 120 }],
      scheduled_basal_u_per_day: 60
    });
    expect(r.other_profiles).toEqual(["Exercise"]);
    expect(call("get_active_profile", { include_all_profiles: true }).other_profiles[0]).toMatchObject({ name: "Exercise", scheduled_basal_u_per_day: 23.25 });
  });

  it("get_profile_as_of picks the version in force, including a switch mid-segment", () => {
    const before = call("get_profile_as_of", { at: "2025-11-01 12:29" });
    expect(before).toMatchObject({ found: true, version: { id: "p1", active_profile: "Standard" } });
    expect(before.in_force_at_time).toMatchObject({ local_time: "12:29", basal: { value: 2, segment: "06:00-24:00" }, carb_ratio: { value: 5, segment: "12:00-24:00" } });
    expect(before.next_change).toMatchObject({ ts: "2025-11-01T17:30:00.000Z", active_profile: "Exercise" });

    const at = call("get_profile_as_of", { at: "2025-11-01 12:30" });
    expect(at.version.id).toBe("p2");
    expect(at.in_force_at_time).toMatchObject({ basal: { value: 1 }, carb_ratio: { value: 20 } });
    expect(call("get_profile_as_of", { at: "2025-11-01T17:30:00Z" }).version.id).toBe("p2");

    const day = call("get_profile_as_of", { at: "2025-11-03" });
    expect(day.at.local).toBe("2025-11-03T00:00:00-06:00");
    expect(day.version.id).toBe("p2");
    expect(day.changes_that_day).toEqual([{ ts: "2025-11-03T18:00:00.000Z", local: "2025-11-03T12:00:00-06:00", id: "p3", active_profile: "Standard" }]);

    // Repeated fall-back hour: the first 01:45 (CDT) is meant.
    const ambiguous = call("get_profile_as_of", { at: "2025-11-02 01:45" });
    expect(ambiguous.at.ts).toBe("2025-11-02T06:45:00.000Z");
    expect(ambiguous.in_force_at_time.basal.value).toBe(1);

    const early = call("get_profile_as_of", { at: "2025-09-01" });
    expect(early.found).toBe(false);
    expect(early.earliest_version.id).toBe("p1");
    expect(early.note).toMatch(/Not extrapolated/);

    expect(call("get_profile_as_of", { at: "2026-03-08 02:30" }).error).toMatch(/does not exist/);
    expect(call("get_profile_as_of", { at: "yesterday" }).error).toMatch(/at must be/);
  });

  it("list_profile_changes classifies switches and edits", () => {
    const r = call("list_profile_changes");
    expect(r.matched).toBe(3);
    expect(r.versions.map((v: any) => [v.id, v.change, v.previous_active_profile ?? null, v.active_profile_changed_fields ?? null])).toEqual([
      ["p1", "first_version", null, null],
      ["p2", "profile_switch", "Standard", []],
      ["p3", "profile_switch_and_edit", "Exercise", ["basal"]]
    ]);
    expect(r.versions[1].end.ts).toBe("2025-11-03T18:00:00.000Z");
    expect(r.versions[2]).toMatchObject({ profiles_added: [], profiles_removed: [], other_profiles_edited: [] });
    const filtered = call("list_profile_changes", { date_from: "2025-11-02", include_settings: true });
    expect(filtered.versions.map((v: any) => v.id)).toEqual(["p3"]);
    expect(filtered.versions[0].active_profile_settings.basal[1].value).toBe(3);
  });

  it("get_settings_vs_delivery integrates the schedule across switches and both DST-repeated boundaries", () => {
    const r = call("get_settings_vs_delivery", { date_from: "2025-11-01", date_to: "2025-11-03", include_days: true });
    expect(r.window).toMatchObject({ hours: 73, days: 3 });
    expect(r.profile_coverage).toMatchObject({ hours_with_profile: 73, hours_without_profile: 0 });
    expect(r.profile_coverage.versions_in_force.map((v: any) => v.id)).toEqual(["p1", "p2", "p3"]);
    expect(r.basal).toMatchObject({
      programmed_u: 101.75,
      delivered_u: 102.25,
      delivered_minus_programmed_u: 0.5,
      delivery_hours_recorded: 73,
      delivered_by_reason_u_whole_window: { Profile: 99.25, Algorithm: 3, Suspended: 0 }
    });
    expect(r.by_day.map((d: any) => [d.day, d.programmed_basal_u, d.hours_with_profile])).toEqual([
      ["2025-11-01", PROGRAMMED_BASAL["2025-11-01"], 24],
      ["2025-11-02", PROGRAMMED_BASAL["2025-11-02"], 25],
      ["2025-11-03", PROGRAMMED_BASAL["2025-11-03"], 24]
    ]);
    const exercise = r.basal.by_segment.find((b: any) => b.profile === "Exercise" && b.segment === "01:30-24:00");
    // 11-01 12:30–24:00 (11.5 h) + 11-02 01:30 CDT–02:00 and 01:30 CST–24:00 (0.5 + 22.5 h) + 11-03 01:30–12:00 (10.5 h)
    expect(exercise).toMatchObject({ programmed_u_per_h: 1, hours: 45, programmed_u: 45, delivered_u: 47 });
    expect(r.carbs).toMatchObject({
      carb_entries: 3,
      carbs_g: 95,
      programmed_carb_insulin_u: 10,
      carb_bolus_delivered_u: 11,
      implied_carb_ratio_g_per_u: 8.64
    });
    expect(r.carbs.by_segment.map((b: any) => [b.profile, b.segment, b.programmed_carb_ratio_g_per_u, b.programmed_carb_insulin_u, b.carb_bolus_delivered_u])).toEqual([
      ["Standard", "00:00-12:00", 10, 3, 3],
      ["Exercise", "00:00-24:00", 20, 2, 2],
      ["Standard", "12:00-24:00", 5, 5, 6]
    ]);
    expect(r.insulin_totals).toMatchObject({ bolus_u_all: 12, total_u: 114.25 });
    expect(r.note).toMatch(/not dosing advice/);
  });

  it("reports hours before the first profile version instead of extrapolating", () => {
    // p1 starts 2025-10-01T00:00Z = 2025-09-30 19:00 CDT
    const r = call("get_settings_vs_delivery", { date_from: "2025-09-30" });
    expect(r.profile_coverage).toMatchObject({ hours_with_profile: 5, hours_without_profile: 19 });
    expect(r.basal.programmed_u).toBe(10); // Standard 06:00 segment, 2 U/h × 5 h
    expect(r.profile_coverage.note).toMatch(/nothing is extrapolated/);
    expect(call("get_settings_vs_delivery", { date_from: "2025-01-01", date_to: "2026-12-31" }).error).toMatch(/limit for this tool is 366/);
  });
});

describe("wall clock helpers", () => {
  it("finds both instants of a repeated fall-back time and none in the spring-forward gap", () => {
    expect(wallInstants("2025-11-02", 5400).map((ms) => new Date(ms).toISOString())).toEqual([
      "2025-11-02T06:30:00.000Z",
      "2025-11-02T07:30:00.000Z"
    ]);
    expect(wallInstants("2026-03-08", 9000)).toEqual([]);
    expect(wallInstants("2026-03-08", 10800).map((ms) => new Date(ms).toISOString())).toEqual(["2026-03-08T08:00:00.000Z"]);
  });
});

describe("archive without profile tables", () => {
  it("the profile tools explain instead of failing", () => {
    const file = tempDb();
    const w = openDatabaseForFixture(file);
    w.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    w.close();
    const ro = openDatabaseReadOnly(file);
    expect(tool(ro, file, "get_active_profile").error).toMatch(/no pump profile tables/);
    ro.close();
  });
});
