# WEBYAR Telephony — Asterisk (PJSIP + ARI + PostgreSQL realtime) plus the
# Node control service in one runtime unit.
#
# Real Asterisk. SIP registration is NEVER simulated in Node: PJSIP performs
# the actual REGISTER against the provider.

# ── Stage 1: build the control service ──────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /opt/webyar/app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── Stage 2: runtime ────────────────────────────────────────────────────────
# Ubuntu 24.04 LTS, deliberately NOT Debian: Debian dropped `asterisk` from the
# archive after bullseye, so `apt-get install asterisk` fails outright on
# bookworm and trixie ("Package asterisk has no installation candidate").
# Ubuntu noble carries Asterisk 20 (an LTS branch) with res_config_pgsql in
# asterisk-modules, which is exactly what PJSIP Realtime needs.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
# asterisk            → core, PJSIP (chan_pjsip), ARI
# asterisk-modules    → res_config_pgsql (PostgreSQL realtime) + extra codecs
# asterisk-core-sounds → codecs DaftareShoma / LiveKit SIP negotiate
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      asterisk \
      asterisk-modules \
      asterisk-config \
      asterisk-core-sounds-en-gsm \
      gettext-base \
      ca-certificates \
      curl \
      procps \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/asterisk/*.conf

# Node 22 runtime only (no npm/corepack): the service is already compiled in
# stage 1, so a single glibc-linked binary from the official image is all the
# runtime needs and it keeps the Node version identical to the build stage.
COPY --from=build /usr/local/bin/node /usr/local/bin/node

WORKDIR /opt/webyar/app
COPY --from=build /opt/webyar/app/node_modules ./node_modules
COPY --from=build /opt/webyar/app/dist ./dist
COPY package.json ./

# Config templates (rendered from env at start — nothing baked in).
COPY asterisk/ /opt/webyar/asterisk/
COPY entrypoint.sh /opt/webyar/entrypoint.sh
RUN chmod +x /opt/webyar/entrypoint.sh \
 && mkdir -p /var/run/asterisk /var/log/asterisk \
 && chown -R asterisk:asterisk /var/run/asterisk /var/log/asterisk

# 5060/5061 SIP signalling, 8088 ARI (internal), 8089 control API (internal).
EXPOSE 5060/udp 5060/tcp 5061/tcp 8088 8089

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=5 \
  CMD curl -fsS -H "x-telephony-internal-secret: ${TELEPHONY_INTERNAL_SECRET}" \
      http://127.0.0.1:8089/internal/telephony/health || exit 1

ENTRYPOINT ["/opt/webyar/entrypoint.sh"]
