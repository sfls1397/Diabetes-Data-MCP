const dateFrom = { type: "string", description: "Inclusive start day, YYYY-MM-DD (America/Chicago)." };
const dateTo = { type: "string", description: "Inclusive end day, YYYY-MM-DD (America/Chicago). Defaults to date_from." };
const timeFrom = {
  type: "string",
  description:
    "Optional local start time HH:MM (America/Chicago), inclusive, applied to every day. If time_from is later than time_to the slice wraps midnight (22:00–06:00)."
};
const timeTo = {
  type: "string",
  description: "Optional local end time HH:MM (America/Chicago), exclusive, applied to every day. 24:00 means end of day."
};
const limit = { type: "number", description: "Max rows to return." };

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOL_DEFINITIONS = [
  {
    name: "sync_status",
    description:
      "Archive freshness and coverage: last_sync_at / last_sync_mode from meta, hours since the last sync (stale after 1h), row counts per table, earliest/latest SGV and treatment timestamps, daily/weekly stats span, schema_version, and the TIR band (80–180). Call this first when freshness matters; the sync runs every minute.",
    inputSchema: { type: "object", properties: {} },
    annotations: readOnly
  },
  {
    name: "list_sgv",
    description:
      "CGM glucose readings (mg/dL) for local days date_from..date_to, oldest first. Optional time_from/time_to slice each day (e.g. overnight 00:00–06:00). Returns ts (ISO UTC), local (Chicago ISO), sgv, direction, device. raw_json only with include_raw. sample=N keeps every Nth matching reading. At most 31 days.",
    inputSchema: {
      type: "object",
      properties: {
        date_from: dateFrom,
        date_to: dateTo,
        time_from: timeFrom,
        time_to: timeTo,
        sample: { type: "number", description: "Keep every Nth matching reading (N >= 1). Applied before limit." },
        order: { type: "string", enum: ["asc", "desc"], description: "Default asc (oldest first)." },
        include_raw: { type: "boolean", description: "Include the stored Nightscout raw_json. Default false." },
        limit: { ...limit, description: "Max rows to return. Default 1000, max 10000." }
      },
      required: ["date_from"]
    },
    annotations: readOnly
  },
  {
    name: "list_treatments",
    description:
      "Nightscout/pump treatments for local days date_from..date_to, oldest first: created_at (ISO UTC), local, event_type, insulin, insulin_counted, carbs, duration_min, rate, percent, absolute, entered_by, notes. insulin_counted is what the row adds to insulin totals: for a Care Portal combo bolus (immediate units in insulin, total in raw enteredinsulin) it includes the extended part unless that part has its own row. Filter by event_type (exact, case-insensitive; e.g. Combo Bolus, Temp Basal, Basal Suspension, Basal Resume, Site Change, Sensor Start) and entered_by substring. include_raw adds raw_json (combo-bolus split details). At most 366 days.",
    inputSchema: {
      type: "object",
      properties: {
        date_from: dateFrom,
        date_to: dateTo,
        event_type: {
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "One event type or a list. Exact match, case-insensitive."
        },
        entered_by: { type: "string", description: "Case-insensitive substring of entered_by." },
        include_raw: { type: "boolean", description: "Include the stored Nightscout raw_json. Default false." },
        limit: { ...limit, description: "Max rows to return. Default 500, max 5000." }
      },
      required: ["date_from"]
    },
    annotations: readOnly
  },
  {
    name: "get_daily_stats",
    description:
      "Precomputed daily rollups from daily_stats (Chicago days): tir_80_180, under_80, over_180 (percent of readings), avg_mgdl, cv_pct, tdd_u, bolus_u, basal_u, sgv_count. Pass date for one day, date_from/date_to for a range, or nothing for the newest `limit` days (default 14).",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "One day, YYYY-MM-DD (America/Chicago)." },
        date_from: dateFrom,
        date_to: dateTo,
        limit: { ...limit, description: "Newest days to return when no date is given. Default 14, max 1000." }
      }
    },
    annotations: readOnly
  },
  {
    name: "get_weekly_stats",
    description:
      "Precomputed Sunday–Saturday weeks from weekly_stats (week_ending is the Saturday): week_start, tir_80_180, under_80, over_180, avg_mgdl, cv_pct, tdd_u (average per day), sgv_count, trend_note. Pass week_ending for one week, date_from/date_to to filter week_ending, or nothing for the newest `limit` weeks (default 8).",
    inputSchema: {
      type: "object",
      properties: {
        week_ending: { type: "string", description: "Saturday that ends the week, YYYY-MM-DD." },
        date_from: { type: "string", description: "Earliest week_ending to include, YYYY-MM-DD." },
        date_to: { type: "string", description: "Latest week_ending to include, YYYY-MM-DD." },
        limit: { ...limit, description: "Newest weeks when no week is given. Default 8, max 520." }
      }
    },
    annotations: readOnly
  },
  {
    name: "get_range_stats",
    description:
      "Computed glucose stats for any window daily_stats cannot answer: local days date_from..date_to, optional time_from/time_to slice applied to each day (overnight, meal 4h windows), optional weekdays filter. Returns tir_80_180, under_80, over_180 (percent), avg_mgdl, sd_mgdl, cv_pct, min/max, sgv_count, hours_covered vs window_hours. include_insulin adds bolus / temp-basal / carbs totals from treatments in the same slice. At most 366 days.",
    inputSchema: {
      type: "object",
      properties: {
        date_from: dateFrom,
        date_to: dateTo,
        time_from: timeFrom,
        time_to: timeTo,
        weekdays: {
          type: "array",
          items: { type: "string" },
          description: "Only these local weekdays: Sun, Mon, Tue, Wed, Thu, Fri, Sat (full names or 0–6 with 0=Sunday also accepted)."
        },
        include_insulin: {
          type: "boolean",
          description:
            "Add treatment totals in the same slice: bolus_u, temp_basal_u (insulin, else rate × duration; not clipped to the slice), other_basal_u, carbs_g. Scheduled profile basal is not in the archive. Default false."
        }
      },
      required: ["date_from"]
    },
    annotations: readOnly
  },
  {
    name: "get_coverage",
    description:
      "Archive health for import and gap questions: earliest/latest SGV and treatments, and per local day in date_from..date_to (default: the whole SGV span) the days with no readings and days with fewer than low_threshold readings (a full CGM day is ~288). include_gaps lists runs with no reading longer than gap_minutes. Also flags days that have readings but no daily_stats row.",
    inputSchema: {
      type: "object",
      properties: {
        date_from: dateFrom,
        date_to: { type: "string", description: "Inclusive end day, YYYY-MM-DD (America/Chicago)." },
        low_threshold: { type: "number", description: "Days with fewer readings than this are low. Default 200." },
        include_gaps: { type: "boolean", description: "List reading gaps. Default false." },
        gap_minutes: { type: "number", description: "Minimum gap length for include_gaps. Default 30." },
        limit: { ...limit, description: "Max days / gaps listed per list. Default 200, max 2000." }
      }
    },
    annotations: readOnly
  },
  {
    name: "query_raw",
    description:
      "Read-only single SELECT (or WITH … SELECT) for a question the other tools do not answer. Prefer the structured tools. Tables: sgv(date_ms UTC ms, date_string, sgv, direction, device, type, raw_json), treatments(id, created_at ISO UTC, timestamp_ms, event_type, insulin, carbs, duration_min, rate, percent, absolute, entered_by, notes, raw_json), daily_stats(day, tir_80_180, under_80, over_180, avg_mgdl, cv_pct, tdd_u, bolus_u, basal_u, sgv_count, source, updated_at), weekly_stats(week_ending, week_start, …, trend_note), meta(key, value). SQLite date functions are UTC. Results are capped at 1000 rows.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SELECT statement" }
      },
      required: ["sql"]
    },
    annotations: readOnly
  },
  {
    name: "get_active_profile",
    description:
      "The pump profile in force now: the newest profile version's active profile (Nightscout defaultProfile, uploaded by tconnectsync) with every schedule segment as local America/Chicago HH:MM–HH:MM: carb_ratio (g/U), sensitivity (mg/dL per U), basal (U/h), target_low/target_high, dia_hours, and scheduled_basal_u_per_day. in_force_now gives the segment values at the current local time. other_profiles lists the pump's other named profiles (full settings with include_all_profiles). profile_sync shows when profiles were last mirrored.",
    inputSchema: {
      type: "object",
      properties: {
        include_all_profiles: { type: "boolean", description: "Return full settings for the other named profiles too. Default false (names only)." }
      }
    },
    annotations: readOnly
  },
  {
    name: "get_profile_as_of",
    description:
      "The pump profile that was in force at a past time: the profile version whose start is the latest on or before `at`, its active profile's full schedules, and in_force_at_time (the carb ratio, sensitivity, basal and target segments at that local time of day). A date alone means 00:00 local and also lists changes_that_day. next_change says when the next version took over. Before the archive's first profile version it returns found:false; nothing is extrapolated.",
    inputSchema: {
      type: "object",
      properties: {
        at: {
          type: "string",
          description: "YYYY-MM-DD or YYYY-MM-DD HH:MM (America/Chicago local), or an ISO timestamp with Z or an offset."
        },
        include_all_profiles: { type: "boolean", description: "Return full settings for the other named profiles too. Default false." }
      },
      required: ["at"]
    },
    annotations: readOnly
  },
  {
    name: "list_profile_changes",
    description:
      "Pump profile change history, oldest first: each profile version's start/end (local and UTC; end = next version's start, null = still in force), active_profile, previous_active_profile, change type (first_version, profile_switch, settings_edit, profile_switch_and_edit, no_active_change), which fields of the active profile changed (carb_ratio, sensitivity, basal, target_low, target_high, dia, units), and profiles added, removed or edited. Filter by the local day a version started (date_from/date_to). include_settings adds each version's full active-profile schedules.",
    inputSchema: {
      type: "object",
      properties: {
        date_from: { type: "string", description: "Earliest local start day to include, YYYY-MM-DD (America/Chicago)." },
        date_to: { type: "string", description: "Latest local start day to include, YYYY-MM-DD (America/Chicago)." },
        include_settings: { type: "boolean", description: "Add each version's full active-profile schedules. Default false." },
        include_deleted: { type: "boolean", description: "Also list versions since deleted in Nightscout (kept in the archive, flagged). Default false." },
        limit: { ...limit, description: "Max versions to return. Default 100, max 1000." }
      }
    },
    annotations: readOnly
  },
  {
    name: "get_settings_vs_delivery",
    description:
      "Programmed pump settings vs delivered insulin for local days date_from..date_to, using the profile version in force at each moment (schedule segments by local time of day; profile switches mid-range split the time exactly). basal: programmed_u (active basal schedule integrated over time) vs delivered_u (Temp Basal rate × time, including Control-IQ changes and suspensions), totals and per profile/segment. carbs: per carb entry the carb ratio in force, programmed_carb_insulin_u (carbs ÷ ratio) vs the bolus actually logged with those carbs, implied g/U, per profile/segment. Also total bolus/basal/TDD. include_days adds per-day rows. Hours before the first recorded profile are reported, never extrapolated. Data only, not dosing advice. At most 366 days.",
    inputSchema: {
      type: "object",
      properties: {
        date_from: dateFrom,
        date_to: dateTo,
        include_days: { type: "boolean", description: "Add per-day programmed vs delivered rows. Default false." }
      },
      required: ["date_from"]
    },
    annotations: readOnly
  }
];
