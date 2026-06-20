#!/usr/bin/env sh
# docker-entrypoint.sh — GitWire app container entrypoint
#
# Runs database migrations before starting the application. If migrations
# fail, the container exits non-zero (fail-closed) rather than starting
# workers against an uncertain schema.
#
# The actual app command is owned by the Dockerfile CMD (or any compose
# override); this entrypoint only prepends the migration step and then
# `exec`s the supplied command.
#
# Why fail-closed: a stale or partially-applied schema under newer code is
# exactly the drift class this entrypoint exists to prevent. The migration
# runner (scripts/migrate.js) is idempotent and transactional, so a failed
# migration indicates the database is genuinely not safe for the code.
set -e

# Migrations live at /app/scripts/migrate.js (one level above the app
# WORKDIR of /app/packages/web). Run from /app so relative paths resolve.
echo "[entrypoint] running database migrations"
( cd /app && node scripts/migrate.js )

echo "[entrypoint] starting GitWire"
exec "$@"
