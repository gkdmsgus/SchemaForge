#!/usr/bin/env bash
# SchemaForge on the Jetson: build the image from this checkout (Dockerfile.jetson), then start the container again
# with limits. The Jetson is a home server beside the SSH keys, the LAN and other services sharing 8 GB, so the
# container gets a memory and process cap, no Linux capabilities and no privilege gain (the server runs skidl code the
# model and the Code tab write), and its logs are capped (the system is on an SD card).
#
#   scripts/jetson_run.sh              build, then run; if the new image does not come up, the one before runs again
#   scripts/jetson_run.sh --no-build   run the image there is, the same way
#   scripts/jetson_run.sh --rollback   run the image before ($IMAGE-prev) again
#
# The image running when this starts is tagged $IMAGE-prev before the new one starts, and only when it is another image:
# a build replaces $IMAGE, and the image it replaced had no name left to go back to (audit of 2026-11-08). A rollback
# still ends with exit 1, so a failed deploy is never read as done.
#
# Keys go in ~/schemaforge.env (mode 600): OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, ALLOWED_EMAILS,
# and the optional ones in server/.env.example. Without the file the app shows the demos only.
# PUBLISH sets the port binding: this host only by default, where Caddy serves it over HTTPS (8002:8002 opens plain
# HTTP to the LAN, for a test). CPUS caps the cores: the Jetson has 6, and its other services need some. IMAGE and NAME
# let a test image and container run beside the real ones (scripts/check_jetson_run.ts).
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-schemaforge:jetson}"
NAME="${NAME:-schemaforge}"
PREV="$IMAGE-prev"
ENV_FILE="$HOME/schemaforge.env"
PUBLISH="${PUBLISH:-127.0.0.1:8002:8002}"
MEMORY="${MEMORY:-2g}"
CPUS="${CPUS:-4}"

mode="${1:-}"
case "$mode" in
  ''|--no-build|--rollback) ;;
  *) echo "usage: scripts/jetson_run.sh [--no-build | --rollback]"; exit 2 ;;
esac

env_args=()
if [ -f "$ENV_FILE" ]; then env_args=(--env-file "$ENV_FILE"); else echo "no $ENV_FILE: demos only"; fi

# PORT after the env file: server/.env.example has the local dev API's PORT for the vite proxy, and copied into the env file it
# made the server listen where nothing is published (review of 2026-11-03). NODE_ENV too: it alone turns on the
# deployed-server guard (deploy_guard.ts), so a NODE_ENV=development in the env file opened generation to anyone
start() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --restart unless-stopped -p "$PUBLISH" "${env_args[@]}" -e PORT=8002 -e NODE_ENV=production \
    --memory "$MEMORY" --memory-swap "$MEMORY" --pids-limit 512 --cpus "$CPUS" \
    --cap-drop ALL --security-opt no-new-privileges \
    --log-opt max-size=10m --log-opt max-file=3 \
    "$1" >/dev/null
}

# up means KiCad answers too: /health says ok before its kicad-cli probe is back, and with "kicad":null when the probe
# failed, when boards and gerbers cannot be made. Asked where PUBLISH puts it: ip:port:8002 or port:8002.
# $1 is the text /health must hold
host_addr=$(echo "$PUBLISH" | awk -F: '{ print (NF == 3 ? $1 : "localhost") ":" (NF >= 2 ? $(NF-1) : $1) }')
wait_up() {
  local health=""
  for _ in $(seq 1 60); do
    health=$(curl -fsS "http://$host_addr/health" 2>/dev/null || true)
    if echo "$health" | grep -qF "$1"; then echo "up: $health"; return 0; fi
    sleep 2
  done
  echo "not up with $1 after 120 s: ${health:-no answer}"
  docker logs --tail 30 "$NAME" || true
  return 1
}
image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || true; }

if [ "$mode" = --rollback ]; then
  [ -n "$(image_id "$PREV")" ] || { echo "no $PREV to go back to"; exit 1; }
  start "$PREV"
  wait_up '"kicad":"10.' || exit 1
  echo "rolled back to $PREV ($(image_id "$PREV"))"
  exit 0
fi

# the image running now, read before a build moves $IMAGE to the new one
live=$(docker container inspect -f '{{.Image}}' "$NAME" 2>/dev/null || true)

if [ "$mode" != --no-build ]; then
  commit=$(git rev-parse --short HEAD)
  echo "building $commit"
  docker build -f Dockerfile.jetson --build-arg SF_COMMIT="$commit" -t "$IMAGE" .
fi
new=$(image_id "$IMAGE")
[ -n "$new" ] || { echo "no image $IMAGE: build it first (scripts/jetson_run.sh)"; exit 1; }
# only when it is another image: run twice with --no-build, the second run would make the new image its own way back
if [ -n "$live" ] && [ "$live" != "$new" ]; then docker tag "$live" "$PREV"; fi

start "$IMAGE"
if wait_up '"kicad":"10.'; then exit 0; fi

prev=$(image_id "$PREV")
if [ -n "$prev" ] && [ "$prev" != "$new" ]; then
  echo "$IMAGE did not come up: going back to $PREV"
  start "$PREV"
  if wait_up '"kicad":"10.'; then echo "rolled back to $PREV ($prev)"; fi
fi
exit 1
