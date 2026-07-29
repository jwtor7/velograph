#!/bin/sh
# Keep the application API on the container loopback interface. The relay is
# the only process that listens on the container network; Compose publishes its
# port to the host loopback interface only.
set -eu

: "${VELO_HOST:=127.0.0.1}"
: "${VELO_INTERNAL_PORT:=5124}"
: "${VELO_PROXY_PORT:=5123}"

case "$VELO_HOST" in
  127.0.0.1|localhost|::1) ;;
  *)
    echo "Refusing non-loopback VELO_HOST in container."
    exit 64
    ;;
esac

export VELO_HOST
export VELO_PORT="$VELO_INTERNAL_PORT"

node apps/api/src/main.ts &
api_pid=$!
node /usr/local/bin/docker-proxy.mjs &
proxy_pid=$!

stop_children() {
  kill -TERM "$api_pid" "$proxy_pid" 2>/dev/null || true
  wait "$api_pid" 2>/dev/null || true
  wait "$proxy_pid" 2>/dev/null || true
}

trap 'stop_children; exit 0' INT TERM

set +e
wait "$api_pid"
api_status=$?
set -e
kill -TERM "$proxy_pid" 2>/dev/null || true
wait "$proxy_pid" 2>/dev/null || true
exit "$api_status"
