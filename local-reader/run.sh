#!/usr/bin/env bash
# Start the local reader on this Mac and open a Cloudflare tunnel to it, then print the phone link.
#   ./run.sh            real model (first run installs the Python packages into ./.venv)
#   ./run.sh --fake     canned answers, no model — proves the tunnel and the app end to end
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8765}"
TOKEN="${READER_TOKEN:-}"

if ! command -v cloudflared >/dev/null; then
  echo "cloudflared missing. Install:  brew install cloudflared" >&2; exit 1
fi
if [ ! -x .venv/bin/python ]; then
  echo "creating .venv and installing packages (one-off, a few minutes)…" >&2
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
# Reuse life's already-downloaded weights: same model id, same Hugging Face cache, nothing to download.

ARGS=("--port" "$PORT")
[ -n "$TOKEN" ] && ARGS+=("--token" "$TOKEN")
.venv/bin/python server.py "${ARGS[@]}" "$@" &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; kill $TUNNEL 2>/dev/null' EXIT

LOG="$(mktemp)"
cloudflared tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate >"$LOG" 2>&1 &
TUNNEL=$!
URL=""
for _ in $(seq 1 60); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 1
done
if [ -z "$URL" ]; then echo "tunnel did not start; see $LOG" >&2; exit 1; fi

READER="$URL/api/read-sign"
[ -n "$TOKEN" ] && READER="$READER?token=$TOKEN"
echo
echo "================================================================"
echo "Reader is reachable at:  $READER"
echo
echo "Open this on your phone ONCE (it remembers):"
echo "  https://dougal441.github.io/streetparking/web/?reader=$READER"
echo
echo "Or point the Cloudflare Worker at it:  READER_BACKEND=local, LOCAL_READER_URL=$URL"
echo "Ctrl-C stops both the reader and the tunnel. The URL changes each run (quick tunnel)."
echo "================================================================"
wait $SERVER
