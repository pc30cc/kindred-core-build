# This file is a thin alias for Dockerfile.frontend so that Coolify
# deployments which default to "Dockerfile" still get the correct
# templated nginx setup (envsubst + custom entrypoint). The canonical
# definition lives in Dockerfile.frontend — keep them in sync.

# ── Frontend Build ──────────────────────────────────────────
# Pin Node — see Dockerfile.frontend for the rationale.
FROM node:20.18-alpine AS build
WORKDIR /app

# zip — used by scripts/build-woocommerce-plugin-zip.mjs (part of `npm run
# build`) to package plugins/webyar-woocommerce/ into the downloadable
# public/downloads/webyar-woocommerce.zip served by nginx.
RUN apk add --no-cache zip

COPY package.json bun.lockb* package-lock.json* ./
RUN npm install --ignore-scripts

COPY . .

ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_API_BASE_URL

ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN npm run build

RUN test -f /app/dist/widget/widget-manifest.json || (echo "❌ widget-manifest.json missing from build output" && ls -la /app/dist/widget/ && exit 1)
RUN echo "✅ widget assets:" && ls -la /app/dist/widget/
RUN test -f /app/dist/downloads/webyar-woocommerce.zip || (echo "❌ webyar-woocommerce.zip missing from build output" && exit 1)
RUN test -f /app/dist/downloads/webyar-whmcs.zip || (echo "❌ webyar-whmcs.zip missing from build output" && exit 1)
RUN test -f /app/dist/downloads/opencart/4.1/webyar.ocmod.zip && test -f /app/dist/downloads/opencart/3.0/webyar-oc3.ocmod.zip && test -f /app/dist/downloads/opencart/manifest.json || (echo "❌ OpenCart packages missing from build output" && exit 1)

# ── Serve with nginx ───────────────────────────────────────
FROM nginx:alpine

RUN apk add --no-cache gettext

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN test -f /usr/share/nginx/html/widget/widget-manifest.json || (echo "❌ widget-manifest.json missing in nginx image" && exit 1)

EXPOSE 80
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD []
