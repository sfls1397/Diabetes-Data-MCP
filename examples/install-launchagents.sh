#!/bin/sh
set -eu
DIR=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
REPO=$(CDPATH='' cd -- "$DIR/.." && pwd)
NODE=${1:-$(command -v node || true)}
WHICH=${2:-all}
test -x "$NODE" || { echo "Node 22.5+ binary not found; pass its absolute path" >&2; exit 1; }
case "$WHICH" in
  tconnectsync) test -x "$HOME/.diabetes-data/tconnectsync/venv/bin/tconnectsync" || { echo "Run tconnectsync/install.sh first" >&2; exit 1; } ;;
  nightscout) test -x "$HOME/.diabetes-data/nightscout/runtime/mongodb/bin/mongod" || { echo "Run nightscout/install-runtime.sh first" >&2; exit 1; }
    mkdir -p "$HOME/.diabetes-data/nightscout/mongo" ;;
  *) test -f "$REPO/dist/cli.js" || { echo "Build first: npm install && npm run build" >&2; exit 1; } ;;
esac
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

install_one() {
  label=$1
  plist="$HOME/Library/LaunchAgents/$label.plist"
  sed -e "s#REPLACE_NODE#$NODE#g" -e "s#REPLACE_REPO#$REPO#g" -e "s#REPLACE_HOME#$HOME#g" "$DIR/$label.plist" > "$plist.tmp"
  plutil -lint "$plist.tmp" >/dev/null
  if [ -f "$plist" ] && cmp -s "$plist.tmp" "$plist" && launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
    rm -f "$plist.tmp"
    if [ "$(plutil -extract KeepAlive raw -o - "$plist" 2>/dev/null)" = true ] || [ "$(plutil -extract RunAtLoad raw -o - "$plist" 2>/dev/null)" = true ]; then
      launchctl kickstart -k "gui/$(id -u)/$label"
      echo "Restarted $label (plist unchanged)"
    else
      echo "Left $label as is (plist unchanged; runs new code on its next scheduled run)"
    fi
    return 0
  fi
  mv "$plist.tmp" "$plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  i=0
  while launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 && [ $i -lt 30 ]; do sleep 1; i=$((i + 1)); done
  i=0
  until launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null; do
    i=$((i + 1))
    [ $i -ge 5 ] && { echo "bootstrap failed for $label" >&2; exit 1; }
    sleep 2
  done
  echo "Loaded $label"
}

case "$WHICH" in
  server) install_one com.diabetes-mcp.server ;;
  sync) install_one com.diabetes-sqlite.sync ;;
  nightscout) install_one com.diabetes-nightscout.mongod; install_one com.diabetes-nightscout.server ;;
  tconnectsync) install_one com.diabetes-tconnectsync.sync ;;
  all) install_one com.diabetes-mcp.server; install_one com.diabetes-sqlite.sync ;;
  *) echo "second argument must be server, sync, nightscout, tconnectsync, or all" >&2; exit 64 ;;
esac
