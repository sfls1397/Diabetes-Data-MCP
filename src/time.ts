/**
 * America/Chicago calendar math without a tz library.
 *
 * Every date and HH:MM a tool accepts is Chicago local. The archive stores
 * UTC epoch ms (sgv.date_ms) and ISO UTC strings (treatments.created_at), so
 * tools convert local days to UTC ms windows here. DST changes happen on the
 * hour, so caching the UTC offset per UTC hour is exact.
 */
export const TIMEZONE = "America/Chicago";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const HM = /^(\d{1,2}):(\d{2})$/;

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
});

const offsetCache = new Map<number, number>();

/** Chicago offset from UTC in ms at `ms` (e.g. -5h during CDT). */
export function offsetMs(ms: number): number {
  const hourKey = Math.floor(ms / HOUR_MS);
  const cached = offsetCache.get(hourKey);
  if (cached !== undefined) return cached;
  const parts: Record<string, number> = {};
  for (const p of formatter.formatToParts(new Date(hourKey * HOUR_MS))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offset = asUtc - hourKey * HOUR_MS;
  if (offsetCache.size > 200_000) offsetCache.clear();
  offsetCache.set(hourKey, offset);
  return offset;
}

export interface LocalParts {
  /** YYYY-MM-DD Chicago */
  ymd: string;
  /** minutes since local midnight, 0..1439 */
  minuteOfDay: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

export function localParts(ms: number): LocalParts {
  const local = ms + offsetMs(ms);
  const dayIndex = Math.floor(local / DAY_MS);
  return {
    ymd: new Date(dayIndex * DAY_MS).toISOString().slice(0, 10),
    minuteOfDay: Math.floor((local - dayIndex * DAY_MS) / 60_000),
    // 1970-01-01 was a Thursday.
    weekday: (((dayIndex + 4) % 7) + 7) % 7
  };
}

/** `2026-09-30T05:00:00-05:00` */
export function localIso(ms: number): string {
  const offset = offsetMs(ms);
  const local = new Date(ms + offset).toISOString().slice(0, 19);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset) / 60_000;
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${local}${sign}${hh}:${mm}`;
}

export function isYmd(value: string): boolean {
  const m = YMD.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

export function addDays(ymd: string, days: number): string {
  const m = YMD.exec(ymd);
  if (!m) throw new Error(`bad date ${ymd}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days)).toISOString().slice(0, 10);
}

/** UTC ms of 00:00 Chicago on `ymd`. */
export function localMidnightMs(ymd: string): number {
  const m = YMD.exec(ymd);
  if (!m) throw new Error(`bad date ${ymd}`);
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const first = guess - offsetMs(guess);
  const second = guess - offsetMs(first);
  return second;
}

/** [start, end) UTC ms covering local days `from`..`to` inclusive. */
export function dayRangeMs(from: string, to: string): { startMs: number; endMs: number } {
  return { startMs: localMidnightMs(from), endMs: localMidnightMs(addDays(to, 1)) };
}

/** Local days from..to inclusive. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function todayLocal(now: number = Date.now()): string {
  return localParts(now).ymd;
}

/** "HH:MM" (00:00–24:00) → minutes since midnight, or null when not valid. */
export function parseHm(value: string): number | null {
  const m = HM.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

/**
 * Nightscout timestamps are UTC ISO strings, usually with `Z`. A string with
 * no zone designator is treated as UTC (Nightscout's convention), never as
 * the host's local time.
 */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  let s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s) && !/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) s = `${s.replace(" ", "T")}Z`;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

export const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
