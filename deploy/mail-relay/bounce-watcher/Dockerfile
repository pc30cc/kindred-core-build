# The relay's bounce watcher (watcher.mjs): plain Node, no dependencies.
# The same Node minor as the platform's images (src/test/ci/nodeVersion.test.ts);
# move it with them.
FROM node:24.22-alpine
WORKDIR /app
COPY watcher.mjs ./
# Runs as root: Postfix's queue directories (counted for the alert) are
# readable by root only, and both volumes are mounted read-only.
CMD ["node", "/app/watcher.mjs"]
