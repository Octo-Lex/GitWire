#!/usr/bin/env bash
# GitWire Restore Script
# Usage: ./scripts/restore.sh <backup_dir>
#
# Restores PostgreSQL, Redis, and config from a backup created by backup.sh.
# WARNING: Stops all services during restore. Causes brief downtime.

set -euo pipefail

BACKUP_DIR="${1:?Usage: restore.sh <backup_dir>}"

if [ ! -f "${BACKUP_DIR}/gitops_hub.dump" ]; then
  echo "❌ Not a valid backup: ${BACKUP_DIR}/gitops_hub.dump not found"
  exit 1
fi

echo "╔══════════════════════════════════════════════╗"
echo "║       GitWire Restore                        ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# Show manifest
if [ -f "${BACKUP_DIR}/manifest.json" ]; then
  echo "Backup info:"
  cat "${BACKUP_DIR}/manifest.json"
  echo ""
fi

# ── Confirm ────────────────────────────────────────────────────────────────
read -p "⚠  This will REPLACE the live database. Continue? [y/N] " CONFIRM
if [ "${CONFIRM}" != "y" ] && [ "${CONFIRM}" != "Y" ]; then
  echo "Aborted."
  exit 0
fi

echo ""

# ── 1. Restore config ──────────────────────────────────────────────────────
echo "Restoring config..."
if [ -f "${BACKUP_DIR}/web.env" ]; then
  cp "${BACKUP_DIR}/web.env" /opt/gitwire/packages/web/.env
  echo "✓ .env restored"
fi
if [ -f "${BACKUP_DIR}/docker-compose.yml" ]; then
  cp "${BACKUP_DIR}/docker-compose.yml" /opt/gitwire/docker-compose.yml
  echo "✓ docker-compose.yml restored"
fi

# ── 2. Restore PostgreSQL ──────────────────────────────────────────────────
echo ""
echo "Restoring PostgreSQL..."

# Stop the app to prevent writes during restore
cd /opt/gitwire
docker compose stop gitwire-app 2>/dev/null || true
echo "✓ App stopped (prevents writes during restore)"

# Drop and recreate the database
docker exec gitwire-postgres-1 psql -U gitwire -d postgres -c "DROP DATABASE IF EXISTS gitops_hub;"
docker exec gitwire-postgres-1 psql -U gitwire -d postgres -c "CREATE DATABASE gitops_hub;"

# Restore from dump
cat "${BACKUP_DIR}/gitops_hub.dump" | docker exec -i gitwire-postgres-1 \
  pg_restore \
    -U gitwire \
    -d gitops_hub \
    --no-owner \
    --no-acl \
    --if-exists \
    --clean

RESTORED_TABLES=$(docker exec gitwire-postgres-1 psql -U gitwire -d gitops_hub -t -A -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
RESTORED_REPOS=$(docker exec gitwire-postgres-1 psql -U gitwire -d gitops_hub -t -A -c "SELECT count(*) FROM repositories" 2>/dev/null || echo "?")
echo "✓ PostgreSQL restored: ${RESTORED_TABLES} tables, ${RESTORED_REPOS} repos"

# ── 3. Restore Redis ───────────────────────────────────────────────────────
echo ""
if [ -f "${BACKUP_DIR}/redis_dump.rdb" ]; then
  echo "Restoring Redis..."
  docker compose stop redis 2>/dev/null || true
  
  # Copy RDB into Redis volume
  docker cp "${BACKUP_DIR}/redis_dump.rdb" gitwire-redis-1:/data/dump.rdb
  
  docker compose start redis 2>/dev/null || true
  sleep 3
  echo "✓ Redis RDB restored"
else
  echo "⚠ No Redis backup — BullMQ queues will be empty (workers re-enqueue on next event)"
fi

# ── 4. Restart everything ──────────────────────────────────────────────────
echo ""
echo "Restarting services..."
cd /opt/gitwire
docker compose up -d 2>/dev/null
sleep 10

# ── 5. Verify ──────────────────────────────────────────────────────────────
echo ""
echo "Verifying..."

HEALTH=$(curl -s http://localhost:3000/health 2>/dev/null || echo "failed")
if echo "${HEALTH}" | grep -q '"status":"ok"'; then
  echo "✓ API healthy: ${HEALTH}"
else
  echo "⚠ API not responding yet (may need a moment to start)"
fi

FINAL_TABLES=$(docker exec gitwire-postgres-1 psql -U gitwire -d gitops_hub -t -A -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
FINAL_REPOS=$(docker exec gitwire-postgres-1 psql -U gitwire -d gitops_hub -t -A -c "SELECT count(*) FROM repositories" 2>/dev/null || echo "?")

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Restore complete                            ║"
echo "║  Tables: ${FINAL_TABLES}"
echo "║  Repos:  ${FINAL_REPOS}"
echo "║                                              ║"
echo "║  Verify: curl https://gitwire.erlab.uk/health"
echo "╚══════════════════════════════════════════════╝"
