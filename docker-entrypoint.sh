#!/bin/sh
# Runs as root just long enough to claim /data, then drops to node.
# Home Assistant mounts the add-on data dir root-owned; plain Docker
# volumes are already node-owned - chown is a no-op either way.
set -e
# Recursive chown is slow on big photo folders - only run it when /data
# itself is not already node-owned (HA mounts it root-owned).
[ "$(stat -c %u /data)" = "$(id -u node)" ] || chown -R node:node /data 2>/dev/null || true
# Pre-rename installs keep their database under the old filename.
if [ ! -f /data/stache.db ] && [ -f /data/stash.db ]; then
  mv /data/stash.db /data/stache.db
  for f in stash.db-shm stash.db-wal; do
    [ -f "/data/$f" ] && mv "/data/$f" "/data/stache${f#stash}" || true
  done
fi
# exec via setpriv (not runuser, which forks) so SIGTERM reaches node.
exec setpriv --reuid node --regid node --clear-groups node /app/server/dist/index.js
