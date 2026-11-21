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
  ymd: string;
  minuteOfDay: number;
  weekday: number;
}

export function localParts(ms: number): LocalParts {
  const local = ms + offsetMs(ms);
  const dayIndex = Math.floor(local / DAY_MS);
  return {
    ymd: new Date(dayIndex * DAY_MS).toISOString().slice(0, 10),
    minuteOfDay: Math.floor((local - dayIndex * DAY_MS) / 60_000),
    weekday: (((dayIndex + 4) % 7) + 7) % 7
  };
}

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

export function localMidnightMs(ymd: string): number {
  const m = YMD.exec(ymd);
  if (!m) throw new Error(`bad date ${ymd}`);
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const first = guess - offsetMs(guess);
  const second = guess - offsetMs(first);
  return second;
}

export function dayRangeMs(from: string, to: string): { startMs: number; endMs: number } {
  return { startMs: localMidnightMs(from), endMs: localMidnightMs(addDays(to, 1)) };
}

export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function todayLocal(now: number = Date.now()): string {
  return localParts(now).ymd;
}

export function parseHm(value: string): number | null {
  const m = HM.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

export function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  let s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s) && !/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) s = `${s.replace(" ", "T")}Z`;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

export const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
