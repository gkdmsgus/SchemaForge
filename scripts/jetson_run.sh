#!/usr/bin/env bash
# SchemaForge on the Jetson: build the image from this checkout (Dockerfile.jetson), then start the container again
# with limits. The Jetson is a home server beside the SSH keys, the LAN and other services sharing 8 GB, so the
# container gets a memory and process cap, no Linux capabilities and no privilege gain (the server runs skidl code the
# model and the Code tab write), and its logs are capped (the system is on an SD card).
#
#   scripts/jetson_run.sh              build, then run
#   scripts/jetson_run.sh --no-build   run the image there is
#
# Keys go in ~/schemaforge.env (mode 600): OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, ALLOWED_EMAILS,
# FRONTEND_URL, and the optional ones in server/.env.example. Without the file the app shows the demos only.
# PUBLISH sets the port binding: the LAN by default; 127.0.0.1:8002:8002 once a reverse proxy serves it.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=schemaforge:jetson
NAME=schemaforge
ENV_FILE="$HOME/schemaforge.env"
PUBLISH="${PUBLISH:-8002:8002}"
MEMORY="${MEMORY:-2g}"

if [ "${1:-}" != "--no-build" ]; then
  docker build -f Dockerfile.jetson -t "$IMAGE" .
fi

env_args=()
if [ -f "$ENV_FILE" ]; then env_args=(--env-file "$ENV_FILE"); else echo "no $ENV_FILE: demos only"; fi

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped -p "$PUBLISH" "${env_args[@]}" \
  --memory "$MEMORY" --memory-swap "$MEMORY" --pids-limit 512 \
  --cap-drop ALL --security-opt no-new-privileges \
  --log-opt max-size=10m --log-opt max-file=3 \
  "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if health=$(curl -fsS http://localhost:8002/health 2>/dev/null); then echo "up: $health"; exit 0; fi
  sleep 2
done
echo "not healthy after 120 s"
docker logs --tail 30 "$NAME"
exit 1
