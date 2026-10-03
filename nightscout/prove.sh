#!/bin/sh
# Health/prove check for the Diabetes Data Nightscout. Read-only. Never prints secrets:
# the api-secret header (SHA-1 of the Keychain secret) goes to curl on stdin.
# Usage: sh nightscout/prove.sh [base-url]   (default http://127.0.0.1:8425)
# Exit 0 = every check PASS; 1 = something failed.
set -u
HOME_DIR=${DIABETES_NIGHTSCOUT_HOME:-$HOME/.diabetes-data/nightscout}
RT=$HOME_DIR/runtime
BASE=${1:-http://127.0.0.1:8425}
NODE=${NODE_BIN:-$(command -v node || true)}
fail=0
ok()  { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; fail=1; }

H=$(security find-generic-password -s diabetes-sqlite -a api-secret -w 2>/dev/null | tr -d '\n' | shasum -a 1 | cut -d' ' -f1)
[ ${#H} -eq 40 ] || { echo "FAIL  Keychain diabetes-sqlite/api-secret missing"; exit 1; }
authget() { printf 'header = "api-secret: %s"\n' "$H" | curl -sS -m 10 -K - "$@"; }

# Listeners: mongod loopback only; Nightscout on its configured bind.
m=$(lsof -nP -iTCP:27017 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}' | sort -u | tr '\n' ' ')
case "$m" in "127.0.0.1:27017 ") ok "mongod listens on 127.0.0.1:27017 only" ;; *) bad "mongod listeners: '${m:-none}'" ;; esac

code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$BASE/api/v1/status.json")
[ "$code" = 401 ] && ok "unauthenticated status.json -> 401" || bad "unauthenticated status.json -> $code (want 401)"

st=$(authget "$BASE/api/v1/status.json")
echo "$st" | "$NODE" -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);
console.log(`PASS  authenticated status.json: ${j.status} version ${j.version} bridge ${j.settings.enable.includes("bridge")?"ON":"OFF"}`)}
catch(e){console.log("FAIL  authenticated status.json unreadable");process.exit(1)}})' || fail=1

newest=$(authget "$BASE/api/v1/entries.json?count=1")
echo "$newest" | "$NODE" -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s)[0];
const age=Math.round((Date.now()-e.date)/60000);
console.log(`INFO  newest SGV ${e.dateString} ${e.sgv} (${age} min ago)`)})'

# Counts straight from Mongo (Nightscout ships the mongodb driver).
cd "$RT/nightscout" && "$NODE" --no-deprecation -e '
const {MongoClient}=require("mongodb");(async()=>{
const c=await MongoClient.connect("mongodb://127.0.0.1:27017");const db=c.db("Nightscout");
const e=db.collection("entries"),t=db.collection("treatments");
const cut=Date.parse("2026-06-08T00:00:00-05:00");
const first=(await e.find().sort({date:1}).limit(1).toArray())[0];
console.log(`INFO  entries ${await e.countDocuments()} (before 2026-06-08 CT: ${await e.countDocuments({date:{$lt:cut}})}, first ${new Date(first.date).toISOString()})`);
console.log(`INFO  treatments ${await t.countDocuments()}, profile ${await db.collection("profile").countDocuments()}`);
await c.close()})().catch(e=>{console.log("FAIL  mongo: "+e.message);process.exit(1)})' || fail=1

[ $fail -eq 0 ] && echo "RESULT PASS" || echo "RESULT FAIL"
exit $fail
