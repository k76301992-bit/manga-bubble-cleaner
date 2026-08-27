#!/bin/sh
set -eu
INFERENCE_HOST=127.0.0.1
INFERENCE_PORT="${INFERENCE_PORT:-8090}"
inference_pid=""
if ! curl -fsS --max-time 1 "http://${INFERENCE_HOST}:${INFERENCE_PORT}/health" >/dev/null 2>&1; then
  INFERENCE_HOST="$INFERENCE_HOST" INFERENCE_PORT="$INFERENCE_PORT" python3 server/inference-service/app.py &
  inference_pid=$!
fi
cleanup() { [ -z "$inference_pid" ] || kill "$inference_pid" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
NODE_ENV=production node --expose-gc dist/index.mjs
