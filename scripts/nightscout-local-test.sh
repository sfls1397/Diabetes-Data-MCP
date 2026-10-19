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
git clone --quiet --depth 1 --branch v15.0.8 https://github.com/nightscout/cgm-remote-monitor.git "$WORK/nightscout"
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
./node_modules/.bin/env-cmd -f tests/local.test.env ./node_modules/.bin/mocha --timeout 30000 --require tests/hooks.js --exit tests/*.test.js
npm prune --omit=dev --ignore-scripts --no-audit --no-fund
node "$REPO/nightscout/sanitize-connect.mjs" .
npm audit --omit=dev --audit-level=low
echo 'Nightscout runtime local test PASS (v15.0.8, reviewed profile, throwaway mongod)'
