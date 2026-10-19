#!/bin/sh
# Local-gate run of the Python runtime CI job: install the locked tconnectsync
# graph twice into a throwaway home and verify it. The live runtime is never used.
set -eu
REPO=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM
DIABETES_TCONNECTSYNC_HOME="$WORK/tconnectsync"
export DIABETES_TCONNECTSYNC_HOME
unset DIABETES_TCONNECTSYNC_PYTHON
sh "$REPO/tconnectsync/install.sh"
sh "$REPO/tconnectsync/install.sh"
"$DIABETES_TCONNECTSYNC_HOME/venv/bin/python" "$REPO/tconnectsync/test_runtime.py"
echo 'tconnectsync runtime local test PASS (throwaway home)'
