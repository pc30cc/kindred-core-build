#!/usr/bin/env bash
# WEBYAR Telephony — container entrypoint.
#
# 1. Render the Asterisk config templates from the environment (no credential
#    and no production host is ever baked into the image).
# 2. Start Asterisk (real PJSIP stack, real REGISTER, ARI enabled).
# 3. Start the control service, which owns provisioning and call control.
#
# Secrets are expanded into /etc/asterisk only, never echoed.

set -euo pipefail

: "${TELEPHONY_INTERNAL_SECRET:?TELEPHONY_INTERNAL_SECRET is required}"
: "${TELEPHONY_CORE_BASE_URL:?TELEPHONY_CORE_BASE_URL is required}"
: "${TELEPHONY_PUBLIC_SIP_HOST:?TELEPHONY_PUBLIC_SIP_HOST is required}"
: "${ASTERISK_ARI_USER:?ASTERISK_ARI_USER is required}"
: "${ASTERISK_ARI_PASSWORD:?ASTERISK_ARI_PASSWORD is required}"
: "${LIVEKIT_URL:?LIVEKIT_URL is required}"
: "${LIVEKIT_API_KEY:?LIVEKIT_API_KEY is required}"
: "${LIVEKIT_API_SECRET:?LIVEKIT_API_SECRET is required}"
: "${LIVEKIT_SIP_URI:?LIVEKIT_SIP_URI is required — LiveKit SIP is the only media path}"

export TELEPHONY_RTP_PORT_MIN="${TELEPHONY_RTP_PORT_MIN:-16384}"
export TELEPHONY_RTP_PORT_MAX="${TELEPHONY_RTP_PORT_MAX:-16584}"
export LIVEKIT_SIP_HOST="${LIVEKIT_SIP_URI%%:*}"

# ── Database credentials: ASTERISK_DB_URL or decomposed variables ───────────
if [[ -n "${ASTERISK_DB_URL:-}" ]]; then
  # postgresql://user:pass@host:port/dbname?params
  proto_removed="${ASTERISK_DB_URL#*://}"
  creds="${proto_removed%%@*}"
  hostpart="${proto_removed#*@}"
  export ASTERISK_DB_USER="${ASTERISK_DB_USER:-${creds%%:*}}"
  export ASTERISK_DB_PASSWORD="${ASTERISK_DB_PASSWORD:-${creds#*:}}"
  hostport="${hostpart%%/*}"
  export ASTERISK_DB_HOST="${ASTERISK_DB_HOST:-${hostport%%:*}}"
  if [[ "$hostport" == *:* ]]; then
    export ASTERISK_DB_PORT="${ASTERISK_DB_PORT:-${hostport##*:}}"
  fi
  dbname="${hostpart#*/}"
  export ASTERISK_DB_NAME="${ASTERISK_DB_NAME:-${dbname%%\?*}}"
fi
: "${ASTERISK_DB_HOST:?ASTERISK_DB_URL or ASTERISK_DB_HOST is required}"
: "${ASTERISK_DB_USER:?ASTERISK_DB_URL or ASTERISK_DB_USER is required}"
: "${ASTERISK_DB_PASSWORD:?ASTERISK_DB_URL or ASTERISK_DB_PASSWORD is required}"
: "${ASTERISK_DB_NAME:?ASTERISK_DB_URL or ASTERISK_DB_NAME is required}"
export ASTERISK_DB_PORT="${ASTERISK_DB_PORT:-5432}"

# ── Render configuration templates ──────────────────────────────────────────
mkdir -p /etc/asterisk
for template in /opt/webyar/asterisk/*.conf; do
  name="$(basename "$template")"
  envsubst < "$template" > "/etc/asterisk/${name}"
done
chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/log/asterisk /var/spool/asterisk /var/run/asterisk 2>/dev/null || true
echo '{"event":"telephony.container.config_rendered"}'

# ── Start Asterisk ──────────────────────────────────────────────────────────
asterisk -U asterisk -G asterisk -f &
ASTERISK_PID=$!

for _ in $(seq 1 30); do
  if asterisk -rx 'core show version' >/dev/null 2>&1; then break; fi
  sleep 1
done
echo '{"event":"telephony.container.asterisk_started"}'

# ── Start the control service ───────────────────────────────────────────────
node /opt/webyar/app/dist/index.js &
SERVICE_PID=$!

terminate() {
  kill -TERM "$SERVICE_PID" 2>/dev/null || true
  kill -TERM "$ASTERISK_PID" 2>/dev/null || true
  wait || true
}
trap terminate SIGTERM SIGINT

# Exit as soon as either process dies so the orchestrator restarts the unit.
wait -n "$ASTERISK_PID" "$SERVICE_PID"
terminate
exit 1
