import type { DatabaseSync } from "../db/open.js";
import { tableColumns, tableExists } from "../db/open.js";
import { TIMEZONE, addDays, dayRangeMs, eachDay, isYmd, localIso, localMidnightMs, localParts, offsetMs, parseTimestamp } from "../time.js";
import { QueryError, assertYmd, bool, clampLimit, dateWindow, json, num, redactUrls, round } from "./sql.js";

/*
 * Pump profile history: read-only over the profile_* tables the sync mirrors from
 * Nightscout's profile collection. One version per Nightscout profile document; the
 * version's active_profile (Nightscout defaultProfile) is in force from its start
 * until the next version starts. Schedules are local America/Chicago time of day.
 * These are data helpers (programmed vs delivered numbers), never dosing advice.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DAY_SEC = 86_400;

type Row = Record<string, unknown>;
type Kind = "carbratio" | "sens" | "basal" | "target_low" | "target_high";
const KINDS: Kind[] = ["carbratio", "sens", "basal", "target_low", "target_high"];
/** Output names for the Nightscout schedule keys. */
const KIND_LABEL: Record<Kind, string> = {
  carbratio: "carb_ratio",
  sens: "sensitivity",
  basal: "basal",
  target_low: "target_low",
  target_high: "target_high"
};

export interface Segment {
  start_sec: number;
  end_sec: number;
  time: string;
  value: number | null;
}

export interface NamedProfile {
  name: string;
  units: string | null;
  timezone: string | null;
  dia_hours: number | null;
  carbs_hr: number | null;
  delay_min: number | null;
  schedules: Record<Kind, Segment[]>;
}

export interface ProfileVersion {
  id: string;
  start_ms: number;
  /** Next version's start; null for the newest (still in force). */
  end_ms: number | null;
  start_date: string;
  active_profile: string | null;
  entered_by: string | null;
  profile_names: string[];
  first_seen_at: string | null;
  updated_at: string | null;
  deleted_upstream_at: string | null;
  profiles: Map<string, NamedProfile>;
}

function requireProfileTables(db: DatabaseSync): void {
  for (const t of ["profile_versions", "profile_settings", "profile_segments"]) {
    if (!tableExists(db, t)) {
      throw new QueryError(
        "The archive has no pump profile tables yet. They are created and filled by com.diabetes-sqlite.sync from diabetes-data-mcp with profile support; check sync_status."
      );
    }
  }
}

function hhmm(sec: number): string {
  const s = Math.max(0, Math.min(DAY_SEC, sec));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}

/** Seconds since local (Chicago) midnight at `ms`. */
export function localSecondOfDay(ms: number): number {
  const local = ms + offsetMs(ms);
  return Math.floor((((local % DAY_MS) + DAY_MS) % DAY_MS) / 1000);
}

/**
 * UTC ms instants at which the Chicago wall clock reads `sec` seconds into local day
 * `ymd`, earliest first: none in a spring-forward gap, two in the repeated fall-back hour.
 */
export function wallInstants(ymd: string, sec: number): number[] {
  const guess = Date.parse(`${ymd}T00:00:00Z`) + sec * 1000;
  const out = new Set<number>();
  for (const probe of [guess - DAY_MS, guess, guess + DAY_MS]) {
    const ms = guess - offsetMs(probe);
    if (localParts(ms).ymd === ymd && localSecondOfDay(ms) === sec) out.add(ms);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Load every version (oldest first) with its named profiles. Upstream-deleted
 * versions are skipped unless asked for; end_ms always comes from the kept list.
 */
export function loadProfileTimeline(db: DatabaseSync, includeDeleted = false): ProfileVersion[] {
  requireProfileTables(db);
  const versions = db
    .prepare(
      `SELECT id, start_ms, start_date, active_profile, entered_by, profile_names, first_seen_at, updated_at, source_deleted_at
       FROM profile_versions ${includeDeleted ? "" : "WHERE source_deleted_at IS NULL"}
       ORDER BY start_ms, id`
    )
    .all() as Row[];
  const byId = new Map<string, ProfileVersion>();
  const out: ProfileVersion[] = [];
  for (const r of versions) {
    let names: string[] = [];
    try {
      const parsed = JSON.parse(String(r.profile_names ?? "[]"));
      if (Array.isArray(parsed)) names = parsed.map(String);
    } catch {
      names = [];
    }
    const v: ProfileVersion = {
      id: String(r.id),
      start_ms: Number(r.start_ms),
      end_ms: null,
      start_date: String(r.start_date),
      active_profile: r.active_profile == null ? null : String(r.active_profile),
      entered_by: r.entered_by == null ? null : String(r.entered_by),
      profile_names: names,
      first_seen_at: r.first_seen_at == null ? null : String(r.first_seen_at),
      updated_at: r.updated_at == null ? null : String(r.updated_at),
      deleted_upstream_at: r.source_deleted_at == null ? null : String(r.source_deleted_at),
      profiles: new Map()
    };
    byId.set(v.id, v);
    out.push(v);
  }
  const live = out.filter((v) => v.deleted_upstream_at == null);
  for (let i = 0; i < live.length; i++) live[i].end_ms = i + 1 < live.length ? live[i + 1].start_ms : null;

  for (const s of db
    .prepare("SELECT version_id, profile_name, units, timezone, dia_hours, carbs_hr, delay_min FROM profile_settings")
    .all() as Row[]) {
    const v = byId.get(String(s.version_id));
    if (!v) continue;
    v.profiles.set(String(s.profile_name), {
      name: String(s.profile_name),
      units: s.units == null ? null : String(s.units),
      timezone: s.timezone == null ? null : String(s.timezone),
      dia_hours: num(s.dia_hours),
      carbs_hr: num(s.carbs_hr),
      delay_min: num(s.delay_min),
      schedules: { carbratio: [], sens: [], basal: [], target_low: [], target_high: [] }
    });
  }
  for (const g of db
    .prepare(
      "SELECT version_id, profile_name, kind, start_sec, end_sec, time, value FROM profile_segments ORDER BY version_id, profile_name, kind, start_sec"
    )
    .all() as Row[]) {
    const p = byId.get(String(g.version_id))?.profiles.get(String(g.profile_name));
    const kind = String(g.kind) as Kind;
    if (!p || !KINDS.includes(kind)) continue;
    p.schedules[kind].push({
      start_sec: Number(g.start_sec),
      end_sec: Number(g.end_sec),
      time: String(g.time),
      value: num(g.value)
    });
  }
  return includeDeleted ? out : live;
}

/** Index of the version in force at `ms` (the last one starting at or before it), or -1. */
export function versionIndexAt(timeline: ProfileVersion[], ms: number): number {
  let lo = 0;
  let hi = timeline.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].start_ms <= ms) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export function segmentAt(segments: Segment[], sec: number): Segment | null {
  let hit: Segment | null = null;
  for (const s of segments) {
    if (s.start_sec <= sec) hit = s;
    else break;
  }
  return hit ?? segments[0] ?? null;
}

function activeOf(v: ProfileVersion): NamedProfile | null {
  return v.active_profile == null ? null : (v.profiles.get(v.active_profile) ?? null);
}

function stampOf(ms: number | null): { ts: string; local: string } | null {
  return ms == null ? null : { ts: new Date(ms).toISOString(), local: localIso(ms) };
}

function unitLabels(p: NamedProfile): Record<string, string> {
  const bg = p.units ?? "mg/dl";
  return { carb_ratio: "g/U", sensitivity: `${bg} per U`, basal: "U/h", target_low: bg, target_high: bg, dia: "hours" };
}

function describeSchedule(segments: Segment[]): Row[] {
  return segments.map((s) => ({ time: hhmm(s.start_sec), until: hhmm(s.end_sec), value: s.value }));
}

function scheduledBasalPerDay(p: NamedProfile): number | null {
  if (!p.schedules.basal.length) return null;
  let total = 0;
  for (const s of p.schedules.basal) total += ((s.value ?? 0) * (s.end_sec - s.start_sec)) / 3600;
  return round(total, 3);
}

export function describeProfile(p: NamedProfile): Row {
  return {
    name: p.name,
    units: p.units,
    unit_labels: unitLabels(p),
    timezone: p.timezone,
    dia_hours: p.dia_hours,
    carb_ratio: describeSchedule(p.schedules.carbratio),
    sensitivity: describeSchedule(p.schedules.sens),
    basal: describeSchedule(p.schedules.basal),
    target_low: describeSchedule(p.schedules.target_low),
    target_high: describeSchedule(p.schedules.target_high),
    scheduled_basal_u_per_day: scheduledBasalPerDay(p),
    carbs_hr: p.carbs_hr,
    delay_min: p.delay_min
  };
}

function settingsAt(p: NamedProfile, sec: number): Row {
  const out: Row = { local_time: hhmm(sec) };
  for (const k of KINDS) {
    const s = segmentAt(p.schedules[k], sec);
    out[KIND_LABEL[k]] = s ? { value: s.value, segment: `${hhmm(s.start_sec)}-${hhmm(s.end_sec)}` } : null;
  }
  return out;
}

function versionSummary(v: ProfileVersion): Row {
  const out: Row = {
    id: v.id,
    start: stampOf(v.start_ms),
    end: stampOf(v.end_ms),
    in_force_days: round(((v.end_ms ?? Date.now()) - v.start_ms) / DAY_MS, 2),
    active_profile: v.active_profile,
    profile_names: v.profile_names,
    entered_by: v.entered_by
  };
  if (v.deleted_upstream_at) out.deleted_upstream_at = v.deleted_upstream_at;
  return out;
}

function profileSyncInfo(db: DatabaseSync): Row {
  const meta: Record<string, string> = {};
  if (tableExists(db, "meta")) {
    for (const r of db.prepare("SELECT key, value FROM meta WHERE key LIKE 'profile_%'").all() as Row[]) {
      meta[String(r.key)] = redactUrls(String(r.value ?? ""));
    }
  }
  const c = db
    .prepare(
      "SELECT SUM(source_deleted_at IS NULL) AS live, SUM(source_deleted_at IS NOT NULL) AS deleted, MIN(start_ms) AS lo FROM profile_versions"
    )
    .get() as Row;
  return {
    versions: Number(c.live ?? 0),
    deleted_upstream_versions: Number(c.deleted ?? 0),
    history_starts: stampOf(num(c.lo)),
    last_profile_sync_at: meta.profile_last_sync_at ?? null,
    last_full_profile_walk_day: meta.profile_last_full_day ?? null,
    last_profile_error: meta.profile_last_error ?? null,
    source: "Nightscout profile collection (tconnectsync PROFILES upload, hourly at :35), mirrored every minute by com.diabetes-sqlite.sync"
  };
}

function otherProfiles(v: ProfileVersion, all: boolean): unknown {
  const names = [...v.profiles.keys()].filter((n) => n !== v.active_profile);
  if (!all) return names;
  return names.map((n) => describeProfile(v.profiles.get(n)!));
}

// ---------------------------------------------------------------------------
// Tools

export function runGetActiveProfile(db: DatabaseSync, args: Record<string, unknown>, now: number = Date.now()): string {
  const timeline = loadProfileTimeline(db);
  const sync = profileSyncInfo(db);
  if (!timeline.length) return json({ found: false, profile_sync: sync, note: "No pump profile versions in the archive." });
  const v = timeline[timeline.length - 1];
  const p = activeOf(v);
  return json({
    found: true,
    now: stampOf(now),
    version: versionSummary(v),
    active_profile: p ? describeProfile(p) : null,
    in_force_now: p ? settingsAt(p, localSecondOfDay(now)) : null,
    other_profiles: otherProfiles(v, bool(args.include_all_profiles)),
    profile_sync: sync,
    note:
      "Newest profile version as uploaded by tconnectsync. A pump change made after its last upload is not here yet. Schedules are America/Chicago time of day."
  });
}

/** `YYYY-MM-DD`, local `YYYY-MM-DD HH:MM[:SS]` / `…THH:MM`, or ISO with Z / offset. */
export function parseAt(value: unknown): { ms: number; dayOnly: string | null } {
  if (typeof value !== "string" || !value.trim()) throw new QueryError("at is required: YYYY-MM-DD or YYYY-MM-DD HH:MM (America/Chicago)");
  const s = value.trim();
  if (isYmd(s)) return { ms: localMidnightMs(s), dayOnly: s };
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (local) {
    const [, ymd, h, m, sec] = local;
    const hours = Number(h);
    const minutes = Number(m);
    const seconds = Number(sec ?? 0);
    if (!isYmd(ymd) || hours > 23 || minutes > 59 || seconds > 59) throw new QueryError(`at ${JSON.stringify(s)} is not a valid local time`);
    const hits = wallInstants(ymd, hours * 3600 + minutes * 60 + seconds);
    if (!hits.length) throw new QueryError(`${s} does not exist in America/Chicago (daylight-saving gap)`);
    return { ms: hits[0], dayOnly: null };
  }
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const ms = parseTimestamp(s);
    if (ms != null) return { ms, dayOnly: null };
  }
  throw new QueryError("at must be YYYY-MM-DD, YYYY-MM-DD HH:MM (America/Chicago), or an ISO timestamp with Z or an offset");
}

export function runGetProfileAsOf(db: DatabaseSync, args: Record<string, unknown>): string {
  const { ms, dayOnly } = parseAt(args.at);
  const timeline = loadProfileTimeline(db);
  const sync = profileSyncInfo(db);
  const idx = versionIndexAt(timeline, ms);
  const at = { input: args.at, ...stampOf(ms) };
  const out: Row = { at };
  if (idx < 0) {
    out.found = false;
    out.earliest_version = timeline.length ? versionSummary(timeline[0]) : null;
    out.note = timeline.length
      ? `No profile version starts on or before this time; the archive's profile history begins ${localIso(timeline[0].start_ms)}. Not extrapolated backwards.`
      : "No pump profile versions in the archive.";
  } else {
    const v = timeline[idx];
    const p = activeOf(v);
    out.found = true;
    out.version = versionSummary(v);
    out.active_profile = p ? describeProfile(p) : null;
    out.in_force_at_time = p ? settingsAt(p, localSecondOfDay(ms)) : null;
    out.other_profiles = otherProfiles(v, bool(args.include_all_profiles));
    out.next_change = idx + 1 < timeline.length ? { ...stampOf(timeline[idx + 1].start_ms), active_profile: timeline[idx + 1].active_profile } : null;
  }
  if (dayOnly) {
    const { startMs, endMs } = dayRangeMs(dayOnly, dayOnly);
    out.day_note = `A date alone means 00:00 local; changes during ${dayOnly} are listed in changes_that_day.`;
    out.changes_that_day = timeline
      .filter((v) => v.start_ms >= startMs && v.start_ms < endMs)
      .map((v) => ({ ...stampOf(v.start_ms), id: v.id, active_profile: v.active_profile }));
  }
  out.profile_sync = sync;
  return json(out);
}

function profileContent(p: NamedProfile | undefined): Record<string, string> {
  if (!p) return {};
  const out: Record<string, string> = {};
  for (const k of KINDS) out[KIND_LABEL[k]] = JSON.stringify(p.schedules[k].map((s) => [s.start_sec, s.value]));
  out.dia = JSON.stringify(p.dia_hours);
  out.units = JSON.stringify(p.units);
  return out;
}

function changedFields(a: NamedProfile | undefined, b: NamedProfile | undefined): string[] {
  const x = profileContent(a);
  const y = profileContent(b);
  return Object.keys({ ...x, ...y }).filter((k) => x[k] !== y[k]);
}

export function runListProfileChanges(db: DatabaseSync, args: Record<string, unknown>): string {
  const includeDeleted = bool(args.include_deleted);
  const all = loadProfileTimeline(db, includeDeleted);
  const live = includeDeleted ? all.filter((v) => !v.deleted_upstream_at) : all;
  const from = assertYmd(args.date_from, "date_from");
  const to = assertYmd(args.date_to, "date_to");
  if (from && to && to < from) throw new QueryError("date_to must be on or after date_from");
  const lo = from ? localMidnightMs(from) : -Infinity;
  const hi = to ? localMidnightMs(addDays(to, 1)) : Infinity;
  const limit = clampLimit(args.limit, 100, 1000);
  const withSettings = bool(args.include_settings);
  const rows: Row[] = [];
  let matched = 0;
  for (const v of all) {
    if (v.start_ms < lo || v.start_ms >= hi) continue;
    matched++;
    if (rows.length >= limit) continue;
    // Compare with the version that was in force just before this one started.
    const prevIdx = versionIndexAt(live, v.start_ms - 1);
    const prev = prevIdx >= 0 && live[prevIdx].id !== v.id ? live[prevIdx] : null;
    const row: Row = versionSummary(v);
    if (!prev) {
      row.change = "first_version";
    } else {
      const switched = prev.active_profile !== v.active_profile;
      // Edits to the now-active profile since the previous version (a newly added profile has none).
      const before = v.active_profile == null ? undefined : prev.profiles.get(v.active_profile);
      const editedList = before ? changedFields(before, v.profiles.get(v.active_profile!)) : [];
      row.previous_active_profile = prev.active_profile;
      row.change = switched ? (editedList.length ? "profile_switch_and_edit" : "profile_switch") : editedList.length ? "settings_edit" : "no_active_change";
      row.active_profile_changed_fields = editedList;
      row.profiles_added = v.profile_names.filter((n) => !prev.profiles.has(n));
      row.profiles_removed = [...prev.profiles.keys()].filter((n) => !v.profiles.has(n));
      row.other_profiles_edited = [...v.profiles.keys()].filter(
        (n) => n !== v.active_profile && prev.profiles.has(n) && changedFields(prev.profiles.get(n), v.profiles.get(n)).length > 0
      );
    }
    if (withSettings) {
      const p = activeOf(v);
      row.active_profile_settings = p ? describeProfile(p) : null;
    }
    rows.push(row);
  }
  return json({
    timezone: TIMEZONE,
    date_from: from ?? null,
    date_to: to ?? null,
    matched,
    returned: rows.length,
    truncated: matched > rows.length,
    versions: rows,
    profile_sync: profileSyncInfo(db),
    note:
      "Oldest first. A version's start is when tconnectsync uploaded the change (it polls hourly), not the exact second it was made on the pump. end is the next version's start (null = still in force)."
  });
}

// ---------------------------------------------------------------------------
// Programmed settings vs delivered insulin

interface Interval {
  s: number;
  e: number;
  vIdx: number;
  day: string;
  basal: Segment | null;
  ratio: Segment | null;
  deliveredU: number;
  deliveredMs: number;
  byReason: Record<string, number>;
}

interface DayTotals {
  hours_with_profile: number;
  programmed_basal_u: number;
  delivered_basal_u: number;
  delivery_hours: number;
  carbs_g: number;
  programmed_carb_insulin_u: number;
  carb_bolus_u: number;
  bolus_u: number;
}

interface Bucket {
  profile: string;
  segment: string;
  value: number | null;
  hours: number;
  programmed_u: number;
  delivered_u: number;
  delivery_hours: number;
  carb_entries: number;
  carbs_g: number;
  carb_bolus_u: number;
}

function newBucket(profile: string, segment: string, value: number | null): Bucket {
  return { profile, segment, value, hours: 0, programmed_u: 0, delivered_u: 0, delivery_hours: 0, carb_entries: 0, carbs_g: 0, carb_bolus_u: 0 };
}

/** [s, e) pieces of the window on which the version, local day and every schedule segment are constant. */
export function splitWindow(timeline: ProfileVersion[], startMs: number, endMs: number): Interval[] {
  const cuts = new Set<number>([startMs, endMs]);
  for (const v of timeline) if (v.start_ms > startMs && v.start_ms < endMs) cuts.add(v.start_ms);
  const secs = new Set<number>([0]);
  for (const v of timeline) for (const p of v.profiles.values()) for (const k of KINDS) for (const s of p.schedules[k]) secs.add(s.start_sec);
  const firstDay = addDays(localParts(startMs).ymd, -1);
  const lastDay = addDays(localParts(endMs).ymd, 1);
  for (const day of eachDay(firstDay, lastDay)) {
    for (const sec of secs) for (const ms of wallInstants(day, sec)) if (ms > startMs && ms < endMs) cuts.add(ms);
  }
  // Clock changes: local time jumps, so a schedule boundary inside a skipped hour lands here.
  for (let h = Math.ceil(startMs / HOUR_MS) * HOUR_MS; h < endMs; h += HOUR_MS) {
    if (offsetMs(h) !== offsetMs(h - 1)) cuts.add(h);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: Interval[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const s = points[i];
    const e = points[i + 1];
    const vIdx = versionIndexAt(timeline, s);
    const p = vIdx >= 0 ? activeOf(timeline[vIdx]) : null;
    const sec = localSecondOfDay(s);
    out.push({
      s,
      e,
      vIdx,
      day: localParts(s).ymd,
      basal: p ? segmentAt(p.schedules.basal, sec) : null,
      ratio: p ? segmentAt(p.schedules.carbratio, sec) : null,
      deliveredU: 0,
      deliveredMs: 0,
      byReason: {}
    });
  }
  return out;
}

function intervalAt(intervals: Interval[], ms: number): Interval | null {
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const it = intervals[mid];
    if (ms < it.s) hi = mid - 1;
    else if (ms >= it.e) lo = mid + 1;
    else return it;
  }
  return null;
}

export function runGetSettingsVsDelivery(db: DatabaseSync, args: Record<string, unknown>): string {
  const { from, to } = dateWindow(args, 366);
  const { startMs, endMs } = dayRangeMs(from, to);
  const timeline = loadProfileTimeline(db);
  const intervals = splitWindow(timeline, startMs, endMs);
  const effective = tableColumns(db, "treatments").has("insulin_effective") ? "insulin_effective" : "NULL AS insulin_effective";

  // Delivered basal: Temp Basal rows (tconnectsync uploads every basal rate change,
  // scheduled, Control-IQ and suspensions, as back-to-back Temp Basal rows), clipped to the window.
  const basalRows = (
    db
      .prepare(
        `SELECT created_at, duration_min, rate, absolute, insulin, json_extract(raw_json,'$.reason') AS reason
         FROM treatments WHERE event_type = 'Temp Basal' AND created_at >= ? AND created_at < ?`
      )
      .all(new Date(startMs - 2 * DAY_MS).toISOString(), new Date(endMs + DAY_MS).toISOString()) as Row[]
  )
    .map((r) => {
      const s = parseTimestamp(r.created_at);
      const minutes = num(r.duration_min);
      if (s == null || minutes == null || minutes <= 0) return null;
      const e = s + minutes * 60_000;
      const rate = num(r.rate) ?? num(r.absolute) ?? (num(r.insulin) != null ? (num(r.insulin)! * 60) / minutes : null);
      if (rate == null || e <= startMs || s >= endMs) return null;
      return { s, e, rate, reason: r.reason == null ? "unspecified" : String(r.reason) };
    })
    .filter((r): r is { s: number; e: number; rate: number; reason: string } => r != null)
    .sort((a, b) => a.s - b.s);

  let j = 0;
  for (const b of basalRows) {
    while (j < intervals.length && intervals[j].e <= b.s) j++;
    for (let k = j; k < intervals.length && intervals[k].s < b.e; k++) {
      const it = intervals[k];
      const overlap = Math.min(it.e, b.e) - Math.max(it.s, b.s);
      if (overlap <= 0) continue;
      const u = (b.rate * overlap) / HOUR_MS;
      it.deliveredU += u;
      it.deliveredMs += overlap;
      it.byReason[b.reason] = (it.byReason[b.reason] ?? 0) + u;
    }
  }

  // Carbs and boluses. insulin_effective counts a combo's extended part (see list_treatments).
  const txRows = (
    db
      .prepare(
        `SELECT created_at, event_type, insulin, ${effective}, carbs FROM treatments
         WHERE created_at >= ? AND created_at < ? AND (carbs > 0 OR lower(event_type) LIKE '%bolus%' OR lower(event_type) = 'smb')`
      )
      .all(new Date(startMs - DAY_MS).toISOString(), new Date(endMs + DAY_MS).toISOString()) as Row[]
  )
    .map((r) => ({ ms: parseTimestamp(r.created_at), r }))
    .filter((x): x is { ms: number; r: Row } => x.ms != null && x.ms >= startMs && x.ms < endMs);

  const basalBuckets = new Map<string, Bucket>();
  const ratioBuckets = new Map<string, Bucket>();
  const days = new Map<string, DayTotals>();
  const dayRow = (d: string): DayTotals => {
    let row = days.get(d);
    if (!row) {
      row = {
        hours_with_profile: 0,
        programmed_basal_u: 0,
        delivered_basal_u: 0,
        delivery_hours: 0,
        carbs_g: 0,
        programmed_carb_insulin_u: 0,
        carb_bolus_u: 0,
        bolus_u: 0
      };
      days.set(d, row);
    }
    return row;
  };
  const versionsUsed = new Set<number>();
  let coveredMs = 0;
  let programmedBasal = 0;
  let deliveredCovered = 0;
  let deliveredAll = 0;
  let deliveryMsAll = 0;
  let deliveryMsCovered = 0;
  const reasonTotals: Record<string, number> = {};
  for (const it of intervals) {
    const dr = dayRow(it.day);
    deliveredAll += it.deliveredU;
    deliveryMsAll += it.deliveredMs;
    dr.delivered_basal_u += it.deliveredU;
    dr.delivery_hours += it.deliveredMs / HOUR_MS;
    for (const [k, u] of Object.entries(it.byReason)) reasonTotals[k] = (reasonTotals[k] ?? 0) + u;
    if (it.vIdx < 0) continue;
    versionsUsed.add(it.vIdx);
    const hours = (it.e - it.s) / HOUR_MS;
    coveredMs += it.e - it.s;
    dr.hours_with_profile += hours;
    deliveredCovered += it.deliveredU;
    deliveryMsCovered += it.deliveredMs;
    const profile = timeline[it.vIdx].active_profile ?? "(none)";
    if (it.basal) {
      const prog = (it.basal.value ?? 0) * hours;
      programmedBasal += prog;
      dr.programmed_basal_u += prog;
      const key = `${profile}|${it.basal.start_sec}|${it.basal.end_sec}|${it.basal.value}`;
      const b = basalBuckets.get(key) ?? newBucket(profile, `${hhmm(it.basal.start_sec)}-${hhmm(it.basal.end_sec)}`, it.basal.value);
      b.hours += hours;
      b.programmed_u += prog;
      b.delivered_u += it.deliveredU;
      b.delivery_hours += it.deliveredMs / HOUR_MS;
      basalBuckets.set(key, b);
    }
  }

  let carbs = 0;
  let programmedCarbInsulin = 0;
  let carbBolus = 0;
  let carbEntries = 0;
  let carbsNoProfile = 0;
  let bolusAll = 0;
  let carbEntriesNoRatio = 0;
  for (const { ms, r } of txRows) {
    const et = String(r.event_type ?? "").toLowerCase();
    const isBolus = et.includes("bolus") || et === "smb";
    const delivered = isBolus ? (num(r.insulin_effective) ?? num(r.insulin) ?? 0) : 0;
    const it = intervalAt(intervals, ms);
    const dr = dayRow(it?.day ?? localParts(ms).ymd);
    bolusAll += delivered;
    dr.bolus_u += delivered;
    const c = num(r.carbs);
    if (!c || c <= 0) continue;
    dr.carbs_g += c;
    if (!it || it.vIdx < 0) {
      carbsNoProfile += c;
      continue;
    }
    const ratio = it.ratio?.value;
    carbEntries++;
    carbs += c;
    carbBolus += delivered;
    dr.carb_bolus_u += delivered;
    const profile = timeline[it.vIdx].active_profile ?? "(none)";
    const key = it.ratio ? `${profile}|${it.ratio.start_sec}|${it.ratio.end_sec}|${it.ratio.value}` : `${profile}|none`;
    const b =
      ratioBuckets.get(key) ??
      newBucket(profile, it.ratio ? `${hhmm(it.ratio.start_sec)}-${hhmm(it.ratio.end_sec)}` : "(no carb ratio)", ratio ?? null);
    b.carb_entries++;
    b.carbs_g += c;
    b.carb_bolus_u += delivered;
    if (ratio && ratio > 0) {
      programmedCarbInsulin += c / ratio;
      dr.programmed_carb_insulin_u += c / ratio;
      b.programmed_u += c / ratio;
    } else carbEntriesNoRatio++;
    ratioBuckets.set(key, b);
  }

  const windowHours = (endMs - startMs) / HOUR_MS;
  const coveredHours = coveredMs / HOUR_MS;
  const r2 = (v: number) => round(v, 2);
  const out: Row = {
    date_from: from,
    date_to: to,
    timezone: TIMEZONE,
    window: { ...stampOf(startMs), end: stampOf(endMs), hours: r2(windowHours), days: eachDay(from, to).length },
    profile_coverage: {
      hours_with_profile: r2(coveredHours),
      hours_without_profile: r2(windowHours - coveredHours),
      versions_in_force: [...versionsUsed].sort((a, b) => a - b).map((i) => versionSummary(timeline[i])),
      note:
        coveredHours < windowHours
          ? "Part of the window has no recorded profile (before the archive's first profile version). Programmed figures cover only hours_with_profile; nothing is extrapolated."
          : undefined
    },
    basal: {
      programmed_u: r2(programmedBasal),
      delivered_u: r2(deliveredCovered),
      delivered_minus_programmed_u: r2(deliveredCovered - programmedBasal),
      delivered_pct_of_programmed: programmedBasal > 0 ? round((100 * deliveredCovered) / programmedBasal, 1) : null,
      delivery_hours_recorded: r2(deliveryMsCovered / HOUR_MS),
      delivered_u_whole_window: r2(deliveredAll),
      delivery_hours_recorded_whole_window: r2(deliveryMsAll / HOUR_MS),
      delivered_by_reason_u_whole_window: Object.fromEntries(Object.entries(reasonTotals).map(([k, v]) => [k, r2(v)])),
      by_segment: [...basalBuckets.values()].map((b) => ({
        profile: b.profile,
        segment: b.segment,
        programmed_u_per_h: b.value,
        hours: r2(b.hours),
        programmed_u: r2(b.programmed_u),
        delivered_u: r2(b.delivered_u),
        delivered_avg_u_per_h: b.delivery_hours > 0 ? round(b.delivered_u / b.delivery_hours, 3) : null,
        delivery_hours_recorded: r2(b.delivery_hours)
      })),
      note:
        "programmed_u integrates the active profile's basal schedule over hours_with_profile, switching at each profile change. delivered_u is Temp Basal rate × time (scheduled, Control-IQ and suspended rows), clipped to the same hours. delivery_hours_recorded below the hours means part of the delivery record is missing."
    },
    carbs: {
      carb_entries: carbEntries,
      carbs_g: r2(carbs),
      programmed_carb_insulin_u: r2(programmedCarbInsulin),
      carb_bolus_delivered_u: r2(carbBolus),
      carb_bolus_minus_programmed_u: r2(carbBolus - programmedCarbInsulin),
      implied_carb_ratio_g_per_u: carbBolus > 0 ? round(carbs / carbBolus, 2) : null,
      entries_without_carb_ratio: carbEntriesNoRatio,
      carbs_g_without_profile: r2(carbsNoProfile),
      by_segment: [...ratioBuckets.values()].map((b) => ({
        profile: b.profile,
        segment: b.segment,
        programmed_carb_ratio_g_per_u: b.value,
        carb_entries: b.carb_entries,
        carbs_g: r2(b.carbs_g),
        programmed_carb_insulin_u: r2(b.programmed_u),
        carb_bolus_delivered_u: r2(b.carb_bolus_u),
        implied_carb_ratio_g_per_u: b.carb_bolus_u > 0 ? round(b.carbs_g / b.carb_bolus_u, 2) : null
      })),
      note:
        "programmed_carb_insulin_u = Σ carbs ÷ the carb ratio in force at each entry's time. carb_bolus_delivered_u is the whole bolus logged with those carbs (insulin_counted), which includes any correction or override the pump calculator added; the archive cannot split them."
    },
    insulin_totals: {
      bolus_u_all: r2(bolusAll),
      basal_u_delivered_whole_window: r2(deliveredAll),
      total_u: r2(bolusAll + deliveredAll),
      avg_total_u_per_day: r2((bolusAll + deliveredAll) / eachDay(from, to).length),
      note: "All boluses (with or without carbs) plus delivered basal over the whole window. A partial current day lowers the average."
    },
    note: "Data helper only: programmed settings vs delivered insulin. Settings judgement stays with the analyst; this is not dosing advice."
  };
  if (bool(args.include_days)) {
    out.by_day = [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, d]) => {
        const row: Row = { day };
        for (const [k, v] of Object.entries(d)) row[k] = r2(v);
        return row;
      });
  }
  return json(out);
}
