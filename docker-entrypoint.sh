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

if [ -f /app/api/dist/velograph-api.mjs ]; then
  node /app/api/dist/velograph-api.mjs &
else
  node /app/api/src/main.ts &
fi
api_pid=$!
node /usr/local/bin/docker-proxy.mjs &
proxy_pid=$!

stop_children() {
  trap '' INT TERM
  kill -TERM "$api_pid" "$proxy_pid" 2>/dev/null || true
  wait "$api_pid" 2>/dev/null || true
  wait "$proxy_pid" 2>/dev/null || true
}

trap 'stop_children; exit 0' INT TERM

while :; do
  if ! kill -0 "$api_pid" 2>/dev/null; then
    failed_name=api
    failed_pid=$api_pid
    sibling_pid=$proxy_pid
    break
  fi
  if ! kill -0 "$proxy_pid" 2>/dev/null; then
    failed_name=proxy
    failed_pid=$proxy_pid
    sibling_pid=$api_pid
    break
  fi
  sleep 0.1
done

if wait "$failed_pid"; then
  echo "Velograph $failed_name exited unexpectedly with status 0." >&2
  failed_status=1
else
  failed_status=$?
fi
kill -TERM "$sibling_pid" 2>/dev/null || true
wait "$sibling_pid" 2>/dev/null || true
exit "$failed_status"
