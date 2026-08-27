#!/bin/sh
set -eu

host="${INFERENCE_HOST:-127.0.0.1}"
port="${INFERENCE_PORT:-8090}"
url="http://${host}:${port}/health"

# tsx can be force-killed during a file reload while its Python child is still
# releasing the port. Keep this worker alive and reuse a healthy instance
# rather than making concurrently terminate the API and Discord bot.
while curl -fsS --max-time 1 "$url" >/dev/null 2>&1; do
  echo "[inference] using the existing healthy service on ${host}:${port}"
  sleep 5
done

exec env INFERENCE_HOST="$host" INFERENCE_PORT="$port" python3 server/inference-service/app.py
