#!/bin/sh
set -eu

PORT="${LLAMA_PORT:-}"

if [ -z "$PORT" ]; then
  echo "Lumen requires the detected or configured LLAMA_PORT." >&2
  exit 1
fi

PID="$(lsof -nP -t -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
if [ -z "$PID" ]; then
  echo "No listener on port ${PORT}."
  exit 0
fi

COMM="$(ps -p "$PID" -o comm= 2>/dev/null || true)"
if [ "$(basename "${COMM:-unknown}")" != "llama-server" ]; then
  echo "Refusing to stop non-llama listener pid=${PID} on port ${PORT}." >&2
  exit 1
fi

kill "$PID"
echo "Stopped llama-server pid=${PID} on port ${PORT}."
