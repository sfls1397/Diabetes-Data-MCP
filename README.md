# Diabetes Data MCP

Peter's diabetes data plane on the Mac Mini, as one product: **Nightscout itself** (moved off GCP `gcns-vm`, home network only), the Nightscout → SQLite sync, and a read-only MCP server over that SQLite archive. The same 8 tools are available to Grok Bot (Local Execution / Mini Shell), Claude Desktop, ChatGPT, and any other MCP client.

**This package is not published to npm.** `package.json` sets `"private": true`. Deploy is a git checkout on the Mini: merge `main` → `git pull` → `npm install && npm run build` → restart the LaunchAgents.

## Pieces

| Piece | What | LaunchAgent |
| --- | --- | --- |
| `nightscout/diabetes-nightscout-server` | Nightscout 15.0.7 on the home LAN, `0.0.0.0:8425`. Dexcom Share bridge + tconnectsync feed it. See [Nightscout on the Mini](#nightscout-on-the-mini). | `com.diabetes-nightscout.server` — KeepAlive |
| MongoDB 8.0 (`nightscout/install-runtime.sh`) | Nightscout's database, **127.0.0.1:27017 only**. | `com.diabetes-nightscout.mongod` — KeepAlive |
| `tconnectsync/diabetes-tconnectsync` | [tconnectsync](https://github.com/jwoglom/tconnectsync) 3.0.3 (pinned venv): Tandem Source pump data → Nightscout. Logins from Keychain. | `com.diabetes-tconnectsync.sync` — hourly at **:35** |
| `sync/diabetes-sqlite-sync` | Nightscout entries + treatments → `~/.diabetes-data/diabetes.sqlite`, then rebuilds `daily_stats` / `weekly_stats`. **Sole writer.** | `com.diabetes-sqlite.sync` — every **minute** (`StartInterval=60`) |
| `bin/diabetes-data-mcp.js serve` | Streamable HTTP MCP, bearer token on every request including `/health`. Preferred port **8424**. | `com.diabetes-mcp.server` — KeepAlive |
| `stdio` | Same tools over stdio for Claude Desktop on the Mini. | — |
| `http-proxy <url>` | stdio → HTTP bridge for Claude Desktop on another Mac. Token in `DIABETES_DATA_MCP_TOKEN`. | — |
| `http-token` | Print the Keychain bearer token (creates it on first use). | — |
| `check-config` | Print the resolved DB path, host, and preferred port. Binds nothing. | — |

Ports on the Mini: ResMed 8420, Apple Tools 8421, Network Tools 8422, SimpleFIN 8423, **Diabetes MCP 8424**, **Diabetes Nightscout 8425**. If 8424 is taken, `serve` binds the next free port above it and logs `preferred port 8424 is in use; listening on http://<host>:<port>/mcp`. Point clients at the logged URL.

Requires **Node.js 22.5+** (`node:sqlite`, no native addon) and macOS `/usr/bin/python3` (3.9+) for the sync.

## Conventions

- **Timezone:** America/Chicago. Every `date_*` argument is a local calendar day and every `time_*` is local `HH:MM`. Rows come back with `ts` (ISO UTC) and `local` (Chicago ISO with offset). DST days are 23 or 25 hours.
- **Time in range:** **80–180 mg/dL only** (`tir_80_180`, `under_80` = below 80, `over_180` = above 180, percent of readings). Never 70–180.
- **Weeks:** Sunday–Saturday; `week_ending` is the Saturday.

## Tools (V1, locked)

| Tool | Purpose |
| --- | --- |
| `sync_status` | `last_sync_at` / `last_sync_mode` from `meta`, hours since the last sync (`stale` after 1 h), row counts, earliest/latest SGV and treatments, daily/weekly span, `schema_version`, TIR band. URL/secret-like meta keys are hidden and URLs in values are redacted. |
| `list_sgv` | Readings for `date_from`..`date_to` (≤ 31 days), optional `time_from`/`time_to` slice per day (wraps midnight when from > to), `sample` (every Nth), `order`, `limit` (default 1000, max 10000). `raw_json` only with `include_raw`. |
| `list_treatments` | Treatments for `date_from`..`date_to` (≤ 366 days): `created_at`, `local`, `event_type`, `insulin`, `carbs`, `duration_min`, `rate`, `percent`, `absolute`, `entered_by`, `notes`. Filters: `event_type` (string or list, exact, case-insensitive), `entered_by` substring. `include_raw` for combo-bolus split details. |
| `get_daily_stats` | `daily_stats` rows by `date`, `date_from`/`date_to`, or newest `limit` (default 14). |
| `get_weekly_stats` | `weekly_stats` rows by `week_ending`, a `week_ending` range, or newest `limit` (default 8). Includes `trend_note`. |
| `get_range_stats` | Computed stats for any window: days, optional per-day `time_from`/`time_to`, optional `weekdays`. Returns TIR/under/over, avg, SD, CV, min/max, `sgv_count`, `hours_covered` (distinct 5-minute slots) vs `window_hours`. `include_insulin` adds bolus / temp-basal / carbs totals for treatments in the same slice (temp basal = insulin, else rate × duration, not clipped to the slice; scheduled profile basal is not in the archive). |
| `get_coverage` | Earliest/latest SGV and treatments; per local day in the window (default the whole SGV span) the days with no readings, days under `low_threshold` (default 200; a full day is ~288), days with readings but no `daily_stats` row; optional `include_gaps` with `gap_minutes` (default 30). |
| `query_raw` | One read-only `SELECT` (or `WITH … SELECT`), capped at 1000 rows. Escape hatch. |

`get_range_stats` uses the same formulas as the sync's `daily_stats` (population SD, CV = SD / mean), so a whole-day range matches that day's rollup. The test suite checks this end to end.

Out of scope for V1: live Nightscout, the active profile (I:C, CF, basal schedule), pump settings math, Meals synthesis, profile history.

## Read-only guarantee

The MCP opens SQLite with `readOnly: true` (`SQLITE_OPEN_READONLY`) and `PRAGMA query_only = ON`. Writes fail with `attempt to write a readonly database`. It does not create the file, run migrations, call Nightscout, or touch `com.diabetes-sqlite.sync`.

## Schema (schema_version 1)

Same DDL as the Grok box archive (`sync/sync_from_nightscout.py` `SCHEMA_SQL`).

| Table | Columns |
| --- | --- |
| `meta` | `key` PK, `value` — `schema_version`, `timezone`, `tir_low`=80, `tir_high`=180, `last_sync_at`, `last_sync_mode`, `last_sync_writer`, `path_note`, … |
| `sgv` | `date_ms` PK (UTC ms), `date_string`, `sgv`, `direction`, `device`, `type`, `raw_json` |
| `treatments` | `id` PK, `created_at` (ISO UTC), `timestamp_ms`, `event_type`, `insulin`, `carbs`, `duration_min`, `rate`, `percent`, `absolute`, `entered_by`, `notes`, `raw_json` |
| `daily_stats` | `day` PK (Chicago), `tir_80_180`, `under_80`, `over_180`, `avg_mgdl`, `cv_pct`, `tdd_u`, `bolus_u`, `basal_u`, `sgv_count`, `source`, `updated_at` |
| `weekly_stats` | `week_ending` PK (Saturday), `week_start`, `tir_80_180`, `under_80`, `over_180`, `avg_mgdl`, `cv_pct`, `tdd_u` (mean per day), `sgv_count`, `source`, `trend_note`, `updated_at` |

## Sync

```bash
sync/diabetes-sqlite-sync check    # credentials present? (no network, no DB write)
sync/diabetes-sqlite-sync sync     # entries + treatments + rollups (LaunchAgent default, every minute)
sync/diabetes-sqlite-sync backfill # one-off: full history from Nightscout, dedupe box-era ids, rebuild all rollups
sync/diabetes-sqlite-sync stats    # rebuild daily/weekly rollups only, no network
```

Credentials are never in git, config, or logs:

1. Env `NIGHTSCOUT_URL` + `NIGHTSCOUT_API_SECRET` (one-off runs / tests)
2. macOS Keychain service **`diabetes-sqlite`**, accounts **`nightscout-url`** and **`api-secret`** (the plaintext site API_SECRET; the sync sends its SHA-1 as the `api-secret` header)

Seed the Keychain on the Mini (keep the values out of shell history):

```bash
security add-generic-password -U -s diabetes-sqlite -a nightscout-url -w
security add-generic-password -U -s diabetes-sqlite -a api-secret -w
```

(`-w` last with no value prompts for it.) Missing credentials exit 2 before the database is opened or created. A Nightscout or network error exits 1; nothing from that run is committed. A second run while one is active prints `SKIP: another sync already running` (`flock` on `~/.diabetes-data/sync.lock`). Logs: `~/Library/Logs/diabetes-sqlite.sync.{out,err}.log`.

`StartInterval=60` runs every minute. `TZ=America/Chicago` in the plist sets the sync's own date math.

A routine run asks Nightscout for the newest page of entries and treatments, stops as soon as it overlaps what is already stored, and recomputes `daily_stats` / `weekly_stats` only for the newest few days (`DIABETES_SYNC_RECOMPUTE_DAYS`, default 3). The first run of each local day recomputes everything, so a late edit to an older day is picked up within a day.

### Two databases, on purpose

| | Nightscout's MongoDB | `diabetes.sqlite` |
| --- | --- | --- |
| Role | Live working store; the Dexcom bridge and tconnectsync write to it | Uniform analytics archive the MCP reads |
| Access | `127.0.0.1:27017`, no auth, owned by Nightscout's layout | Read-only to the MCP, Chicago-time days, TIR 80–180 rollups |
| History | Dexcom + pump back to **2021-05-25** (treatments to 2023-01-01) | Everything Mongo has, after a backfill |

The MCP never reads Mongo. `sync` keeps SQLite current each minute. `sync/diabetes-sqlite-sync backfill` walks the whole Nightscout history into SQLite (commits per page, safe to interrupt and rerun), removes box-era rows whose synthesized id now exists under the real Nightscout id (otherwise insulin would double count), and rebuilds every daily/weekly rollup. Rows deleted from Nightscout are not deleted from SQLite (upsert-only).

Mini is the sole Nightscout→SQLite writer. Box `/workspace/diabetes-db` is legacy/fail-closed. The sync reads the Mini's own Nightscout: Keychain `nightscout-url` = `http://127.0.0.1:8425`.

## Nightscout on the Mini

```
Dexcom Share ──(bridge, outbound)──┐
Tandem Source ──(tconnectsync)─────┴─► Nightscout :8425 ─► MongoDB 127.0.0.1:27017
                                            └─► com.diabetes-sqlite.sync ─► SQLite ─► MCP :8424
```

Upstream [cgm-remote-monitor](https://github.com/nightscout/cgm-remote-monitor) 15.0.7, downloaded and pinned, not forked or vendored (AGPL-3.0). **Home network only:** no public URL, port-forward, tunnel, or DNS (`nsrange.mooo.com` retired with `gcns-vm`). Dexcom and Tandem are outbound pulls; nothing on the internet connects in.

Who connects:
- Grok Bot agents: Local Execution on the Mini → `http://127.0.0.1:8425`, like the other Mini services.
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

Runs `tconnectsync --days 1 --features BASAL BOLUS PUMP_EVENTS PROFILES` hourly at :35 against `http://127.0.0.1:8425`. It does not upload CGM; Dexcom comes through the bridge. Pinned to 3.0.3, which already sends `eventCodes` (Tandem rejects the old `eventIds` with HTTP 400). Combo-bolus split fields (`splitNow`/`splitExt`/`duration`) are **not** written by stock tconnectsync.

| Keychain service / account | What |
| --- | --- |
| `diabetes-tconnectsync` / `tconnect-email`, `tconnect-password`, `pump-serial-number` | Tandem Source login and pump |
| `diabetes-sqlite` / `api-secret` | Nightscout secret (shared) |

```bash
sh tconnectsync/install.sh
tconnectsync/diabetes-tconnectsync --pretend          # dry run: reads Tandem + Nightscout, uploads nothing
sh examples/install-launchagents.sh "$(command -v node)" tconnectsync
```

Log: `~/Library/Logs/diabetes-tconnectsync.sync.log`.

### Install / update

```bash
cd ~/code/Diabetes-Data-MCP
sh nightscout/install-runtime.sh "$(command -v node)"                        # Mongo + tools (sha256-pinned), Nightscout tag + npm ci
sh examples/install-launchagents.sh "$(command -v node)" nightscout          # mongod + server agents
sh nightscout/prove.sh                                                       # read-only: bind, 401/200, newest SGV, counts
```

Optional non-secret overrides: `~/.diabetes-data/nightscout/config.env` (see `nightscout/config.env.example`). Upgrading Nightscout = bump `NS_TAG` in `nightscout/install-runtime.sh`, rerun it, kickstart the server; the old version stays under `runtime/` for rollback.

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

## Deploy on the Mini

```bash
git clone https://github.com/sfls1397/Diabetes-Data-MCP.git ~/code/Diabetes-Data-MCP
cd ~/code/Diabetes-Data-MCP
npm install          # runs tsc via prepare
npm run build
sh examples/install-launchagents.sh "$(command -v node)"   # both agents; or add: server | sync
```

LaunchAgents do not load a login shell, so the installer writes the absolute `node` path into `com.diabetes-mcp.server`. Update after a merge:

```bash
cd ~/code/Diabetes-Data-MCP && git pull && npm install && npm run build
launchctl kickstart -k gui/$(id -u)/com.diabetes-mcp.server
```

The sync agent runs the checkout's `sync/` script directly and needs no restart.

Server log: `~/Library/Logs/diabetes-data-mcp.server.log`.

### Keychain bearer token

Service **`diabetes-data-mcp-http`**, account **`http-auth-token`**. `serve` creates it on first start. Print it once on the Mini for client setup:

```bash
node ~/code/Diabetes-Data-MCP/bin/diabetes-data-mcp.js http-token
```

Never paste it into chat, Notion, or logs. Rotate: `security delete-generic-password -s diabetes-data-mcp-http -a http-auth-token`, kickstart the server, update clients. Client setup: `examples/mcp-client.md`.

### Config

Optional `~/.diabetes-data-mcp/config.json` (see `examples/config.json.example`). Env overrides the file; the file overrides defaults.

| Key / env | Default |
| --- | --- |
| `dbPath` / `DIABETES_DATA_MCP_DB_PATH` | `/Users/petercoates/.diabetes-data/diabetes.sqlite` |
| `serverHost` / `DIABETES_DATA_MCP_SERVER_HOST` | `0.0.0.0` |
| `serverPort` / `DIABETES_DATA_MCP_SERVER_PORT` | `8424` (preferred start) |

`DIABETES_DATA_MCP_HOME` relocates the config directory (tests only).

## Develop

```bash
npm install
npm test          # vitest: tools, time math, HTTP auth, and a fake-Nightscout end-to-end sync
npm run typecheck
```
