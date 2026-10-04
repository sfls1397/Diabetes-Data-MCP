#!/bin/sh
# Install or refresh tconnectsync (pinned) in ~/.diabetes-data/tconnectsync/venv
# using macOS /usr/bin/python3. Never reads or prints secrets.
# Usage: sh tconnectsync/install.sh
set -eu
VERSION=3.0.3   # includes the Tandem pump-logs eventCodes fix (eventIds -> HTTP 400); combo mapping is written for exactly this version
HOME_DIR=${DIABETES_TCONNECTSYNC_HOME:-$HOME/.diabetes-data/tconnectsync}
mkdir -p "$HOME_DIR"
[ -x "$HOME_DIR/venv/bin/python" ] || /usr/bin/python3 -m venv "$HOME_DIR/venv"
PYTHONWARNINGS=ignore "$HOME_DIR/venv/bin/pip" install -q --upgrade pip
PYTHONWARNINGS=ignore "$HOME_DIR/venv/bin/pip" install -q "tconnectsync==$VERSION"
PYTHONWARNINGS=ignore "$HOME_DIR/venv/bin/python" -c 'import importlib.metadata as m; print("tconnectsync", m.version("tconnectsync"))'
DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
PYTHONWARNINGS=ignore "$HOME_DIR/venv/bin/python" "$DIR/diabetes_tconnectsync.py" --combo-selftest
