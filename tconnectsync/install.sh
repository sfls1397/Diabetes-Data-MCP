#!/bin/sh
# Prepare an immutable, audited environment before switching venv.
# Previous runtimes remain available for rollback. No credentials are read.
set -eu
umask 077
DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
HOME_DIR=${DIABETES_TCONNECTSYNC_HOME:-$HOME/.diabetes-data/tconnectsync}
mkdir -p "$HOME_DIR/runtime" "$HOME_DIR/downloads"
chmod 700 "$HOME_DIR" "$HOME_DIR/runtime" "$HOME_DIR/downloads"

field() { /usr/bin/python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d[sys.argv[2]][sys.argv[3]])' "$DIR/runtime-profile.json" "$1" "$2"; }
fetch() {
  url=$1 file=$2 checksum=$3
  if [ ! -f "$file" ] || ! printf '%s  %s\n' "$checksum" "$file" | shasum -a 256 -c - >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --tlsv1.2 "$url" -o "$file.tmp"
    printf '%s  %s\n' "$checksum" "$file.tmp" | shasum -a 256 -c - >/dev/null
    mv "$file.tmp" "$file"
  fi
}

PYTHON=${DIABETES_TCONNECTSYNC_PYTHON:-}
EXPECTED_PYTHON=$(field python version)
if [ -z "$PYTHON" ]; then
  [ "$(uname -s)/$(uname -m)" = Darwin/arm64 ] || { echo 'Pass a supported Python 3.13 interpreter on other platforms' >&2; exit 1; }
  PYTHON_NAME=$(field python name)
  PYTHON_ARCHIVE=$HOME_DIR/downloads/$PYTHON_NAME
  fetch "$(field python url)" "$PYTHON_ARCHIVE" "$(field python sha256)"
  PYTHON_DIR=$HOME_DIR/runtime/python-$(field python sha256)
  if [ ! -x "$PYTHON_DIR/python/bin/python3" ]; then
    python_tmp=$(mktemp -d "$HOME_DIR/runtime/.python.XXXXXX")
    tar xzf "$PYTHON_ARCHIVE" -C "$python_tmp"
    "$python_tmp/python/bin/python3" -c 'import ssl,sys; assert sys.version.split()[0] == sys.argv[1]' "$EXPECTED_PYTHON"
    mv "$python_tmp" "$PYTHON_DIR"
  fi
  PYTHON=$PYTHON_DIR/python/bin/python3
fi
"$PYTHON" -c 'import ssl,sys; assert sys.version.split()[0] == sys.argv[1]' "$EXPECTED_PYTHON"

PROFILE_SHA=$({ cat "$DIR/runtime-profile.json" "$DIR/requirements.lock" "$DIR/prepare-wheel.py" "$DIR/audit.py" "$DIR/install.sh"; } | shasum -a 256 | cut -d' ' -f1)
TARGET=$HOME_DIR/runtime/tconnectsync-$PROFILE_SHA
WHEEL=$(field wheel filename)
fetch "$(field wheel url)" "$HOME_DIR/downloads/$WHEEL" "$(field wheel sha256)"
if [ ! -f "$TARGET/.diabetes-runtime-ready" ]; then
  mkdir -p "$TARGET"
  "$PYTHON" -m venv "$TARGET/venv"
  # Venv executables contain absolute paths; build at the final inactive path.
  "$PYTHON" "$DIR/prepare-wheel.py" "$HOME_DIR/downloads/$WHEEL" "$TARGET/wheels/$WHEEL" "$DIR/runtime-profile.json"
  "$TARGET/venv/bin/python" -m pip install --disable-pip-version-check --require-hashes -r "$DIR/requirements.lock"
  "$TARGET/venv/bin/python" -m pip install --disable-pip-version-check --no-deps --no-index "$TARGET/wheels/$WHEEL"
  "$TARGET/venv/bin/python" -m pip check
  "$TARGET/venv/bin/python" "$DIR/audit.py" --installed
  "$TARGET/venv/bin/python" "$DIR/diabetes_tconnectsync.py" --combo-selftest
  printf '%s\n' "$PROFILE_SHA" > "$TARGET/.diabetes-runtime-ready"
fi
test "$(cat "$TARGET/.diabetes-runtime-ready")" = "$PROFILE_SHA"
"$TARGET/venv/bin/python" -m pip check
"$TARGET/venv/bin/python" "$DIR/audit.py" --installed
"$TARGET/venv/bin/python" "$DIR/diabetes_tconnectsync.py" --combo-selftest

if [ -d "$HOME_DIR/venv" ] && [ ! -L "$HOME_DIR/venv" ]; then
  mv "$HOME_DIR/venv" "$HOME_DIR/runtime/legacy-venv-$(date +%s)"
fi
ln -s "$TARGET/venv" "$HOME_DIR/.venv-$PROFILE_SHA"
# rename(2) replaces a symlink itself, rather than following it as mv may do.
/usr/bin/python3 -c 'import os,sys; os.replace(sys.argv[1],sys.argv[2])' "$HOME_DIR/.venv-$PROFILE_SHA" "$HOME_DIR/venv"
echo 'tconnectsync 3.0.3: verified Python profile active'
