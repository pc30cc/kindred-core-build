#!/bin/bash
# WebYar's Iran relay: coturn on a server inside Iran (README.md next to this).
#
# Phones on Iranian networks reach this server domestically; it forwards their
# audio and video, over UDP, to WebYar's LiveKit abroad. WebYar only: RESPOK
# never lists this relay.
#
# Run as root on the relay server after `apt-get install coturn`:
#
#   PUBLIC_IP=185.213.167.216 PEER_IPS="5.39.70.213" ./configure.sh
#
# Settings (environment):
#   PUBLIC_IP    this server's public IPv4 (required; on the NIC, no NAT)
#   PUBLIC_IP6   its public IPv6 (optional; listens there too)
#   PEER_IPS     the only addresses the relay may send to: LiveKit's node IP(s).
#                Change it when LiveKit moves, or the relay stops working.
#   PORT         client port, UDP and TCP (default 3478)
#   MIN_PORT/MAX_PORT  relay port range (default 49160-49999)
#   MAX_BPS      bytes per second per session, each direction (default 1000000)
#   TOTAL_QUOTA  concurrent allocations on the server (default 600)
#
# The shared secret is /etc/webyar-turn/secret (root, 0600): the same value as
# Super Admin → Voice & Video → network → TURN shared secret. It is never
# printed. To rotate it, write a new one there, run this again, and save the
# same value in Super Admin.
set -euo pipefail

PUBLIC_IP=${PUBLIC_IP:?set PUBLIC_IP}
PUBLIC_IP6=${PUBLIC_IP6:-}
PEER_IPS=${PEER_IPS:?set PEER_IPS (LiveKit node IP)}
PORT=${PORT:-3478}
MIN_PORT=${MIN_PORT:-49160}
MAX_PORT=${MAX_PORT:-49999}
MAX_BPS=${MAX_BPS:-1000000}
TOTAL_QUOTA=${TOTAL_QUOTA:-600}
SECRET_FILE=/etc/webyar-turn/secret
CONF=/etc/turnserver.conf

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -s "$SECRET_FILE" ] || { echo "missing $SECRET_FILE" >&2; exit 1; }
command -v turnserver >/dev/null || { echo "coturn is not installed" >&2; exit 1; }
id turnserver >/dev/null

tmp=$(mktemp "$CONF.XXXXXX")
trap 'rm -f "$tmp"' EXIT
chmod 640 "$tmp"
{
  echo "# WebYar Iran relay. Written by deploy/iran-relay/configure.sh on $(date -u +%FT%TZ)."
  echo "# Do not edit by hand: change the settings and run configure.sh again."
  echo "listening-port=$PORT"
  echo "listening-ip=$PUBLIC_IP"
  echo "relay-ip=$PUBLIC_IP"
  if [ -n "$PUBLIC_IP6" ]; then
    echo "listening-ip=$PUBLIC_IP6"
    echo "relay-ip=$PUBLIC_IP6"
  fi
  echo "min-port=$MIN_PORT"
  echo "max-port=$MAX_PORT"
  echo "realm=webyar.ai"
  echo "fingerprint"
  # Time-limited credentials minted by WebYar's backend (RFC 7635 style).
  echo "use-auth-secret"
  echo "static-auth-secret=$(tr -d '\r\n' < "$SECRET_FILE")"
  echo "stale-nonce=600"
  # Plain UDP/TCP on the client side; TLS needs a domain and is not used yet.
  echo "no-tls"
  echo "no-dtls"
  echo "no-cli"
  echo "no-tcp-relay"
  echo "no-multicast-peers"
  echo "no-software-attribute"
  # Relay only to WebYar's media server: deny every peer, then allow LiveKit.
  echo "denied-peer-ip=0.0.0.0-255.255.255.255"
  echo "denied-peer-ip=::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"
  for ip in $PEER_IPS; do echo "allowed-peer-ip=$ip"; done
  echo "max-bps=$MAX_BPS"
  echo "total-quota=$TOTAL_QUOTA"
  echo "user-quota=12"
  echo "syslog"
  echo "simple-log"
  echo "no-stdout-log"
} > "$tmp"
chown root:turnserver "$tmp"
mv "$tmp" "$CONF"
trap - EXIT

touch /etc/webyar-turn/ready
systemctl daemon-reload
systemctl enable coturn >/dev/null 2>&1
systemctl restart coturn
sleep 2
systemctl is-active coturn
ss -lnup "sport = :$PORT" | tail -n +2
ss -lntp "sport = :$PORT" | tail -n +2
