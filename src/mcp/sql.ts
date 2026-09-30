import { isYmd, parseHm } from "../time.js";

/** Meta keys or values that could carry a Nightscout URL, API secret, or token. */
const SECRET_KEY = /secret|token|password|authorization|api_?key|url/i;
const ANY_URL = /https?:\/\/\S+/gi;

export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryError";
  }
}

export function isSecretKey(name: string): boolean {
  return SECRET_KEY.test(name);
}

export function redactUrls(value: string): string {
  return value.replace(ANY_URL, "[redacted-url]");
}

export function assertYmd(value: unknown, label: string): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || !isYmd(value)) {
    throw new QueryError(`${label} must be a real date, YYYY-MM-DD (America/Chicago)`);
  }
  return value;
}

export function assertHm(value: unknown, label: string): number | undefined {
  if (value == null || value === "") return undefined;
  const minutes = typeof value === "string" ? parseHm(value) : null;
  if (minutes == null) throw new QueryError(`${label} must be HH:MM local time (00:00–24:00)`);
  return minutes;
}

/** Required date_from, optional date_to (defaults to date_from), in order. */
export function dateWindow(args: Record<string, unknown>, maxDays: number): { from: string; to: string } {
  const from = assertYmd(args.date_from, "date_from");
  const to = assertYmd(args.date_to, "date_to") ?? from;
  if (!from || !to) throw new QueryError("date_from is required (YYYY-MM-DD, America/Chicago)");
  if (to < from) throw new QueryError("date_to must be on or after date_from");
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > maxDays) throw new QueryError(`window is ${days} days; the limit for this tool is ${maxDays}`);
  return { from, to };
}

export function clampLimit(value: unknown, fallback: number, max: number): number {
  if (value == null) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new QueryError("limit must be a number");
  return Math.min(Math.max(Math.floor(n), 1), max);
}

export function bool(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

export function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

export function round(value: number | null | undefined, places = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

export function stringList(value: unknown, label: string): string[] | undefined {
  if (value == null || value === "") return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const out = raw.map((v) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "")).filter(Boolean);
  if (out.some((v) => v.length > 200)) throw new QueryError(`${label} entries must be at most 200 characters`);
  return out.length ? out : undefined;
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function errorJson(message: string): string {
  return json({ error: message });
}
