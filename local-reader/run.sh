#!/usr/bin/env bash
# Start the local reader on this Mac and open a Cloudflare tunnel to it, then print the reader address
# (never the token: with READER_TOKEN set, the reader reads it from a private temporary file).
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
TOKEN_FILE=""
if [ -n "$TOKEN" ]; then
  TOKEN_FILE="$( umask 077; mktemp )"
  printf '%s\n' "$TOKEN" > "$TOKEN_FILE"
  ARGS+=("--token-file" "$TOKEN_FILE")
fi
SERVER=""; TUNNEL=""
trap 'kill $SERVER 2>/dev/null; kill $TUNNEL 2>/dev/null; [ -n "$TOKEN_FILE" ] && rm -f "$TOKEN_FILE"' EXIT
.venv/bin/python server.py "${ARGS[@]}" "$@" &
SERVER=$!

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

echo
echo "================================================================"
echo "Reader is reachable at:  $URL/api/read-sign"
[ -n "$TOKEN" ] && echo "It answers only with the password in the x-reader-token header."
echo
echo "Ctrl-C stops both the reader and the tunnel. The URL changes each run (quick tunnel)."
echo "================================================================"
wait $SERVER
