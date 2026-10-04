import { describe, expect, it } from "vitest";
import { callTool } from "../src/mcp/queries.js";
import { TOOL_DEFINITIONS } from "../src/mcp/tools.js";
import { createFixture } from "./fixture.js";

const { path: dbPath, db } = createFixture();

function call(name: string, args: Record<string, unknown> = {}): any {
  return JSON.parse(callTool(db, name, args, dbPath));
}

describe("tool list", () => {
  it("exposes exactly the 8 locked V1 tools, all read-only", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([
      "sync_status",
      "list_sgv",
      "list_treatments",
      "get_daily_stats",
      "get_weekly_stats",
      "get_range_stats",
      "get_coverage",
      "query_raw"
    ]);
    for (const t of TOOL_DEFINITIONS) expect(t.annotations.readOnlyHint).toBe(true);
  });

  it("never describes a 70-180 band", () => {
    expect(JSON.stringify(TOOL_DEFINITIONS)).not.toMatch(/70\s*[-–]\s*180/);
  });
});

describe("sync_status", () => {
  it("reports freshness, counts, spans, and the 80-180 band", () => {
    const r = call("sync_status");
    expect(r.counts).toEqual({ sgv: 864, treatments: 5, daily_stats: 2, weekly_stats: 2 });
    expect(r.schema_version).toBe("1");
    expect(r.tir_band).toMatchObject({ low: 80, high: 180, meta_low: 80, meta_high: 180 });
    expect(r.last_sync_at).toBe("2025-11-04T11:15:04Z");
    expect(r.stale).toBe(true);
    expect(r.sgv.earliest.ts).toBe("2025-11-01T05:00:00.000Z");
    expect(r.sgv.earliest.local).toBe("2025-11-01T00:00:00-05:00");
    expect(r.sgv.latest.local).toBe("2025-11-03T23:55:00-06:00");
    expect(r.treatments.latest.created_at).toBe("2025-11-04T05:30:00Z");
    expect(r.daily_stats).toEqual({ first_day: "2025-11-01", last_day: "2025-11-03" });
    expect(r.weekly_stats).toEqual({ first_week_ending: "2025-10-25", last_week_ending: "2025-11-01" });
  });

  it("hides URL-like meta keys and redacts URLs in values", () => {
    const r = call("sync_status");
    const text = JSON.stringify(r);
    expect(text).not.toContain("example-ns.invalid");
    expect(r.meta.nightscout_url).toBeUndefined();
    expect(r.meta.path_note).toContain("[redacted-url]");
  });
});

describe("list_sgv", () => {
  it("returns a whole 25-hour fall-back day in Chicago time", () => {
    const r = call("list_sgv", { date_from: "2025-11-02" });
    expect(r.matched).toBe(300);
    expect(r.rows[0]).toEqual({
      ts: "2025-11-02T05:00:00.000Z",
      local: "2025-11-02T00:00:00-05:00",
      sgv: 200,
      direction: "Flat",
      device: "share2"
    });
    expect(r.rows.at(-1).local).toBe("2025-11-02T23:55:00-06:00");
    expect(r.rows[0].raw_json).toBeUndefined();
  });

  it("slices overnight 00:00-06:00 on each day", () => {
    const r = call("list_sgv", { date_from: "2025-11-01", date_to: "2025-11-03", time_from: "00:00", time_to: "06:00" });
    expect(r.matched).toBe(72 + 84 + 72);
    expect(r.rows.every((row: any) => row.sgv === 200)).toBe(true);
  });

  it("supports wrap-around slices, sample, order, limit, and include_raw", () => {
    const wrap = call("list_sgv", { date_from: "2025-11-01", time_from: "22:00", time_to: "02:00" });
    expect(wrap.matched).toBe(48);
    const sampled = call("list_sgv", { date_from: "2025-11-01", sample: 12, order: "desc", limit: 5, include_raw: true });
    expect(sampled.matched).toBe(288);
    expect(sampled.returned).toBe(5);
    expect(sampled.truncated).toBe(true);
    expect(sampled.rows[0].local).toBe("2025-11-01T23:00:00-05:00");
    expect(JSON.parse(sampled.rows[0].raw_json).sgv).toBe(150);
  });

  it("rejects bad input with a clear error", () => {
    expect(call("list_sgv", {}).error).toMatch(/date_from is required/);
    expect(call("list_sgv", { date_from: "2025-11-31" }).error).toMatch(/YYYY-MM-DD/);
    expect(call("list_sgv", { date_from: "2025-11-01", time_from: "25:00" }).error).toMatch(/HH:MM/);
    expect(call("list_sgv", { date_from: "2025-01-01", date_to: "2025-03-01" }).error).toMatch(/limit for this tool is 31/);
  });
});

describe("list_treatments", () => {
  it("assigns treatments to Chicago days and returns the documented fields", () => {
    const r = call("list_treatments", { date_from: "2025-11-03" });
    expect(r.rows.map((t: any) => t.id)).toEqual(["t4", "t5"]);
    expect(r.rows[1]).toMatchObject({ event_type: "Correction Bolus", insulin: 1.5, local: "2025-11-03T23:30:00-06:00" });
    expect(Object.keys(r.rows[0])).toEqual([
      "id",
      "created_at",
      "local",
      "event_type",
      "insulin",
      "insulin_counted",
      "carbs",
      "duration_min",
      "rate",
      "percent",
      "absolute",
      "entered_by",
      "notes"
    ]);
    expect(call("list_treatments", { date_from: "2025-11-02" }).matched).toBe(0);
  });

  it("filters by event_type (case-insensitive, list) and entered_by substring", () => {
    const byType = call("list_treatments", { date_from: "2025-11-01", date_to: "2025-11-03", event_type: ["combo bolus", "Temp Basal"] });
    expect(byType.rows.map((t: any) => t.id)).toEqual(["t1", "t3"]);
    const byWho = call("list_treatments", { date_from: "2025-11-01", entered_by: "patient" });
    expect(byWho.rows.map((t: any) => t.id)).toEqual(["t2"]);
    const raw = call("list_treatments", { date_from: "2025-11-01", event_type: "Combo Bolus", include_raw: true });
    expect(JSON.parse(raw.rows[0].raw_json).notes).toBe("split 60/40");
  });
});

describe("daily and weekly stats", () => {
  it("returns one day, a range, or the newest days", () => {
    const one = call("get_daily_stats", { date: "2025-11-01" });
    expect(one.found).toBe(true);
    expect(one.rows[0]).toMatchObject({ day: "2025-11-01", tir_80_180: 50, cv_pct: 35.12, tdd_u: 12.5, bolus_u: 3, basal_u: 0.8, sgv_count: 288 });
    expect(call("get_daily_stats", { date: "2025-11-02" }).found).toBe(false);
    expect(call("get_daily_stats", { date_from: "2025-11-01", date_to: "2025-11-03" }).count).toBe(2);
    const newest = call("get_daily_stats", { limit: 1 });
    expect(newest.rows[0].day).toBe("2025-11-03");
  });

  it("returns weeks with trend_note", () => {
    const one = call("get_weekly_stats", { week_ending: "2025-11-01" });
    expect(one.rows[0]).toMatchObject({ week_start: "2025-10-26", trend_note: "steady", tdd_u: 41 });
    expect(call("get_weekly_stats", { week_ending: "2025-11-02" }).note).toMatch(/not a Saturday/);
    const newest = call("get_weekly_stats", {});
    expect(newest.rows.map((w: any) => w.week_ending)).toEqual(["2025-10-25", "2025-11-01"]);
  });
});

describe("get_range_stats", () => {
  it("computes TIR 80-180 for the fall-back day", () => {
    const r = call("get_range_stats", { date_from: "2025-11-02" });
    expect(r).toMatchObject({ sgv_count: 300, tir_80_180: 48, under_80: 24, over_180: 28, min_mgdl: 70, max_mgdl: 200 });
    expect(r.hours_covered).toBe(25);
  });

  it("slices overnight across days and reports coverage", () => {
    const r = call("get_range_stats", { date_from: "2025-11-01", date_to: "2025-11-03", time_from: "00:00", time_to: "06:00" });
    expect(r).toMatchObject({ sgv_count: 228, over_180: 100, tir_80_180: 0, avg_mgdl: 200, cv_pct: 0 });
    expect(r.window_hours).toBe(18);
  });

  it("filters weekdays and adds insulin totals", () => {
    const mon = call("get_range_stats", { date_from: "2025-11-01", date_to: "2025-11-03", weekdays: ["Monday"], include_insulin: true });
    expect(mon).toMatchObject({ days_in_slice: 1, sgv_count: 276, tir_80_180: 47.83, under_80: 26.09, over_180: 26.09 });
    expect(mon.insulin).toMatchObject({ bolus_u: 3.5, temp_basal_u: 0, carbs_g: 30, treatment_count: 2 });
    const night = call("get_range_stats", { date_from: "2025-11-01", time_from: "00:00", time_to: "06:00", include_insulin: true });
    expect(night.insulin).toMatchObject({ bolus_u: 0, temp_basal_u: 0.8, basal_u: 0.8, treatment_count: 1 });
    const day = call("get_range_stats", { date_from: "2025-11-01", include_insulin: true });
    expect(day.insulin).toMatchObject({ bolus_u: 3, temp_basal_u: 0.8, total_u: 3.8, carbs_g: 45, treatment_count: 3 });
  });

  it("rejects unknown weekdays and zero-length slices", () => {
    expect(call("get_range_stats", { date_from: "2025-11-01", weekdays: ["Funday"] }).error).toMatch(/Unknown weekday/);
    expect(call("get_range_stats", { date_from: "2025-11-01", time_from: "06:00", time_to: "06:00" }).error).toMatch(/same time/);
  });
});

describe("get_coverage", () => {
  it("finds low days, days without daily_stats, and gaps", () => {
    const r = call("get_coverage", { low_threshold: 280, include_gaps: true });
    expect(r).toMatchObject({
      date_from: "2025-11-01",
      date_to: "2025-11-03",
      days_in_range: 3,
      days_with_sgv: 3,
      missing_days_count: 0,
      low_days: [{ day: "2025-11-03", sgv_count: 276 }],
      days_without_daily_stats: ["2025-11-02"],
      gaps_count: 1
    });
    expect(r.gaps[0]).toEqual({ from: "2025-11-03T09:55:00-06:00", to: "2025-11-03T11:00:00-06:00", minutes: 65 });
  });

  it("lists days with no readings inside an explicit window", () => {
    const r = call("get_coverage", { date_from: "2025-10-30", date_to: "2025-11-01" });
    expect(r.missing_days).toEqual(["2025-10-30", "2025-10-31"]);
  });
});

describe("query_raw", () => {
  it("runs a single read-only SELECT and caps at 1000 rows", () => {
    const r = call("query_raw", { sql: "SELECT a.date_ms FROM sgv a CROSS JOIN sgv b" });
    expect(r.count).toBe(1000);
    expect(r.truncated).toBe(true);
    const w = call("query_raw", { sql: "WITH x AS (SELECT COUNT(*) AS n FROM treatments) SELECT n FROM x;" });
    expect(w.rows).toEqual([{ n: 5 }]);
  });

  it("refuses writes and multiple statements", () => {
    expect(call("query_raw", { sql: "DELETE FROM sgv" }).error).toMatch(/SELECT/);
    expect(call("query_raw", { sql: "SELECT 1; DROP TABLE sgv" }).error).toMatch(/single statement/);
    expect(call("query_raw", { sql: "WITH x AS (SELECT 1) INSERT INTO meta VALUES ('a','b')" }).error).toMatch(/read-only/);
    expect(call("query_raw", { sql: "SELECT * FROM nope" }).error).toMatch(/Query failed/);
  });
});
