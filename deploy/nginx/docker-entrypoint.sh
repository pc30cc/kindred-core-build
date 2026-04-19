#!/bin/sh
# Substitute ${BACKEND_URL} in the nginx site config at container start.
# Defaults to the docker-compose service name `backend:3001`.
set -e

: "${BACKEND_URL:=http://backend:3001}"
export BACKEND_URL

# Only the BACKEND_URL var is substituted — leave nginx's own $vars alone.
envsubst '${BACKEND_URL}' \
  < /etc/nginx/conf.d/default.conf.template \
  > /etc/nginx/conf.d/default.conf

echo "▶ nginx /api/ -> ${BACKEND_URL}"

exec nginx -g 'daemon off;'
