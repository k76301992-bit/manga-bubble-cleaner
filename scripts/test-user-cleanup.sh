#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
input_image="$project_dir/assets/test-input/tiles/tile_009_x000000_y004715.png"
output_json="$project_dir/assets/test-input/user-cleanup-response.json"
payload_json="$project_dir/assets/test-input/user-cleanup-payload.json"

printf '{"0":{"json":{"imageDataUrl":"data:image/png;base64,' > "$payload_json"
base64 -w 0 "$input_image" >> "$payload_json"
printf '","fileName":"user-dialogue-bubble-test.png","quality":"maximum-detail","width":900,"height":675}}}' >> "$payload_json"

curl --fail --silent --show-error \
  --request POST "http://127.0.0.1:3000/api/trpc/image.cleanMangaBubbles?batch=1" \
  --header "content-type: application/json" \
  --data-binary "@$payload_json" \
  --output "$output_json"

cat "$output_json"
