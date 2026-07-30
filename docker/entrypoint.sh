#!/bin/sh
# Builds the artifacts once if the volume is empty, then hands over to the server.
#
# A fresh volume has no public/data, which the app treats as "no contracts built"
# and shows the upload screen. If the workbooks are mounted we can just build them,
# so the first `docker compose up` comes up with data rather than needing a manual
# step afterwards.
set -e

DATA_INDEX="/app/public/data/states.json"

if [ ! -f "$DATA_INDEX" ]; then
  if ls /app/BEMMP\ DATA/TM-*.xlsx >/dev/null 2>&1; then
    echo "[entrypoint] no artifacts yet — building from BEMMP DATA/"
    node /app/scripts/build-data.mjs || echo "[entrypoint] build failed; the Data panel can still take an upload"
  else
    echo "[entrypoint] no artifacts and no TM-*.xlsx mounted."
    echo "[entrypoint] Mount the exports at '/app/BEMMP DATA' or upload one in the app."
  fi
fi

exec "$@"
