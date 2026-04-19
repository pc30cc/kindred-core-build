# ── Frontend Build ──────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

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

# ── Serve with nginx ───────────────────────────────────────
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

RUN test -f /usr/share/nginx/html/widget/widget-manifest.json || (echo "❌ widget-manifest.json missing in nginx image" && exit 1)

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
