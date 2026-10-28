# Stache - single container: app + embedded SQLite, no external services.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY client/package.json client/
# better-sqlite3/sqlite-vec ship prebuilt binaries; toolchain is a fallback
# for platforms without one.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && npm ci

FROM deps AS build
# Release workflow bakes the tag in; shows in the UI via Vite.
ARG APP_VERSION=dev
ENV VITE_APP_VERSION=${APP_VERSION}
COPY server/ server/
COPY client/ client/
RUN npm run build -w server && npm run build -w client

FROM node:22-bookworm-slim AS runtime
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION}
WORKDIR /app

# `lp` for CUPS label printers; `ca-certificates` for HTTPS AI providers.
RUN apt-get update \
  && apt-get install -y --no-install-recommends cups-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/migrations server/migrations
COPY --from=build /app/client/dist client/dist

ENV PORT=8080 \
    DATA_DIR=/data \
    CLIENT_DIST=/app/client/dist

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /data/photos && chown -R node:node /data

VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Stays root only for the chown, then drops to node (entrypoint handles it;
# required because Home Assistant mounts /data root-owned).
CMD ["docker-entrypoint.sh"]
