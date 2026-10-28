#!/bin/sh
# Runs as root just long enough to claim /data, then drops to node.
# Home Assistant mounts the add-on data dir root-owned; plain Docker
# volumes are already node-owned - chown is a no-op either way.
set -e
chown -R node:node /data 2>/dev/null || true
exec runuser -u node -- node /app/server/dist/index.js
