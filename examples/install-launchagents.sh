#!/bin/sh
# Install or refresh both Diabetes Data LaunchAgents for the current user:
#   com.diabetes-mcp.server   read-only HTTP MCP (KeepAlive, preferred :8424)
#   com.diabetes-sqlite.sync  Nightscout -> SQLite writer (daily 5:15 AM America/Chicago)
# Usage: sh examples/install-launchagents.sh [/absolute/path/to/node] [server|sync|all]
# Secrets stay in Keychain; this script never reads or prints them.
set -eu
DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
REPO=$(CDPATH= cd -- "$DIR/.." && pwd)
NODE=${1:-$(command -v node || true)}
WHICH=${2:-all}
test -x "$NODE" || { echo "Node 22.5+ binary not found; pass its absolute path" >&2; exit 1; }
test -f "$REPO/dist/cli.js" || { echo "Build first: npm install && npm run build" >&2; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

install_one() {
  label=$1
  plist="$HOME/Library/LaunchAgents/$label.plist"
  sed -e "s#REPLACE_NODE#$NODE#g" -e "s#REPLACE_REPO#$REPO#g" -e "s#REPLACE_HOME#$HOME#g" "$DIR/$label.plist" > "$plist.tmp"
  plutil -lint "$plist.tmp" >/dev/null
  mv "$plist.tmp" "$plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "Loaded $label"
}

case "$WHICH" in
  server) install_one com.diabetes-mcp.server ;;
  sync) install_one com.diabetes-sqlite.sync ;;
  all) install_one com.diabetes-mcp.server; install_one com.diabetes-sqlite.sync ;;
  *) echo "second argument must be server, sync, or all" >&2; exit 64 ;;
esac
