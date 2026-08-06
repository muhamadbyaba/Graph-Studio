# BuildGraph Studio
#
# There is no build stage, because there is nothing to build: Node runs the TypeScript directly.
# The image installs dependencies, copies the source, and starts the server.

FROM node:24-alpine AS deps
WORKDIR /app

# Only the manifests first, so a source-only change reuses the cached install layer.
COPY package.json package-lock.json ./
COPY packages/engineering-core/package.json ./packages/engineering-core/
COPY apps/studio/package.json ./apps/studio/
COPY apps/studio/scripts/vendor.mjs ./apps/studio/scripts/

# --ignore-scripts during install: the vendor step needs the app tree, which is not here yet.
RUN npm ci --omit=dev --ignore-scripts


FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4317 \
    BG_DATA_DIR=/data

RUN apk add --no-cache curl \
 && addgroup -S buildgraph \
 && adduser -S -G buildgraph -h /app buildgraph \
 && mkdir -p /data \
 && chown buildgraph:buildgraph /data

COPY --from=deps --chown=buildgraph:buildgraph /app/node_modules ./node_modules
COPY --chown=buildgraph:buildgraph . .

# Copy the browser assets out of node_modules now that the app tree exists.
RUN node apps/studio/scripts/vendor.mjs

USER buildgraph
EXPOSE 4317
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

# Run the server as PID 1 so SIGTERM reaches it and documents are flushed before exit.
CMD ["node", "apps/studio/server.ts"]
