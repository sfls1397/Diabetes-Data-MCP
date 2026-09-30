import { describe, expect, it } from "vitest";
import { addDays, dayRangeMs, isYmd, localIso, localMidnightMs, localParts, parseHm, parseTimestamp } from "../src/time.js";
import { DAY_MIDNIGHTS } from "./fixture.js";

describe("America/Chicago day math", () => {
  it("finds local midnight on both sides of the fall-back", () => {
    for (const [day, ms] of Object.entries(DAY_MIDNIGHTS)) {
      expect(new Date(localMidnightMs(day)).toISOString()).toBe(new Date(ms).toISOString());
    }
  });

  it("handles the spring-forward day as 23 hours", () => {
    const { startMs, endMs } = dayRangeMs("2026-03-08", "2026-03-08");
    expect(new Date(startMs).toISOString()).toBe("2026-03-08T06:00:00.000Z");
    expect((endMs - startMs) / 3_600_000).toBe(23);
  });

  it("maps UTC instants to Chicago day, minute, and weekday", () => {
    // 2025-11-04T05:30Z is Monday 2025-11-03 23:30 CST
    expect(localParts(Date.parse("2025-11-04T05:30:00Z"))).toEqual({ ymd: "2025-11-03", minuteOfDay: 23 * 60 + 30, weekday: 1 });
    // 2026-09-30T10:00Z is Wednesday 05:00 CDT
    expect(localParts(Date.parse("2026-09-30T10:00:00Z"))).toEqual({ ymd: "2026-09-30", minuteOfDay: 300, weekday: 3 });
    expect(localIso(Date.parse("2026-09-30T10:00:00Z"))).toBe("2026-09-30T05:00:00-05:00");
    expect(localIso(Date.parse("2026-01-15T18:00:00Z"))).toBe("2026-01-15T12:00:00-06:00");
  });

  it("validates dates and times", () => {
    expect(isYmd("2026-02-29")).toBe(false);
    expect(isYmd("2028-02-29")).toBe(true);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(parseHm("06:00")).toBe(360);
    expect(parseHm("24:00")).toBe(1440);
    expect(parseHm("24:30")).toBeNull();
    expect(parseHm("7:5")).toBeNull();
  });

  it("parses Nightscout timestamps as UTC when no zone is given", () => {
    expect(parseTimestamp("2025-11-03T09:00:00-06:00")).toBe(Date.parse("2025-11-03T15:00:00Z"));
    expect(parseTimestamp("2025-11-03T15:00:00")).toBe(Date.parse("2025-11-03T15:00:00Z"));
    expect(parseTimestamp("2025-11-03T15:00:00.000Z")).toBe(Date.parse("2025-11-03T15:00:00Z"));
    expect(parseTimestamp("")).toBeNull();
  });
});
