#!/bin/sh
# Install or refresh the pinned runtime under ~/.diabetes-data/nightscout/runtime:
#   MongoDB Community server (macOS arm64)   -> runtime/mongodb
#   MongoDB Database Tools (mongodump/restore) -> runtime/mongotools
#   Nightscout cgm-remote-monitor (git tag)  -> runtime/nightscout  (npm ci)
# Downloads are verified against pinned sha256 values before unpacking.
# Usage: sh nightscout/install-runtime.sh [/absolute/path/to/node]
# Never reads or prints secrets.
set -eu
umask 077
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

MONGO_VERSION=8.0.32
MONGO_SHA256=f81cb258434d548dca7244d599c82eb339043d8dedd0b1b807870c9d263117f2
TOOLS_VERSION=100.19.1
TOOLS_SHA256=54643d4aedb79ddc81797d6fb54113acf79f77fd82a5868b6674f6c74e1b3000
NS_TAG=v15.0.8
NS_COMMIT=92d0834219aa771b5837dbcbf1baeb839a200cf6
NS_REPO=https://github.com/nightscout/cgm-remote-monitor.git

NODE=${1:-$(command -v node || true)}
test -x "$NODE" || { echo "Node 20+ binary not found; pass its absolute path" >&2; exit 1; }
NODE_DIR=$(dirname "$NODE")

HOME_DIR=${DIABETES_NIGHTSCOUT_HOME:-$HOME/.diabetes-data/nightscout}
RT=$HOME_DIR/runtime
DL=$RT/downloads
mkdir -p "$DL"

fetch() { # url file sha256
  if [ -f "$DL/$2" ] && echo "$3  $DL/$2" | shasum -a 256 -c - >/dev/null 2>&1; then
    echo "cached $2"
  else
    curl -fsSL "$1" -o "$DL/$2.tmp"
    echo "$3  $DL/$2.tmp" | shasum -a 256 -c - >/dev/null || { echo "sha256 mismatch: $2" >&2; rm -f "$DL/$2.tmp"; exit 1; }
    mv "$DL/$2.tmp" "$DL/$2"
    echo "downloaded $2 (sha256 OK)"
  fi
}

MONGO_TGZ=mongodb-macos-arm64-$MONGO_VERSION.tgz
TOOLS_ZIP=mongodb-database-tools-macos-arm64-$TOOLS_VERSION.zip
fetch "https://fastdl.mongodb.org/osx/$MONGO_TGZ" "$MONGO_TGZ" "$MONGO_SHA256"
fetch "https://fastdl.mongodb.org/tools/db/$TOOLS_ZIP" "$TOOLS_ZIP" "$TOOLS_SHA256"

if [ ! -x "$RT/mongodb-$MONGO_VERSION/bin/mongod" ]; then
  tmp=$(mktemp -d "$RT/.mongo.XXXXXX")
  tar xzf "$DL/$MONGO_TGZ" -C "$tmp"
  mv "$tmp"/*/ "$RT/mongodb-$MONGO_VERSION"   # tarball dir is named mongodb-macos-aarch64--<ver>
  rmdir "$tmp"
fi
if [ ! -x "$RT/mongotools-$TOOLS_VERSION/bin/mongorestore" ]; then
  tmp=$(mktemp -d "$RT/.tools.XXXXXX")
  unzip -q "$DL/$TOOLS_ZIP" -d "$tmp"
  mv "$tmp"/*/ "$RT/mongotools-$TOOLS_VERSION"
  rmdir "$tmp"
fi
ln -sfn "mongodb-$MONGO_VERSION" "$RT/mongodb"
ln -sfn "mongotools-$TOOLS_VERSION" "$RT/mongotools"

# The profile hash selects an immutable prepared runtime. An incomplete or failed
# build never replaces the current runtime, and a future profile cannot reuse it.
PROFILE_SHA=$({ cat "$SCRIPT_DIR"/runtime-profile/* "$SCRIPT_DIR"/compat/* "$SCRIPT_DIR/prepare-runtime.mjs" "$SCRIPT_DIR/sanitize-connect.mjs"; } | shasum -a 256 | cut -d' ' -f1)
NS_NAME=nightscout-${NS_TAG#v}-$PROFILE_SHA
NS_DIR=$RT/$NS_NAME
if [ ! -f "$NS_DIR/.diabetes-runtime-ready" ]; then
  tmp=$(mktemp -d "$RT/.nightscout.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT HUP INT TERM
  git -c advice.detachedHead=false clone -q --depth 1 --branch "$NS_TAG" "$NS_REPO" "$tmp/source"
  test "$(git -C "$tmp/source" rev-parse HEAD)" = "$NS_COMMIT" || { echo "Nightscout commit mismatch" >&2; exit 1; }
  "$NODE" "$SCRIPT_DIR/prepare-runtime.mjs" "$tmp/source"
  (cd "$tmp/source" && PATH="$NODE_DIR:$PATH" npm ci --allow-remote=all --no-audit --no-fund --loglevel=error &&
    PATH="$NODE_DIR:$PATH" npm audit --omit=dev --audit-level=high &&
    PATH="$NODE_DIR:$PATH" npm prune --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error &&
    "$NODE" "$SCRIPT_DIR/sanitize-connect.mjs" "$tmp/source")
  printf '%s\n' "$PROFILE_SHA" > "$tmp/source/.diabetes-runtime-ready"
  mv "$tmp/source" "$NS_DIR"
  rmdir "$tmp"
  trap - EXIT HUP INT TERM
fi
test "$(cat "$NS_DIR/.diabetes-runtime-ready")" = "$PROFILE_SHA" || { echo "Nightscout runtime marker mismatch" >&2; exit 1; }
(cd "$NS_DIR" && PATH="$NODE_DIR:$PATH" npm audit --omit=dev --audit-level=high)
ln -sfn "$NS_NAME" "$RT/nightscout"

echo "mongod:       $("$RT/mongodb/bin/mongod" --version | head -1)"
echo "mongorestore: $("$RT/mongotools/bin/mongorestore" --version | head -1)"
echo "nightscout:   $(PATH="$NODE_DIR:$PATH" node -p "require('$RT/nightscout/package.json').version") ($NS_TAG)"
