# Diabetes Data MCP

A self-hosted diabetes data plane for one Mac, as one product: **Nightscout itself** (home network only), a Nightscout → SQLite sync, and a read-only MCP server over that SQLite archive. The same 12 tools are available to Claude Desktop, Claude Code, ChatGPT, and any other MCP client, over stdio or bearer-token HTTP.

Published to npm as **`diabetes-data-mcp`**. Run the **global npm install**, not a git checkout: see [Install and deploy](#install-and-deploy). Every command below uses `PKG="$(npm root -g)/diabetes-data-mcp"` (the global install under the `node` your LaunchAgents use).

## Pieces

| Piece | What | LaunchAgent |
| --- | --- | --- |
| `nightscout/diabetes-nightscout-server` | Nightscout 15.0.8 on the home LAN, `0.0.0.0:8425`. Dexcom Share bridge + tconnectsync feed it. See [Bundled Nightscout](#bundled-nightscout). | `com.diabetes-nightscout.server` — KeepAlive |
| MongoDB 8.0 (`nightscout/install-runtime.sh`) | Nightscout's database, **127.0.0.1:27017 only**. | `com.diabetes-nightscout.mongod` — KeepAlive |
| `tconnectsync/diabetes-tconnectsync` | [tconnectsync](https://github.com/jwoglom/tconnectsync) 3.0.3 (pinned venv): Tandem Source pump data → Nightscout. Logins from Keychain. | `com.diabetes-tconnectsync.sync` — hourly at **:35** |
| `sync/diabetes-sqlite-sync` | Nightscout entries + treatments + pump profiles → `~/.diabetes-data/diabetes.sqlite`, then rebuilds `daily_stats` / `weekly_stats`. **Sole writer.** | `com.diabetes-sqlite.sync` — every **minute** (`StartInterval=60`) |
| `bin/diabetes-data-mcp.js serve` | Streamable HTTP MCP, bearer token on every request including `/health`. Preferred port **8424**. | `com.diabetes-mcp.server` — KeepAlive |
| `stdio` | Same tools over stdio for a client on the same Mac. | — |
| `http-proxy <url>` | stdio → HTTP bridge for Claude Desktop on another Mac. Token in `DIABETES_DATA_MCP_TOKEN`. | — |
| `http-token` | Print the Keychain bearer token (creates it on first use). | — |
| `check-config` | Print the resolved DB path, host, and preferred port. Binds nothing. | — |

Default ports: **MCP 8424**, **Nightscout 8425**. If 8424 is taken, `serve` binds the next free port above it and logs `preferred port 8424 is in use; listening on http://<host>:<port>/mcp`. Point clients at the logged URL.

Requires **Node.js 22.12+** (`node:sqlite`, no native addon) and macOS `/usr/bin/python3` (3.9+) for the SQLite sync. The Tandem installer prepares its own checksum-pinned Python 3.13 runtime with hash-locked, audited dependencies; it does not change system Python. See [Python runtime](tconnectsync/RUNTIME.md).

## Conventions

These are fixed in the code (the MCP and the sync), not settings. Using another time zone or range needs a code change.

- **Timezone:** America/Chicago. Every `date_*` argument is a local calendar day and every `time_*` is local `HH:MM`. Rows come back with `ts` (ISO UTC) and `local` (Chicago ISO with offset). DST days are 23 or 25 hours.
- **Time in range:** **80–180 mg/dL** (`tir_80_180`, `under_80` = below 80, `over_180` = above 180, percent of readings), not the common 70–180 band.
- **Weeks:** Sunday–Saturday; `week_ending` is the Saturday.

## Tools

| Tool | Purpose |
| --- | --- |
| `sync_status` | `last_sync_at` / `last_sync_mode` from `meta`, hours since the last sync (`stale` after 1 h), row counts, earliest/latest SGV and treatments, daily/weekly span, `schema_version`, TIR band. URL/secret-like meta keys are hidden and URLs in values are redacted. |
| `list_sgv` | Readings for `date_from`..`date_to` (≤ 31 days), optional `time_from`/`time_to` slice per day (wraps midnight when from > to), `sample` (every Nth), `order`, `limit` (default 1000, max 10000). `raw_json` only with `include_raw`. |
| `list_treatments` | Treatments for `date_from`..`date_to` (≤ 366 days): `created_at`, `local`, `event_type`, `insulin`, `carbs`, `duration_min`, `rate`, `percent`, `absolute`, `entered_by`, `notes`. Filters: `event_type` (string or list, exact, case-insensitive), `entered_by` substring. `include_raw` for combo-bolus split details. |
| `get_daily_stats` | `daily_stats` rows by `date`, `date_from`/`date_to`, or newest `limit` (default 14). |
| `get_weekly_stats` | `weekly_stats` rows by `week_ending`, a `week_ending` range, or newest `limit` (default 8). Includes `trend_note`. |
| `get_range_stats` | Computed stats for any window: days, optional per-day `time_from`/`time_to`, optional `weekdays`. Returns TIR/under/over, avg, SD, CV, min/max, `sgv_count`, `hours_covered` (distinct 5-minute slots) vs `window_hours`. `include_insulin` adds bolus / temp-basal / carbs totals for treatments in the same slice (temp basal = insulin, else rate × duration, not clipped to the slice; for programmed basal use `get_settings_vs_delivery`). |
| `get_coverage` | Earliest/latest SGV and treatments; per local day in the window (default the whole SGV span) the days with no readings, days under `low_threshold` (default 200; a full day is ~288), days with readings but no `daily_stats` row; optional `include_gaps` with `gap_minutes` (default 30). |
| `query_raw` | One read-only `SELECT` (or `WITH … SELECT`), capped at 1000 rows. Escape hatch. |

Pump profile tools:

| Tool | Purpose |
| --- | --- |
| `get_active_profile` | The profile in force now: the newest version's active profile with every segment (`carb_ratio` g/U, `sensitivity` mg/dL per U, `basal` U/h, `target_low`/`target_high`, `dia_hours`, `scheduled_basal_u_per_day`), `in_force_now` (segment values at the current local time), the other named profiles (full with `include_all_profiles`) and `profile_sync` freshness. |
| `get_profile_as_of` | The profile in force at `at` (`YYYY-MM-DD` = 00:00 local, `YYYY-MM-DD HH:MM` local, or ISO with Z/offset): version, active schedules, `in_force_at_time`, `next_change`; a date alone also lists `changes_that_day`. Before the first recorded version: `found: false`, never extrapolated. In the repeated fall-back hour the first occurrence is used; a time in the spring-forward gap is an error. |
| `list_profile_changes` | History oldest first: start/end per version, `active_profile`, `previous_active_profile`, `change` (`first_version`, `profile_switch`, `settings_edit`, `profile_switch_and_edit`, `no_active_change`), `active_profile_changed_fields`, profiles added/removed/edited. Filter by start day; `include_settings` adds full schedules; `include_deleted` shows versions deleted upstream. |
| `get_settings_vs_delivery` | Programmed vs delivered for `date_from`..`date_to` (≤ 366 days) using the version in force at every moment (exact splits at profile switches, schedule boundaries and DST). `basal`: schedule integrated over time vs Temp Basal rate × time (scheduled, Control-IQ, suspended), totals, by reason, per profile/segment. `carbs`: carbs ÷ the carb ratio in force at each entry vs the bolus logged with those carbs, implied g/U, per segment. `insulin_totals`; `include_days` for per-day rows. Hours before the first version are reported separately. Data only, not dosing advice. |

`get_range_stats` uses the same formulas as the sync's `daily_stats` (population SD, CV = SD / mean), so a whole-day range matches that day's rollup. The test suite checks this end to end.

Out of scope: live Nightscout reads, settings recommendations (the profile tools return numbers only; judging settings is left to the person or model reading them), meal analysis.

## Read-only guarantee

The MCP opens SQLite with `readOnly: true` (`SQLITE_OPEN_READONLY`) and `PRAGMA query_only = ON`. Writes fail with `attempt to write a readonly database`. It does not create the file, run migrations, call Nightscout, or touch `com.diabetes-sqlite.sync`.

## Schema (schema_version 1)

The DDL is `SCHEMA_SQL` in `sync/sync_from_nightscout.py`.

| Table | Columns |
| --- | --- |
| `meta` | `key` PK, `value` — `schema_version`, `timezone`, `tir_low`=80, `tir_high`=180, `last_sync_at`, `last_sync_mode`, `last_sync_writer`, `path_note`, … |
| `sgv` | `date_ms` PK (UTC ms), `date_string`, `sgv`, `direction`, `device`, `type`, `raw_json` |
| `treatments` | `id` PK, `created_at` (ISO UTC), `timestamp_ms`, `event_type`, `insulin`, `carbs`, `duration_min`, `rate`, `percent`, `absolute`, `entered_by`, `notes`, `raw_json` |
| `daily_stats` | `day` PK (Chicago), `tir_80_180`, `under_80`, `over_180`, `avg_mgdl`, `cv_pct`, `tdd_u`, `bolus_u`, `basal_u`, `sgv_count`, `source`, `updated_at` |
| `weekly_stats` | `week_ending` PK (Saturday), `week_start`, `tir_80_180`, `under_80`, `over_180`, `avg_mgdl`, `cv_pct`, `tdd_u` (mean per day), `sgv_count`, `source`, `trend_note`, `updated_at` |

### Pump profile history (`PROFILE_SCHEMA_SQL`)

One `profile_versions` row per Nightscout profile document. tconnectsync's PROFILES feature uploads a new document whenever the pump's settings or active profile change; each document carries every named profile (`store`), and its `defaultProfile` is the profile in force from `start_ms` until the next version starts.

| Table / view | Columns |
| --- | --- |
| `profile_versions` | `id` PK (Nightscout `_id`), `start_ms` (UTC ms of `startDate`), `start_date` (as stored), `created_at`, `active_profile`, `entered_by`, `profile_names` (JSON array), `content_sha256`, `raw_json`, `first_seen_at`, `updated_at`, `source_deleted_at` (set when a full walk no longer finds the document; the row is kept and the tools ignore it) |
| `profile_settings` | (`version_id`, `profile_name`) PK, `is_active`, `units`, `timezone`, `dia_hours`, `carbs_hr`, `delay_min` |
| `profile_segments` | (`version_id`, `profile_name`, `kind`, `seq`) PK; `kind` ∈ `carbratio` (g/U), `sens` (BG units per U), `basal` (U/h), `target_low`, `target_high`; `start_sec`/`end_sec` (local seconds of day, end = next start or 86400; the first segment covers from 00:00, as Nightscout reads it), `time` (as stored), `value` |
| `profile_timeline` (view) | `id`, `start_ms`, `end_ms` (next version's start, NULL = in force), `start_date`, `active_profile`, `entered_by` |

Basal programmed at an instant, in SQL:

```sql
WITH t AS (SELECT CAST(strftime('%s','2026-10-01T15:00:00Z') AS INTEGER) * 1000 AS ms)
SELECT v.id, v.active_profile, s.value AS basal_u_per_h
FROM t, profile_timeline v JOIN profile_segments s
  ON s.version_id = v.id AND s.profile_name = v.active_profile AND s.kind = 'basal'
WHERE v.start_ms <= t.ms AND (v.end_ms IS NULL OR t.ms < v.end_ms)
  AND s.start_sec <= :local_seconds_of_day AND :local_seconds_of_day < s.end_sec;
```

(`:local_seconds_of_day` is the Chicago wall-clock time; SQLite's date functions are UTC, so prefer `get_profile_as_of` / `get_settings_vs_delivery`, which handle DST.) A version's start is when tconnectsync uploaded the change (it polls Tandem hourly), not the second it was made on the pump. Profile history begins at the first document in Nightscout; earlier times have no profile.

## Sync

```bash
sync/diabetes-sqlite-sync check    # credentials present? (no network, no DB write)
sync/diabetes-sqlite-sync sync     # entries + treatments + rollups (LaunchAgent default, every minute)
sync/diabetes-sqlite-sync backfill # one-off: full history from Nightscout, dedupe legacy synthesized ids, rebuild all rollups
sync/diabetes-sqlite-sync stats    # rebuild daily/weekly rollups only, no network
sync/diabetes-sqlite-sync profiles # re-read every Nightscout profile document only (exit 1 if that fails)
```

Credentials are never in git, config, or logs:

1. Env `NIGHTSCOUT_URL` + `NIGHTSCOUT_API_SECRET` (one-off runs / tests)
2. macOS Keychain service **`diabetes-sqlite`**, accounts **`nightscout-url`** and **`api-secret`** (the plaintext site API_SECRET; the sync sends its SHA-1 as the `api-secret` header)

Seed the Keychain on the Mac that runs the sync (keep the values out of shell history):

```bash
security add-generic-password -U -s diabetes-sqlite -a nightscout-url -w
security add-generic-password -U -s diabetes-sqlite -a api-secret -w
```

(`-w` last with no value prompts for it.) Missing credentials exit 2 before the database is opened or created. A Nightscout or network error exits 1; nothing from that run is committed. A second run while one is active prints `SKIP: another sync already running` (`flock` on `~/.diabetes-data/sync.lock`). Logs: `~/Library/Logs/diabetes-sqlite.sync.{out,err}.log`.

`StartInterval=60` runs every minute. `TZ=America/Chicago` in the plist sets the sync's own date math.

A routine run asks Nightscout for the newest page of entries and treatments, stops as soon as it overlaps what is already stored, and recomputes `daily_stats` / `weekly_stats` only for the newest few days (`DIABETES_SYNC_RECOMPUTE_DAYS`, default 3). The first run of each local day recomputes everything, so a late edit to an older day is picked up within a day.

Profiles are mirrored after the entries/treatments commit, read-only through Nightscout's `GET /api/v1/profile` (its MongoDB `profile` collection; no Mongo connection or new credential). A routine run re-reads the newest `DIABETES_SYNC_PROFILE_RECENT` documents (default 10); the whole collection is re-read when the table is empty, on the first run of each local day, and in `backfill` / `profiles` modes, which also flag documents deleted upstream. Unchanged documents (same content hash) are never rewritten. A profile failure is printed (scrubbed) and stored in `meta.profile_last_error`; it never undoes or fails the glucose/treatment sync. `meta.profile_last_sync_at` / `profile_last_full_day` record the last mirror.

### Two databases, on purpose

| | Nightscout's MongoDB | `diabetes.sqlite` |
| --- | --- | --- |
| Role | Live working store; the Dexcom bridge and tconnectsync write to it | Uniform analytics archive the MCP reads |
| Access | `127.0.0.1:27017`, no auth, owned by Nightscout's layout | Read-only to the MCP, Chicago-time days, TIR 80–180 rollups |
| History | Whatever the Dexcom bridge, tconnectsync, or an import has stored | Everything Mongo has, after a backfill |

The MCP never reads Mongo. `sync` keeps SQLite current each minute. `sync/diabetes-sqlite-sync backfill` walks the whole Nightscout history into SQLite (commits per page, safe to interrupt and rerun), removes rows imported from an older archive whose synthesized id now exists under the real Nightscout id (otherwise insulin would double count), and rebuilds every daily/weekly rollup. Rows deleted from Nightscout are not deleted from SQLite (upsert-only).

The sync is the only writer of `diabetes.sqlite`. With the bundled Nightscout on the same Mac, set Keychain `nightscout-url` to `http://127.0.0.1:8425`.

## Bundled Nightscout

```
Dexcom Share ──(bridge, outbound)──┐
Tandem Source ──(tconnectsync)─────┴─► Nightscout :8425 ─► MongoDB 127.0.0.1:27017
                                            └─► com.diabetes-sqlite.sync ─► SQLite ─► MCP :8424
```

Upstream [cgm-remote-monitor](https://github.com/nightscout/cgm-remote-monitor) 15.0.8, downloaded at an exact commit with a reviewed dependency/security compatibility profile (AGPL-3.0; see [runtime profile](nightscout/RUNTIME.md)). **Home network only:** no public URL, port-forward, tunnel, or DNS. Dexcom and Tandem are outbound pulls; nothing on the internet connects in.

Who connects:
- Tools and agents on the same Mac: `http://127.0.0.1:8425`.
- Devices at home: `http://<LocalHostName>.local:8425`.

Every request needs the site API secret (`AUTH_DEFAULT_ROLES=denied`); without it the API returns 401. Don't port-forward 8425 or 27017.

### Secrets (Keychain only)

| Service / account | What |
| --- | --- |
| `diabetes-sqlite` / `api-secret` | Plaintext site `API_SECRET`. Nightscout reads it at launch; the sync and `nightscout/prove.sh` send its SHA-1. One item, so they can't drift. |
| `diabetes-nightscout` / `dexcom-username`, `dexcom-password` | Dexcom Share login. Read only when `BRIDGE_ENABLE=1`. |

```bash
security add-generic-password -U -s diabetes-nightscout -a dexcom-username -w
security add-generic-password -U -s diabetes-nightscout -a dexcom-password -w
```

### Dexcom Share: one poller only

Share allows one session per login, so two Nightscouts polling it duplicate or drop readings. The bridge is off by default. Turn it on only after every other Nightscout's bridge is off:

```bash
echo BRIDGE_ENABLE=1 >> ~/.diabetes-data/nightscout/config.env
launchctl kickstart -k gui/$(id -u)/com.diabetes-nightscout.server
```

### tconnectsync (Tandem → Nightscout)

Runs `tconnectsync --days 1 --features BASAL BOLUS PUMP_EVENTS PROFILES` hourly at :35 against the bundled Nightscout (`http://127.0.0.1:8425`). It does not upload CGM; Dexcom comes through the bridge. Pinned to 3.0.3, which already sends `eventCodes` (Tandem rejects the old `eventIds` with HTTP 400). A true combo/extended bolus is written in the Care Portal shape (`insulin` = immediate U, `enteredinsulin` = total U, `splitNow`/`splitExt` %, `duration` min, `relative` extended U/h) by `tconnectsync/combo_bolus.py`, applied at run time through `tconnectsync/diabetes_tconnectsync.py`; nothing in site-packages is edited, and the hook refuses (with a loud WARNING) on any tconnectsync version other than 3.0.3. The later "Extended Bolus" completion entry is dropped so insulin is not double counted. `diabetes-tconnectsync enrich START END [--apply]` re-maps combos already in Nightscout (dry run by default; only replaces a combo whose old plain document exists, so it is safe to rerun).

| Keychain service / account | What |
| --- | --- |
| `diabetes-tconnectsync` / `tconnect-email`, `tconnect-password`, `pump-serial-number` | Tandem Source login and pump |
| `diabetes-sqlite` / `api-secret` | Nightscout secret (shared) |

```bash
sh "$PKG/tconnectsync/install.sh"
"$PKG/tconnectsync/diabetes-tconnectsync" --pretend    # dry run: reads Tandem + Nightscout, uploads nothing
sh "$PKG/examples/install-launchagents.sh" "$(command -v node)" tconnectsync
```

Log: `~/Library/Logs/diabetes-tconnectsync.sync.log`.

### Install / update

```bash
sh "$PKG/nightscout/install-runtime.sh" "$(command -v node)"                 # Mongo + tools (sha256-pinned), Nightscout tag + npm ci
sh "$PKG/examples/install-launchagents.sh" "$(command -v node)" nightscout   # mongod + server agents
sh "$PKG/nightscout/prove.sh"                                                # read-only: bind, 401/200, newest SGV, counts
```

Optional non-secret overrides: `~/.diabetes-data/nightscout/config.env` (see `nightscout/config.env.example`). Upgrading Nightscout requires updating the exact commit, source hashes and dependency profile together, then passing the upstream runtime test (`scripts/nightscout-local-test.sh` in the local gate). The installer audits a new profile-hashed runtime before switching it; the old runtime stays under `runtime/` for rollback. See [runtime profile](nightscout/RUNTIME.md).

| Path | What |
| --- | --- |
| `~/.diabetes-data/nightscout/mongo/` | MongoDB data |
| `~/.diabetes-data/nightscout/runtime/` | mongod, Database Tools, Nightscout checkout, cached downloads |
| `~/Library/Logs/diabetes-nightscout.{server,mongod}.log` | Logs |

Backup / restore (archives hold health data; `*.archive.gz` is git-ignored):

```bash
R=~/.diabetes-data/nightscout/runtime/mongotools/bin
$R/mongodump --host 127.0.0.1 --port 27017 --db Nightscout --gzip --archive=nightscout-$(date +%Y%m%d-%H%M).archive.gz
$R/mongorestore --host 127.0.0.1 --port 27017 --gzip --archive=<file> --nsInclude='Nightscout.*' --drop
```

## Install and deploy

Run the **published npm package**, installed globally under the `node` that the LaunchAgents use. Don't point a LaunchAgent at a git checkout; a checkout is for development and tests only.

```bash
NODE="$(command -v node)"                         # the node the LaunchAgents will run (Node.js 22.12+)
PREFIX="$(dirname "$(dirname "$NODE")")"
"$PREFIX/bin/npm" install -g --prefix "$PREFIX" diabetes-data-mcp@<version>
PKG="$PREFIX/lib/node_modules/diabetes-data-mcp"
sh "$PKG/examples/install-launchagents.sh" "$NODE" all            # com.diabetes-mcp.server + com.diabetes-sqlite.sync
sh "$PKG/examples/install-launchagents.sh" "$NODE" nightscout     # com.diabetes-nightscout.mongod + .server
sh "$PKG/examples/install-launchagents.sh" "$NODE" tconnectsync   # com.diabetes-tconnectsync.sync
sh "$PKG/nightscout/prove.sh"
```

One time per machine (state lives in `~/.diabetes-data/` and survives package upgrades): `sh "$PKG/nightscout/install-runtime.sh" "$NODE"` and `sh "$PKG/tconnectsync/install.sh"`.

**Upgrading:** run the `npm install -g --prefix` line with the new `@X.Y.Z`, rerun the three installer lines above (paths do not change, so this just reloads), and run `prove.sh`.

**Releases:** bump the version in a PR, merge, and publish a GitHub Release `vX.Y.Z`; `.github/workflows/npm-publish.yml` publishes via npm Trusted Publishing (OIDC, no tokens).

LaunchAgents do not load a login shell, so the installer writes the absolute `node` path into `com.diabetes-mcp.server` and `com.diabetes-nightscout.server`.

Server log: `~/Library/Logs/diabetes-data-mcp.server.log`.

### Keychain bearer token

Service **`diabetes-data-mcp-http`**, account **`http-auth-token`**. `serve` creates it on first start. Print it on the server Mac for client setup:

```bash
diabetes-data-mcp http-token
```

Keep it out of chat, notes, and logs. Rotate: `security delete-generic-password -s diabetes-data-mcp-http -a http-auth-token`, kickstart the server, update clients. Client setup: `examples/mcp-client.md`.

### Config

Optional `~/.diabetes-data-mcp/config.json` (see `examples/config.json.example`). Env overrides the file; the file overrides defaults.

| Key / env | Default |
| --- | --- |
| `dbPath` / `DIABETES_DATA_MCP_DB_PATH` | `~/.diabetes-data/diabetes.sqlite` (derived from the runtime home) |
| `serverHost` / `DIABETES_DATA_MCP_SERVER_HOST` | `0.0.0.0` |
| `serverPort` / `DIABETES_DATA_MCP_SERVER_PORT` | `8424` (preferred start) |

`DIABETES_DATA_MCP_HOME` relocates the config directory (tests only).

## Develop

```bash
npm install
npm test          # vitest: tools, time math, HTTP auth, and a fake-Nightscout end-to-end sync
npm run typecheck
```


### Persistent database setting

The default archive is `.diabetes-data/diabetes.sqlite` under the runtime user's home.
For a different archive, enter its absolute path once as `dbPath` in
`~/.diabetes-data-mcp/config.json` (mode 0600, directory mode 0700).
Existing local config survives npm upgrades. Environment overrides the file;
the file overrides the home-derived default. No deploy-time path entry is needed.
The MCP always opens the archive read-only; the existing sync job remains its sole writer.
The example config omits `dbPath` to keep the portable default.

### Privacy gates

Install Gitleaks 8.30.1 and enable the staged gate once per clone:

```bash
git config core.hooksPath .githooks
gitleaks git --log-opts=--all --config .gitleaks.toml --redact=100 --no-banner .
npm run build && npm run scan:package
```

Before a pull request is merged, `python3 .security/local-gate.py <PR number>`
runs Gitleaks, the production `npm audit`, offline Semgrep and the tests
(including the Nightscout and tconnectsync runtime tests) on the exact PR head
and records the result as the `local-gate` status.
Push and pull-request CI also scans full fetched history and the exact npm package
file list. Release CI scans history and `prepublishOnly` rebuilds and scans
the package before OIDC publication. Tests use synthetic Patient A fixtures.
Keep real paths and people solely in local settings, and secrets in Keychain.
After a history rewrite, discard old clones and re-clone so removed history
is not restored by an old branch.
