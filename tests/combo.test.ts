import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/*
 * tconnectsync/combo_bolus.py is pure Python (duck-typed on event NAME), so it is tested
 * with fake pump events and stock-shaped Nightscout entries. No tconnectsync install needed.
 * The 5.64 U / 5.73 U cases are real combos whose correct Nightscout shape was verified
 * against the live treatments on 2026-10-03.
 */
const run = promisify(execFile);
const DIR = path.resolve(__dirname, "../tconnectsync");

async function py(body: string): Promise<any> {
  const code = `
import json, sys
from types import SimpleNamespace as NS
sys.path.insert(0, ${JSON.stringify(DIR)})
import combo_bolus as cb
def ev(name, seq, bolus, **kw): return NS(NAME=name, seqNum=seq, bolusId=bolus, **kw)
def stock(created, insulin, pump, notes=""): return {"eventType": "Combo Bolus", "created_at": created, "insulin": insulin, "carbs": 0, "notes": notes, "enteredBy": "Pump (tconnectsync)", "pump_event_id": pump}
${body}
`;
  const { stdout } = await run("python3", ["-c", code]);
  return JSON.parse(stdout);
}

const COMBO_EVENTS = (total: number, pct: number, dur: number, delivered: number) => `
events = [
  ev("LID_BOLUS_COMPLETED", 100, 7, insulinDelivered=${delivered}),
  ev("LID_BOLUS_REQUESTED_MSG2", 102, 7, standardPercent=${pct}, duration=${dur}),
  ev("LID_BOLUS_REQUESTED_MSG3", 103, 7, totalBolusSize=${total}),
  ev("LID_BOLEX_COMPLETED", 140, 7, insulinDelivered=2.2),
]
entries = [stock("2026-10-02 14:34:22-05:00", ${delivered}, "100,101,102,103"), stock("2026-10-02 16:34:22-05:00", 2.2, "140", "Extended Bolus")]
`;

describe("combo bolus mapping", () => {
  it("turns a true combo into one Care Portal treatment and drops the extended-completion entry", async () => {
    const out = await py(`${COMBO_EVENTS(5.640000343322754, 60, 120, 3.46)}\nprint(json.dumps(cb.apply_to_entries(entries, events)))`);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ insulin: 3.46, enteredinsulin: 5.64, splitNow: 60, splitExt: 40, duration: 120, relative: 1.13 });
    expect(out[0].pump_event_id).toBe("100,101,102,103");
  });

  it("matches the other verified real combo (5.73 U, 60/40, 2 h -> 1.15 U/h)", async () => {
    const out = await py(`${COMBO_EVENTS(5.730000019073486, 60, 120, 3.44)}\nprint(json.dumps(cb.apply_to_entries(entries, events)))`);
    expect(out[0]).toMatchObject({ insulin: 3.44, enteredinsulin: 5.73, relative: 1.15 });
  });

  it("handles a pure extended bolus (0% now)", async () => {
    const out = await py(`${COMBO_EVENTS(4, 0, 180, 0)}\nprint(json.dumps(cb.apply_to_entries(entries, events)))`);
    expect(out[0]).toMatchObject({ splitNow: 0, splitExt: 100, duration: 180, relative: 1.33 });
  });

  it("leaves standard boluses and unrelated extended entries exactly as stock wrote them", async () => {
    const out = await py(`
events = [ev("LID_BOLUS_COMPLETED", 10, 3, insulinDelivered=2.0), ev("LID_BOLUS_REQUESTED_MSG2", 12, 3, standardPercent=100, duration=0), ev("LID_BOLUS_REQUESTED_MSG3", 13, 3, totalBolusSize=2.0), ev("LID_BOLEX_COMPLETED", 50, 9, insulinDelivered=1.5)]
entries = [stock("2026-10-02 08:00:00-05:00", 2.0, "10,11,12,13"), stock("2026-10-02 10:00:00-05:00", 1.5, "50", "Extended Bolus")]
print(json.dumps({"same": cb.apply_to_entries(entries, events) == entries}))`);
    expect(out.same).toBe(true);
  });

  it("fails open: without the request messages the stock entries are kept, never dropping insulin", async () => {
    const out = await py(`
events = [ev("LID_BOLUS_COMPLETED", 100, 7, insulinDelivered=3.0), ev("LID_BOLEX_COMPLETED", 140, 7, insulinDelivered=2.0)]
entries = [stock("2026-10-02 14:00:00-05:00", 3.0, "100"), stock("2026-10-02 16:00:00-05:00", 2.0, "140", "Extended Bolus")]
print(json.dumps({"same": cb.apply_to_entries(entries, events) == entries}))`);
    expect(out.same).toBe(true);
  });

  it("reports which stock entries a combo replaces (used by the enrich tool)", async () => {
    const out = await py(`${COMBO_EVENTS(5.64, 60, 120, 3.46)}\nnow, ext = cb.Index(events).replaced_seqs()\nprint(json.dumps({"now": sorted(now), "ext": sorted(ext)}))`);
    expect(out).toEqual({ now: [100], ext: [140] });
  });
});

describe("tconnectsync wrapper", () => {
  const read = (p: string) => fs.readFileSync(path.join(DIR, p), "utf8");
  it("runs through the combo hook and keeps secrets out of the repo", () => {
    expect(read("diabetes-tconnectsync")).toMatch(/diabetes_tconnectsync\.py/);
    expect(read("diabetes-tconnectsync")).toMatch(/enrich_combos\.py/);
    for (const f of ["combo_bolus.py", "diabetes_tconnectsync.py", "enrich_combos.py", "diabetes-tconnectsync"]) {
      expect(read(f)).not.toMatch(/^\s*(export\s+)?(TCONNECT_PASSWORD|NS_SECRET)=["']?[^$"'\s(]/m);
    }
  });
  it("refuses to patch an unsupported tconnectsync version, loudly", () => {
    expect(read("diabetes_tconnectsync.py")).toMatch(/COMBO PATCH NOT APPLIED/);
    expect(read("install.sh")).toMatch(/--combo-selftest/);
  });
});
