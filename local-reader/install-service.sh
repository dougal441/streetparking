#!/usr/bin/env bash
# Make the local reader permanent on this Mac: a launchd service that is always running (model loads on
# first photo, unloads after 10 idle minutes), published at a FIXED address through Tailscale so the phone
# can reach it from anywhere. Run once:   ./install-service.sh
# Undo:                                   ./uninstall-service.sh
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd)"
PORT="${PORT:-8765}"
LABEL="com.dougal.caniparkhere-reader"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE="$HERE/state"; mkdir -p "$STATE" logs

command -v tailscale >/dev/null || { echo "tailscale command not found. Install the Tailscale app (it includes the command line tool), then run again." >&2; exit 1; }
[ -x .venv/bin/python ] || { echo "creating .venv and installing packages (one-off)…" >&2; python3 -m venv .venv; .venv/bin/pip install -q -r requirements.txt; }

# One secret, kept here (not in git). The phone link carries it; without it the reader answers 401.
if [ ! -s "$STATE/token" ]; then .venv/bin/python -c 'import secrets;print(secrets.token_urlsafe(24))' > "$STATE/token"; fi
TOKEN="$(cat "$STATE/token")"

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$HERE/.venv/bin/python</string><string>$HERE/server.py</string>
    <string>--host</string><string>127.0.0.1</string><string>--port</string><string>$PORT</string>
    <string>--token</string><string>$TOKEN</string><string>--idle-minutes</string><string>10</string>
  </array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string><key>HF_HUB_OFFLINE</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HERE/logs/reader.stdout.log</string>
  <key>StandardErrorPath</key><string>$HERE/logs/reader.stderr.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 2
curl -sf "http://127.0.0.1:$PORT/api/read-sign" >/dev/null && echo "reader running on port $PORT" || { echo "reader did not start; see logs/reader.stderr.log" >&2; exit 1; }

# Publish through Tailscale on this Mac's fixed name, under /streetparking (life's /mail-capture stays as is).
# funnel = reachable from the public internet (phone needs no Tailscale app); serve = your tailnet only.
MODE="${TS_MODE:-funnel}"
tailscale "$MODE" --bg --set-path /streetparking "http://127.0.0.1:$PORT" >/dev/null
HOST="$(tailscale status --json | .venv/bin/python -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
READER="https://$HOST/streetparking/api/read-sign?token=$TOKEN"
LINK="https://dougal441.github.io/streetparking/web/?reader=$READER"
echo "$LINK" > "$STATE/phone-link.txt"
echo
echo "================================================================"
echo "Fixed reader address:  https://$HOST/streetparking/api/read-sign"
echo
echo "BOOKMARK THIS ON YOUR PHONE (add to Home Screen):"
echo "  $LINK"
echo "(also saved to $STATE/phone-link.txt)"
echo
echo "The reader now starts with your Mac and restarts if it dies. It answers while the Mac is awake."
echo "Mode: $MODE  ($( [ "$MODE" = funnel ] && echo 'public address, protected by the token' || echo 'tailnet only: phone needs the Tailscale app signed in' ))"
echo "================================================================"
