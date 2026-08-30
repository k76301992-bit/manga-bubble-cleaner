#!/bin/sh
set -eu

INFERENCE_HOST="${INFERENCE_HOST:-127.0.0.1}"
INFERENCE_PORT="${INFERENCE_PORT:-8090}"
STARTUP_TIMEOUT="${INFERENCE_STARTUP_TIMEOUT_SEC:-180}"
inference_pid=""

health_is_ready() {
  response="$(curl -fsS --max-time 2 "http://${INFERENCE_HOST}:${INFERENCE_PORT}/health" 2>/dev/null || true)"
  printf '%s' "$response" | grep -q '"ok":true'
}

if ! health_is_ready; then
  INFERENCE_HOST="$INFERENCE_HOST" INFERENCE_PORT="$INFERENCE_PORT" \
    TEXT_DETECTOR_ENABLED="${TEXT_DETECTOR_ENABLED:-true}" \
    python3 server/inference-service/app.py &
  inference_pid=$!
fi

elapsed=0
while ! health_is_ready; do
  if [ -n "$inference_pid" ] && ! kill -0 "$inference_pid" 2>/dev/null; then
    echo "[standalone-api] inference service exited before becoming ready" >&2
    exit 1
  fi
  if [ "$elapsed" -ge "$STARTUP_TIMEOUT" ]; then
    echo "[standalone-api] inference service did not become ready within ${STARTUP_TIMEOUT}s" >&2
    exit 1
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

echo "[standalone-api] inference service ready after ${elapsed}s"
cleanup() { [ -z "$inference_pid" ] || kill "$inference_pid" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
NODE_ENV=production node --expose-gc dist/index.mjs
