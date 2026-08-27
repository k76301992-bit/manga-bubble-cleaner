#!/bin/sh
set -eu
INFERENCE_HOST=127.0.0.1 INFERENCE_PORT="${INFERENCE_PORT:-8090}" python3 server/inference-service/app.py &
inference_pid=$!
cleanup() { kill "$inference_pid" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
NODE_ENV=production node --expose-gc dist/index.mjs
