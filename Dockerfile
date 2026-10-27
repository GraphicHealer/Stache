# Stash - single-container build (app only; Postgres runs separately)

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm install

FROM deps AS build
COPY server/ server/
COPY client/ client/
RUN npm run build -w server && npm run build -w client

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# `lp` for CUPS label printers; `ca-certificates` for HTTPS AI providers.
RUN apt-get update \
  && apt-get install -y --no-install-recommends cups-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm install --omit=dev && npm cache clean --force

COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/migrations server/migrations
COPY --from=build /app/client/dist client/dist

ENV PORT=8080 \
    DATA_DIR=/data \
    CLIENT_DIST=/app/client/dist

RUN mkdir -p /data/photos && chown -R node:node /data

VOLUME /data
EXPOSE 8080

USER node
CMD ["node", "server/dist/index.js"]
