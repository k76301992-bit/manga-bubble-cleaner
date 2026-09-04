#!/bin/sh
set -eu

INFERENCE_HOST="${INFERENCE_HOST:-127.0.0.1}"
INFERENCE_PORT="${INFERENCE_PORT:-8090}"
STARTUP_TIMEOUT="${INFERENCE_STARTUP_TIMEOUT_SEC:-180}"
RESTART_DELAY="${INFERENCE_RESTART_DELAY_SEC:-3}"
supervisor_pid=""

health_is_ready() {
  response="$(curl -fsS --max-time 2 "http://${INFERENCE_HOST}:${INFERENCE_PORT}/health" 2>/dev/null || true)"
  printf '%s' "$response" | grep -q '"ok":true'
}

# The sidecar previously ran as a one-shot background child: the first crash
# took Big-LaMa down for the rest of the container's life (production log
# 2026-09-01..09-04 shows days of "fetch failed" inpainting failures after a
# single silent exit). This tiny supervisor loop restarts it instead. TERM/INT
# are forwarded to the active python child so container shutdown stays clean.
run_inference_supervisor() {
  child=""
  terminate() { [ -z "$child" ] || kill "$child" 2>/dev/null || true; exit 0; }
  trap terminate TERM INT
  while :; do
    code=0
    INFERENCE_HOST="$INFERENCE_HOST" INFERENCE_PORT="$INFERENCE_PORT" \
      TEXT_DETECTOR_ENABLED="${TEXT_DETECTOR_ENABLED:-true}" \
      python3 server/inference-service/app.py & child=$!
    wait "$child" || code=$?
    child=""
    echo "[standalone-api] inference sidecar exited (code=${code}) — restarting in ${RESTART_DELAY}s" >&2
    sleep "$RESTART_DELAY"
  done
}

if ! health_is_ready; then
  run_inference_supervisor &
  supervisor_pid=$!
fi

elapsed=0
while ! health_is_ready; do
  if [ -n "$supervisor_pid" ] && ! kill -0 "$supervisor_pid" 2>/dev/null; then
    echo "[standalone-api] inference supervisor exited before becoming ready" >&2
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
cleanup() { [ -z "$supervisor_pid" ] || kill "$supervisor_pid" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
NODE_ENV=production node --expose-gc dist/index.mjs
