#!/bin/sh
set -eu

MODELS_DIR="${LLAMA_MODELS_DIR:-}"
MODELS_MAX="${LLAMA_MODELS_MAX:-1}"
HOST="${LLAMA_HOST:-127.0.0.1}"
PORT="${LLAMA_PORT:-}"
CTX="${LLAMA_CTX:-16384}"
PARALLEL="${LLAMA_PARALLEL:-1}"
THREADS="${LLAMA_THREADS:-5}"
LOG_DIR="${LLAMA_LOG_DIR:-${TMPDIR:-/tmp}/lumen-llama}"
BIN="${LLAMA_SERVER_BIN:-}"
RESTART="${LUMEN_RESTART:-0}"

if [ -z "$MODELS_DIR" ]; then
  echo "Lumen requires LLAMA_MODELS_DIR for its multi-model router." >&2
  exit 1
fi
if [ -z "$PORT" ]; then
  echo "Lumen requires the detected or configured LLAMA_PORT." >&2
  exit 1
fi
if [ ! -d "$MODELS_DIR" ]; then
  echo "Lumen models directory does not exist: $MODELS_DIR" >&2
  exit 1
fi

if [ -z "$BIN" ]; then
  BIN="$(command -v llama-server 2>/dev/null || true)"
fi
if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
  echo "llama-server is not installed or is not executable. Install llama.cpp and ensure llama-server is on PATH." >&2
  exit 1
fi

mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/llama-server.log"
PID_FILE="${LOG_DIR}/llama-server.pid"

if [ "${LUMEN_DRY_RUN:-0}" = "1" ]; then
  printf '%s\n' "$BIN --models-dir $MODELS_DIR --models-max $MODELS_MAX --models-autoload -ngl 999 -c $CTX -np $PARALLEL --host $HOST --port $PORT"
  exit 0
fi

# Keep an existing router on the detected/configured port. Replace an obsolete
# single-model llama-server so every request can route by its OpenAI `model`.
if curl -sf -m 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  if [ "$RESTART" != "1" ] && curl -sf -m 1 "http://127.0.0.1:${PORT}/props" 2>/dev/null | grep -q '"role"[[:space:]]*:[[:space:]]*"router"'; then
    echo "Lumen multi-model router is already ready on port ${PORT}."
    exit 0
  fi

  OLD_PID=""
  if command -v lsof >/dev/null 2>&1; then
    OLD_PID="$(lsof -nP -t -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
  elif [ -f "$PID_FILE" ]; then
    OLD_PID="$(sed -n '1p' "$PID_FILE" 2>/dev/null || true)"
  fi
  OLD_COMM="$(ps -p "${OLD_PID:-0}" -o comm= 2>/dev/null || true)"
  OLD_NAME="$(basename "${OLD_COMM:-unknown}")"
  if [ -z "$OLD_PID" ] || [ "$OLD_NAME" != "llama-server" ]; then
    echo "Port ${PORT} is occupied by a non-Lumen service; cannot start the multi-model router." >&2
    exit 1
  fi

  echo "Replacing old llama-server pid=${OLD_PID} with Lumen multi-model router."
  kill "$OLD_PID" 2>/dev/null || true
  i=0
  while [ "$i" -lt 40 ]; do
    if ! curl -sf -m 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      break
    fi
    i=$((i + 1))
    sleep 0.25
  done
  if curl -sf -m 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    kill -9 "$OLD_PID" 2>/dev/null || true
  fi
fi

set -- \
  --models-dir "$MODELS_DIR" \
  --models-max "$MODELS_MAX" \
  --models-autoload \
  -ngl 999 \
  -c "$CTX" \
  -np "$PARALLEL" \
  -b 2048 \
  -ub 2048 \
  -t "$THREADS" \
  -fa on \
  -ctk q4_0 \
  -ctv q4_0 \
  --jinja \
  --reasoning-format auto \
  --host "$HOST" \
  --port "$PORT"

nohup "$BIN" "$@" \
  >"$LOG_FILE" 2>&1 &

PID=$!
printf '%s\n' "$PID" >"$PID_FILE"
echo "llama-server pid=${PID} log=${LOG_FILE}"

i=0
while [ "$i" -lt 120 ]; do
  if curl -sf -m 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "llama-server ready on ${HOST}:${PORT}"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "llama-server did not become ready. See ${LOG_FILE}." >&2
exit 1
