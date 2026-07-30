#!/bin/sh
# Takes the latest code and restarts, without touching the key or the artifacts.
#
#   ./docker/update.sh
#
# Safe to re-run. Neither `git pull` nor a rebuild can reach .env or the
# bemmp-artifacts volume, so nothing has to be re-entered afterwards.
set -e

cd "$(dirname "$0")/.."

echo "==> pulling"
git pull --ff-only

echo "==> rebuilding and restarting"
docker compose up -d --build

echo "==> waiting for health"
for i in $(seq 1 30); do
  status=$(docker inspect --format='{{.State.Health.Status}}' bemmp-dashboard 2>/dev/null || echo starting)
  if [ "$status" = "healthy" ]; then
    echo "==> healthy"
    docker compose logs --tail 15 bemmp
    exit 0
  fi
  sleep 2
done

echo "==> did not report healthy in 60s; recent logs:"
docker compose logs --tail 40 bemmp
exit 1
