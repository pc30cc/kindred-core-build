FROM node:20-alpine AS frontend-build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_API_BASE_URL
RUN npm run build

FROM node:20-alpine AS server-build
WORKDIR /app/server
COPY server/package*.json ./
RUN npm install
COPY server/ .
RUN npm run build

FROM nginx:alpine
RUN apk add --no-cache nodejs
WORKDIR /app
ARG SUPABASE_URL
ARG SUPABASE_ANON_KEY
ARG SUPABASE_SERVICE_ROLE_KEY
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ENV SUPABASE_URL=${SUPABASE_URL}
ENV SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
ENV SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL}
ENV VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY}
ENV VITE_SUPABASE_PUBLISHABLE_KEY=${VITE_SUPABASE_PUBLISHABLE_KEY}
COPY --from=frontend-build /app/dist /usr/share/nginx/html
COPY --from=frontend-build /app/.env /app/.env
COPY --from=server-build /app/server/dist /app/server/dist
COPY --from=server-build /app/server/node_modules /app/server/node_modules
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 80
CMD ["/start.sh"]
