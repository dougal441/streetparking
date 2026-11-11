#!/usr/bin/env bash
# Make the local reader permanent on this Mac: a launchd service that is always running (model loads on
# first photo, unloads after 10 idle minutes), published at a FIXED address through Tailscale so the site's
# Worker can reach it from anywhere. Run once:   ./install-service.sh
# Undo:                                   ./uninstall-service.sh
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd)"
PORT="${PORT:-8765}"
LABEL="com.dougal.caniparkhere-reader"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE="$HERE/state"; mkdir -p "$STATE"
# Logs live outside ~/Documents: launchd cannot open files in a privacy-protected folder (the job fails
# before it starts with "78: EX_CONFIG"), so they go in ~/Library/Logs, private to this account.
LOGS="$HOME/Library/Logs/caniparkhere-reader"; mkdir -p "$LOGS"; chmod 700 "$LOGS"

command -v tailscale >/dev/null || { echo "tailscale command not found. Install the Tailscale app (it includes the command line tool), then run again." >&2; exit 1; }
[ -x .venv/bin/python ] || { echo "creating .venv and installing packages (one-off)…" >&2; python3 -m venv .venv; .venv/bin/pip install -q -r requirements.txt; }

# One secret, kept only in state/token (not in git, mode 600). The service settings name the file, never the
# value, and no link carries it: the site Worker is the only client and sends it in the x-reader-token header.
if [ ! -s "$STATE/token" ]; then
  ( umask 077; .venv/bin/python -c 'import secrets;print(secrets.token_urlsafe(24))' > "$STATE/token" )
fi
chmod 600 "$STATE/token"

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$HERE/.venv/bin/python</string><string>$HERE/server.py</string>
    <string>--host</string><string>127.0.0.1</string><string>--port</string><string>$PORT</string>
    <string>--token-file</string><string>$STATE/token</string><string>--idle-minutes</string><string>10</string><string>--no-upload</string>
  </array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string><key>HF_HUB_OFFLINE</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGS/reader.stdout.log</string>
  <key>StandardErrorPath</key><string>$LOGS/reader.stderr.log</string>
</dict></plist>
PL
# The logs are private to this account (mode 600), made before launchd opens them.
for f in "$LOGS/reader.stdout.log" "$LOGS/reader.stderr.log"; do
  [ -e "$f" ] || install -m 600 /dev/null "$f"
  chmod 600 "$f"
done
# Re-runs: stop the old service and wait until launchd has really let go of it before loading again
# (loading too soon gives "Bootstrap failed: 5: Input/output error").
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 30); do launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
fi
launchctl bootstrap "gui/$(id -u)" "$PLIST" || { sleep 2; launchctl bootstrap "gui/$(id -u)" "$PLIST"; }
sleep 2
curl -sf "http://127.0.0.1:$PORT/api/read-sign" >/dev/null && echo "reader running on port $PORT" || { echo "reader did not start; see $LOGS/reader.stderr.log" >&2; exit 1; }

# Publish through Tailscale on this Mac's fixed name, under /streetparking (life's /mail-capture stays as is).
# funnel = reachable from the public internet (phone needs no Tailscale app); serve = your tailnet only.
MODE="${TS_MODE:-funnel}"
tailscale "$MODE" --bg --set-path /streetparking "http://127.0.0.1:$PORT" >/dev/null
HOST="$(tailscale status --json | .venv/bin/python -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
# No phone link any more: an old one is deleted, and nothing printed here carries the token.
rm -f "$STATE/phone-link.txt"
echo
echo "================================================================"
echo "Fixed reader address:  https://$HOST/streetparking/api/read-sign"
echo "The site's Worker is the only client; it sends the password in a header."
echo
echo "The reader now starts with your Mac and restarts if it dies. It answers while the Mac is awake."
echo "Mode: $MODE  ($( [ "$MODE" = funnel ] && echo 'public address, protected by the token' || echo 'tailnet only: phone needs the Tailscale app signed in' ))"
echo "================================================================"
