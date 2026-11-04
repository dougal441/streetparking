#!/usr/bin/env bash
# Stop and remove the always-on reader and its Tailscale path. Keeps the .venv and the token file.
set -uo pipefail
cd "$(dirname "$0")"
LABEL="com.dougal.caniparkhere-reader"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "stopped $LABEL"
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
tailscale funnel --set-path /streetparking off 2>/dev/null || tailscale serve --set-path /streetparking off 2>/dev/null || true
echo "removed. Other Tailscale paths (life's /mail-capture) untouched."
