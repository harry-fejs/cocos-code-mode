#!/bin/sh
set -eu
db="${CCP_DB_PATH:-/data/ccp.db}"
mkdir -p "$(dirname "$db")"
chown -R node:node "$(dirname "$db")" || true
exec su-exec node yarn start
