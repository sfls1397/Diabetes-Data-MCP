#!/usr/bin/env python3
"""Sync Nightscout entries/treatments into the Mac Mini diabetes SQLite archive.

Sole writer of ~/.diabetes-data/diabetes.sqlite (LaunchAgent com.diabetes-sqlite.sync,
daily 5:15 AM America/Chicago). Diabetes Data MCP only reads this file.

Credentials (never hardcode, print, or log the Nightscout URL or API secret):
  1. Env NIGHTSCOUT_URL + NIGHTSCOUT_API_SECRET (tests / one-off runs)
  2. macOS Keychain service `diabetes-sqlite`, accounts `nightscout-url` and `api-secret`
Missing credentials fail closed: exit 2 before the database is opened or created.

Ported from the Grok box writer (/workspace/diabetes-db/sync_from_nightscout.py);
schema and daily/weekly math are unchanged so box and Mini rows match."""
from __future__ import annotations

import fcntl
import hashlib
import json
import math
import os
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

HOME = Path(os.environ.get("HOME", str(Path.home())))
DB_PATH = Path(os.environ.get("DIABETES_DB_PATH", str(HOME / ".diabetes-data" / "diabetes.sqlite")))
LOCK_PATH = Path(os.environ.get("DIABETES_SYNC_LOCK", str(DB_PATH.parent / "sync.lock")))
KEYCHAIN_SERVICE = os.environ.get("DIABETES_KEYCHAIN_SERVICE", "diabetes-sqlite")
KEYCHAIN_URL_ACCOUNT = "nightscout-url"
KEYCHAIN_SECRET_ACCOUNT = "api-secret"
WRITER = "com.diabetes-sqlite.sync (Mac mini)"


class MissingCredentials(RuntimeError):
    pass


def keychain_get(service: str, account: str) -> str | None:
    try:
        out = subprocess.run(
            ["/usr/bin/security", "find-generic-password", "-s", service, "-a", account, "-w"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    value = out.stdout.decode("utf-8", "replace").strip() if out.returncode == 0 else ""
    return value or None


def load_nightscout_auth() -> tuple[str, str]:
    """Return (base_url, api_secret_plaintext). Env pair wins, else Keychain."""
    env_url = os.environ.get("NIGHTSCOUT_URL", "").strip()
    env_secret = os.environ.get("NIGHTSCOUT_API_SECRET", "").strip()
    if env_url and env_secret:
        return env_url.rstrip("/"), env_secret
    url = keychain_get(KEYCHAIN_SERVICE, KEYCHAIN_URL_ACCOUNT)
    secret = keychain_get(KEYCHAIN_SERVICE, KEYCHAIN_SECRET_ACCOUNT)
    missing = [a for a, v in ((KEYCHAIN_URL_ACCOUNT, url), (KEYCHAIN_SECRET_ACCOUNT, secret)) if not v]
    if missing:
        raise MissingCredentials(
            f"Nightscout credentials missing: Keychain service {KEYCHAIN_SERVICE} account(s) {', '.join(missing)} "
            "(or env NIGHTSCOUT_URL + NIGHTSCOUT_API_SECRET)."
        )
    if not url.startswith("https://") and not url.startswith("http://"):
        raise MissingCredentials(f"Keychain {KEYCHAIN_SERVICE}/{KEYCHAIN_URL_ACCOUNT} is not an http(s) URL.")
    return url.rstrip("/"), secret


BASE: str | None = None
API_SECRET: str | None = None


def ensure_auth() -> tuple[str, str]:
    global BASE, API_SECRET
    if BASE is None or API_SECRET is None:
        BASE, API_SECRET = load_nightscout_auth()
    return BASE, API_SECRET


def scrub(message: str) -> str:
    """Remove the Nightscout base URL and secret from an error message."""
    for value in (BASE, API_SECRET):
        if value:
            message = message.replace(value, "[redacted]")
    if API_SECRET:
        message = message.replace(hashlib.sha1(API_SECRET.encode()).hexdigest(), "[redacted]")
    return message

TZ = ZoneInfo("America/Chicago")
PAGE = int(os.environ.get("DIABETES_SYNC_PAGE", "1000"))  # tests page with smaller batches

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sgv (
  date_ms INTEGER PRIMARY KEY,
  date_string TEXT NOT NULL,
  sgv INTEGER NOT NULL,
  direction TEXT,
  device TEXT,
  type TEXT,
  raw_json TEXT
);
CREATE TABLE IF NOT EXISTS treatments (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  timestamp_ms INTEGER,
  event_type TEXT,
  insulin REAL,
  carbs REAL,
  duration_min REAL,
  rate REAL,
  percent REAL,
  absolute REAL,
  entered_by TEXT,
  notes TEXT,
  raw_json TEXT
);
CREATE TABLE IF NOT EXISTS daily_stats (
  day TEXT PRIMARY KEY,
  tir_80_180 REAL,
  under_80 REAL,
  over_180 REAL,
  avg_mgdl REAL,
  cv_pct REAL,
  tdd_u REAL,
  bolus_u REAL,
  basal_u REAL,
  sgv_count INTEGER,
  source TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS weekly_stats (
  week_ending TEXT PRIMARY KEY,
  week_start TEXT,
  tir_80_180 REAL,
  under_80 REAL,
  over_180 REAL,
  avg_mgdl REAL,
  cv_pct REAL,
  tdd_u REAL,
  sgv_count INTEGER,
  source TEXT,
  trend_note TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sgv_date_string ON sgv(date_string);
CREATE INDEX IF NOT EXISTS idx_tx_created ON treatments(created_at);
CREATE INDEX IF NOT EXISTS idx_tx_type ON treatments(event_type);
"""


def init_db(conn: sqlite3.Connection) -> None:
    """Create tables/indexes if missing. Safe on every run; portable Mac Mini bootstrap."""
    conn.executescript(SCHEMA_SQL)
    # Seed portable meta if empty
    if conn.execute("SELECT COUNT(*) FROM meta").fetchone()[0] == 0:
        conn.execute("INSERT INTO meta(key,value) VALUES ('schema_version','1')")
        conn.execute("INSERT INTO meta(key,value) VALUES ('timezone','America/Chicago')")
        conn.execute("INSERT INTO meta(key,value) VALUES ('tir_low','80')")
        conn.execute("INSERT INTO meta(key,value) VALUES ('tir_high','180')")
        conn.execute(
            "INSERT INTO meta(key,value) VALUES (?,?)",
            (
                "path_note",
                "Mac mini archive; sole writer com.diabetes-sqlite.sync; set DIABETES_DB_PATH to move",
            ),
        )
    conn.commit()



def api_secret_header() -> str:
    _, secret = ensure_auth()
    return hashlib.sha1(secret.encode()).hexdigest()


def ns_get(path: str) -> list | dict:
    base, _ = ensure_auth()
    url = f"{base}{path}"
    req = urllib.request.Request(url, headers={"api-secret": api_secret_header(), "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode())


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=60)
    conn.row_factory = sqlite3.Row
    init_db(conn)
    return conn


def meta_get(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else None


def meta_set(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)", (key, value))


def upsert_sgv(conn: sqlite3.Connection, rows: list[dict]) -> int:
    n = 0
    for r in rows:
        date_ms = r.get("date")
        if date_ms is None:
            continue
        sgv = r.get("sgv")
        if sgv is None:
            continue
        conn.execute(
            """INSERT OR REPLACE INTO sgv(date_ms,date_string,sgv,direction,device,type,raw_json)
               VALUES (?,?,?,?,?,?,?)""",
            (
                int(date_ms),
                r.get("dateString") or "",
                int(sgv),
                r.get("direction"),
                r.get("device"),
                r.get("type"),
                json.dumps(r, separators=(",", ":")),
            ),
        )
        n += 1
    return n


def upsert_treatments(conn: sqlite3.Connection, rows: list[dict]) -> int:
    n = 0
    for r in rows:
        tid = r.get("_id") or r.get("identifier")
        if not tid:
            # synthesize stable-ish id
            tid = f"{r.get('created_at','')}:{r.get('eventType','')}:{r.get('insulin')}:{r.get('carbs')}"
        created = r.get("created_at") or r.get("timestamp") or ""
        ts = r.get("timestamp")
        if isinstance(ts, str) and ts.isdigit():
            ts = int(ts)
        elif not isinstance(ts, (int, float)):
            ts = None
        conn.execute(
            """INSERT OR REPLACE INTO treatments(
                 id,created_at,timestamp_ms,event_type,insulin,carbs,duration_min,rate,percent,absolute,entered_by,notes,raw_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                str(tid),
                created,
                int(ts) if ts is not None else None,
                r.get("eventType"),
                r.get("insulin"),
                r.get("carbs"),
                r.get("duration"),
                r.get("rate"),
                r.get("percent"),
                r.get("absolute"),
                r.get("enteredBy"),
                r.get("notes") or r.get("reason"),
                json.dumps(r, separators=(",", ":")),
            ),
        )
        n += 1
    return n


def page_entries(conn: sqlite3.Connection) -> int:
    """Page newest-first until we overlap existing data or run out."""
    total = 0
    oldest_seen = None
    known_min = conn.execute("SELECT MIN(date_ms) FROM sgv").fetchone()[0]
    # Always pull at least one newest page; keep going while oldest_seen > known_min (gap) or known_min is None
    safety = 0
    while safety < 40:
        safety += 1
        if oldest_seen is None:
            path = f"/api/v1/entries.json?count={PAGE}"
        else:
            # older than oldest_seen on this walk
            q = urllib.parse.quote(f'{{"date":{{"$lt":{oldest_seen}}}}}')
            path = f"/api/v1/entries.json?find={q}&count={PAGE}"
        try:
            batch = ns_get(path)
        except Exception as e:
            # find often 500s — fall back to count-only once
            if oldest_seen is not None:
                print(f"entries find failed ({scrub(str(e))}); stopping page walk", file=sys.stderr)
                break
            raise
        if not isinstance(batch, list) or not batch:
            break
        total += upsert_sgv(conn, batch)
        dates = [int(x["date"]) for x in batch if x.get("date") is not None]
        batch_min = min(dates)
        batch_max = max(dates)
        if oldest_seen is None or batch_min < oldest_seen:
            oldest_seen = batch_min
        # If we already had data and this page is entirely newer-or-equal to known_min with overlap, done for incremental
        if known_min is not None and batch_min <= known_min:
            break
        if len(batch) < PAGE:
            break
    return total


def page_treatments(conn: sqlite3.Connection) -> int:
    total = 0
    oldest_seen = None
    known_min = conn.execute(
        "SELECT MIN(created_at) FROM treatments WHERE created_at IS NOT NULL AND created_at != ''"
    ).fetchone()[0]
    safety = 0
    while safety < 80:
        safety += 1
        if oldest_seen is None:
            path = f"/api/v1/treatments.json?count={PAGE}"
        else:
            q = urllib.parse.quote(f'{{"created_at":{{"$lt":"{oldest_seen}"}}}}')
            path = f"/api/v1/treatments.json?find={q}&count={PAGE}"
        try:
            batch = ns_get(path)
        except Exception as e:
            if oldest_seen is not None:
                print(f"treatments find failed ({scrub(str(e))}); stopping", file=sys.stderr)
                break
            raise
        if not isinstance(batch, list) or not batch:
            break
        total += upsert_treatments(conn, batch)
        createds = [x.get("created_at") for x in batch if x.get("created_at")]
        if not createds:
            break
        batch_min = min(createds)
        if oldest_seen is None or batch_min < oldest_seen:
            oldest_seen = batch_min
        if known_min is not None and batch_min <= known_min:
            break
        if len(batch) < PAGE:
            break
    return total


def day_bounds_utc(day: str) -> tuple[int, int]:
    """Inclusive start ms, exclusive end ms for CT calendar day."""
    d = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=TZ)
    start = d.astimezone(timezone.utc)
    end = (d + timedelta(days=1)).astimezone(timezone.utc)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def recompute_daily(conn: sqlite3.Connection, day: str, source: str = "Nightscout API") -> None:
    start_ms, end_ms = day_bounds_utc(day)
    sgvs = [r[0] for r in conn.execute(
        "SELECT sgv FROM sgv WHERE date_ms >= ? AND date_ms < ?", (start_ms, end_ms)
    )]
    if not sgvs:
        return
    n = len(sgvs)
    avg = sum(sgvs) / n
    var = sum((x - avg) ** 2 for x in sgvs) / n
    sd = math.sqrt(var)
    cv = (100 * sd / avg) if avg else None
    tir = 100 * sum(1 for x in sgvs if 80 <= x <= 180) / n
    under = 100 * sum(1 for x in sgvs if x < 80) / n
    over = 100 * sum(1 for x in sgvs if x > 180) / n

    start_iso = datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    end_iso = datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")

    rows = conn.execute(
        """SELECT event_type, insulin, duration_min, rate, absolute, percent, created_at
           FROM treatments WHERE created_at >= ? AND created_at < ?""",
        (start_iso, end_iso),
    ).fetchall()
    bolus = 0.0
    basal = 0.0
    for r in rows:
        et = (r["event_type"] or "").lower()
        insulin = r["insulin"] or 0.0
        if "bolus" in et or et in ("meal bolus", "correction bolus", "combo bolus", "smb"):
            bolus += float(insulin)
        elif "temp basal" in et or et == "temp basal":
            # approximate from rate * duration/60 if insulin missing
            if insulin:
                basal += float(insulin)
            elif r["rate"] is not None and r["duration_min"]:
                basal += float(r["rate"]) * float(r["duration_min"]) / 60.0
        elif "basal" in et and insulin:
            basal += float(insulin)
    tdd = bolus + basal if (bolus or basal) else None
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    conn.execute(
        """INSERT OR REPLACE INTO daily_stats(
             day,tir_80_180,under_80,over_180,avg_mgdl,cv_pct,tdd_u,bolus_u,basal_u,sgv_count,source,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (day, tir, under, over, avg, cv, tdd, bolus or None, basal or None, n, source, now),
    )



def week_bounds_for_day(d: date) -> tuple[date, date]:
    """Sunday–Saturday CT week containing d. week_ending is Saturday."""
    # Monday=0 ... Sunday=6 in date.weekday(); we want Sunday start
    # days since Sunday:
    since_sun = (d.weekday() + 1) % 7
    start = d - timedelta(days=since_sun)
    end = start + timedelta(days=6)
    return start, end


def recompute_weekly(conn: sqlite3.Connection, week_ending: str, source: str = "SQLite") -> None:
    """Rebuild one week of weekly_stats from daily_stats. Keeps existing trend_note."""
    end = datetime.strptime(week_ending, "%Y-%m-%d").date()
    start = end - timedelta(days=6)
    rows = conn.execute(
        """SELECT day, tir_80_180, under_80, over_180, avg_mgdl, cv_pct, tdd_u, sgv_count
           FROM daily_stats
           WHERE day >= ? AND day <= ?
           ORDER BY day""",
        (start.isoformat(), end.isoformat()),
    ).fetchall()
    if not rows:
        return
    # Require a full week of daily rows for archived weeks; allow partial only for the in-progress week
    today = datetime.now(TZ).date()
    if end < today and len(rows) < 7:
        return
    total_sgv = sum(int(r["sgv_count"] or 0) for r in rows)
    if total_sgv <= 0:
        return

    def wavg(field: str) -> float | None:
        num = 0.0
        den = 0
        for r in rows:
            v = r[field]
            n = int(r["sgv_count"] or 0)
            if v is None or n <= 0:
                continue
            num += float(v) * n
            den += n
        return (num / den) if den else None

    tir = wavg("tir_80_180")
    under = wavg("under_80")
    over = wavg("over_180")
    avg = wavg("avg_mgdl")
    cv = wavg("cv_pct")
    tdds = [float(r["tdd_u"]) for r in rows if r["tdd_u"] is not None]
    tdd = (sum(tdds) / len(tdds)) if tdds else None
    prev = conn.execute(
        "SELECT trend_note FROM weekly_stats WHERE week_ending=?", (week_ending,)
    ).fetchone()
    trend_note = prev["trend_note"] if prev else None
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    conn.execute(
        """INSERT OR REPLACE INTO weekly_stats(
             week_ending, week_start, tir_80_180, under_80, over_180, avg_mgdl, cv_pct,
             tdd_u, sgv_count, source, trend_note, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            week_ending,
            start.isoformat(),
            tir,
            under,
            over,
            avg,
            cv,
            tdd,
            total_sgv,
            source,
            trend_note,
            now,
        ),
    )


def recompute_weeks(conn: sqlite3.Connection, source: str = "SQLite") -> int:
    row = conn.execute("SELECT MIN(day), MAX(day) FROM daily_stats").fetchone()
    if not row or row[0] is None:
        return 0
    start = datetime.strptime(row[0], "%Y-%m-%d").date()
    end = datetime.strptime(row[1], "%Y-%m-%d").date()
    # Align to first Saturday on/after start's week end
    _ws, first_end = week_bounds_for_day(start)
    d = first_end
    count = 0
    while d <= end:
        recompute_weekly(conn, d.isoformat(), source=source)
        count += 1
        d += timedelta(days=7)
    return count


def recompute_range(conn: sqlite3.Connection, source: str = "Nightscout API") -> int:
    row = conn.execute("SELECT MIN(date_ms), MAX(date_ms) FROM sgv").fetchone()
    if not row or row[0] is None:
        return 0
    start = datetime.fromtimestamp(row[0] / 1000, tz=timezone.utc).astimezone(TZ).date()
    end = datetime.fromtimestamp(row[1] / 1000, tz=timezone.utc).astimezone(TZ).date()
    d = start
    count = 0
    while d <= end:
        recompute_daily(conn, d.isoformat(), source=source)
        count += 1
        d += timedelta(days=1)
    return count


MODES = ("sync", "entries", "treatments", "stats", "recompute", "check")


def run(mode: str) -> None:
    conn = connect()
    try:
        if mode in ("sync", "entries"):
            n = page_entries(conn)
            print(f"sgv upserts this walk: {n}")
        if mode in ("sync", "treatments"):
            n = page_treatments(conn)
            print(f"treatment upserts this walk: {n}")
        if mode in ("sync", "stats", "recompute"):
            days = recompute_range(conn)
            print(f"daily_stats days: {days}")
            weeks = recompute_weeks(conn)
            print(f"weekly_stats weeks: {weeks}")
        meta_set(conn, "last_sync_at", datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))
        meta_set(conn, "last_sync_mode", mode)
        meta_set(conn, "last_sync_writer", WRITER)
        sgv_n = conn.execute("SELECT COUNT(*) FROM sgv").fetchone()[0]
        tx_n = conn.execute("SELECT COUNT(*) FROM treatments").fetchone()[0]
        print(f"totals: sgv={sgv_n} treatments={tx_n}")
        conn.commit()
    finally:
        conn.close()


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "sync"
    if mode not in MODES:
        print(f"usage: diabetes-sqlite-sync [{'|'.join(MODES)}]", file=sys.stderr)
        return 64
    stamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    print(f"{stamp} diabetes-sqlite-sync {mode} db={DB_PATH}")
    network = mode in ("sync", "entries", "treatments", "check")
    if network:
        # Fail closed before the database is opened or created.
        try:
            ensure_auth()
        except MissingCredentials as e:
            print(f"ERROR: {e}", file=sys.stderr)
            return 2
    if mode == "check":
        print("OK: Nightscout credentials present (values not shown)")
        return 0
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(LOCK_PATH, "w") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("SKIP: another sync already running")
            return 0
        try:
            run(mode)
        except (urllib.error.URLError, OSError, ValueError, sqlite3.Error) as e:
            # Uncommitted rows roll back with the connection; the archive keeps its last good state.
            print(f"ERROR: {type(e).__name__}: {scrub(str(e))}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
