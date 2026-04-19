#!/bin/sh
# ─────────────────────────────────────────────────────────────────────
# Frontend nginx entrypoint
#
# Renders /etc/nginx/templates/default.conf.template into
# /etc/nginx/conf.d/default.conf using envsubst, then execs nginx in
# the foreground.
#
# Fails fast (exit 1) if any required env var is missing — we never
# want nginx to start with `${BACKEND_URL}` left literally in the
# config (would crash with: unknown "backend_url" variable).
# ─────────────────────────────────────────────────────────────────────
set -eu

TEMPLATE_PATH="/etc/nginx/templates/default.conf.template"
OUTPUT_PATH="/etc/nginx/conf.d/default.conf"

# ── 1. Validate required env vars ────────────────────────────────────
missing=""
for var in BACKEND_URL; do
  eval "value=\${$var:-}"
  if [ -z "$value" ]; then
    missing="$missing $var"
  fi
done

if [ -n "$missing" ]; then
  echo "❌ FATAL: missing required environment variable(s):$missing" >&2
  echo "   These must be set in Coolify → Environment Variables" >&2
  echo "   Example: BACKEND_URL=https://api.example.com" >&2
  exit 1
fi

# Strip trailing slash from BACKEND_URL to avoid double slashes in proxy_pass
BACKEND_URL="${BACKEND_URL%/}"
export BACKEND_URL

# ── 2. Verify template exists ────────────────────────────────────────
if [ ! -f "$TEMPLATE_PATH" ]; then
  echo "❌ FATAL: nginx template not found at $TEMPLATE_PATH" >&2
  exit 1
fi

# ── 3. Render template — only substitute the vars we whitelist.
#       Without the explicit list, envsubst would also replace nginx's
#       own runtime vars ($host, $uri, $remote_addr, ...) and break
#       the config.
# ────────────────────────────────────────────────────────────────────
echo "→ rendering nginx config: $TEMPLATE_PATH → $OUTPUT_PATH"
echo "  BACKEND_URL=$BACKEND_URL"

envsubst '${BACKEND_URL}' < "$TEMPLATE_PATH" > "$OUTPUT_PATH"

# ── 4. Sanity-check the rendered config — no unresolved ${...} left ──
if grep -q '\${' "$OUTPUT_PATH"; then
  echo "❌ FATAL: rendered nginx config still contains unresolved \${...} placeholders:" >&2
  grep -n '\${' "$OUTPUT_PATH" >&2
  exit 1
fi

# ── 5. Test config before starting ───────────────────────────────────
nginx -t

# ── 6. Hand off to nginx in the foreground (PID 1) ───────────────────
echo "✅ starting nginx"
exec nginx -g 'daemon off;'
