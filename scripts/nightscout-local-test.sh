#!/bin/sh
# Local-gate run of the Nightscout runtime CI job: exact upstream source with the
# reviewed profile, production audits and the upstream tests on a throwaway
# mongod (own port and data directory). The live database is never used.
set -eu
REPO=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
MONGOD=${DIABETES_LOCAL_GATE_MONGOD:-$HOME/.diabetes-data/nightscout/runtime/mongodb/bin/mongod}
MONGO_PORT=${DIABETES_LOCAL_GATE_MONGO_PORT:-27117}
[ -x "$MONGOD" ] || { echo 'mongod 8.0 missing: run nightscout/install-runtime.sh or set DIABETES_LOCAL_GATE_MONGOD' >&2; exit 1; }
"$MONGOD" --version | head -1 | grep -q ' v8\.0\.' || { echo 'Nightscout tests need mongod 8.0' >&2; exit 1; }
# Upstream tests also bind 1337 directly; refuse rather than collide with anything live.
for port in "$MONGO_PORT" 1337; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $port is already in use" >&2; exit 1; fi
done
unset MONGO_CONNECTION MONGODB_URI MONGO MONGOLAB_URI STORAGE_URI CUSTOMCONNSTR_mongo
WORK=$(mktemp -d)
MONGO_PID=
cleanup() {
  if [ -n "$MONGO_PID" ]; then kill "$MONGO_PID" 2>/dev/null || true; wait "$MONGO_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM
# A stalled GitHub path used to hang this clone for about 650 s and fail the gate. Abort after STALL seconds below 1 KB/s
# and retry a bounded number of times from an empty directory; a clone that never completes still fails the gate.
ATTEMPTS=${DIABETES_DOWNLOAD_ATTEMPTS:-5}
STALL=${DIABETES_DOWNLOAD_STALL_SECONDS:-30}
RETRY_DELAY=${DIABETES_DOWNLOAD_RETRY_DELAY:-5}
CLONE_URL=${DIABETES_LOCAL_GATE_NIGHTSCOUT_URL:-https://github.com/nightscout/cgm-remote-monitor.git}
attempt=1
until git -c http.lowSpeedLimit=1024 -c http.lowSpeedTime="$STALL" clone --quiet --depth 1 --branch v15.0.8 "$CLONE_URL" "$WORK/nightscout"; do
  rm -rf "${WORK:?}/nightscout"
  [ "$attempt" -lt "$ATTEMPTS" ] || { echo "Nightscout clone failed after $attempt attempts" >&2; exit 1; }
  attempt=$((attempt + 1))
  sleep "$RETRY_DELAY"
done
node "$REPO/nightscout/prepare-runtime.mjs" "$WORK/nightscout"
mkdir "$WORK/db"
"$MONGOD" --dbpath "$WORK/db" --bind_ip 127.0.0.1 --port "$MONGO_PORT" --logpath "$WORK/mongod.log" --quiet &
MONGO_PID=$!
tries=0
until lsof -nP -a -p "$MONGO_PID" -iTCP:"$MONGO_PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  tries=$((tries + 1))
  [ "$tries" -le 60 ] || { echo 'Throwaway mongod did not start' >&2; exit 1; }
  sleep 1
done
cd "$WORK/nightscout"
sed "s#^CUSTOMCONNSTR_mongo=mongodb://127\.0\.0\.1:27017/testdb\$#CUSTOMCONNSTR_mongo=mongodb://127.0.0.1:$MONGO_PORT/testdb#" tests/ci.test.env > tests/local.test.env
grep -qx "CUSTOMCONNSTR_mongo=mongodb://127.0.0.1:$MONGO_PORT/testdb" tests/local.test.env || { echo 'Test database rewrite failed' >&2; exit 1; }
if grep -q ':27017' tests/local.test.env; then echo 'Test env still names the live port' >&2; exit 1; fi
npm ci --allow-remote=all --no-audit --no-fund
node "$REPO/nightscout/sanitize-connect.mjs" .
npm audit --omit=dev --audit-level=low
# --retries 1 (local gate only; CI runners are not shared): under gate load an upstream request can fail with a
# localhost ETIMEDOUT that no timeout covers (TEST-CARB-004 sets its own 30 s; PR #24 gate run 1, 5-minute load ~24,
# passed unchanged on the rerun). One retry absorbs that; a test that fails every time still fails the gate. A test that
# passes only on its retry is named on a gate-warning line (scripts/mocha-retry-report.cjs) that the gate shows.
./node_modules/.bin/env-cmd -f tests/local.test.env ./node_modules/.bin/mocha --timeout 30000 --retries 1 --require tests/hooks.js --require "$REPO/scripts/mocha-retry-report.cjs" --exit tests/*.test.js
npm prune --omit=dev --ignore-scripts --no-audit --no-fund
node "$REPO/nightscout/sanitize-connect.mjs" .
npm audit --omit=dev --audit-level=low
echo 'Nightscout runtime local test PASS (v15.0.8, reviewed profile, throwaway mongod)'
