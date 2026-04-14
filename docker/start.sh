#!/bin/sh
set -eu

if [ -f /app/.env ]; then
  set -a
  . /app/.env
  set +a
fi

export SUPABASE_URL="${SUPABASE_URL:-${VITE_SUPABASE_URL:-}}"
export SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-${VITE_SUPABASE_ANON_KEY:-${VITE_SUPABASE_PUBLISHABLE_KEY:-}}}"

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
