import fs from "node:fs";
import type { DatabaseSync } from "../db/open.js";
import { tableColumns, tableExists } from "../db/open.js";
import {
  WEEKDAY_NAMES,
  TIMEZONE,
  dayRangeMs,
  eachDay,
  localIso,
  localParts,
  parseTimestamp
} from "../time.js";
import {
  QueryError,
  assertHm,
  assertYmd,
  bool,
  clampLimit,
  dateWindow,
  errorJson,
  isSecretKey,
  json,
  num,
  redactUrls,
  round,
  stringList
} from "./sql.js";
import { runGetActiveProfile, runGetProfileAsOf, runGetSettingsVsDelivery, runListProfileChanges } from "./profiles.js";

/** Product rule: time in range is 80–180 mg/dL. Never 70–180. */
export const TIR_LOW = 80;
export const TIR_HIGH = 180;
export const WRITER = "com.diabetes-sqlite.sync (every minute)";
/** The sync runs every minute; an hour without one means it is stuck. */
const STALE_AFTER_HOURS = 1;
const CGM_SLOT_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

type Row = Record<string, unknown>;

function isoUtc(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

function stamp(ms: number | null): { ts: string | null; local: string | null } {
  return { ts: isoUtc(ms), local: ms == null ? null : localIso(ms) };
}

// ---------------------------------------------------------------------------
// Slices: local time-of-day and weekday filters

interface Slice {
  fromMin?: number;
  toMin?: number;
  weekdays?: Set<number>;
  /** minutes per day the slice covers */
  minutesPerDay: number;
  matches(ms: number): boolean;
  describe: Record<string, unknown>;
}

function parseWeekdays(value: unknown): Set<number> | undefined {
  const list = stringList(value, "weekdays");
  if (!list) return undefined;
  const out = new Set<number>();
  for (const raw of list) {
    const v = raw.toLowerCase();
    const idx = /^[0-6]$/.test(v) ? Number(v) : WEEKDAY_NAMES.findIndex((n) => v.startsWith(n.toLowerCase()));
    if (idx < 0) throw new QueryError(`Unknown weekday ${JSON.stringify(raw)}; use Sun, Mon, Tue, Wed, Thu, Fri, Sat`);
    out.add(idx);
  }
  return out;
}

function buildSlice(args: Record<string, unknown>, allowWeekdays: boolean): Slice {
  const fromMin = assertHm(args.time_from, "time_from");
  const toMin = assertHm(args.time_to, "time_to");
  const weekdays = allowWeekdays ? parseWeekdays(args.weekdays) : undefined;
  const f = fromMin ?? 0;
  const t = toMin ?? 1440;
  if ((fromMin !== undefined || toMin !== undefined) && f % 1440 === t % 1440 && !(f === 0 && t === 1440)) {
    throw new QueryError("time_from and time_to are the same time; omit both for whole days");
  }
  const wraps = f > t;
  const minutesPerDay = wraps ? 1440 - f + t : t - f;
  const inTime =
    fromMin === undefined && toMin === undefined
      ? () => true
      : wraps
        ? (m: number) => m >= f || m < t
        : (m: number) => m >= f && m < t;
  return {
    fromMin,
    toMin,
    weekdays,
    minutesPerDay,
    matches(ms: number) {
      const p = localParts(ms);
      if (weekdays && !weekdays.has(p.weekday)) return false;
      return inTime(p.minuteOfDay);
    },
    describe: {
      time_from: typeof args.time_from === "string" ? args.time_from : null,
      time_to: typeof args.time_to === "string" ? args.time_to : null,
      wraps_midnight: wraps,
      weekdays: weekdays ? [...weekdays].sort().map((d) => WEEKDAY_NAMES[d]) : null
    }
  };
}

// ---------------------------------------------------------------------------
// Glucose math (same formulas as the sync's daily_stats: population SD)

export function glucoseStats(values: number[]): Record<string, number | null> {
  const n = values.length;
  if (n === 0) {
    return {
      sgv_count: 0,
      tir_80_180: null,
      under_80: null,
      over_180: null,
      avg_mgdl: null,
      sd_mgdl: null,
      cv_pct: null,
      min_mgdl: null,
      max_mgdl: null
    };
  }
  let sum = 0;
  let inRange = 0;
  let under = 0;
  let over = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    sum += v;
    if (v < TIR_LOW) under++;
    else if (v > TIR_HIGH) over++;
    else inRange++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const avg = sum / n;
  let sq = 0;
  for (const v of values) sq += (v - avg) ** 2;
  const sd = Math.sqrt(sq / n);
  return {
    sgv_count: n,
    tir_80_180: round((100 * inRange) / n),
    under_80: round((100 * under) / n),
    over_180: round((100 * over) / n),
    avg_mgdl: round(avg),
    sd_mgdl: round(sd),
    cv_pct: avg ? round((100 * sd) / avg) : null,
    min_mgdl: min,
    max_mgdl: max
  };
}

/** Same classification as the sync's daily_stats bolus_u / basal_u. */
export function insulinTotals(rows: Row[]): Record<string, number | null> {
  let bolus = 0;
  let tempBasal = 0;
  let otherBasal = 0;
  let carbs = 0;
  for (const r of rows) {
    const et = String(r.event_type ?? "").toLowerCase();
    // insulin_effective = units the row adds to totals (combo: immediate + extended when
    // its separate extended entry is absent). Older archives lack it: fall back to insulin.
    const insulin = num(r.insulin_effective) ?? num(r.insulin) ?? 0;
    const c = num(r.carbs);
    if (c) carbs += c;
    if (et.includes("bolus") || et === "smb") {
      bolus += insulin;
    } else if (et.includes("temp basal")) {
      if (insulin) tempBasal += insulin;
      else {
        const rate = num(r.rate);
        const duration = num(r.duration_min);
        if (rate != null && duration) tempBasal += (rate * duration) / 60;
      }
    } else if (et.includes("basal") && insulin) {
      otherBasal += insulin;
    }
  }
  return {
    treatment_count: rows.length,
    bolus_u: round(bolus),
    temp_basal_u: round(tempBasal),
    other_basal_u: round(otherBasal),
    basal_u: round(tempBasal + otherBasal),
    total_u: round(bolus + tempBasal + otherBasal),
    carbs_g: round(carbs)
  };
}

// ---------------------------------------------------------------------------
// Shared readers

function sgvRows(db: DatabaseSync, startMs: number, endMs: number, withRaw = false): Row[] {
  return db
    .prepare(
      `SELECT date_ms, date_string, sgv, direction, device${withRaw ? ", raw_json" : ""}
       FROM sgv WHERE date_ms >= ? AND date_ms < ? ORDER BY date_ms`
    )
    .all(startMs, endMs) as Row[];
}

/**
 * Treatments whose created_at falls in [startMs, endMs). created_at is a text
 * ISO timestamp whose exact format varies by uploader, so SQL narrows with a
 * one-day margin and the exact window is applied on the parsed time.
 */
function treatmentRows(db: DatabaseSync, startMs: number, endMs: number, withRaw = false): (Row & { _ms: number })[] {
  const effective = tableColumns(db, "treatments").has("insulin_effective") ? ", insulin_effective" : "";
  const rows = db
    .prepare(
      `SELECT id, created_at, timestamp_ms, event_type, insulin, carbs, duration_min, rate, percent, absolute,
              entered_by, notes${effective}${withRaw ? ", raw_json" : ""}
       FROM treatments
       WHERE created_at >= ? AND created_at < ?
       ORDER BY created_at`
    )
    .all(new Date(startMs - DAY_MS).toISOString(), new Date(endMs + DAY_MS).toISOString()) as Row[];
  const out: (Row & { _ms: number })[] = [];
  for (const r of rows) {
    const ms = parseTimestamp(r.created_at) ?? num(r.timestamp_ms);
    if (ms == null || ms < startMs || ms >= endMs) continue;
    out.push({ ...r, _ms: ms });
  }
  out.sort((a, b) => a._ms - b._ms);
  return out;
}

function metaMap(db: DatabaseSync): Record<string, string> {
  if (!tableExists(db, "meta")) return {};
  const out: Record<string, string> = {};
  for (const r of db.prepare("SELECT key, value FROM meta ORDER BY key").all() as Row[]) {
    const key = String(r.key);
    if (isSecretKey(key)) continue;
    out[key] = redactUrls(String(r.value ?? ""));
  }
  return out;
}

function count(db: DatabaseSync, table: string): number {
  if (!tableExists(db, table)) return 0;
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n);
}

function sgvSpan(db: DatabaseSync): { min: number | null; max: number | null } {
  const r = db.prepare("SELECT MIN(date_ms) AS lo, MAX(date_ms) AS hi FROM sgv").get() as Row;
  return { min: num(r.lo), max: num(r.hi) };
}

function treatmentSpan(db: DatabaseSync): { min: string | null; max: string | null } {
  const r = db
    .prepare("SELECT MIN(created_at) AS lo, MAX(created_at) AS hi FROM treatments WHERE created_at != ''")
    .get() as Row;
  return { min: (r.lo as string) ?? null, max: (r.hi as string) ?? null };
}

function treatmentStamp(value: string | null): { created_at: string | null; local: string | null } {
  const ms = parseTimestamp(value);
  return { created_at: value, local: ms == null ? null : localIso(ms) };
}

function statsRow(r: Row, extra: string[]): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) {
    out[k] = typeof v === "number" && !Number.isInteger(v) ? round(v) : v;
  }
  for (const k of extra) if (!(k in out)) out[k] = null;
  return out;
}

// ---------------------------------------------------------------------------
// Tools

export function runSyncStatus(db: DatabaseSync, dbPath: string, now: number = Date.now()): string {
  const meta = metaMap(db);
  let file: Row = { path: dbPath };
  try {
    const st = fs.statSync(dbPath);
    file = { path: dbPath, size_bytes: st.size, modified_at: st.mtime.toISOString() };
  } catch {
    file = { path: dbPath, error: "not readable" };
  }
  const lastSyncMs = parseTimestamp(meta.last_sync_at);
  const hoursSince = lastSyncMs == null || lastSyncMs <= 0 ? null : round((now - lastSyncMs) / 3_600_000, 1);
  const sgv = sgvSpan(db);
  const tx = treatmentSpan(db);
  const daily = db.prepare("SELECT MIN(day) AS lo, MAX(day) AS hi FROM daily_stats").get() as Row;
  const weekly = db.prepare("SELECT MIN(week_ending) AS lo, MAX(week_ending) AS hi FROM weekly_stats").get() as Row;
  const tirLow = num(meta.tir_low);
  const tirHigh = num(meta.tir_high);
  const warnings: string[] = [];
  if (hoursSince == null) warnings.push("meta.last_sync_at is missing or the epoch placeholder; no real sync recorded.");
  else if (hoursSince > STALE_AFTER_HOURS) warnings.push(`Last sync was ${hoursSince}h ago (sync runs every minute).`);
  if (tirLow !== TIR_LOW || tirHigh !== TIR_HIGH) {
    warnings.push(`meta tir band is ${tirLow}-${tirHigh}; this MCP always reports 80-180.`);
  }
  if (meta.timezone && meta.timezone !== TIMEZONE) warnings.push(`meta.timezone is ${meta.timezone}; tools use ${TIMEZONE}.`);
  return json({
    writer: WRITER,
    database: file,
    schema_version: meta.schema_version ?? null,
    timezone: TIMEZONE,
    tir_band: { low: TIR_LOW, high: TIR_HIGH, meta_low: tirLow, meta_high: tirHigh },
    last_sync_at: meta.last_sync_at ?? null,
    last_sync_mode: meta.last_sync_mode ?? null,
    hours_since_last_sync: hoursSince,
    stale: hoursSince == null || hoursSince > STALE_AFTER_HOURS,
    counts: {
      sgv: count(db, "sgv"),
      treatments: count(db, "treatments"),
      daily_stats: count(db, "daily_stats"),
      weekly_stats: count(db, "weekly_stats")
    },
    sgv: {
      earliest: stamp(sgv.min),
      latest: stamp(sgv.max),
      latest_age_minutes: sgv.max == null ? null : Math.round((now - sgv.max) / 60_000)
    },
    treatments: { earliest: treatmentStamp(tx.min), latest: treatmentStamp(tx.max) },
    daily_stats: { first_day: daily.lo ?? null, last_day: daily.hi ?? null },
    weekly_stats: { first_week_ending: weekly.lo ?? null, last_week_ending: weekly.hi ?? null },
    meta,
    warnings
  });
}

export function runListSgv(db: DatabaseSync, args: Record<string, unknown>): string {
  const { from, to } = dateWindow(args, 31);
  const slice = buildSlice(args, false);
  const sample = args.sample == null ? 1 : clampLimit(args.sample, 1, 10_000);
  const limit = clampLimit(args.limit, 1000, 10_000);
  const desc = args.order === "desc";
  const withRaw = bool(args.include_raw);
  const { startMs, endMs } = dayRangeMs(from, to);
  const matched = sgvRows(db, startMs, endMs, withRaw).filter((r) => slice.matches(Number(r.date_ms)));
  const sampled = sample > 1 ? matched.filter((_, i) => i % sample === 0) : matched;
  if (desc) sampled.reverse();
  const rows = sampled.slice(0, limit).map((r) => {
    const ms = Number(r.date_ms);
    const out: Row = { ts: isoUtc(ms), local: localIso(ms), sgv: r.sgv, direction: r.direction ?? null, device: r.device ?? null };
    if (withRaw) out.raw_json = r.raw_json ?? null;
    return out;
  });
  return json({
    date_from: from,
    date_to: to,
    timezone: TIMEZONE,
    slice: slice.describe,
    sample,
    matched: matched.length,
    returned: rows.length,
    truncated: sampled.length > rows.length,
    rows
  });
}

export function runListTreatments(db: DatabaseSync, args: Record<string, unknown>): string {
  const { from, to } = dateWindow(args, 366);
  const limit = clampLimit(args.limit, 500, 5000);
  const withRaw = bool(args.include_raw);
  const types = stringList(args.event_type, "event_type")?.map((t) => t.toLowerCase());
  const enteredBy = typeof args.entered_by === "string" && args.entered_by.trim() ? args.entered_by.trim().toLowerCase() : null;
  const { startMs, endMs } = dayRangeMs(from, to);
  const matched = treatmentRows(db, startMs, endMs, withRaw).filter((r) => {
    if (types && !types.includes(String(r.event_type ?? "").toLowerCase())) return false;
    if (enteredBy && !String(r.entered_by ?? "").toLowerCase().includes(enteredBy)) return false;
    return true;
  });
  const rows = matched.slice(0, limit).map((r) => {
    const out: Row = {
      id: r.id,
      created_at: r.created_at,
      local: localIso(r._ms),
      event_type: r.event_type ?? null,
      insulin: r.insulin ?? null,
      insulin_counted: r.insulin_effective ?? r.insulin ?? null,
      carbs: r.carbs ?? null,
      duration_min: r.duration_min ?? null,
      rate: r.rate ?? null,
      percent: r.percent ?? null,
      absolute: r.absolute ?? null,
      entered_by: r.entered_by ?? null,
      notes: r.notes ?? null
    };
    if (withRaw) out.raw_json = r.raw_json ?? null;
    return out;
  });
  const byType: Record<string, number> = {};
  for (const r of matched) {
    const k = String(r.event_type ?? "(none)");
    byType[k] = (byType[k] ?? 0) + 1;
  }
  return json({
    date_from: from,
    date_to: to,
    timezone: TIMEZONE,
    matched: matched.length,
    returned: rows.length,
    truncated: matched.length > rows.length,
    event_type_counts: byType,
    rows
  });
}

const DAILY_FIELDS = [
  "day",
  "tir_80_180",
  "under_80",
  "over_180",
  "avg_mgdl",
  "cv_pct",
  "tdd_u",
  "bolus_u",
  "basal_u",
  "sgv_count",
  "source",
  "updated_at"
];

export function runGetDailyStats(db: DatabaseSync, args: Record<string, unknown>): string {
  const cols = DAILY_FIELDS.join(", ");
  const date = assertYmd(args.date, "date");
  if (date) {
    const row = db.prepare(`SELECT ${cols} FROM daily_stats WHERE day = ?`).get(date) as Row | undefined;
    return json({
      tir_band: `${TIR_LOW}-${TIR_HIGH}`,
      found: !!row,
      rows: row ? [statsRow(row, DAILY_FIELDS)] : [],
      note: row ? undefined : `No daily_stats row for ${date}. Try get_range_stats or get_coverage.`
    });
  }
  const from = assertYmd(args.date_from, "date_from");
  const to = assertYmd(args.date_to, "date_to");
  let rows: Row[];
  if (from || to) {
    rows = db
      .prepare(`SELECT ${cols} FROM daily_stats WHERE day >= ? AND day <= ? ORDER BY day`)
      .all(from ?? "0000-00-00", to ?? "9999-99-99") as Row[];
    rows = rows.slice(0, clampLimit(args.limit, 1000, 1000));
  } else {
    const limit = clampLimit(args.limit, 14, 1000);
    rows = (db.prepare(`SELECT ${cols} FROM daily_stats ORDER BY day DESC LIMIT ?`).all(limit) as Row[]).reverse();
  }
  return json({ tir_band: `${TIR_LOW}-${TIR_HIGH}`, count: rows.length, rows: rows.map((r) => statsRow(r, DAILY_FIELDS)) });
}

const WEEKLY_FIELDS = [
  "week_ending",
  "week_start",
  "tir_80_180",
  "under_80",
  "over_180",
  "avg_mgdl",
  "cv_pct",
  "tdd_u",
  "sgv_count",
  "source",
  "trend_note",
  "updated_at"
];

export function runGetWeeklyStats(db: DatabaseSync, args: Record<string, unknown>): string {
  const cols = WEEKLY_FIELDS.join(", ");
  const week = assertYmd(args.week_ending, "week_ending");
  if (week) {
    const row = db.prepare(`SELECT ${cols} FROM weekly_stats WHERE week_ending = ?`).get(week) as Row | undefined;
    const isSaturday = new Date(`${week}T12:00:00Z`).getUTCDay() === 6;
    return json({
      tir_band: `${TIR_LOW}-${TIR_HIGH}`,
      found: !!row,
      rows: row ? [statsRow(row, WEEKLY_FIELDS)] : [],
      note: row
        ? undefined
        : isSaturday
          ? `No weekly_stats row for week ending ${week}.`
          : `${week} is not a Saturday; weeks run Sunday–Saturday and week_ending is the Saturday.`
    });
  }
  const from = assertYmd(args.date_from, "date_from");
  const to = assertYmd(args.date_to, "date_to");
  let rows: Row[];
  if (from || to) {
    rows = db
      .prepare(`SELECT ${cols} FROM weekly_stats WHERE week_ending >= ? AND week_ending <= ? ORDER BY week_ending`)
      .all(from ?? "0000-00-00", to ?? "9999-99-99") as Row[];
    rows = rows.slice(0, clampLimit(args.limit, 520, 520));
  } else {
    const limit = clampLimit(args.limit, 8, 520);
    rows = (
      db.prepare(`SELECT ${cols} FROM weekly_stats ORDER BY week_ending DESC LIMIT ?`).all(limit) as Row[]
    ).reverse();
  }
  return json({ tir_band: `${TIR_LOW}-${TIR_HIGH}`, count: rows.length, rows: rows.map((r) => statsRow(r, WEEKLY_FIELDS)) });
}

export function runGetRangeStats(db: DatabaseSync, args: Record<string, unknown>): string {
  const { from, to } = dateWindow(args, 366);
  const slice = buildSlice(args, true);
  const { startMs, endMs } = dayRangeMs(from, to);
  const values: number[] = [];
  const slots = new Set<number>();
  for (const r of sgvRows(db, startMs, endMs)) {
    const ms = Number(r.date_ms);
    if (!slice.matches(ms)) continue;
    const v = num(r.sgv);
    if (v == null) continue;
    values.push(v);
    slots.add(Math.floor(ms / CGM_SLOT_MS));
  }
  const days = eachDay(from, to);
  const matchedDays = slice.weekdays
    ? days.filter((d) => slice.weekdays!.has(new Date(`${d}T12:00:00Z`).getUTCDay())).length
    : days.length;
  const windowHours = (matchedDays * slice.minutesPerDay) / 60;
  const hoursCovered = (slots.size * CGM_SLOT_MS) / 3_600_000;
  const out: Row = {
    date_from: from,
    date_to: to,
    timezone: TIMEZONE,
    tir_band: `${TIR_LOW}-${TIR_HIGH}`,
    slice: slice.describe,
    days_in_slice: matchedDays,
    ...glucoseStats(values),
    hours_covered: round(hoursCovered),
    window_hours: round(windowHours),
    coverage_pct: windowHours ? round((100 * hoursCovered) / windowHours, 1) : null
  };
  if (bool(args.include_insulin)) {
    const tx = treatmentRows(db, startMs, endMs).filter((r) => slice.matches(r._ms));
    out.insulin = {
      ...insulinTotals(tx),
      note: "Treatments whose time falls in the slice. Temp basal uses insulin when present, else rate × duration, not clipped to the slice. Scheduled profile basal is not in the archive."
    };
  }
  return json(out);
}

export function runGetCoverage(db: DatabaseSync, args: Record<string, unknown>): string {
  const span = sgvSpan(db);
  const tx = treatmentSpan(db);
  const base: Row = {
    timezone: TIMEZONE,
    sgv: { earliest: stamp(span.min), latest: stamp(span.max), count: count(db, "sgv") },
    treatments: { earliest: treatmentStamp(tx.min), latest: treatmentStamp(tx.max), count: count(db, "treatments") }
  };
  let from = assertYmd(args.date_from, "date_from");
  let to = assertYmd(args.date_to, "date_to");
  if (span.min == null || span.max == null) {
    if (!from || !to) return json({ ...base, note: "No SGV rows in the archive." });
  }
  from = from ?? localParts(span.min!).ymd;
  to = to ?? localParts(span.max!).ymd;
  if (to < from) throw new QueryError("date_to must be on or after date_from");
  const days = eachDay(from, to);
  if (days.length > 3660) throw new QueryError("coverage window is limited to 3660 days");
  const lowThreshold = clampLimit(args.low_threshold, 200, 100_000);
  const limit = clampLimit(args.limit, 200, 2000);

  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM sgv WHERE date_ms >= ? AND date_ms < ?");
  const dailyDays = new Set(
    (db.prepare("SELECT day FROM daily_stats WHERE day >= ? AND day <= ?").all(from, to) as Row[]).map((r) => String(r.day))
  );
  const missing: string[] = [];
  const low: { day: string; sgv_count: number }[] = [];
  const noDaily: string[] = [];
  let daysWithData = 0;
  for (const day of days) {
    const { startMs, endMs } = dayRangeMs(day, day);
    const n = Number((countStmt.get(startMs, endMs) as Row).n);
    if (n === 0) missing.push(day);
    else {
      daysWithData++;
      if (n < lowThreshold) low.push({ day, sgv_count: n });
      if (!dailyDays.has(day)) noDaily.push(day);
    }
  }
  const out: Row = {
    ...base,
    date_from: from,
    date_to: to,
    days_in_range: days.length,
    days_with_sgv: daysWithData,
    low_threshold: lowThreshold,
    missing_days_count: missing.length,
    missing_days: missing.slice(0, limit),
    low_days_count: low.length,
    low_days: low.slice(0, limit),
    days_without_daily_stats_count: noDaily.length,
    days_without_daily_stats: noDaily.slice(0, limit)
  };
  if (bool(args.include_gaps)) {
    const gapMinutes = clampLimit(args.gap_minutes, 30, 100_000);
    const { startMs, endMs } = dayRangeMs(from, to);
    const gaps = db
      .prepare(
        `SELECT prev, date_ms FROM (
           SELECT date_ms, LAG(date_ms) OVER (ORDER BY date_ms) AS prev
           FROM sgv WHERE date_ms >= ? AND date_ms < ?
         ) WHERE prev IS NOT NULL AND date_ms - prev > ? ORDER BY prev`
      )
      .all(startMs, endMs, gapMinutes * 60_000) as Row[];
    out.gap_minutes = gapMinutes;
    out.gaps_count = gaps.length;
    out.gaps = gaps.slice(0, limit).map((g) => {
      const a = Number(g.prev);
      const b = Number(g.date_ms);
      return { from: localIso(a), to: localIso(b), minutes: Math.round((b - a) / 60_000) };
    });
  }
  return json(out);
}

const FORBIDDEN_SQL_RE =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|ATTACH|DETACH|CREATE|REPLACE|VACUUM|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|REINDEX|ANALYZE)\b/i;
const RAW_ROW_CAP = 1000;

export function runQueryRaw(db: DatabaseSync, args: Record<string, unknown>): string {
  if (!args.sql || typeof args.sql !== "string") return errorJson("sql is required");
  const trimmed = args.sql.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed)) return errorJson("Only a single SELECT statement is allowed");
  if (trimmed.includes(";")) return errorJson("Only a single statement is allowed");
  if (FORBIDDEN_SQL_RE.test(trimmed)) return errorJson("Only read-only SELECT queries are allowed");
  try {
    const stmt = db.prepare(trimmed);
    const rows: unknown[] = [];
    let truncated = false;
    for (const row of stmt.iterate()) {
      if (rows.length === RAW_ROW_CAP) {
        truncated = true;
        break;
      }
      rows.push(row);
    }
    return json({ count: rows.length, truncated, rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorJson(`Query failed: ${message}`);
  }
}

export function callTool(db: DatabaseSync, name: string, args: Record<string, unknown>, dbPath: string): string {
  try {
    switch (name) {
      case "sync_status":
        return runSyncStatus(db, dbPath);
      case "list_sgv":
        return runListSgv(db, args);
      case "list_treatments":
        return runListTreatments(db, args);
      case "get_daily_stats":
        return runGetDailyStats(db, args);
      case "get_weekly_stats":
        return runGetWeeklyStats(db, args);
      case "get_range_stats":
        return runGetRangeStats(db, args);
      case "get_coverage":
        return runGetCoverage(db, args);
      case "query_raw":
        return runQueryRaw(db, args);
      case "get_active_profile":
        return runGetActiveProfile(db, args);
      case "get_profile_as_of":
        return runGetProfileAsOf(db, args);
      case "list_profile_changes":
        return runListProfileChanges(db, args);
      case "get_settings_vs_delivery":
        return runGetSettingsVsDelivery(db, args);
      default:
        return errorJson(`Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof QueryError) return errorJson(err.message);
    throw err;
  }
}

