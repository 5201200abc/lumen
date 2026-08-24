#!/bin/sh
set -eu

MODEL="${LLAMA_MODEL:-}"
HOST="${LLAMA_HOST:-127.0.0.1}"
PORT="${LLAMA_PORT:-18082}"
CTX="${LLAMA_CTX:-16384}"
ALIAS="${LLAMA_ALIAS:-Lumen-local}"
PARALLEL="${LLAMA_PARALLEL:-1}"
THREADS="${LLAMA_THREADS:-5}"
LOG_DIR="${LLAMA_LOG_DIR:-${TMPDIR:-/tmp}/lumen-llama}"
BIN="${LLAMA_SERVER_BIN:-}"

if [ -z "$MODEL" ] || [ ! -f "$MODEL" ]; then
  echo "Lumen could not find a GGUF model. Set LLAMA_MODEL or choose a models directory in Settings." >&2
  exit 1
fi

if [ -z "$BIN" ]; then
  BIN="$(command -v llama-server 2>/dev/null || true)"
fi
if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
  echo "llama-server is not installed or is not executable. Install llama.cpp and ensure llama-server is on PATH." >&2
  exit 1
fi

# Never replace or stop a service that is already using Lumen's port.
if curl -sf -m 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "A compatible llama-server is already ready on port ${PORT}; leaving it running."
  exit 0
fi

mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/llama-server.log"
PID_FILE="${LOG_DIR}/llama-server.pid"

if [ "${LUMEN_DRY_RUN:-0}" = "1" ]; then
  printf '%s\n' "$BIN -m $MODEL -a $ALIAS -ngl 999 -c $CTX -np $PARALLEL --host $HOST --port $PORT"
  exit 0
fi

nohup "$BIN" \
  -m "$MODEL" \
  -a "$ALIAS" \
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
  --port "$PORT" \
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
