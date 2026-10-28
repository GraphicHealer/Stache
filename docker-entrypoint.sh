#!/bin/sh
# Runs as root just long enough to claim /data, then drops to node.
# Home Assistant mounts the add-on data dir root-owned; plain Docker
# volumes are already node-owned - chown is a no-op either way.
set -e
chown -R node:node /data 2>/dev/null || true
# Pre-rename installs keep their database under the old filename.
if [ ! -f /data/stache.db ] && [ -f /data/stash.db ]; then
  mv /data/stash.db /data/stache.db
  for f in stash.db-shm stash.db-wal; do [ -f "/data/$f" ] && mv "/data/$f" "/data/${f/stash/stache}" || true; done
fi
exec runuser -u node -- node /app/server/dist/index.js
