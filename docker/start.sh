#!/bin/sh
set -eu

node /app/server/dist/index.js &
NODE_PID=$!

nginx -g 'daemon off;' &
NGINX_PID=$!

cleanup() {
  kill -TERM "$NODE_PID" "$NGINX_PID" 2>/dev/null || true
  wait "$NODE_PID" 2>/dev/null || true
  wait "$NGINX_PID" 2>/dev/null || true
}

trap cleanup INT TERM

while kill -0 "$NODE_PID" 2>/dev/null && kill -0 "$NGINX_PID" 2>/dev/null; do
  sleep 1
done

cleanup
exit 1
